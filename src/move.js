// Moving the whole calendar to another Google account (e.g. the one your iPhone uses).
// Steps, each a short request driven by the Settings page (resumable at any point):
//   start   → a fresh token for the new account's bridge
//   connect → the new bridge's URL; works out how the old calendar can be read and cleaned up
//   export  → reads everything from `cutoff` on (series with their rules, singles, exceptions) = the backup
//   import  → recreates it in the new account's primary calendar in small chunks; nobody is emailed
//   switch  → Donna now runs on the new account and ignores the old calendar
//   cleanup → ends the old series at the cutoff and deletes the copied singles (only what was copied OK)
import * as T from './time.js';
import { load, loadLazy, save, settings, saveSettings } from './store.js';
import { callBridgeAt, invalidateCache, resetSync } from './sync.js';

const IMPORT_CHUNK = 25;
const CLEANUP_CHUNK = 40;
const COPY_DAYS_BACK = 20;
const HORIZON_DAYS = 730;
const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(18)), b => b.toString(36).padStart(2, '0')).join('').slice(0, 32);

export async function moveState() {
  await loadLazy('move');
  const m = load('state').move || { stage: 'idle' };
  const data = load('move');
  const items = data.resources || [];
  return {
    stage: m.stage, email: m.email || '', oldEmail: m.oldEmail || '', sourceVia: m.sourceVia, cleanupVia: m.cleanupVia, access: m.access || '',
    needsOldUpdate: !!m.needsOldUpdate, cutoff: m.cutoff || '', summary: m.summary || null,
    imported: items.filter(r => r.newId).length, failed: items.filter(r => r.error).length, total: items.length,
    cleaned: items.filter(r => r.cleaned).length, cleanable: items.filter(r => r.newId && r.cleanup).length,
    errors: items.filter(r => r.error).slice(0, 8).map(r => `${r.title}: ${r.error}`), skippedInvites: m.skippedInvites || 0,
  };
}
const setMove = patch => { const st = load('state'); st.move = { ...(st.move || {}), ...patch }; save('state'); return st.move; };
const oldBridge = () => ({ url: settings().bridgeUrl, token: settings().bridgeToken });
const newBridge = () => { const m = load('state').move || {}; return { url: m.url, token: m.token }; };

export async function startMove() {
  await loadLazy('move');
  const s = settings();
  if (s.calendarMode !== 'google' || !s.bridgeUrl) throw new Error('Donna is not connected to a Google Calendar yet, so there is nothing to move.');
  const m = load('state').move;
  if (m && ['importing', 'imported', 'switched', 'cleaning'].includes(m.stage)) throw new Error('A move is already in progress; continue it below.');
  load('move').resources = [];
  save('move');
  setMove({ stage: 'setup', token: randomToken(), url: '', email: '', started: T.nowStr(), summary: null, needsOldUpdate: false });
  return await moveState();
}

export async function cancelMove() {
  const m = load('state').move || {};
  if (['switched', 'cleaning', 'done'].includes(m.stage)) throw new Error('The move already switched accounts; it can only be finished now.');
  setMove({ stage: 'idle' });
  return await moveState();
}

export async function connectMove(url) {
  const m = load('state').move || {};
  if (m.stage !== 'setup' && m.stage !== 'connected') throw new Error('Start the move first.');
  url = String(url || '').trim();
  // Development only: a local fake bridge (never set in production).
  const devUrl = typeof process !== 'undefined' && process.env && process.env.DONNA_DEV_BRIDGES && /^http:\/\/127\.0\.0\.1:\d+\//.test(url);
  if (!devUrl && !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) throw new Error('That does not look like a bridge URL. It should start with https://script.google.com/macros/s/ and end with /exec.');
  const n = await callBridgeAt(url, m.token, { action: 'ping' });
  if (Number(n.version || 2) < 4) throw new Error('The new bridge is an older version. Paste the code from the Copy button again and deploy a new version.');
  const o = await callBridgeAt(oldBridge().url, oldBridge().token, { action: 'ping' });
  if (!n.email || n.email === o.email) throw new Error(`The new bridge runs as ${n.email || 'an unknown account'}, the same as the current one. Deploy it while signed in to the account you want to move to.`);
  // How can the old calendar be read and tidied? Best: the new account already has edit access to it.
  const shared = (n.calendars || []).find(c => c.id.toLowerCase() === String(o.email).toLowerCase());
  const access = shared ? shared.access : '';
  const sourceVia = access === 'owner' || access === 'writer' || access === 'reader' ? 'new' : 'old';
  const cleanupVia = access === 'owner' || access === 'writer' ? 'new' : 'old';
  const needsOldUpdate = (sourceVia === 'old' || cleanupVia === 'old') && Number(o.version || 2) < 4;
  setMove({ stage: 'connected', url, email: n.email, oldEmail: o.email, access, sourceVia, cleanupVia, needsOldUpdate, timeZone: n.timeZone });
  return await moveState();
}

/** Re-checks the old bridge's version (after the user updated it). */
export async function recheckOld() {
  const m = load('state').move || {};
  const o = await callBridgeAt(oldBridge().url, oldBridge().token, { action: 'ping' });
  setMove({ needsOldUpdate: (m.sourceVia === 'old' || m.cleanupVia === 'old') && Number(o.version || 2) < 4 });
  return await moveState();
}

const sourceCall = (m, payload) => m.sourceVia === 'new' ? callBridgeAt(m.url, m.token, { ...payload, calendarId: m.oldEmail }) : callBridgeAt(oldBridge().url, oldBridge().token, { ...payload, calendarId: 'primary' });

export async function exportMove() {
  await loadLazy('move');
  const m = load('state').move || {};
  if (m.stage !== 'connected' && m.stage !== 'exported') throw new Error('Connect the new bridge first.');
  if (m.needsOldUpdate) throw new Error('Update the old bridge first (see the steps above).');
  const cutoff = T.addDays(T.today(), -COPY_DAYS_BACK) + 'T00:00';
  const r = await sourceCall(m, { action: 'export', from: cutoff, to: T.addDays(T.today(), HORIZON_DAYS) + 'T00:00' });
  const { resources, summary, skippedInvites } = buildResources(r.items || [], cutoff);
  const data = load('move');
  data.backup = { at: T.nowStr(), from: m.oldEmail, cutoff, items: r.items || [] };
  data.resources = resources;
  save('move');
  setMove({ stage: 'exported', cutoff, summary, skippedInvites });
  return await moveState();
}

// ─── Turning exported Google events into new-account resources ───
const utcBasic = iso => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const startKey = t => t ? (t.dateTime ? new Date(t.dateTime).toISOString() : t.date) : '';
const cutoffIso = cutoff => new Date(cutoff.replace(' ', 'T') + ':00' + offsetOf(cutoff)).toISOString();
/** UTC offset of the user's zone at wall time `s`, as "+05:30". */
function offsetOf(s) {
  const wall = T.parse(s).getTime();
  const guess = new Date(wall);
  const back = T.wall(guess).getTime();
  const mins = Math.round((back - wall) / 60000);
  const sign = mins >= 0 ? '+' : '-';
  const a = Math.abs(mins);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

export function buildResources(items, cutoff) {
  const cut = cutoffIso(cutoff);
  const cutDate = cutoff.slice(0, 10);
  const after = t => t && (t.dateTime ? new Date(t.dateTime).toISOString() >= cut : t.date >= cutDate);
  const masters = new Map(), exdates = new Map(), out = [];
  let skippedInvites = 0;
  for (const e of items) if (e.recurrence && e.status !== 'cancelled') masters.set(e.id, e);
  const note = e => {
    const lines = [];
    const guests = (e.attendees || []).filter(a => !a.self && !a.resource).map(a => a.email);
    if (guests.length) lines.push('Guests: ' + guests.join(', '));
    if (e.hangoutLink) lines.push('Meet: ' + e.hangoutLink);
    if (e.organizer && !e.organizer.self && e.organizer.email) lines.push(`Invitation from ${e.organizer.email}`);
    return [e.description || '', lines.join('\n')].filter(Boolean).join('\n\n');
  };
  const base = e => {
    const r = { summary: e.summary || '(no title)', description: note(e), location: e.location || '' };
    for (const k of ['colorId', 'reminders', 'transparency', 'visibility', 'extendedProperties']) if (e[k]) r[k] = e[k];
    return r;
  };
  const invite = e => !!(e.organizer && !e.organizer.self);
  for (const e of items) {
    if (e.recurringEventId) {
      // An exception to a series: cancelled → excluded date; changed → its own event, excluded from the series.
      if (!after(e.originalStartTime) && !after(e.start)) continue;
      const list = exdates.get(e.recurringEventId) || [];
      list.push(e.originalStartTime);
      exdates.set(e.recurringEventId, list);
      if (e.status === 'cancelled' || !after(e.start)) continue;
      out.push({ key: 'ex:' + e.id, sourceId: e.id, title: e.summary || '', kind: 'exception', cleanup: !invite(e), resource: { ...base(e), start: e.start, end: e.end } });
      continue;
    }
    if (e.status === 'cancelled') continue;
    if (e.recurrence) {
      if (!e.firstStart) continue;
      out.push({ key: 'ser:' + e.id, sourceId: e.id, title: e.summary || '', kind: 'series', cleanup: !invite(e), resource: { ...base(e), start: e.firstStart, end: e.firstEnd || e.end, recurrence: e.recurrence.slice() }, remaining: e.remaining });
      continue;
    }
    if (!after(e.end) && !after(e.start)) continue;
    out.push({ key: 'one:' + e.id, sourceId: e.id, title: e.summary || '', kind: 'single', cleanup: !invite(e), resource: { ...base(e), start: e.start, end: e.end } });
  }
  for (const r of out) {
    if (r.kind !== 'series') continue;
    let rec = r.resource.recurrence;
    if (r.remaining) rec = rec.map(x => /^RRULE:/.test(x) ? x.replace(/COUNT=\d+/, 'COUNT=' + r.remaining) : x);
    const ex = (exdates.get(r.sourceId) || []).filter(Boolean);
    if (ex.length) {
      const timed = ex.filter(t => t.dateTime).map(t => utcBasic(t.dateTime));
      const days = ex.filter(t => t.date).map(t => t.date.replace(/-/g, ''));
      if (timed.length) rec.push('EXDATE:' + timed.join(','));
      if (days.length) rec.push('EXDATE;VALUE=DATE:' + days.join(','));
    }
    r.resource.recurrence = rec;
    delete r.remaining;
  }
  skippedInvites = out.filter(r => !r.cleanup).length;
  const summary = { series: out.filter(r => r.kind === 'series').length, singles: out.filter(r => r.kind === 'single').length, exceptions: out.filter(r => r.kind === 'exception').length };
  // Keep the order stable and series first: they matter most.
  out.sort((a, b) => (a.kind === 'series' ? 0 : 1) - (b.kind === 'series' ? 0 : 1) || startKey(a.resource.start).localeCompare(startKey(b.resource.start)));
  return { resources: out, summary, skippedInvites };
}

export async function importMove() {
  await loadLazy('move');
  const m = load('state').move || {};
  if (!['exported', 'importing'].includes(m.stage)) throw new Error('Export first.');
  const data = load('move');
  const todo = data.resources.filter(r => !r.newId && (r.tries || 0) < 3).slice(0, IMPORT_CHUNK);
  if (todo.length) {
    const res = await callBridgeAt(m.url, m.token, { action: 'importRaw', items: todo.map(r => ({ key: r.key, resource: r.resource })) }, 300000);
    for (const x of res.results || []) {
      const r = data.resources.find(y => y.key === x.key);
      if (!r) continue;
      r.tries = (r.tries || 0) + 1;
      if (x.id) { r.newId = x.id; delete r.error; } else r.error = x.error || 'unknown error';
    }
    save('move');
  }
  const left = data.resources.filter(r => !r.newId && (r.tries || 0) < 3).length;
  setMove({ stage: left ? 'importing' : 'imported' });
  return await moveState();
}

/** From now on Donna works on the new account (and ignores the old calendar so nothing shows twice). */
export async function switchMove() {
  await loadLazy('move');
  const m = load('state').move || {};
  if (m.stage !== 'imported') throw new Error('Finish copying first.');
  const s = settings();
  const ignore = [...new Set([...(s.ignoreCalendars || []), m.oldEmail].filter(Boolean))];
  setMove({ stage: 'switched', previous: { url: s.bridgeUrl, token: s.bridgeToken, email: m.oldEmail } });
  saveSettings({ bridgeUrl: m.url, bridgeToken: m.token, ignoreCalendars: ignore, calendarMode: 'google' });
  load('settings').userEmail = m.email; save('settings');
  // Tasks and bookings point at copied single events: follow them to their new ids.
  const map = {};
  for (const r of load('move').resources) if (r.newId && r.kind === 'single') { map[r.sourceId] = r.newId; map[r.sourceId + '@google.com'] = r.newId; }
  for (const name of ['tasks', 'bookings']) {
    const col = load(name);
    let text = JSON.stringify(col.items);
    for (const [a, b] of Object.entries(map)) text = text.split(JSON.stringify(a)).join(JSON.stringify(b));
    col.items = JSON.parse(text);
    save(name);
  }
  invalidateCache(); resetSync();
  return await moveState();
}

/** Removes from the old calendar exactly what was copied (series end at the cutoff; copied singles deleted). */
export async function cleanupMove() {
  await loadLazy('move');
  const m = load('state').move || {};
  if (!['switched', 'cleaning'].includes(m.stage)) throw new Error('Switch to the new account first.');
  if (m.needsOldUpdate) throw new Error('Update the old bridge first (see the steps above).');
  const data = load('move');
  const todo = data.resources.filter(r => r.newId && r.cleanup && !r.cleaned && (r.cleanTries || 0) < 3).slice(0, CLEANUP_CHUNK);
  const via = m.cleanupVia === 'new' ? { url: m.url, token: m.token, cal: m.oldEmail } : { url: m.previous.url, token: m.previous.token, cal: 'primary' };
  const series = todo.filter(r => r.kind === 'series');
  const others = todo.filter(r => r.kind !== 'series');
  if (series.length) {
    const res = await callBridgeAt(via.url, via.token, { action: 'truncate', calendarId: via.cal, items: series.map(r => ({ id: r.sourceId, until: m.cutoff })) }, 300000);
    for (const x of res.results || []) { const r = series.find(y => y.sourceId === x.id); if (!r) continue; r.cleanTries = (r.cleanTries || 0) + 1; if (x.error) r.cleanError = x.error; else r.cleaned = true; }
  }
  if (others.length) {
    const prefix = via.cal === 'primary' ? '' : via.cal + '|';
    const res = await callBridgeAt(via.url, via.token, { action: 'batch', ops: others.map(r => ({ op: 'delete', id: prefix + r.sourceId, quiet: true })) }, 300000);
    for (const x of res.results || []) {
      const r = others.find(y => prefix + y.sourceId === x.id);
      if (!r) continue;
      r.cleanTries = (r.cleanTries || 0) + 1;
      if (x.error && !/not found|deleted|does not exist/i.test(x.error)) r.cleanError = x.error; else r.cleaned = true;
    }
  }
  save('move');
  const left = data.resources.filter(r => r.newId && r.cleanup && !r.cleaned && (r.cleanTries || 0) < 3).length;
  setMove({ stage: left ? 'cleaning' : 'done', finished: left ? undefined : T.nowStr() });
  return await moveState();
}
