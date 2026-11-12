// Scheduling benchmark (no AI, deterministic): does the planner build a schedule a busy student can live by?
//   node eval/plan-bench.js            all scenarios, a table of metrics, exit 1 if a hard check fails
//   node eval/plan-bench.js crunch     only scenarios whose name contains a word
// Each scenario sets up a week, runs the planner (tasks, habits, goals), then measures:
//   hard   overlaps, blocks outside waking hours, after the deadline or in the past, work booked < work possible
//   soft   deep work in peak hours, scraps (< 45 min), deadline-day cramming, heaviest day, churn on a no-op re-plan
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { useFsStore } from '../src/node-store.js';
import { load, saveSettings, settings } from '../src/store.js';
import * as T from '../src/time.js';
import * as cal from '../src/calendar.js';
import { beginRun, TOOLS, RUN, isAgentBlock } from '../src/engine.js';
import { plan } from '../src/planner.js';
import '../src/dayplan.js';
import '../src/goals.js';
import { energy } from '../src/smart.js';

const words = process.argv.slice(2);
const NOW = '2026-11-09T09:00'; // Monday
const D = n => T.addDays('2026-11-09', n);
const ev = (d, s, e, title, x = {}) => ({ title, start: `${d}T${s}`, end: `${d}T${e}`, kind: 'task', guests: [], ...x });

/** A typical college week: classes most mornings, a lab, a couple of meetings, a weekend class. */
function collegeWeek() {
  const out = [];
  for (let i = 0; i < 14; i++) {
    const d = D(i), w = T.dow(d);
    if ([1, 3, 5].includes(w)) out.push(ev(d, '09:30', '12:30', 'OS Lecture'), ev(d, '14:00', '16:00', 'SE Lab'));
    if ([2, 4].includes(w)) out.push(ev(d, '10:00', '13:00', 'AI Lecture'), ev(d, '15:00', '16:00', 'Club meeting', { kind: 'meeting', guests: ['c@x.com'] }));
    if (w === 6) out.push(ev(d, '17:00', '21:00', 'CFA class'));
    if (w === 0) out.push(ev(d, '08:00', '12:00', 'CFA class'));
  }
  return out;
}

const SCENARIOS = [
  { name: 'normal week: 3 tasks + daily gym', events: collegeWeek,
    tasks: [['OS assignment', 180, D(4)], ['DSA practice set', 240, D(3)], ['CFA reading', 360, D(6)]],
    habits: [['Gym', 60, '17:00', '21:00']] },
  { name: 'crunch: 20h exam prep in 5 days', events: collegeWeek,
    tasks: [['Mid-sem exam prep', 1200, D(5) + 'T09:00']] },
  { name: 'overload: 45h in 3 days (must flag, never break rules)', events: collegeWeek,
    tasks: [['Thesis draft', 1500, D(3)], ['Problem sets', 1200, D(3)]] },
  { name: 'many small tasks', events: collegeWeek,
    tasks: Array.from({ length: 10 }, (_, i) => [`Lab report ${i + 1}`, 60, D(1 + (i % 6))]) },
  { name: 'night owl (awake 11:00–02:00)', settings: { dayStart: '11:00', dayEnd: '02:00', workStart: '12:00' }, events: collegeWeek,
    tasks: [['Side project', 480, D(4)]] },
  { name: 'early bird (06:00–21:30)', settings: { dayStart: '06:00', dayEnd: '21:30' }, events: collegeWeek,
    tasks: [['GRE prep', 600, D(6)]], habits: [['Run', 45, '06:00', '08:00']] },
  { name: 'disruption: a meeting lands on a session', events: collegeWeek,
    tasks: [['OS assignment', 240, D(4)]],
    after: () => { const s = cal.all().find(e => e.taskId); return s ? [ev(T.day(s.start), T.clock(s.start), T.clock(T.addMin(s.start, 60)), 'Prof meeting', { kind: 'meeting', guests: ['p@x.com'] })] : []; } },
  { name: 'missed session: time passes, the work is not done', events: collegeWeek,
    tasks: [['OS assignment', 240, D(4)]], miss: true },
  { name: 'weekly goal: 10h of CFA', events: collegeWeek, goals: [['CFA', 10]] },
  { name: 'goal set on a Sunday: small share now, next week booked', now: '2026-11-15T10:00', events: collegeWeek, goals: [['DSA', 6]],
    check: () => { const t = load('tasks').items.filter(x => x.goalId); const next = cal.all().filter(e => e.goalId || (e.taskId && t.some(x => x.id === e.taskId && x.week === '2026-11-16')));
      const out = []; if (t.some(x => x.atRisk)) out.push('goal flagged at risk'); const m = next.reduce((n, e) => n + T.diffMin(e.start, e.end), 0); if (m < 330) out.push(`next week only ${m} min`); if (next.some(e => e.start < '2026-11-16')) out.push('next week work booked this week'); return out; } },
  { name: 'plan my day: 5 items around classes', events: collegeWeek, day: { date: D(1), items: [
    { title: 'CFA study', minutes: 120 }, { title: 'Side project', minutes: 180 }, { title: '5k run', minutes: 45, after: '17:00' },
    { title: 'College assignments', minutes: 120 }, { title: 'Weekly review', minutes: 30 }] } },
  { name: 'plan my day: "run around 7pm" keeps its time though deep work wants the evening', events: collegeWeek, day: { date: D(4), items: [
    { title: 'CFA study', minutes: 120 }, { title: 'Side project', minutes: 180 }, { title: '5k run', around: '19:00' }, { title: 'Weekly review', minutes: 30, after: '17:00' }] } },
  { name: 'plan my day: overfull (8h of work, ~8h free after classes)', events: collegeWeek, settings: { dayStart: '08:00', dayEnd: '21:00' }, day: { date: D(1), items: [
    { title: 'Thesis writing', minutes: 240 }, { title: 'Problem set', minutes: 180 }, { title: 'Reading', minutes: 60 }] } },
  { name: 'a day of 15-min autopilot runs (nothing new happens)', events: collegeWeek,
    tasks: [['OS assignment', 300, D(4)], ['CFA reading', 360, D(6)]], habits: [['Gym', 60, '17:00', '21:00']], crons: 60 },
];

// ─── metrics ───
const agentBlocks = () => cal.all().filter(e => e.agent && (e.taskId || e.habitId || e.goalId || e.kind === 'focus') && e.myStatus !== 'declined');
function awakeAt(e, s) {
  const lo = T.hm(s.dayStart), hi = T.hm(s.dayEnd) || 1440, a = T.mins(e.start), b = T.day(e.end) > T.day(e.start) ? 1440 + T.mins(e.end) : (T.mins(e.end) || 1440);
  if (hi > lo) return a >= lo && b <= hi;
  return (a >= lo && b <= 1440 + hi) || (a < hi && b <= hi); // window crosses midnight
}
/** Free minutes before `due` inside waking hours, net of real commitments: an upper bound on bookable work. */
const FOCUS_PER_DAY = 600; // nobody does more than ~10h of focused work a day, however free they are
function capacity(due, s) {
  const perDay = {};
  const lo = T.hm(s.dayStart), hiRaw = T.hm(s.dayEnd) || 1440;
  for (let t = T.roundUp15(T.nowStr()); t < due; t = T.addMin(t, 15)) {
    const m = T.mins(t);
    const awake = hiRaw > lo ? m >= lo && m < hiRaw : m >= lo || m < hiRaw;
    if (!awake) continue;
    if (cal.list(t, T.addMin(t, 15)).some(e => !isAgentBlock(e) && !e.allDay && e.kind !== 'buffer')) continue;
    perDay[T.day(t)] = Math.min(FOCUS_PER_DAY, (perDay[T.day(t)] || 0) + 15);
  }
  return Object.values(perDay).reduce((a, b) => a + b, 0);
}
function measure(sc, s, cap) {
  const blocks = agentBlocks().filter(e => e.end > T.nowStr());
  const real = cal.all().filter(e => !e.agent || (!e.taskId && !e.habitId && !e.goalId && e.kind !== 'buffer'));
  const all = [...blocks, ...real].filter(e => !e.allDay);
  const hard = [];
  for (const b of blocks) {
    if (all.some(x => x.id !== b.id && T.overlaps(x, b) && !(x.agent && x.kind === 'buffer'))) hard.push(`overlap: ${b.title} ${b.start}`);
    if (!awakeAt(b, s)) hard.push(`asleep: ${b.title} ${b.start}`);
    if (b.start < T.addMin(T.nowStr(), -1)) hard.push(`past: ${b.title} ${b.start}`);
  }
  const tasks = load('tasks').items.filter(t => t.status === 'open');
  let booked = 0, wanted = 0, possible = 0, onDue = 0;
  for (const t of tasks) {
    const due = t.due.length === 10 ? t.due + 'T' + (T.hm(s.dayEnd) > T.hm(s.dayStart) ? s.dayEnd : '23:59') : t.due;
    const mine = blocks.filter(b => b.taskId === t.id);
    for (const b of mine) if (b.end > due) hard.push(`late: ${b.title} ${b.start}`);
    const doneMin = (t.sessions || []).filter(x => x.end <= T.nowStr() && !x.missed).reduce((n, x) => n + T.diffMin(x.start, x.end), 0);
    const left = Math.max(0, t.minutes - doneMin);
    booked += Math.min(left, mine.reduce((n, b) => n + T.diffMin(b.start, b.end), 0));
    wanted += left;
    possible += Math.min(left, cap(due));
    onDue += mine.filter(b => T.day(b.start) === T.day(due) && T.day(due) !== T.today()).length;
  }
  // Several tasks share the same free time: the bound is the smaller of their sum and the free time before the last deadline.
  if (tasks.length > 1) { const lastDue = tasks.map(t => t.due.length === 10 ? t.due + 'T' + s.dayEnd : t.due).sort().pop(); possible = Math.min(possible, cap(lastDue)); }
  if (booked + 30 < Math.min(wanted, possible) * 0.97) hard.push(`under-booked: ${booked} of ${Math.min(wanted, possible)} possible min`);
  const deep = blocks.filter(b => b.taskId || b.goalId);
  const wake = T.hm(s.dayStart), sleep = T.hm(s.dayEnd) > wake ? T.hm(s.dayEnd) : 1440;
  const peak = deep.length ? deep.filter(b => energy(T.mins(b.start) + 15, wake, sleep) >= 0.85).length / deep.length : 1;
  const scraps = deep.filter(b => T.diffMin(b.start, b.end) < 45).length;
  const perDay = {};
  for (const b of deep) perDay[T.day(b.start)] = (perDay[T.day(b.start)] || 0) + T.diffMin(b.start, b.end);
  const heaviest = Math.max(0, ...Object.values(perDay));
  return { hard, booked, wanted, possible, peak, scraps, onDue, heaviest, blocks: deep.length };
}

const results = [];
for (const sc of SCENARIOS.filter(x => !words.length || words.some(w => x.name.includes(w)))) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'donna-bench-'));
  await useFsStore(dir);
  T.setNow(sc.now || NOW); T.setTimeZone('Asia/Kolkata');
  saveSettings({ autonomous: true, dayStart: '08:00', dayEnd: '23:30', workStart: '09:00', workEnd: '18:00', planDaysAhead: 7, bufferMinutes: 0, ...(sc.settings || {}) });
  const s = settings();
  cal.replaceAll(sc.events());
  beginRun('chat', '');
  for (const [title, minutes, due] of sc.tasks || []) await TOOLS.add_task({ title, minutes, due });
  for (const [title, minutes, ws, we] of sc.habits || []) await TOOLS.add_habit({ title, minutes, window_start: ws, window_end: we });
  for (const [title, h] of sc.goals || []) await TOOLS.set_goal({ title, hours_per_week: h });
  beginRun('auto'); await plan();
  const cap = due => capacity(due, s);
  let extra = {};
  if (sc.day) {
    beginRun('chat', 'plan my day');
    const r = await TOOLS.plan_day({ date: sc.day.date, items: sc.day.items });
    if (process.env.DBG) console.log(JSON.stringify(r, null, 1));
    const mine = cal.all().filter(e => T.day(e.start) === sc.day.date && RUN.actions.some(a => a.summary.includes(e.title)));
    const others = cal.all().filter(e => T.day(e.start) === sc.day.date && !mine.includes(e) && !e.allDay);
    const hard = [];
    for (const e of mine) {
      if (others.some(o => T.overlaps(o, e))) hard.push(`overlap: ${e.title}`);
      if (!awakeAt(e, s)) hard.push(`asleep: ${e.title}`);
      const it = sc.day.items.find(x => e.title.includes(x.title));
      if (it && it.after && T.clock(e.start) < it.after) hard.push(`too early: ${e.title}`);
      if (it && it.around && Math.abs(T.mins(e.start) - T.hm(it.around)) > 60) hard.push(`ignored "around ${it.around}": ${e.title} at ${T.clock(e.start)}`);
    }
    const sorted = mine.slice().sort((a, b) => a.start.localeCompare(b.start));
    for (let i = 1; i < sorted.length; i++) if (T.diffMin(sorted[i - 1].end, sorted[i].start) < 0) hard.push('self-overlap');
    const want = sc.day.items.reduce((n, x) => n + (x.minutes || 60), 0), got = mine.reduce((n, e) => n + T.diffMin(e.start, e.end), 0);
    const free = (() => { let n = 0; for (let t = T.at(sc.day.date, T.hm(s.dayStart)); T.mins(t) < (T.hm(s.dayEnd) || 1440) && T.day(t) === sc.day.date; t = T.addMin(t, 15)) if (!others.some(o => o.start < T.addMin(t, 15) && o.end > t)) n += 15; return n; })();
    const reported = (r.not_placed || []).length + (r.moved_to_next_day || []).length > 0;
    if (got + 15 < Math.min(want, free * (reported ? 0.75 : 0.85))) hard.push(`under-placed: ${got} of ${Math.min(want, free)} min`);
    if (want > free && !(r.not_placed || r.moved_to_next_day)) hard.push('overfull day not reported');
    results.push({ name: sc.name, hard, booked: got, wanted: want, possible: free, peak: 1, scraps: mine.filter(e => T.diffMin(e.start, e.end) < 30).length, onDue: 0, heaviest: got, churn: '' });
    fs.rmSync(dir, { recursive: true, force: true });
    continue;
  }
  // Re-planning with nothing new must change nothing.
  beginRun('auto'); await plan(); extra.churn = RUN.actions.length;
  if (sc.after) {
    const add = sc.after();
    for (const e of add) cal.create({ ...e, organizer: true, myStatus: 'accepted' });
    beginRun('auto'); await plan();
    extra.disrupted = RUN.actions.filter(a => /^Moved|^Cancelled|^Created/.test(a.summary)).length;
  }
  if (sc.crons) {
    // The autopilot every 15 minutes for 15 hours: blocks may only change when time passes them, never reshuffle.
    let moves = 0;
    for (let i = 0; i < sc.crons; i++) {
      T.setNow(T.addMin(T.nowStr(), 15));
      beginRun('auto'); await plan();
      moves += RUN.actions.length;
    }
    extra.churn = moves;
  }
  if (sc.miss) {
    const first = agentBlocks().filter(e => e.taskId).sort((a, b) => a.start.localeCompare(b.start))[0];
    T.setNow(T.addMin(first.end, 30));
    // The user says they skipped it (Today's "Missed" button).
    if (TOOLS.session_status) { beginRun('chat', ''); await TOOLS.session_status({ event_id: first.id, status: 'missed' }); }
    beginRun('auto'); await plan();
  }
  const m = measure(sc, s, cap);
  if (sc.check) m.hard.push(...sc.check());
  results.push({ name: sc.name, ...m, ...extra });
  fs.rmSync(dir, { recursive: true, force: true });
}

const pct = x => Math.round(x * 100) + '%';
const h = m => (m / 60).toFixed(1) + 'h';
console.log('scenario'.padEnd(56), 'booked/possible', 'peak', 'scraps', 'dueDay', 'maxDay', 'churn', 'hard');
let bad = 0;
for (const r of results) {
  console.log(r.name.slice(0, 55).padEnd(56), `${h(r.booked)}/${h(Math.min(r.wanted, r.possible))}`.padEnd(15), pct(r.peak).padEnd(4), String(r.scraps).padEnd(6), String(r.onDue).padEnd(6), h(r.heaviest).padEnd(6), String(r.churn ?? '').padEnd(5), r.hard.length ? '✗ ' + r.hard.slice(0, 3).join(' | ') : '✓');
  if (r.hard.length) bad++;
  if (r.disrupted !== undefined) console.log('   disruption: changes after one new meeting =', r.disrupted);
}
console.log(`\n${results.length - bad}/${results.length} scenarios with no hard failure`);
if (bad) process.exitCode = 1;
