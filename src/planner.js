// Planner (no AI): buffers around high-stakes events, habits placed in their best window each day,
// task work sessions booked before their due date, conflict detection. Runs after every change
// and every 15 minutes, and repairs whatever the day threw at the plan.
import * as T from './time.js';
import * as cal from './calendar.js';
import { load, save, settings } from './store.js';
import { RUN, TOOLS, isTimed, isAgentBlock, isHighStakes, isProtected, isPing, logAction, markWrite, ref } from './engine.js';
import { ensureRange } from './sync.js';
import { syncGoals } from './goals.js';
import { demandOf, scoreSlot, freeAround, reasonFor } from './smart.js';

const TASK_HORIZON_DAYS = 14;
const MIN_SESSION = 30;
const PRIORITY = { high: 0, normal: 1, low: 2 };

const dayEvents = d => cal.list(T.at(d, 0), T.addDays(d, 1) + 'T00:00').filter(isTimed);
const busy = (evs, slot, ignoreId) => evs.some(e => e.id !== ignoreId && T.overlaps(e, slot));

function rejected(pred) {
  return load('actions').items.filter(a => a.type === 'create' && ['removed_by_user', 'reverted'].includes(a.status) && a.after && pred(a.after));
}
function markCreate(eventId, status) {
  load('actions').items.filter(a => a.type === 'create' && a.eventId === eventId && a.status === 'active').forEach(a => { a.status = status; });
  save('actions');
}

/** The next n days (from today) on which something can be planned. */
export function upcomingDays(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(T.addDays(T.today(), i));
  return out;
}
export function upcomingWorkdays(n) {
  const s = settings();
  const out = [];
  for (let i = 0; out.length < n && i < 21; i++) { const d = T.addDays(T.today(), i); if (s.workDays.includes(T.dow(d))) out.push(d); }
  return out;
}

/**
 * Re-plans everything the agent owns. Returns issues that need judgement (for the AI or the briefing).
 * @returns {Promise<string[]>}
 */
export async function plan() {
  const s = settings();
  const issues = [];
  const tasks = load('tasks').items.filter(t => t.status === 'open');
  const lastDue = tasks.map(t => T.day(t.due)).sort().pop();
  const horizon = Math.max(s.planDaysAhead, lastDue ? Math.min(TASK_HORIZON_DAYS, T.diffMin(T.today() + 'T00:00', lastDue + 'T00:00') / 1440 + 1) : 0);
  const goals = load('goals').items.some(g => g.active !== false);
  await ensureRange(goals ? [T.weekStart(T.today()), T.today()].sort()[0] : T.today(), T.addDays(T.today(), Math.max(Math.ceil(horizon), goals ? 7 : 0)));
  if (goals) syncGoals();
  RUN.inPlanner = true;
  try {
    for (const d of upcomingDays(s.planDaysAhead)) {
      removeOrphanBuffers(d);
      issues.push(...ensureBuffers(d, s));
    }
    issues.push(...planHabits(s));
    issues.push(...planTasks(s));
    for (const d of upcomingDays(s.planDaysAhead)) issues.push(...findConflicts(d));
  } finally { RUN.inPlanner = false; }
  return issues;
}

// ─── Buffers ───
function removeOrphanBuffers(d) {
  for (const b of dayEvents(d).filter(e => e.agent && e.kind === 'buffer')) {
    const anchor = b.anchor && cal.get(b.anchor.id);
    const ok = anchor && isTimed(anchor) && isHighStakes(anchor) && (b.anchor.side === 'before' ? b.end === anchor.start : b.start === anchor.end);
    if (ok) continue;
    markWrite();
    cal.remove(b.id);
    markCreate(b.id, 'deleted');
    logAction('delete', b, null, 'Buffer no longer needed: its event moved or was removed');
  }
}

function ensureBuffers(d, s) {
  const issues = [];
  const buf = s.bufferMinutes;
  if (!buf) return issues;
  const evs = dayEvents(d);
  const real = evs.filter(e => !isAgentBlock(e) && !e.readOnly);
  const no = new Set(rejected(e => e.kind === 'buffer' && e.anchor).map(a => a.after.anchor.id + '|' + a.after.anchor.side));
  for (const x of real) {
    if (!isHighStakes(x, s)) continue;
    for (const side of ['before', 'after']) {
      const bs = side === 'before' ? T.addMin(x.start, -buf) : x.end;
      const slot = { start: bs, end: T.addMin(bs, buf) };
      if (slot.start < T.nowStr() || no.has(x.id + '|' + side)) continue;
      if (evs.some(e => e.agent && e.kind === 'buffer' && e.anchor && e.anchor.id === x.id && e.anchor.side === side)) continue;
      const blockers = evs.filter(e => e.id !== x.id && T.overlaps(e, slot));
      if (blockers.some(e => !isAgentBlock(e))) {
        issues.push(`No room for the ${buf}-min buffer ${side} high-stakes ${ref(x.id)} "${x.title}" (${T.clock(x.start)}–${T.clock(x.end)}) on ${d}.`);
        continue;
      }
      for (const b of blockers) { cal.remove(b.id); markCreate(b.id, 'yielded'); logAction('delete', b, null, `Made room for a buffer around "${x.title}"`); }
      markWrite();
      const ev = cal.create({ title: '⏸ Buffer', ...slot, kind: 'buffer', agent: true, anchor: { id: x.id, side },
        description: `${side === 'before' ? 'Before' : 'After'} "${x.title}". Auto-buffer; delete it and the agent won't re-add it.` });
      logAction('create', null, ev, `${buf}-min buffer ${side} high-stakes "${x.title}"`);
      evs.push(ev);
    }
  }
  return issues;
}

// ─── Free-time search shared by habits and tasks ───
/** Candidate starts on day d inside [lo, hi) minutes that clash with nothing (real or agent). */
function freeStarts(d, dur, lo, hi, ignoreId) {
  const evs = dayEvents(d);
  const out = [];
  let from = T.at(d, lo);
  const nowR = T.roundUp15(T.addMin(T.nowStr(), 5));
  if (d === T.today() && nowR > from) from = nowR;
  if (T.day(from) !== d) return out;
  for (let t = from; T.mins(t) + dur <= hi && T.day(t) === d; t = T.addMin(t, 15)) {
    if (!busy(evs, { start: t, end: T.addMin(t, dur) }, ignoreId)) out.push(t);
  }
  return out;
}

// ─── Habits ───
const DAY_CODE = d => T.DAY_CODES[T.dow(d)];
export function habitDays(h) {
  const raw = String(h.days || 'daily').toUpperCase();
  if (/DAILY|EVERY|ALL/.test(raw)) return T.DAY_CODES.slice();
  if (/WEEKDAY/.test(raw)) return ['MO', 'TU', 'WE', 'TH', 'FR'];
  if (/WEEKEND/.test(raw)) return ['SA', 'SU'];
  return raw.split(/[^A-Z]+/).map(x => x.slice(0, 2)).filter(x => T.DAY_CODES.includes(x));
}

function planHabits(s) {
  const issues = [];
  const habits = load('habits').items.filter(h => h.active !== false);
  for (const h of habits) {
    const lo = T.hm(h.windowStart), hi = T.hm(h.windowEnd);
    const ideal = h.idealTime ? T.hm(h.idealTime) : lo;
    for (const d of upcomingDays(s.planDaysAhead)) {
      if (!habitDays(h).includes(DAY_CODE(d))) continue;
      if (rejected(e => e.habitId === h.id && T.day(e.start) === d).length) continue;
      const mine = dayEvents(d).filter(e => e.habitId === h.id);
      // An existing block that is now under a real commitment gets moved, not duplicated.
      let keep = mine.find(e => !busy(dayEvents(d).filter(x => !isAgentBlock(x) || x.kind === 'buffer'), e, e.id));
      for (const e of mine) {
        if (e === keep) continue;
        if (e.end <= T.nowStr()) { keep = keep || e; continue; }
        const starts = freeStarts(d, h.minutes, lo, hi, e.id);
        if (!keep && starts.length) {
          const t = starts.sort((a, b) => Math.abs(T.mins(a) - ideal) - Math.abs(T.mins(b) - ideal))[0];
          markWrite();
          const after = cal.update(e.id, { start: t, end: T.addMin(t, h.minutes) });
          logAction('move', e, after, `"${h.title}" was double-booked; moved it to the next best time in its window`);
          keep = after;
        } else {
          markWrite();
          cal.remove(e.id); markCreate(e.id, 'yielded');
          logAction('delete', e, null, `"${h.title}" lost its slot to a real commitment`);
        }
      }
      if (keep) continue;
      if (d === T.today() && T.mins(T.nowStr()) + h.minutes > hi) continue;
      const starts = freeStarts(d, h.minutes, lo, hi);
      if (!starts.length) { issues.push(`No room for habit ${h.id} "${h.title}" (${h.minutes} min, ${h.windowStart}–${h.windowEnd}) on ${d}.`); continue; }
      const t = starts.sort((a, b) => Math.abs(T.mins(a) - ideal) - Math.abs(T.mins(b) - ideal) || a.localeCompare(b))[0];
      markWrite();
      const ev = cal.create({ title: h.title, start: t, end: T.addMin(t, h.minutes), kind: h.kind === 'focus' ? 'focus' : 'habit', agent: true, habitId: h.id,
        description: `Habit ${h.id}: ${h.minutes} min between ${h.windowStart} and ${h.windowEnd}. Placed automatically; it moves if something more important needs the time.` });
      logAction('create', null, ev, `Habit "${h.title}" placed in its ${h.windowStart}–${h.windowEnd} window`);
    }
  }
  return issues;
}

// ─── Tasks ───
function planTasks(s) {
  const issues = [];
  const store = load('tasks');
  const now = T.nowStr();
  const lo = T.hm(s.dayStart), hi = T.hm(s.dayEnd);
  // 1. Bring each task's sessions up to date with the calendar.
  for (const t of store.items) {
    t.sessions = t.sessions || [];
    t.sessions = t.sessions.filter(x => {
      if (x.end <= now) return true;                 // past: counts as work done
      const ev = cal.get(x.eventId);
      if (!ev) return false;                         // deleted by the user: re-plan
      x.start = ev.start; x.end = ev.end;
      return true;
    });
    if (t.status !== 'open') {
      for (const x of t.sessions.filter(x => x.start > now)) {
        if (cal.get(x.eventId)) { markWrite(); const ev = cal.get(x.eventId); cal.remove(ev.id); logAction('delete', ev, null, `Task "${t.title}" is ${t.status}; freed its session`); }
      }
      t.sessions = t.sessions.filter(x => x.start <= now);
    }
  }
  // 2. Sessions now sitting under a real commitment are released and re-planned.
  for (const t of store.items.filter(t => t.status === 'open')) {
    t.sessions = t.sessions.filter(x => {
      if (x.start <= now) return true;
      const clash = dayEvents(T.day(x.start)).some(e => e.id !== x.eventId && !isAgentBlock(e) && T.overlaps(e, x));
      if (!clash) return true;
      const ev = cal.get(x.eventId);
      if (ev) { markWrite(); cal.remove(ev.id); markCreate(ev.id, 'yielded'); logAction('delete', ev, null, `A commitment took the slot of "${t.title}"; re-planning it`); }
      return false;
    });
  }
  // 3. Book what is still missing: earliest deadline first, high priority first.
  const open = store.items.filter(t => t.status === 'open').sort((a, b) => a.due.localeCompare(b.due) || PRIORITY[a.priority || 'normal'] - PRIORITY[b.priority || 'normal']);
  for (const t of open) {
    const minsOf = list => list.reduce((n, x) => n + T.diffMin(x.start, x.end), 0);
    const done = minsOf(t.sessions.filter(x => x.end <= now));
    let need = t.minutes - done - minsOf(t.sessions.filter(x => x.end > now));
    t.spent = done;
    // Too much booked (the user shortened the task): release the latest sessions.
    while (need < -14) {
      const last = t.sessions.filter(x => x.start > now).sort((a, b) => b.start.localeCompare(a.start))[0];
      if (!last) break;
      const ev = cal.get(last.eventId);
      if (ev) { markWrite(); cal.remove(ev.id); logAction('delete', ev, null, `"${t.title}" needs less time now`); }
      t.sessions = t.sessions.filter(x => x !== last);
      need += T.diffMin(last.start, last.end);
    }
    const due = t.due.length === 10 ? t.due + 'T' + s.dayEnd : t.due;
    const maxSession = Math.max(MIN_SESSION, Number(t.sessionMinutes) || 90);
    const demand = demandOf(t.title, 'task');
    const last = [T.day(due), T.addDays(T.today(), TASK_HORIZON_DAYS)].sort()[0];
    const days = [];
    for (let d = T.today(); d <= last; d = T.addDays(d, 1)) days.push(d);
    // Each session goes to the best (day, time) before the deadline, not the first free one: focus hours for
    // deep work, spread over days, a day of slack before it is due, light days before packed ones.
    while (need >= MIN_SESSION / 2) {
      const len = Math.max(MIN_SESSION, Math.min(maxSession, Math.ceil(need / 15) * 15));
      const top = bestSession(t, days, len, due, demand, s);
      if (!top) break;
      markWrite();
      const ev = cal.create({ title: `📝 ${t.title}`, start: top.st, end: T.addMin(top.st, top.len), kind: 'task', agent: true, taskId: t.id,
        description: `Work session for task ${t.id} (due ${T.human(due)}). Placed automatically; delete or move it freely and the plan adapts.` });
      logAction('create', null, ev, `Work session for "${t.title}" (due ${T.human(due)}): ${top.why}`);
      t.sessions.push({ eventId: ev.id, start: ev.start, end: ev.end });
      need -= top.len;
    }
    t.atRisk = need >= MIN_SESSION / 2;
    if (t.atRisk) issues.push(`Task ${t.id} "${t.title}" is at risk: ${Math.round(need)} of ${t.minutes} min could not be booked before it is due ${T.human(due)}.`);
  }
  save('tasks');
  return issues;
}

/** Minutes of day d an event covers, clipped to the day. */
const spanOn = (e, d) => [T.day(e.start) < d ? 0 : T.mins(e.start), T.day(e.end) > d ? 1440 : (T.mins(e.end) || 1440)];

/** The best (day, start, length) for one more session of task t, or null if nothing fits before it is due. */
function bestSession(t, days, len, due, demand, s) {
  const lo = T.hm(s.dayStart), hi = T.hm(s.dayEnd) || 1440, civil = T.hm(s.workStart);
  const lengths = [...new Set([len, Math.max(MIN_SESSION, len - 30), MIN_SESSION])].filter(n => n <= len);
  let top = null;
  days.forEach((d, i) => {
    const mine = t.sessions.filter(x => T.day(x.start) === d);
    if (mine.length >= 2) return;
    const dayHi = T.day(due) === d ? Math.min(hi, T.mins(due)) : hi;
    const evs = dayEvents(d);
    const ranges = evs.map(e => spanOn(e, d));
    const neighbors = evs.map((e, k) => ({ a: ranges[k][0], b: ranges[k][1], demand: demandOf(e.title, e.kind) }));
    const load = evs.filter(e => !isAgentBlock(e)).reduce((n, e) => { const [a, b] = spanOn(e, d); return n + Math.max(0, Math.min(b, hi) - Math.max(a, lo)); }, 0);
    for (const n of lengths) {
      for (const st of freeStarts(d, n, lo, dayHi)) {
        if (mine.some(x => (st >= x.end ? T.diffMin(x.end, st) : T.diffMin(T.addMin(st, n), x.start)) < 90)) continue; // 90 min apart
        const m = T.mins(st);
        let sc = scoreSlot(m, n, { demand, wake: lo, sleep: hi, free: freeAround(m, n, ranges, 0, lo, dayHi), neighbors, brk: s.breakMinutes });
        sc += 1.2 * n / len;                         // whole sessions beat stubs
        sc -= 0.3 * i;                               // sooner is safer
        if (d === T.day(due)) sc -= 1.2;             // keep a day of slack
        if (mine.length) sc -= 1;                    // spread over days
        if (m < civil && demand !== 'physical') sc -= 0.6; // civilised hours unless needed
        sc -= Math.max(0, load - 6 * 60) / 60 * 0.25; // packed days get less
        if (!top || sc > top.sc + 1e-9) top = { d, st, len: n, sc };
      }
    }
  });
  if (top) top.why = `${top.d === T.today() ? 'today' : T.DAY_NAMES[T.dow(top.d)]}, ${reasonFor(T.mins(top.st), top.len, demand, lo, hi)}`;
  return top;
}

// ─── Task & habit tools (model-facing; declared in engine.TOOL_DECLS) ───
const taskView = t => ({ id: t.id, title: t.title, minutes: t.minutes, spent: t.spent || 0, due: t.due, priority: t.priority, status: t.status, atRisk: t.atRisk || undefined,
  sessions: (t.sessions || []).filter(x => x.end > T.nowStr()).map(x => `${T.human(x.start)}–${T.clock(x.end)}`) });

function normDue(due) {
  const s = String(due || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return T.norm(s);
}

Object.assign(TOOLS, {
  async add_task(a) {
    const minutes = Math.round(Number(a.minutes));
    if (!(minutes >= 15 && minutes <= 60 * 40)) throw new Error('minutes must be between 15 and 2400.');
    const due = normDue(a.due);
    if ((due.length === 10 ? due + 'T23:59' : due) < T.nowStr()) throw new Error('The due date is in the past.');
    const store = load('tasks');
    const t = { id: 'T' + (++store.seq), title: String(a.title).trim().slice(0, 120), minutes, due, priority: PRIORITY[a.priority] !== undefined ? a.priority : 'normal',
      sessionMinutes: Number(a.session_minutes) || 90, notes: a.notes || '', status: 'open', created: T.nowStr(), sessions: [], spent: 0 };
    store.items.push(t);
    save('tasks');
    RUN.planNeeded = true;
    await plan();
    return { ok: true, task: taskView(load('tasks').items.find(x => x.id === t.id)) };
  },

  async update_task(a) {
    const store = load('tasks');
    const t = store.items.find(x => x.id.toLowerCase() === String(a.task_id || '').trim().toLowerCase());
    if (!t) throw new Error(`No task "${a.task_id}". Open tasks: ${store.items.filter(x => x.status === 'open').map(x => `${x.id} ${x.title}`).join(', ') || 'none'}.`);
    if (a.status === 'deleted') { t.status = 'deleted'; }
    else if (a.status === 'done' || a.status === 'open') { t.status = a.status; if (a.status === 'done') t.doneAt = T.nowStr(); }
    if (a.title) t.title = String(a.title).slice(0, 120);
    if (a.minutes) t.minutes = Math.round(Number(a.minutes));
    if (a.due) t.due = normDue(a.due);
    if (a.priority && PRIORITY[a.priority] !== undefined) t.priority = a.priority;
    save('tasks');
    await plan();
    if (t.status === 'deleted') { store.items = store.items.filter(x => x !== t); save('tasks'); }
    return { ok: true, task: taskView(t) };
  },

  async add_habit(a) {
    const minutes = Math.round(Number(a.minutes));
    if (!(minutes >= 5 && minutes <= 480)) throw new Error('minutes must be between 5 and 480.');
    if (!T.isHM(a.window_start) || !T.isHM(a.window_end)) throw new Error('window_start and window_end must look like 07:00.');
    if (T.hm(a.window_end) - T.hm(a.window_start) < minutes) throw new Error('The window is shorter than the habit.');
    const store = load('habits');
    const h = { id: 'H' + (++store.seq), title: String(a.title).trim().slice(0, 80), minutes, days: a.days || 'daily', windowStart: a.window_start, windowEnd: a.window_end,
      idealTime: T.isHM(a.ideal_time) ? a.ideal_time : '', kind: ['focus', 'personal', 'task'].includes(a.kind) ? a.kind : 'personal', active: true, created: T.nowStr() };
    store.items.push(h);
    save('habits');
    await plan();
    const placed = cal.all().filter(e => e.habitId === h.id && e.start > T.nowStr()).map(e => `${T.human(e.start)}–${T.clock(e.end)}`);
    return { ok: true, habit: h, placed };
  },

  async remove_habit(a) {
    const store = load('habits');
    const h = store.items.find(x => x.id.toLowerCase() === String(a.habit_id || '').trim().toLowerCase());
    if (!h) throw new Error(`No habit "${a.habit_id}". Habits: ${store.items.map(x => `${x.id} ${x.title}`).join(', ') || 'none'}.`);
    store.items = store.items.filter(x => x !== h);
    save('habits');
    let n = 0;
    for (const e of cal.all().filter(e => e.habitId === h.id && e.start > T.nowStr())) {
      const ev = cal.get(e.id); cal.remove(ev.id); markCreate(ev.id, 'deleted'); logAction('delete', ev, null, `Habit "${h.title}" removed`, { auto: true }); n++;
    }
    return { ok: true, removed: h.title, blocks_removed: n };
  },
});
export { taskView };

// ─── Conflicts ───
export function findConflicts(d) {
  // Reminders (short solo events) sitting on top of something are intentional, not clashes.
  const real = dayEvents(d).filter(e => !isAgentBlock(e) && !(e.agent && e.kind === 'buffer') && !isPing(e));
  const out = [];
  for (let i = 0; i < real.length; i++) {
    for (let j = i + 1; j < real.length && real[j].start < real[i].end; j++) {
      if (real[j].end <= T.nowStr()) continue;
      if (real[i].readOnly && real[j].readOnly) continue;
      const a = real[i], b = real[j];
      const movable = [a, b].some(e => e.organizer && !e.readOnly && !isProtected(e));
      out.push(`Conflict on ${d}: ${ref(a.id)} "${a.title}" ${T.clock(a.start)}–${T.clock(a.end)} overlaps ${ref(b.id)} "${b.title}" ${T.clock(b.start)}–${T.clock(b.end)}${movable ? '' : ' (neither can be moved automatically)'}.`);
    }
  }
  return out;
}
