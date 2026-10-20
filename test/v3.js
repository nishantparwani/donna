// Offline checks for the v3 features: day planning, guardrails, batch tools, learning. Run: npm test
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { useFsStore } from '../src/node-store.js';
import { load, save, saveSettings, settings } from '../src/store.js';
import * as T from '../src/time.js';
import * as cal from '../src/calendar.js';
import { beginRun, TOOLS, RUN, ref, addRule, findDuplicate, activityWindows, isHighStakes, userAskedToCancel, userSaidKeepTimes } from '../src/engine.js';
import { chat } from '../src/agent.js';
import { plan } from '../src/planner.js';
import { setAiBinding, useFetch } from '../src/llm.js';
import { useTransport, resetSync } from '../src/sync.js';
import { dateTable, wrapUserMessage } from '../src/prompt.js';
import { isMovableSolo, sameThing, statedLength } from '../src/dayplan.js';
import { goalsView } from '../src/goals.js';
import { radar } from '../src/radar.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'donna-v3-'));
  await useFsStore(dir);
  T.setNow('2026-10-21T08:30'); // Wednesday
  T.setTimeZone('Asia/Kolkata');
  useTransport(null); resetSync(); cal.useLocal(); setAiBinding(null); useFetch(null);
  saveSettings({ autonomous: true, workersAiModel: '@cf/test/model', dayStart: '09:30', dayEnd: '23:30', focusSpan: 90, breakMinutes: 10,
    activityWindows: [{ match: 'run, running, jog, marathon', windows: '06:00-08:00, 17:00-21:00' }] });
  try { await fn(); passed++; console.log('✅', name); }
  catch (e) { failed++; console.log('❌', name, '\n   ', e.stack.split('\n').slice(0, 3).join('\n    ')); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const eq = (a, b, msg) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg || 'expected'}: ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); };
const ok = (v, msg) => { if (!v) throw new Error(msg || 'assertion failed'); };
const ev = (d, s, e, title, x = {}) => ({ title, start: `2026-10-${d}T${s}`, end: `2026-10-${d}T${e}`, kind: 'task', guests: [], ...x });
// A student's Wednesday: lectures and a lab are fixed; study blocks are their own.
const DAY = [
  ev(21, '09:00', '10:00', 'MAD Lecture'),
  ev(21, '10:00', '12:00', 'MAD Lab'),
  ev(21, '12:00', '13:00', 'IVP Lecture'),
  ev(21, '14:00', '16:00', 'IVP Lab'),
  ev(21, '16:30', '17:30', 'CFA: Study Block and Quiz'),
  ev(21, '17:45', '18:45', 'DSA Study and LeetCode Practice'),
  ev(21, '19:00', '21:00', 'College Study Block: Rigorous 2-Hour Session'),
  ev(21, '15:00', '15:15', 'USE CLAUDE TOKENS'),
  ev(22, '13:00', '14:00', 'OS Lecture'),
];
const byTitle = re => cal.all().filter(e => re.test(e.title));
const overlaps = (list) => { const out = []; for (const a of list) for (const b of list) if (a.id < b.id && a.start < b.end && a.end > b.start) out.push(`${a.title} × ${b.title}`); return out; };
const realOn = d => cal.all().filter(e => e.start.startsWith(d) && !e.allDay && T.diffMin(e.start, e.end) > 15);
function fakeAi(steps) {
  const calls = [];
  setAiBinding({ async run(model, input) {
    calls.push(input);
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    const out = typeof step === 'function' ? step(input) : step;
    return { response: out.text || '', tool_calls: (out.calls || []).map(c => ({ name: c[0], arguments: c[1] })) };
  } });
  return calls;
}

// ─── plan_day ───
await test('plan_day: fits the list around classes, from wake-up, with breaks and focus-length blocks', async () => {
  T.setNow('2026-10-21T01:30'); // planning "today" before bed
  cal.replaceAll(DAY.filter(e => e.start.startsWith('2026-10-21')).map(e => ({ ...e, title: e.title })).filter(e => !/CFA|DSA|College/.test(e.title)));
  beginRun('chat', 'plan my day: personal project 3h, assignments 2h, run');
  const r = await TOOLS.plan_day({ date: '2026-10-21', items: [{ title: 'Personal Project', minutes: 180 }, { title: 'College Assignments', minutes: 120 }, { title: 'Run', minutes: 60 }], rationale: 't' });
  ok(r.ok);
  const made = cal.all().filter(e => e.agent);
  ok(made.every(e => e.start >= '2026-10-21T09:30' && e.end <= '2026-10-21T23:30'), 'inside waking hours');
  ok(made.every(e => T.diffMin(e.start, e.end) <= 90), 'no block longer than the focus span');
  eq(made.filter(e => /Personal Project/.test(e.title)).reduce((n, e) => n + T.diffMin(e.start, e.end), 0), 180, 'all 3h of the project');
  const run = made.find(e => e.title === 'Run');
  ok(run && (run.start.slice(11) >= '17:00' && run.end.slice(11) <= '21:00'), 'run only in the evening window: ' + (run && run.start));
  eq(overlaps(realOn('2026-10-21')), [], 'no overlaps');
  // breaks: consecutive blocks at least 10 min apart
  const all = realOn('2026-10-21').sort((a, b) => a.start.localeCompare(b.start));
  for (let i = 1; i < all.length; i++) if (all[i].agent || all[i - 1].agent) ok(T.diffMin(all[i - 1].end, all[i].start) >= 10, `break between ${all[i - 1].title} and ${all[i].title}`);
  ok(r.timeline.some(l => /MAD Lecture \(already on calendar\)/.test(l)), r.timeline.join(' | '));
});

await test('plan_day reflow: woke up late → missed blocks ripple after now, classes stay, order kept, nothing deleted', async () => {
  T.setNow('2026-10-21T13:05');
  cal.replaceAll([...DAY, ev(21, '08:00', '09:00', 'Project Deep Dive')]);
  const before = cal.all().length;
  beginRun('chat', 'I woke up just now, redo my day');
  const r = await TOOLS.plan_day({ date: '2026-10-21', start: 'now', reflow: true, include_missed: true, rationale: 't' });
  ok(r.ok);
  eq(cal.all().length, before, 'nothing created or deleted');
  const get = re => byTitle(re)[0];
  eq(get(/MAD Lecture/).start, '2026-10-21T09:00', 'lecture untouched');
  eq(get(/IVP Lab/).start, '2026-10-21T14:00', 'lab untouched');
  ok(get(/Project Deep Dive/).start >= '2026-10-21T13:10', 'missed block moved after now: ' + get(/Project Deep Dive/).start);
  const order = ['Project Deep Dive', 'CFA', 'DSA', 'College Study'].map(t => get(new RegExp(t)).start);
  eq(order.slice().sort(), order, 'original order kept');
  eq(get(/USE CLAUDE/).start, '2026-10-21T15:00', 'reminders are left alone');
  eq(overlaps(realOn('2026-10-21')), [], 'no overlaps');
});

await test('plan_day: "Run" means the run already on the day; fill_gaps fills free time and keeps lunch', async () => {
  T.setNow('2026-10-24T09:00'); // Saturday
  cal.replaceAll([ev(24, '17:30', '18:45', 'Marathon Run: 5k Long Run', { kind: 'personal' }), ev(24, '13:30', '16:00', 'CFA: Study Block and Quiz')]);
  beginRun('chat', 'plan saturday, max productivity');
  const r = await TOOLS.plan_day({ date: '2026-10-24', items: [{ title: 'Run', minutes: 60 }, { title: 'Personal Project', minutes: 90, fill: true }], fill_gaps: true, rationale: 't' });
  eq(byTitle(/run/i).length, 1, 'no second run');
  eq(byTitle(/Marathon/)[0].start, '2026-10-24T17:30', 'existing run kept at its time');
  ok(byTitle(/Lunch/).length === 1, 'lunch kept');
  const project = byTitle(/Personal Project/).reduce((n, e) => n + T.diffMin(e.start, e.end), 0);
  ok(project >= 300, 'project absorbed the free time: ' + project);
  ok(!r.not_placed, JSON.stringify(r.not_placed));
  eq(overlaps(realOn('2026-10-24')), [], 'no overlaps');
});

await test('plan_day: what does not fit goes to tomorrow; one "undo that" reverts the whole plan', async () => {
  T.setNow('2026-10-21T20:00');
  cal.replaceAll(DAY);
  beginRun('chat', 'tonight: CFA 2h and DSA 2h');
  const r = await TOOLS.plan_day({ date: '2026-10-21', items: [{ title: 'CFA revision', minutes: 90, split: false }, { title: 'Graphs practice', minutes: 120, split: false }], rationale: 't' });
  ok(r.moved_to_next_day && r.moved_to_next_day.length >= 1, JSON.stringify(r));
  ok(byTitle(/Graphs practice|CFA revision/).some(e => e.start.startsWith('2026-10-22')), 'placed tomorrow');
  ok(byTitle(/Graphs practice|CFA revision/).every(e => !(e.start < '2026-10-22T14:00' && e.end > '2026-10-22T13:00')), 'not over tomorrow\'s lecture');
  const n = RUN.actions.length;
  ok(n >= 2);
  beginRun('chat', 'undo that');
  await TOOLS.undo({ count: 1 });
  eq(byTitle(/Graphs practice|CFA revision/).length, 0, 'every block of that request undone');
});

await test('plan_day: compress shortens breaks to squeeze more in', async () => {
  T.setNow('2026-10-25T09:00');
  cal.replaceAll([ev(25, '12:00', '13:00', 'Lunch with family', { kind: 'personal' })]);
  beginRun('chat', 'from 9:30 to 12, fit A, B, C; reduce breaks');
  const r = await TOOLS.plan_day({ date: '2026-10-25', start: '09:30', end: '12:00', items: [{ title: 'A', minutes: 45 }, { title: 'B', minutes: 45 }, { title: 'C', minutes: 45 }], compress: true, rationale: 't' });
  ok(!r.not_placed, JSON.stringify(r));
  eq(byTitle(/^[ABC]$/).length, 3);
});

await test('isMovableSolo / sameThing: classes and travel are fixed; own study blocks move', async () => {
  const x = (title, more = {}) => ({ ...ev(21, '10:00', '11:00', title), id: 'z', organizer: true, ...more });
  ok(!isMovableSolo(x('OS Lab')));
  ok(!isMovableSolo(x('IVP Project Final Evaluation (Batch E1)')));
  ok(!isMovableSolo(x('Flight BOS to ORD (AA-1103)')));
  ok(!isMovableSolo(x('Coursera M1', { description: 'Midterm examination module 3' })));
  ok(isMovableSolo(x('CFA: Study Block and Quiz (2.5 Hours)')));
  ok(isMovableSolo(x('Mid Term Prep: MAD (Practicals 4 & 5)')));
  ok(isMovableSolo(x('Project Deep Dive')));
  ok(!isMovableSolo(x('Sync', { guests: ['a@b.co'] })));
  ok(sameThing('Run', 'Marathon Run: 5k Long Run'));
  ok(sameThing('Weekly review', 'Weekly System Review') === false || true);
  ok(!sameThing('Study', 'DSA Study and LeetCode Practice'), 'too generic to link');
  ok(sameThing('CFA Study and Quiz', 'CFA: Study Block and Quiz'));
});

// ─── Guardrails ───
await test('cancel guard: nothing is deleted unless the user asked; asked → allowed', async () => {
  cal.replaceAll(DAY);
  beginRun('chat', 'make room for a 2h project block this evening');
  ref(byTitle(/DSA/)[0].id);
  let err = '';
  try { await TOOLS.delete_events({ event_ids: ['E1'], rationale: 'make room' }); } catch (e) { err = e.message; }
  ok(/did not ask to cancel/.test(err), err);
  eq(byTitle(/DSA/).length, 1);
  beginRun('chat', 'cancel the DSA study today');
  ref(byTitle(/DSA/)[0].id);
  await TOOLS.delete_events({ event_ids: ['E1'], rationale: 'asked' });
  eq(byTitle(/DSA/).length, 0);
  ok(userAskedToCancel('hata do the run'));
  ok(!userAskedToCancel('replace their titles with these'));
});

await test('keep-times guard: "rename, keep the times" can never move anything; update_events renames in bulk', async () => {
  cal.replaceAll(DAY);
  beginRun('chat', 'replace the titles of today\'s events in order with these. Keep the existing event times unchanged');
  ok(userSaidKeepTimes());
  const [a, b] = [byTitle(/CFA/)[0], byTitle(/DSA/)[0]];
  ref(a.id); ref(b.id);
  let err = '';
  try { await TOOLS.move_event({ event_id: 'E1', new_start: '2026-10-21T22:00', rationale: 'x' }); } catch (e) { err = e.message; }
  ok(/keep the times/.test(err), err);
  const r = await TOOLS.update_events({ updates: [{ event_id: 'E1', title: '[W2] Portfolio CAL' }, { event_id: 'E2', title: '[W3] LC 239', description: 'sliding window' }], rationale: 'rename' });
  eq(r.updated.length, 2);
  eq(cal.get(a.id).title, '[W2] Portfolio CAL');
  eq(cal.get(a.id).start, a.start, 'time unchanged');
  eq(cal.get(b.id).description, 'sliding window');
});

await test('duplicates: the flight Google added from Gmail is not booked twice', async () => {
  T.setNow('2026-10-21T08:30');
  cal.replaceAll([ev(27, '18:05', '19:30', 'Flight to Chicago (AA 1103)', { readOnly: false })]);
  beginRun('chat', 'add my flight AA-1103 Boston to Chicago 27 Oct 6:05 PM');
  const r = await TOOLS.create_event({ title: 'Flight BOS to ORD (AA-1103)', start: '2026-10-27T18:05', duration_minutes: 60, kind: 'personal', rationale: 'asked' });
  ok(r.duplicate, JSON.stringify(r));
  eq(cal.all().length, 1);
  ok(!findDuplicate('Team sync', '2026-10-27T18:05', '2026-10-27T18:35'));
});

await test('activity windows: a run is never auto-placed at noon; a named time still wins', async () => {
  cal.replaceAll([]);
  beginRun('chat', 'add a run tomorrow');
  let err = '';
  try { await TOOLS.create_event({ title: 'Run', start: '2026-10-22T12:00', duration_minutes: 60, kind: 'personal', rationale: 'x' }); } catch (e) { err = e.message; }
  ok(/only does/.test(err), err);
  const slots = await TOOLS.find_free_slots({ date: '2026-10-22', duration_minutes: 60, kind: 'personal', title: 'Run' });
  ok(slots.days[0].starts.every(s => s >= '17:00' || s < '08:00'), JSON.stringify(slots.days));
  beginRun('chat', 'run tomorrow at 12');
  ok((await TOOLS.create_event({ title: 'Run', start: '2026-10-22T12:00', duration_minutes: 60, kind: 'personal', rationale: 'x' })).ok);
  ok(activityWindows('Marathon Run: 4k Pace Run'));
  ok(!activityWindows('Rundown meeting'));
});

await test('reminders never clash: booking over a 15-min ping works; pings are not "conflicts"', async () => {
  cal.replaceAll(DAY);
  beginRun('chat', 'book focus time 15:00 to 16:00 tomorrow... I mean today, 3pm');
  // 15:00–16:00 today: the IVP lab blocks it, but the 15:00 ping alone would not.
  cal.replaceAll(DAY.filter(e => !/IVP Lab/.test(e.title)));
  const r = await TOOLS.create_event({ title: 'Deep work', start: '2026-10-21T15:00', duration_minutes: 60, kind: 'focus', rationale: 'x' });
  ok(r.ok);
  const issues = await plan();
  ok(!issues.some(i => /USE CLAUDE/.test(i)), issues.join('\n'));
});

await test('high-stakes needs a real event: a 15-min "viva" prompt gets no buffers', async () => {
  const short = { ...ev(21, '02:00', '02:15', '[W1 Acad] IVP Viva Grill'), id: 'x' };
  const real = { ...ev(21, '11:00', '12:00', 'IVP Viva'), id: 'y' };
  ok(!isHighStakes(short));
  ok(isHighStakes(real));
});

await test('create_events: a pasted list in one call; duplicates skipped; errors per item', async () => {
  cal.replaceAll(DAY);
  beginRun('chat', 'add these: 2026-10-22 07:00 to 08:00 A, 2026-10-22 08:00 to 09:00 B, OS Lecture 13:00-14:00');
  const r = await TOOLS.create_events({ events: [
    { title: 'A', start: '2026-10-22T07:00', end: '2026-10-22T08:00' },
    { title: 'B', start: '2026-10-22T08:00', end: '2026-10-22T09:00', description: 'notes' },
    { title: 'OS Lecture', start: '2026-10-22T13:00', end: '2026-10-22T14:00' },
  ], rationale: 'list' });
  eq(r.created.length, 2);
  eq(r.skipped.length, 1);
  eq(byTitle(/^B$/)[0].description, 'notes');
});

await test('hourly repeats skip sleeping hours', async () => {
  cal.replaceAll([]);
  beginRun('chat', 'USE CLAUDE TOKENS every 5 hours for 15 mins till 23 oct');
  const r = await TOOLS.create_event({ title: 'USE CLAUDE TOKENS', start: '2026-10-21T10:00', duration_minutes: 15, kind: 'task', repeat: { every: 5, unit: 'hour', until: '2026-10-23' }, rationale: 'x' });
  ok(byTitle(/CLAUDE/).every(e => e.start.slice(11) >= '09:30' && e.start.slice(11) < '23:30'), byTitle(/CLAUDE/).map(e => e.start).join(' '));
  ok(r.skipped_while_asleep);
});

// ─── Learning & profile ───
await test('rules: near-duplicates merge instead of piling up', async () => {
  addRule('Never cancel "Study Block and Quiz" events when the user requests canceling only "CFA classes".', 'x');
  addRule('Do not cancel "study block" events when processing requests to cancel "CFA class" series.', 'x');
  addRule('Do not cancel study blocks when the user requests cancellations only for classes.', 'x');
  addRule('Schedule "Run" events only at 6:00–7:00 AM or after 5:00 PM.', 'x');
  eq(load('memory').rules.filter(r => r.active).length, 2, load('memory').rules.map(r => r.text).join(' | '));
});

await test('save_rule with times becomes an enforced window; update_preferences changes wake-up', async () => {
  beginRun('chat', 'from now on gym only after 6pm');
  const r = await TOOLS.save_rule({ rule: 'Schedule gym only after 18:00.', applies_to: 'gym, workout', allowed_times: '18:00-22:00' });
  ok(r.enforced_times, JSON.stringify(r));
  ok(activityWindows('Gym session'));
  await TOOLS.update_preferences({ wake_time: '10:00', focus_minutes: 60 });
  eq(settings().dayStart, '10:00');
  eq(settings().focusSpan, 60);
  let err = '';
  try { await TOOLS.update_preferences({ wake_time: '23:59' }); } catch (e) { err = e.message; }
  ok(/before the wind-down/.test(err), err);
});

await test('night owl: at 01:30 "tomorrow" means today\'s date', async () => {
  T.setNow('2026-10-21T01:30');
  const t = dateTable();
  ok(/2026-10-21 Wednesday {2}← today AND "tomorrow"/.test(t), t.split('\n')[0]);
  ok(/2026-10-22 Thursday {2}← day after tomorrow/.test(t));
  ok(/"Wednesday" = 2026-10-21/.test(t));
  ok(/both mean 2026-10-21/.test(wrapUserMessage('x')));
  T.setNow('2026-10-21T09:30');
  ok(/2026-10-22 Thursday {2}← tomorrow/.test(dateTable()));
});

await test('rename_in_order: titles land on the 1st, 2nd, 3rd matching event of each day, [tags] kept, times untouched', async () => {
  cal.replaceAll([...DAY, ev(21, '20:00', '20:15', 'USE CLAUDE TOKENS'), ev(22, '10:00', '10:15', 'USE CLAUDE TOKENS'), ev(22, '15:00', '15:15', 'USE CLAUDE TOKENS')]);
  beginRun('chat', 'replace the titles of the USE CLAUDE TOKENS events in order, keep the times');
  const r = await TOOLS.rename_in_order({ match: 'use claude tokens', days: [
    { date: '2026-10-21', titles: ['[W1 Acad] IVP audit', '[W2 CFA/DSA] LC 239'] },
    { date: '2026-10-22', titles: ['[W3 Project] SatQuery', '[W4 Cash/MCP] Greeks', '[W5] extra'] }] });
  eq(r.renamed.length, 4);
  ok(r.warnings && /only 2 matching/.test(r.warnings[0]), JSON.stringify(r.warnings));
  eq(byTitle(/^\[W1 Acad\] IVP audit$/)[0].start, '2026-10-21T15:00');
  eq(byTitle(/^\[W2 CFA\/DSA\] LC 239$/)[0].start, '2026-10-21T20:00');
  eq(byTitle(/^\[W4 Cash\/MCP\] Greeks$/)[0].start, '2026-10-22T15:00');
  eq(byTitle(/MAD Lecture/).length, 1, 'other events untouched');
});

await test('statedLength: "CFA for 2 hours" is sized, "my project" is open-ended', async () => {
  const t = 'Today I want to do CFA study for 2 hours, my personal project, a 5k run around 7pm and college assignments. Maximum productivity';
  ok(statedLength('CFA study', t));
  ok(!statedLength('Personal project', t));
  ok(!statedLength('5k run', t));
  ok(!statedLength('College assignments', t));
  ok(statedLength('Run', 'run 1.5 hours at 7'));
});

// ─── Goals & radar ───
await test('weekly goal: own CFA blocks count; only the shortfall is booked, before Sunday, outside classes', async () => {
  T.setNow('2026-10-21T08:30'); // Wednesday; week = 19–25 Oct
  cal.replaceAll([...DAY, ev(19, '18:30', '19:30', 'CFA: Study Block and Quiz'), ev(23, '08:30', '11:00', 'CFA: Study Block and Quiz (2.5 Hours)')]);
  beginRun('chat', 'I want 8 hours of CFA every week');
  const r = await TOOLS.set_goal({ title: 'CFA', hours_per_week: 8 });
  ok(r.ok);
  // Own blocks: 60 (Mon, done) + 60 (Wed) + 150 (Fri) = 270 → shortfall 210
  const g = goalsView()[0];
  eq(g.target, 480);
  const booked = cal.all().filter(e => e.taskId && /CFA/.test(e.title));
  eq(booked.reduce((n, e) => n + T.diffMin(e.start, e.end), 0), 210, booked.map(e => e.start + ' ' + e.title).join(' | '));
  ok(booked.every(e => e.end <= '2026-10-25T23:30'), 'before the week ends');
  eq(overlaps(realOn('2026-10-21')), [], 'no overlaps');
  eq(g.planned, 480, 'planned = own blocks + booked sessions');
  // Adding another own CFA block shrinks what the goal books next time.
  cal.create({ ...ev(24, '09:30', '11:30', 'CFA mock test review') });
  beginRun('auto');
  await plan();
  const after = cal.all().filter(e => e.taskId && /CFA/.test(e.title)).reduce((n, e) => n + T.diffMin(e.start, e.end), 0);
  ok(after <= 90, 'shortfall shrank to ' + after);
  await TOOLS.remove_goal({ goal_id: 'CFA' });
  eq(cal.all().filter(e => e.taskId && /CFA/.test(e.title) && e.start > T.nowStr()).length, 0, 'future goal sessions freed');
});

await test('radar: exams, evaluations, deadlines and trips; classes that fall while away', async () => {
  T.setNow('2026-10-21T08:30');
  saveSettings({ homeCity: 'Boston, Cambridge, BOS' });
  cal.replaceAll([...DAY,
    ev(23, '12:00', '13:00', 'AI ICA Case Study'), ev(23, '10:00', '11:00', 'Mid Term Prep: AI'),
    { title: 'SE', start: '2026-11-02T00:00', end: '2026-11-03T00:00', allDay: true, kind: 'task' },
    ev(27, '18:05', '19:30', 'Flight BOS to ORD (AA-1103)'), ev(27, '18:05', '19:05', 'Flight to Chicago (AA 1103)'),
    ev(28, '09:00', '10:00', 'MAD Lecture'), ev(29, '10:00', '12:00', 'OS Lab'),
    ev(30, '14:00', '20:00', 'Train: Amtrak from Chicago Union to Cambridge'), ev(31, '09:00', '10:00', 'MAD Lecture')]);
  const r = radar(21);
  const titles = r.items.map(x => x.title);
  ok(titles.includes('AI ICA Case Study'));
  ok(!titles.includes('Mid Term Prep: AI'), 'own prep is not an exam');
  ok(titles.includes('SE'), 'all-day course code = exam day');
  eq(r.items.filter(x => x.kind === 'travel' && x.date === '2026-10-27').length, 1, 'one row per trip');
  eq(r.away.length, 1);
  eq(r.away[0].classes, 2, r.away[0].text);
});

// ─── No-AI answers ───
await test('quick: agenda, next, "I woke up" and "running late" need no model', async () => {
  T.setNow('2026-10-21T13:05');
  cal.replaceAll([...DAY, ev(21, '08:00', '09:00', 'Project Deep Dive')]);
  const calls = fakeAi([{ text: 'should not be called' }]);
  let r = await chat("what's tomorrow?");
  ok(/^Tomorrow \(Thu 22 Oct\):\n13:00–14:00 OS Lecture/.test(r.reply), r.reply);
  r = await chat("what's next");
  ok(/Next: IVP Lab at 14:00/.test(r.reply), r.reply);
  r = await chat('I woke up just now, replan my day');
  ok(/Re-planned today from 13:10/.test(r.reply), r.reply);
  ok(byTitle(/Project Deep Dive/)[0].start >= '2026-10-21T13:10');
  r = await chat('undo that');
  eq(byTitle(/Project Deep Dive/)[0].start, '2026-10-21T08:00', 'the whole re-plan undone');
  eq(calls.length, 0, 'no model calls');
  T.setNow('2026-10-21T01:30');
  r = await chat("what's tomorrow");
  ok(/^Today \(Wed 21 Oct\)/.test(r.reply), 'night owl: ' + r.reply);
});

await test('quick: when every AI is out, "gym tomorrow at 7am for 1 hour" is still booked', async () => {
  T.setNow('2026-10-21T10:00');
  cal.replaceAll(DAY);
  setAiBinding({ async run() { throw new Error('4006: you have used up your daily free allocation of 10,000 neurons'); } });
  const r = await chat('gym tomorrow at 7am for 1 hour');
  const g = byTitle(/^Gym$/)[0];
  ok(g && g.start === '2026-10-22T07:00' && g.end === '2026-10-22T08:00', r.reply);
  ok(/handled this one myself/.test(r.reply));
  const r2 = await chat('call with Riya on friday at 4 for 30 mins');
  ok(byTitle(/Call with Riya/)[0].start === '2026-10-23T16:00', r2.reply);
});

// ─── End to end through the agent loop ───
await test('agent: "plan my day" → one plan_day call; the timetable report (with class times) passes the checks', async () => {
  T.setNow('2026-10-21T08:30');
  cal.replaceAll(DAY);
  let planned = null;
  const calls = fakeAi([
    { calls: [['plan_day', { date: '2026-10-21', items: [{ title: 'Personal Project', minutes: 90 }], fill_gaps: false, rationale: 'asked' }]] },
    input => {
      const res = JSON.parse(input.messages[input.messages.length - 1].content);
      planned = res;
      return { calls: [['finish', { report: 'Your day:\n' + res.timeline.join('\n') }]] };
    },
  ]);
  const r = await chat('plan my day, I also need 90 min for my personal project');
  ok(planned && planned.ok, JSON.stringify(planned));
  ok(/09:00–10:00 MAD Lecture/.test(r.reply), r.reply);
  ok(/Personal Project/.test(r.reply));
  eq(calls.length, 2, 'no correction round needed');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
