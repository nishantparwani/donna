// Google Calendar sync through the Apps Script bridge (bridge/Code.gs).
// The bridge is slow (seconds per call), so a copy of the next ~6 weeks is saved in the database:
//   • views (Today, Calendar, Radar…) read the saved copy instantly; the app then asks /api/sync
//     to compare it with Google in the background and redraws only if something changed
//   • chat and edits use the copy while it is younger than FRESH_MS, else read Google first
//   • every change pushed to Google updates the copy; the 15-minute cron refreshes it
// Days outside the saved window are read from Google on demand, as before.
// Works with bridge v2 (single calendar, no series ops) and v3 (all calendars, series, Meet, email).
import * as T from './time.js';
import * as cal from './calendar.js';
import { settings, load, save, readRow, writeRow } from './store.js';

const CACHE_MS = 45000;
const SAVED = 'gcache';
const WINDOW = [-7, 42];         // days around today kept in the saved copy
const FRESH_MS = 5 * 60e3;       // chat / edits trust a copy this young
let loaded = null;   // { from, to } days currently in memory
let memo = null;     // { from, to, at, events } last Google read, reused for CACHE_MS
let lastSync = null; // { at, saved: bool } when the data this request used was read from Google

export const googleMode = () => { const s = settings(); return s.calendarMode === 'google' && !!s.bridgeUrl && !!s.bridgeToken; };
export const bridgeVersion = () => Number(load('state').bridgeVersion || 2);
export const hasV3 = () => googleMode() && bridgeVersion() >= 3;

/** Test hook: replaces the network call to the bridge. */
let transport = null;
export function useTransport(fn) { transport = fn; memo = null; loaded = null; }

function callBridge(payload, timeoutMs = 45000) {
  const s = settings();
  return callBridgeAt(s.bridgeUrl, s.bridgeToken, payload, timeoutMs);
}

/** A call to any bridge (e.g. the new account's during a move). */
export async function callBridgeAt(url, token, payload, timeoutMs = 45000) {
  if (transport) return transport(payload, url);
  let res, text;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ token, ...payload }),
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch (e) {
    throw new Error(`Can't reach Google Calendar right now (${e.name === 'TimeoutError' ? 'timed out' : e.message}).`);
  }
  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error('The Google bridge did not answer correctly. Check the bridge URL ends in /exec and access is "Anyone".');
  }
  if (data.error) throw new Error(data.error === 'unauthorized' ? 'The bridge rejected the token. Make sure the token in Settings matches bridge/Code.gs.' : `Google bridge: ${data.error}`);
  return data;
}

function noteVersion(r) {
  const v = Number(r.version || 2);
  const st = load('state');
  if (st.bridgeVersion !== v) { st.bridgeVersion = v; save('state'); }
}

export function fromBridge(e) {
  const m = e.meta || {};
  // v2 bridges key recurring instances as "<id>@<epoch ms>": they belong to one series.
  const legacySeries = !e.recurringId && /@\d{12,}$/.test(e.id) ? e.id.replace(/@\d+$/, '') : '';
  return {
    id: e.id, title: e.title, start: e.start, end: e.end, allDay: !!e.allDay,
    description: e.description || '', location: e.location || '', guests: e.guests || [],
    organizer: e.organizer !== false, myStatus: e.myStatus || 'accepted',
    agent: !!m.agent, kind: m.kind || (e.readOnly ? 'busy' : ((e.guests || []).length ? 'meeting' : 'task')), anchor: m.anchor || null,
    flexible: !!m.flexible, highStakes: !!m.highStakes, protected: !!m.protected,
    groupId: m.groupId || '', taskId: m.taskId || '', habitId: m.habitId || '',
    recurringId: e.recurringId || legacySeries, meetLink: e.meetLink || '', reminder: e.reminder ?? null, color: e.color || '',
    calendarId: e.calendarId || 'primary', calendarName: e.calendarName || '', readOnly: !!e.readOnly,
  };
}

async function fetchRange(fromDay, toDay) {
  const r = await callBridge({ action: 'list', from: fromDay + 'T00:00', to: T.addDays(toDay, 1) + 'T00:00', exclude: settings().ignoreCalendars || [] });
  noteVersion(r);
  if (r.timeZone && r.timeZone !== settings().timeZone) {
    load('settings').timeZone = r.timeZone; save('settings');
    T.setTimeZone(r.timeZone);
  }
  return (r.events || []).map(fromBridge);
}

export async function ping() {
  const r = await callBridge({ action: 'ping' });
  noteVersion(r);
  if (r.email && settings().userEmail !== r.email) { load('settings').userEmail = r.email; save('settings'); }
  return { timeZone: r.timeZone, email: r.email, fast: !!r.fast, version: Number(r.version || 2), calendars: r.calendars || [] };
}

// ─── Saved copy ───
const savedKey = () => { const s = settings(); return `${s.bridgeUrl}|${(s.ignoreCalendars || []).join(',')}|${T.tzName()}`; };
const windowDays = () => ({ from: T.addDays(T.today(), WINDOW[0]), to: T.addDays(T.today(), WINDOW[1]) });

async function readSaved() {
  let c = null;
  try { c = JSON.parse(await readRow(SAVED) || 'null'); } catch { c = null; }
  return c && c.key === savedKey() && Array.isArray(c.events) ? c : null;
}
/** Saves events for [from, to]. at = when they were read from Google; wrote guards against stale overwrites. */
async function writeSaved(from, to, events, at, { since } = {}) {
  const body = JSON.stringify({ key: savedKey(), from, to, at, wrote: Date.now(), events: events.map(cal.compact) });
  return writeRow(SAVED, body, since ? { field: 'wrote', below: since } : undefined);
}
// Saved events are compact (default-valued fields left out), so missing fields read as their defaults.
const signature = events => events.map(e => `${e.id}|${e.start}|${e.end}|${e.title}|${e.myStatus || 'accepted'}|${e.calendarId || 'primary'}`).sort().join('\n');

/** When the data in use was last read from Google (for the "updated 2 min ago" hint). */
export const syncInfo = () => lastSync;

/**
 * Loads Google events for [fromDay, toDay] (inclusive) into memory.
 * @param {{maxAge?: number, stale?: boolean}} opts  stale: a view may use an old saved copy (the app refreshes it next)
 */
export async function pull(fromDay, toDay, { maxAge = FRESH_MS, stale = false } = {}) {
  if (memo && Date.now() - memo.at < CACHE_MS && memo.from <= fromDay && memo.to >= toDay) {
    cal.setRemoteEvents(memo.events.filter(e => e.end > memo.from && e.start < T.addDays(memo.to, 1)));
    loaded = { from: memo.from, to: memo.to };
    lastSync = { at: memo.at, saved: !!memo.saved };
    return;
  }
  const win = windowDays();
  if (fromDay >= win.from && toDay <= win.to) {
    const c = await readSaved();
    if (c && c.from <= fromDay && c.to >= toDay && (stale || Date.now() - c.at < maxAge)) {
      cal.setRemoteEvents(c.events);
      loaded = { from: c.from, to: c.to };
      memo = { from: c.from, to: c.to, at: c.at, events: c.events, saved: true };
      lastSync = { at: c.at, saved: true };
      return;
    }
    // One read covers the whole window, so the next views and chats need no Google call at all.
    const at = Date.now();
    const events = await fetchRange(win.from, win.to);
    cal.setRemoteEvents(events);
    loaded = { ...win };
    memo = { ...win, at, events };
    lastSync = { at, saved: false };
    await writeSaved(win.from, win.to, events, at, { since: at });
    return;
  }
  const at = Date.now();
  const events = await fetchRange(fromDay, toDay);
  cal.setRemoteEvents(events);
  loaded = { from: fromDay, to: toDay };
  memo = { from: fromDay, to: toDay, at, events };
  lastSync = { at, saved: false };
}

/** Reads the saved window from Google now. Returns whether anything changed since the saved copy. */
export async function refreshSaved() {
  if (!googleMode()) return { changed: false, at: Date.now() };
  const before = await readSaved();
  const win = windowDays();
  const at = Date.now();
  const events = await fetchRange(win.from, win.to);
  const changed = !before || signature(before.events.filter(e => e.end > win.from && e.start < T.addDays(win.to, 1))) !== signature(events);
  if (await writeSaved(win.from, win.to, events, at, { since: at })) memo = { ...win, at, events };
  lastSync = { at, saved: false };
  return { changed, at };
}

/** Makes sure [fromDay, toDay] is in memory (fetches only the missing part). */
export async function ensureRange(fromDay, toDay) {
  if (!googleMode() || !cal.isRemote()) return;
  if (loaded && fromDay >= loaded.from && toDay <= loaded.to) return;
  const parts = [];
  if (!loaded) parts.push([fromDay, toDay]);
  else {
    if (fromDay < loaded.from) parts.push([fromDay, T.addDays(loaded.from, -1)]);
    if (toDay > loaded.to) parts.push([T.addDays(loaded.to, 1), toDay]);
  }
  for (const [a, b] of parts) cal.mergeRemoteEvents(await fetchRange(a, b));
  loaded = { from: loaded ? [loaded.from, fromDay].sort()[0] : fromDay, to: loaded ? [loaded.to, toDay].sort()[1] : toDay };
}
export const loadedRange = () => loaded;

/** Full-text search over a long range. v3 asks Google; v2 reads the range and filters here. */
export async function searchRemote(q, fromDay, toDay) {
  if (hasV3()) {
    const r = await callBridge({ action: 'search', q, from: fromDay + 'T00:00', to: T.addDays(toDay, 1) + 'T00:00' });
    const evs = (r.events || []).map(fromBridge);
    cal.mergeRemoteEvents(evs);
    return evs.map(e => e.id);
  }
  await ensureRange(fromDay, toDay);
  return null; // caller filters the loaded events
}

const HARMLESS = /does not exist|already been deleted|not found in google calendar/i;

/** Sends this run's changes to Google. Returns a list of problems (empty if all good). */
export async function push() {
  const ops = cal.takeOps();
  if (!ops.length) return [];
  // Big runs (e.g. a 100-event hourly plan) go in chunks so one Apps Script call never runs too long.
  const problems = [];
  const map = {};
  for (let i = 0; i < ops.length; i += 60) {
    const r = await callBridge({ action: 'batch', ops: ops.slice(i, i + 60) }, 300000);
    for (const res of r.results || []) {
      const op = ops.find(o => o.id === res.id);
      if (res.error && !(op && op.op === 'delete' && HARMLESS.test(res.error))) problems.push(`${titleOf(op)}: ${res.error}`);
      if (res.newId) map[res.id] = res.newId;
      if (res.meetLink) { const ev = cal.all().find(e => e.id === res.id); if (ev) ev.meetLink = res.meetLink; }
    }
  }
  cal.remapIds(map);
  // A series changed: its other instances look different now, so read fresh next time.
  const seriesTouched = ops.some(o => o.scope === 'series' || o.recurrence);
  const doubtful = seriesTouched || problems.length;
  if (memo && loaded) memo = doubtful ? null : { from: loaded.from, to: loaded.to, at: memo.at, events: structuredClone(cal.all()), saved: memo.saved };
  // Keep the saved copy in step with what was just written (a doubtful one is marked old, so it is re-read).
  const win = windowDays();
  if (loaded && loaded.from <= win.from && loaded.to >= win.to) {
    const evs = cal.all().filter(e => e.end > win.from && e.start < T.addDays(win.to, 1));
    await writeSaved(win.from, win.to, evs, doubtful ? 0 : (lastSync ? lastSync.at : 0));
  } else {
    const c = await readSaved();
    if (c) await writeSaved(c.from, c.to, c.events, 0); // can't patch it reliably: mark it old
  }
  return problems;
}
const titleOf = op => (op && op.ev && op.ev.title) ? `"${op.ev.title}"` : (op ? op.id : '?');

export async function emailMe(subject, html) {
  if (!hasV3()) return { ok: false, reason: 'Update the Google bridge to v3 to get email briefings.' };
  return callBridge({ action: 'email', subject, html, from: settings().agentName });
}

export async function freeBusy(fromDay, toDay, emails) {
  if (!hasV3() || !emails.length) return {};
  const r = await callBridge({ action: 'freebusy', from: fromDay + 'T00:00', to: T.addDays(toDay, 1) + 'T00:00', emails });
  return r.busy || {};
}

export function invalidateCache() { memo = null; }
export function resetSync() { memo = null; loaded = null; }
