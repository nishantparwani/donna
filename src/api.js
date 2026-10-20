// Platform-neutral API used by both the laptop server (server.js) and Cloudflare (worker.js).
import * as T from './time.js';
import * as cal from './calendar.js';
import { load, save, settings, saveSettings, hydrate, flush, reload, SECRETS } from './store.js';
import { describe, noteUserEdit, beginRun, findAction, TOOLS, isAgentBlock, RUN } from './engine.js';
import { plan, taskView, findConflicts } from './planner.js';
import { chat, autoRun, chatHistory, appendToLastReply, saveChat } from './agent.js';
import { applyFeedback, learnProfile } from './learning.js';
import { importIcs, loadDemo } from './ics.js';
import { googleMode, hasV3, pull, push, ping, ensureRange, invalidateCache, emailMe, bridgeVersion, refreshSaved, syncInfo } from './sync.js';
import { providerStatus, configured } from './llm.js';
import { briefing, insights, category } from './briefing.js';
import { radar, morningTime } from './radar.js';
import { goalsView } from './goals.js';
import { BRIDGE_CODE, BRIDGE_MANIFEST } from './bridge-code.js';
import { migrate } from './migrate.js';
import { moveState, startMove, cancelMove, connectMove, recheckOld, exportMove, importMove, switchMove, cleanupMove } from './move.js';
import { vapid, subscribe, unsubscribe, notify } from './push.js';
import { checkPassword } from './auth.js';
import { clean } from './agent.js';
import { bookingEnabled, publicInfo, publicSlots, book, cancelBooking, bookingByToken } from './booking.js';

// One job at a time: chat, edits and background checks never interleave.
let chain = Promise.resolve();
function exclusive(fn) { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; }

/**
 * Runs fn with fresh data: load store → (Google) read the needed days → fn → (Google) write changes → save.
 * @param {Function} fn
 * @param {{days?: [number, number] | null, stale?: boolean}} opts  days relative to today to read from Google (null = none);
 *   stale: a read-only view may use the saved copy however old it is (the app asks /api/sync right after)
 * @returns {Promise<{out: any, problems: string[]}>}
 */
export function session(fn, { days = [-1, 14], stale = false } = {}) {
  return exclusive(async () => {
    await hydrate();
    migrate();
    T.setTimeZone(settings().timeZone);
    const google = googleMode();
    if (google && days) await pull(T.addDays(T.today(), days[0]), T.addDays(T.today(), days[1]), { stale });
    else if (!google && cal.isRemote()) { cal.useLocal(); await reload('calendar'); }
    let out, err;
    try { out = await fn(); } catch (e) { err = e; }
    // Whatever happened, changes already made are sent to Google and saved.
    const problems = google ? await push() : [];
    await flush();
    if (err) throw err;
    return { out, problems };
  });
}
const NO_CALENDAR = { days: null };
const VIEW = days => ({ days, stale: true });
const syncView = () => { const x = syncInfo(); return googleMode() && x ? { at: new Date(x.at).toISOString(), ageSec: Math.round((Date.now() - x.at) / 1000) } : null; };

/** The day an evening open plans: tomorrow after 18:00; today before 04:00 (still "tonight" for a night owl). */
function autoPlanTarget() {
  const h = T.hourNow();
  return h >= 18 ? T.addDays(T.today(), 1) : h < 4 ? T.today() : null;
}
function autoPlanState() {
  const st = load('state');
  return { on: settings().autonomous, target: autoPlanTarget(), done: !!autoPlanTarget() && st.autoPlanned === autoPlanTarget(), at: st.autoPlannedAt || null };
}
/** What Donna decided on its own in the last 24 hours (newest first), for the Today screen. */
function decisions() {
  const since = T.addMin(T.nowStr(), -24 * 60);
  return load('actions').items.filter(a => a.source === 'auto' && a.time >= since && a.type !== 'revert').slice(-12).reverse()
    .map(a => ({ id: a.id, time: a.time, summary: a.summary, why: a.rationale, undone: a.status === 'reverted', kept: /^good/.test(a.feedback || '') }));
}

/**
 * Who put each event where it is, and why: 'auto' = Donna on its own, 'asked' = Donna because you asked,
 * 'you' = you (or Google). The newest create/move of an event wins.
 */
function origins() {
  const map = new Map();
  for (const a of load('actions').items) {
    if (!a.eventId || !['create', 'move'].includes(a.type)) continue;
    const id = (a.after && a.after.id) || a.eventId;
    map.set(id, { origin: a.source === 'auto' ? 'auto' : 'asked', why: a.rationale || '', actionId: a.id, kept: /^good/.test(a.feedback || ''), undone: a.status === 'reverted' });
  }
  return map;
}
/** The trust ledger: what Donna did on its own this week and what you made of it. */
function ledger() {
  const since = T.addDays(T.today(), -7) + 'T00:00';
  const mine = load('actions').items.filter(a => a.source === 'auto' && a.time >= since && a.type !== 'revert');
  return { changes: mine.length, undone: mine.filter(a => a.status === 'reverted').length, kept: mine.filter(a => /^good/.test(a.feedback || '')).length };
}

function stateView(from, n, pub) {
  const by = origins();
  const events = cal.list(from + 'T00:00', T.addDays(from, n) + 'T00:00').map(e => {
    const o = by.get(e.id);
    return { ...eventView(e), origin: o && !o.undone ? o.origin : 'you', why: o ? o.why : '', actionId: o ? o.actionId : '', kept: o ? o.kept : false };
  });
  const st = load('state');
  return { from, days: n, weekStart: T.weekStart(from), today: T.today(), now: T.nowStr(), events, settings: pub(),
    tasks: load('tasks').items.filter(t => t.status === 'open').map(taskView), habits: load('habits').items,
    issues: liveIssues(), lastAutoRun: st.lastAutoRun || null, sync: syncView() };
}

/** What needs attention now, computed from the calendar as it is (never a leftover from an old run). */
function liveIssues() {
  const out = [];
  for (let i = 0; i < 7; i++) out.push(...findConflicts(T.addDays(T.today(), i)));
  for (const t of load('tasks').items.filter(t => t.status === 'open' && t.atRisk)) {
    out.push(`"${t.title}" may not fit before it is due (${T.human(t.due.length === 10 ? t.due + 'T23:59' : t.due)}).`);
  }
  return [...new Set(out.map(i => i.replace(/\bE\d+ /g, '').replace(/^Conflict on (\d{4}-\d{2}-\d{2}): /, (_, d) => `${T.DAY_NAMES[T.dow(d)]} ${Number(d.slice(8))}: `)))];
}

/** Text that reads well aloud: no emoji, markdown or arrows. */
const speakable = s => String(s || '')
  .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
  .replace(/[*_`#]/g, '').replace(/→/g, ' to ').replace(/–/g, ' to ').replace(/\s+\n/g, '\n').trim();

function publicSettings(extra = {}) {
  const s = settings();
  const masked = Object.fromEntries(SECRETS.map(k => [k, s[k] ? '••••' + String(s[k]).slice(-4) : '']));
  return { ...s, ...masked, timeZone: T.tzName(), google: googleMode(), bridgeVersion: googleMode() ? bridgeVersion() : null,
    ai: providerStatus(), aiReady: configured().length > 0, ...extra };
}

function activity() {
  return load('actions').items.slice(-400).reverse().map(a => ({
    id: a.id, time: a.time, type: a.type, title: a.title, summary: a.summary, rationale: a.rationale,
    status: a.status, feedback: a.feedback, source: a.source, auto: !!a.auto,
  }));
}

const syncNote = problems => problems.length ? `⚠️ Google Calendar didn't accept ${problems.length} change(s): ${problems.slice(0, 5).join('; ')}` : '';
const relDays = d => Math.round(T.diffMin(T.today() + 'T00:00', T.day(d) + 'T00:00') / 1440);
const eventView = e => ({ ...e, view: { ...describe(e), id: e.id }, category: category(e) });

/** Background check (cron / timer): plan, briefings, weekly learning. */
export async function scheduledRun() {
  await hydrate();
  const s = settings();
  T.setTimeZone(s.timeZone);
  const out = {};
  const ahead = Math.max(s.planDaysAhead + 1, 8);
  // Keep the saved copy of Google fresh, so opening the app never waits on Google.
  if (googleMode()) {
    try { out.sync = (await session(() => refreshSaved(), NO_CALENDAR)).out; } catch (e) { console.error('Calendar refresh failed:', e.message); }
  }
  if (s.autonomous) {
    const { out: r, problems } = await session(async () => {
      const res = await autoRun();
      const mine = res && res.actions.filter(a => !a.auto || /^(Moved|Cancelled)/.test(a.summary));
      if (mine && mine.length && settings().notify.changes) await notify({ title: `${settings().agentName} changed your plan`, body: clean(res.text) || mine.slice(0, 3).map(a => a.summary).join('\n'), url: '/#activity', tag: 'auto' });
      return res;
    }, { days: [0, ahead] });
    out.auto = r;
    if (problems.length) await session(() => appendToLastReply(syncNote(problems)), NO_CALENDAR);
  }
  const st = load('state');
  const nowHM = T.clock(T.nowStr());
  for (const kind of ['morning', 'evening']) {
    // The morning one goes out earlier on days that start early (45 min before the first commitment).
    const at = kind === 'morning' ? morningTime() : s.eveningReview;
    const key = kind === 'morning' ? 'lastMorning' : 'lastEvening';
    if (!at || st[key] === T.today() || nowHM < at || T.hm(nowHM) - T.hm(at) > 180) continue;
    await session(async () => {
      const b = briefing(kind);
      saveChat('assistant', b.text, [], { briefing: kind });
      load('state')[key] = T.today(); save('state');
      if (s.notify.briefings) await notify({ title: b.title, body: b.text.split('\n').filter(Boolean).slice(0, 4).join('\n'), url: '/#today', tag: 'briefing' });
      if (s.emailBriefing) { try { await emailMe(b.title, b.html); } catch (e) { appendToLastReply('⚠️ Could not email the briefing: ' + e.message); } }
    }, { days: [0, 2] });
    out[kind] = true;
  }
  if (T.dow(T.today()) === 0 && load('state').lastLearn !== T.today()) {
    await session(() => { learnProfile(); load('state').lastLearn = T.today(); save('state'); }, { days: [-60, 0] });
  }
  return out;
}

const PUBLIC_ROUTES = new Set(['GET /api/public/booking', 'GET /api/public/slots', 'POST /api/public/book', 'GET /api/public/cancel', 'POST /api/public/cancel', 'POST /api/siri', 'GET /api/siri']);
export const isPublicRoute = (method, pathname) => PUBLIC_ROUTES.has(`${method} ${pathname}`);

/**
 * @returns {Promise<{status: number, body: any}>}
 */
export async function handle(method, pathname, query, readBody, ctx = {}) {
  const json = async () => { const b = await readBody(); return b ? JSON.parse(b) : {}; };
  const ok = body => ({ status: 200, body });
  const bad = (msg, status = 400) => ({ status, body: { error: msg } });
  const pub = () => publicSettings({ authEnabled: !!ctx.authEnabled });

  switch (`${method} ${pathname}`) {
    // ─── App ───
    case 'GET /api/state': {
      const view = query.get('view') === 'day' ? 'day' : 'week';
      const anchor = query.get('date') || query.get('week') || T.today();
      const from = view === 'day' ? T.day(anchor) : T.weekStart(anchor);
      const n = view === 'day' ? 1 : 7;
      const off = relDays(from);
      const { out } = await session(() => stateView(from, n, pub), VIEW([Math.min(off, 0), Math.max(off + n, 7)]));
      return ok(out);
    }
    case 'GET /api/home': {
      // Everything the Today screen needs in one request (one database read, one calendar load).
      const { out } = await session(() => {
        const st = stateView(T.today(), 1, pub);
        const tm = stateView(T.addDays(T.today(), 1), 1, pub);
        return { st, tm: { events: tm.events }, rd: { ...radar(21), goals: goalsView(), today: T.today() }, decisions: decisions(), autoPlan: autoPlanState(), ledger: ledger() };
      }, VIEW([-6, 22]));
      return ok(out);
    }
    case 'POST /api/autoplan': {
      // Opening the app in the evening (after 18:00, or before 04:00 for a night owl): get the next day ready on its own, once.
      const target = autoPlanTarget();
      const pre = (await session(() => ({ on: settings().autonomous, done: load('state').autoPlanned === target }), NO_CALENDAR)).out;
      if (!target || !pre.on || pre.done) return ok({ skipped: !target ? 'not evening' : !pre.on ? 'autonomy off' : 'already planned', target, decisions: (await session(() => decisions(), NO_CALENDAR)).out });
      const { out, problems } = await session(async () => {
        const r = await autoRun({ force: true, label: `Got ${T.day(target) === T.today() ? 'today' : 'tomorrow'} (${T.DAY_NAMES[T.dow(target)]}) ready` });
        const st = load('state');
        st.autoPlanned = target; st.autoPlannedAt = T.nowStr(); save('state');
        return { target, changes: r ? r.actions.length : 0, text: r ? clean(r.text) : '', decisions: decisions() };
      }, { days: [0, Math.max(settings().planDaysAhead + 1, 8)] });
      if (problems.length) out.text = (out.text ? out.text + '\n' : '') + syncNote(problems);
      return ok(out);
    }
    case 'GET /api/today': {
      const { out } = await session(() => ({ briefing: briefing('morning'), tomorrow: briefing('evening'), now: T.nowStr() }), VIEW([0, 3]));
      return ok(out);
    }
    case 'POST /api/sync': {
      // Compare the saved copy with Google (one bridge call). The app redraws only if something changed.
      const { out } = await session(() => refreshSaved(), NO_CALENDAR);
      return ok({ changed: out.changed, sync: { at: new Date(out.at).toISOString(), ageSec: 0 } });
    }
    case 'GET /api/chat': return ok((await session(() => chatHistory(), NO_CALENDAR)).out);
    case 'POST /api/chat': {
      const { message } = await json();
      const { out, problems } = await session(() => chat(message), { days: [-1, 8] });
      if (problems.length) {
        await session(() => appendToLastReply(syncNote(problems)), NO_CALENDAR);
        out.reply += '\n\n' + syncNote(problems);
      }
      return ok(out);
    }
    case 'POST /api/chat/clear': {
      await session(() => { load('chat').messages = []; save('chat'); }, NO_CALENDAR);
      return ok({ ok: true });
    }
    case 'GET /api/activity': return ok((await session(() => activity(), NO_CALENDAR)).out);
    case 'POST /api/feedback': {
      const { id, verdict, reason } = await json();
      const { out, problems } = await session(async () => {
        beginRun('chat');
        const a = findAction(id);
        const snap = a && (a.before || a.after);
        if (snap && snap.start) await ensureRange(T.day(snap.start) < T.today() ? T.day(snap.start) : T.today(), T.day((a.after || a.before).start));
        const text = await applyFeedback(String(id).toUpperCase(), String(verdict).toLowerCase(), reason || '');
        if (RUN.planNeeded && settings().autonomous) await plan();
        saveChat('user', `${id}: ${verdict}${reason ? ' - ' + reason : ''}`, []);
        saveChat('assistant', text, RUN.actions.slice());
        return text;
      }, { days: [0, 7] });
      return ok({ text: out + (problems.length ? '\n' + syncNote(problems) : '') });
    }
    case 'GET /api/settings': return ok((await session(() => pub(), NO_CALENDAR)).out);
    case 'POST /api/settings': {
      const patch = await json();
      const { out } = await session(() => { saveSettings(patch); T.setTimeZone(settings().timeZone); invalidateCache(); return pub(); }, NO_CALENDAR);
      return ok(out);
    }
    case 'POST /api/ai/reset': {
      await session(() => { load('state').aiBlocked = {}; save('state'); }, NO_CALENDAR);
      return ok({ ok: true });
    }
    case 'POST /api/bridge/test': {
      const patch = await json();
      const { out } = await session(async () => {
        if (patch && Object.keys(patch).length) saveSettings(patch);
        const started = Date.now();
        const r = await ping();
        saveSettings({ timeZone: r.timeZone });
        T.setTimeZone(r.timeZone);
        invalidateCache();
        return { ...r, ms: Date.now() - started };
      }, NO_CALENDAR);
      return ok(out);
    }
    case 'GET /api/bridge/code': {
      const { out } = await session(() => {
        const token = settings().bridgeToken;
        if (!token) throw new Error('Set a bridge token first (any long random text), save, then copy the code.');
        return { code: BRIDGE_CODE.replace('__TOKEN__', token.replace(/[^A-Za-z0-9_-]/g, '')), manifest: BRIDGE_MANIFEST };
      }, NO_CALENDAR);
      return ok(out);
    }
    case 'POST /api/briefing/send': {
      const { kind } = await json();
      const { out } = await session(async () => {
        const b = briefing(kind === 'evening' ? 'evening' : 'morning');
        const r = await emailMe(b.title, b.html);
        return { ...r, preview: b.text };
      }, { days: [0, 2] });
      return ok(out);
    }
    case 'GET /api/insights': {
      const week = T.weekStart(query.get('week') || T.today());
      const off = relDays(week);
      return ok((await session(() => insights(week), VIEW([Math.min(off, 0), off + 7]))).out);
    }
    case 'GET /api/memory': return ok((await session(() => ({ ...load('memory'), people: load('people').items }), NO_CALENDAR)).out);
    case 'POST /api/rules': {
      const { id, text, active, remove } = await json();
      const { out } = await session(() => {
        const m = load('memory');
        if (id) {
          const r = m.rules.find(x => x.id === id);
          if (r && remove) m.rules = m.rules.filter(x => x.id !== id);
          else if (r && active !== undefined) r.active = !!active;
          else if (r && text) r.text = String(text).trim();
        } else if (text && text.trim()) {
          m.rules.push({ id: 'r' + (++m.seq), text: text.trim(), source: 'you', active: true, time: T.nowStr() });
        }
        save('memory');
        return { ...m, people: load('people').items };
      }, NO_CALENDAR);
      return ok(out);
    }
    case 'POST /api/people': {
      const { id, name, email, note, remove } = await json();
      const { out } = await session(async () => {
        const p = load('people');
        if (remove) { p.items = p.items.filter(x => x.id !== id); save('people'); }
        else await TOOLS.remember_person({ name, email, note });
        return { ...load('memory'), people: load('people').items };
      }, NO_CALENDAR);
      return ok(out);
    }
    case 'POST /api/relearn': return ok((await session(() => { learnProfile(); return { ...load('memory'), people: load('people').items }; }, { days: [-60, 0] })).out);
    case 'POST /api/run': {
      const { out, problems } = await session(() => autoRun({ force: true }), { days: [0, Math.max(settings().planDaysAhead + 1, 8)] });
      if (out && problems.length) out.text = (out.text || '') + '\n' + syncNote(problems);
      return ok(out);
    }

    // ─── Tasks & habits (UI) ───
    case 'GET /api/tasks': return ok((await session(() => load('tasks').items.map(taskView), NO_CALENDAR)).out);
    case 'POST /api/tasks': {
      const a = await json();
      const { out, problems } = await session(async () => {
        beginRun('chat', '');
        const r = a.id ? await TOOLS.update_task({ task_id: a.id, ...a }) : await TOOLS.add_task(a);
        return { ...r, tasks: load('tasks').items.map(taskView) };
      }, { days: [0, 15] });
      return ok({ ...out, problems });
    }
    case 'GET /api/radar': {
      const { out } = await session(() => ({ ...radar(21), goals: goalsView(), today: T.today() }), VIEW([-6, 22]));
      return ok(out);
    }
    case 'POST /api/goals': {
      const a = await json();
      const { out, problems } = await session(async () => {
        beginRun('chat', '');
        const r = a.remove ? await TOOLS.remove_goal({ goal_id: a.id }) : await TOOLS.set_goal({ title: a.title, hours_per_week: a.hours, counts: a.counts });
        return { ...r, goals: goalsView() };
      }, { days: [-6, 8] });
      return ok({ ...out, problems });
    }
    case 'GET /api/habits': return ok((await session(() => load('habits').items, NO_CALENDAR)).out);
    case 'POST /api/habits': {
      const a = await json();
      const { out, problems } = await session(async () => {
        beginRun('chat', '');
        let r;
        if (a.remove) r = await TOOLS.remove_habit({ habit_id: a.id });
        else if (a.id) {
          const h = load('habits').items.find(x => x.id === a.id);
          if (!h) throw new Error('No such habit');
          for (const k of ['title', 'minutes', 'days', 'windowStart', 'windowEnd', 'idealTime', 'kind', 'active']) if (a[k] !== undefined) h[k] = k === 'minutes' ? Number(a[k]) : a[k];
          save('habits');
          // Re-place this habit's future blocks with the new settings.
          for (const e of cal.all().filter(e => e.habitId === h.id && e.start > T.nowStr())) cal.remove(e.id);
          await plan();
          r = { ok: true, habit: h };
        } else r = await TOOLS.add_habit({ title: a.title, minutes: a.minutes, days: a.days, window_start: a.windowStart, window_end: a.windowEnd, ideal_time: a.idealTime, kind: a.kind });
        return { ...r, habits: load('habits').items };
      }, { days: [0, 8] });
      return ok({ ...out, problems });
    }

    // ─── Manual calendar edits (the user is in charge: no guardrails, but agent blocks learn from it) ───
    case 'POST /api/events': {
      const e = await json();
      if (!(e.end > e.start)) return bad('End must be after start.');
      const d = relDays(e.start);
      const { out, problems } = await session(() => cal.create({ title: e.title || 'Untitled', start: e.start, end: e.end, kind: e.kind || 'meeting',
        guests: e.guests || [], description: e.description || '', location: e.location || '', meet: !!e.meet,
        flexible: !!e.flexible, highStakes: !!e.highStakes, protected: !!e.protected, organizer: e.organizer !== false }), { days: [d, d] });
      return ok({ event: out, problems });
    }
    case 'POST /api/events/update': {
      const { id, origStart, scope, ...patch } = await json();
      const d = relDays(origStart || patch.start);
      const d2 = relDays(patch.start || origStart);
      const { out, problems } = await session(() => {
        const before = cal.get(id);
        if (!before) return null;
        if (before.readOnly) throw new Error(`"${before.title}" is on another calendar; change it there.`);
        const allowed = ['title', 'start', 'end', 'kind', 'guests', 'description', 'location', 'flexible', 'highStakes', 'protected', 'organizer', 'meet', 'reminder'];
        const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
        const after = cal.update(id, clean, { scope: scope === 'series' && hasV3() ? 'series' : 'this' });
        noteUserEdit(before, after);
        return after;
      }, { days: [Math.min(d, d2), Math.max(d, d2)] });
      return out ? ok({ event: out, problems }) : { status: 404, body: { error: 'No such event' } };
    }
    case 'POST /api/events/delete': {
      const { id, origStart, scope } = await json();
      const d = origStart ? relDays(origStart) : 0;
      const { problems } = await session(() => {
        const before = cal.get(id);
        if (!before) return;
        if (before.readOnly) throw new Error(`"${before.title}" is on another calendar; change it there.`);
        cal.remove(id, { scope: scope === 'series' && hasV3() ? 'series' : 'this' });
        noteUserEdit(before, null);
      }, { days: [d, d] });
      return ok({ ok: true, problems });
    }
    case 'POST /api/import': {
      const replace = query.get('replace') === '1';
      const text = await readBody();
      const { out } = await session(() => {
        if (googleMode()) throw new Error('You are connected to Google Calendar, so import is not needed: the agent reads Google directly.');
        const n = importIcs(text, { replace });
        learnProfile();
        return { imported: n };
      });
      return ok(out);
    }
    case 'POST /api/demo': {
      const { out } = await session(async () => {
        if (googleMode()) throw new Error('Switch the calendar to "Practice calendar" in Settings to load the demo.');
        const n = loadDemo();
        learnProfile();
        beginRun('auto');
        await plan();
        return { events: n };
      });
      return ok(out);
    }

    // ─── Move to another Google account ───
    case 'GET /api/move': return ok((await session(() => moveState(), NO_CALENDAR)).out);
    case 'POST /api/move/start': return ok((await session(() => startMove(), NO_CALENDAR)).out);
    case 'POST /api/move/cancel': return ok((await session(() => cancelMove(), NO_CALENDAR)).out);
    case 'GET /api/move/code': {
      const { out } = await session(() => {
        const m = load('state').move || {};
        if (!m.token) throw new Error('Start the move first.');
        return { code: BRIDGE_CODE.replace('__TOKEN__', m.token), manifest: BRIDGE_MANIFEST };
      }, NO_CALENDAR);
      return ok(out);
    }
    case 'POST /api/move/connect': { const { url } = await json(); return ok((await session(() => connectMove(url), NO_CALENDAR)).out); }
    case 'POST /api/move/recheck': return ok((await session(() => recheckOld(), NO_CALENDAR)).out);
    case 'POST /api/move/export': return ok((await session(() => exportMove(), NO_CALENDAR)).out);
    case 'POST /api/move/import': return ok((await session(() => importMove(), NO_CALENDAR)).out);
    case 'POST /api/move/switch': return ok((await session(() => switchMove(), NO_CALENDAR)).out);
    case 'POST /api/move/cleanup': return ok((await session(() => cleanupMove(), NO_CALENDAR)).out);

    // ─── Notifications & Siri ───
    case 'GET /api/push/key': return ok((await session(async () => ({ publicKey: (await vapid()).publicKey, devices: (load('push').subscriptions || []).map(s => s.device) }), NO_CALENDAR)).out);
    case 'POST /api/push/subscribe': {
      const { subscription, device } = await json();
      return ok((await session(() => ({ devices: subscribe(subscription, device) }), NO_CALENDAR)).out);
    }
    case 'POST /api/push/unsubscribe': { const { endpoint } = await json(); await session(() => unsubscribe(endpoint), NO_CALENDAR); return ok({ ok: true }); }
    case 'POST /api/push/test': {
      const { out } = await session(() => notify({ title: settings().agentName, body: 'Notifications are working. Briefings and changes will show up here.', url: '/#today', tag: 'test' }), NO_CALENDAR);
      return ok({ sent: out });
    }
    case 'POST /api/siri/key': {
      const { out } = await session(() => {
        const key = Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, '0')).join('');
        saveSettings({ siriKey: key });
        return { key };
      }, NO_CALENDAR);
      return ok(out);
    }
    case 'GET /api/siri':
    case 'POST /api/siri': {
      const key = (ctx.authorization || '').replace(/^Bearer\s+/i, '') || query.get('key') || '';
      const raw = method === 'POST' ? await readBody() : '';
      let message = query.get('q') || '';
      if (raw) { try { message = JSON.parse(raw).message || message; } catch { message = raw; } }
      const plain = query.get('format') !== 'json';
      // Check the key before touching Google: a wrong key must not cost a calendar read.
      const refused = (await session(() => {
        const s = settings();
        if (!s.siriKey || !checkPassword(key, s.siriKey)) return { status: 401, reply: "That Siri key is wrong. Copy the link again from the app's settings." };
        if (!String(message).trim()) return { status: 400, reply: "I didn't catch that. Try again?" };
        return null;
      }, NO_CALENDAR)).out;
      const { out } = refused ? { out: refused } : await session(async () => {
        const r = await chat(String(message));
        return { status: 200, reply: r.reply, actions: r.actions.filter(a => !a.auto).map(a => a.summary) };
      }, { days: [-1, 8] });
      const speak = speakable(out.reply);
      return plain ? { status: out.status, text: speak || 'Done.' } : { status: out.status, body: { reply: speak, actions: out.actions || [] } };
    }

    // ─── Public booking page (no login) ───
    case 'GET /api/public/booking': {
      const slug = query.get('slug') || '';
      const { out } = await session(() => bookingEnabled(slug) ? publicInfo() : null, NO_CALENDAR);
      return out ? ok(out) : bad('This booking page does not exist.', 404);
    }
    case 'GET /api/public/slots': {
      const slug = query.get('slug') || '';
      // Settings come from the database, so check them in a session before reading the calendar.
      const ahead = (await session(() => bookingEnabled(slug) ? settings().booking.daysAhead : null, NO_CALENDAR)).out;
      if (ahead === null) return bad('This booking page does not exist.', 404);
      const { out } = await session(async () => {
        await ensureRange(T.today(), T.addDays(T.today(), settings().booking.daysAhead + 1));
        return publicSlots(query.get('duration'));
      }, { days: [0, Math.min(60, ahead + 1)] });
      return ok(out);
    }
    case 'POST /api/public/book': {
      const a = await json();
      const ahead = (await session(() => bookingEnabled(a.slug) ? settings().booking.daysAhead : null, NO_CALENDAR)).out;
      if (ahead === null) return bad('This booking page does not exist.', 404);
      const { out, problems } = await session(async () => {
        await ensureRange(T.today(), T.addDays(T.today(), settings().booking.daysAhead + 1));
        const r = book(a);
        if (settings().autonomous) await plan();
        saveChat('assistant', `📅 New booking: ${a.name} booked ${T.span(r.start, r.end)} through your booking page.`, r.actions);
        if (settings().notify.bookings) await notify({ title: 'New booking', body: `${a.name} booked ${T.span(r.start, r.end)}`, url: '/#calendar', tag: 'booking' });
        return r;
      }, { days: [0, Math.min(60, ahead + 1)] });
      if (problems.length) return bad('Booking failed on the calendar side. Please try another time.', 502);
      const link = (await session(() => bookingByToken(out.token), { days: [relDays(out.start), relDays(out.start)] })).out;
      return ok({ ok: true, start: out.start, end: out.end, title: out.title, token: out.token, meetLink: link && link.meetLink || '' });
    }
    case 'GET /api/public/cancel': {
      const t = query.get('token');
      const { out } = await session(() => bookingByToken(t), NO_CALENDAR);
      return out ? ok(out) : bad('Booking not found.', 404);
    }
    case 'POST /api/public/cancel': {
      const { token } = await json();
      const b = (await session(() => bookingByToken(token), NO_CALENDAR)).out;
      if (!b) return bad('Booking not found.', 404);
      const { out } = await session(() => {
        const r = cancelBooking(token);
        saveChat('assistant', `📅 ${b.name} cancelled their booking on ${T.span(b.start, b.end)}.`, RUN.actions.slice());
        return r;
      }, { days: [relDays(b.start), relDays(b.start)] });
      return ok(out);
    }
    default:
      return { status: 404, body: { error: 'Not found' } };
  }
}
