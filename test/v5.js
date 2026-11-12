// Offline checks for v5: the failures found by the 95-scenario real-model eval (eval/crud.js), each fixed in code.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { useFsStore } from '../src/node-store.js';
import { load, saveSettings } from '../src/store.js';
import * as T from '../src/time.js';
import * as cal from '../src/calendar.js';
import { beginRun, TOOLS, userAskedToCancel } from '../src/engine.js';
import { chat } from '../src/agent.js';
import { setAiBinding, useFetch, stripChannels } from '../src/llm.js';
import { useTransport, resetSync } from '../src/sync.js';
import { hinglish, whenIn } from '../src/when.js';
import { wrapUserMessage } from '../src/prompt.js';
import { migrate } from '../src/migrate.js';
import { plan, weekLoad, sessionsToConfirm } from '../src/planner.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'donna-v5-'));
  await useFsStore(dir);
  T.setNow('2026-10-21T10:00'); // Wednesday
  T.setTimeZone('Asia/Kolkata');
  useTransport(null); resetSync(); cal.useLocal(); setAiBinding(null); useFetch(null);
  saveSettings({ autonomous: false, workersAiModel: '@cf/test/model', aiOrder: ['workers-ai'], dayStart: '09:30', dayEnd: '23:30', workStart: '09:00', workEnd: '18:00' });
  try { await fn(); passed++; console.log('✅', name); }
  catch (e) { failed++; console.log('❌', name, '\n   ', e.stack.split('\n').slice(0, 3).join('\n    ')); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const eq = (a, b, msg) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg || 'expected'}: ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); };
const ok = (v, msg) => { if (!v) throw new Error(msg || 'assertion failed'); };
const ev = (d, s, e, title, x = {}) => ({ title, start: `2026-10-${d}T${s}`, end: `2026-10-${d}T${e}`, kind: 'task', guests: [], ...x });
const titled = re => cal.all().filter(e => re.test(e.title));
/** A model that answers with these tool calls, one turn at a time, then plain text. */
function scripted(...turns) {
  let i = 0;
  setAiBinding({ async run() {
    const t = turns[i++];
    if (!t) return { response: 'Done.' };
    if (typeof t === 'string') return { response: t };
    return { response: '', tool_calls: t.map(([name, args]) => ({ name, arguments: args })) };
  } });
}

await test('gpt-oss "analysis" leaks never reach the user', async () => {
  eq(stripChannels('analysisWe need to add haircut'), null, 'only reasoning = retry');
  eq(stripChannels('analysis: user wants x assistantfinalBooked.'), 'Booked.');
  eq(stripChannels('Analysis of your week: busy'), 'Analysis of your week: busy', 'a real sentence is kept');
  cal.replaceAll([ev('22', '11:00', '11:30', 'Vendor sync')]);
  let n = 0;
  setAiBinding({ async run() { n++; return n === 1 ? { response: 'analysisThe user wants the vendor sync. Let me look.' } : { response: 'Your vendor sync is tomorrow 11:00.' }; } });
  const r = await chat('tell me about the vendor thing');
  ok(!/analysis/i.test(r.reply), 'leak stripped: ' + r.reply);
  ok(/11:00/.test(r.reply), 'the retry answered');
});

await test('a time the user names is booked even over a clash, and the clash is reported', async () => {
  cal.replaceAll([ev('24', '17:00', '21:00', 'CFA class')]);
  const r = await chat('add yoga on saturday at 6pm');
  const y = titled(/yoga/i)[0];
  ok(y && y.start === '2026-10-24T18:00', 'booked at 18:00');
  ok(/overlaps CFA class/i.test(r.reply), 'heads-up given: ' + r.reply);
  eq(titled(/cfa class/i).length, 1, 'the class stays');
});

await test('without a named time, a clash is still avoided', async () => {
  cal.replaceAll([ev('22', '09:00', '18:00', 'Workshop')]);
  beginRun('chat', 'add a meeting with Sam on thursday');
  let err = '';
  try { await TOOLS.create_event({ title: 'Meeting with Sam', start: '2026-10-22T10:00', kind: 'meeting' }); } catch (e) { err = e.message; }
  ok(/Overlaps/.test(err), 'clash refused when the model picked the time');
});

await test('Hinglish: "kal shaam 6 baje gym" is tomorrow 18:00, in code', async () => {
  eq(hinglish('kal shaam 6 baje gym'), 'tomorrow evening at 6 gym');
  cal.replaceAll([]);
  const r = await chat('kal shaam 6 baje gym');
  const g = titled(/gym/i);
  eq(g.length, 1); eq(g[0].start, '2026-10-22T18:00');
  ok(/Gym/.test(r.reply));
});

await test('"yesterday" is understood, and never booked as today', async () => {
  eq(whenIn('add a meeting yesterday at 3pm').days, ['2026-10-20']);
  cal.replaceAll([]);
  const r = await chat('add a meeting yesterday at 3pm');
  eq(cal.all().length, 0, 'nothing booked');
  ok(/past/i.test(r.reply), r.reply);
});

await test('"cancel it" with nothing before it asks which event, without a model call', async () => {
  cal.replaceAll([ev('22', '21:00', '22:30', 'Project Deep Dive')]);
  let calls = 0; setAiBinding({ async run() { calls++; return { response: 'x' }; } });
  const r = await chat('cancel it');
  ok(/which event/i.test(r.reply), r.reply);
  eq(calls, 0); eq(titled(/deep dive/i).length, 1);
});

await test('a delete-by-query must use the user\'s words, not the model\'s guess', async () => {
  cal.replaceAll([ev('22', '21:00', '22:30', 'Project Deep Dive')]);
  beginRun('chat', 'cancel the thing');
  let err = '';
  try { await TOOLS.delete_events({ query: 'Project Deep Dive' }); } catch (e) { err = e.message; }
  ok(/never named/.test(err), err);
  eq(titled(/deep dive/i).length, 1);
});

await test('"clear my evening tomorrow" counts as asking to cancel', async () => {
  ok(userAskedToCancel('clear my evening tomorrow'));
  ok(!userAskedToCancel('is my evening clear?'));
});

await test('"push everything after 6pm" keeps going after the first move', async () => {
  cal.replaceAll([ev('22', '18:00', '19:00', 'Run'), ev('22', '20:00', '20:45', 'College Assignments')]);
  const ids = cal.all().map(e => e.id);
  // The model moves one event per turn; the loop must not stop after the first success.
  scripted([['move_event', { event_id: ids[0], shift_minutes: 30 }]], [['move_event', { event_id: ids[1], shift_minutes: 30 }]], [['finish', {}]]);
  await chat('push everything after 6pm tomorrow by 30 minutes');
  eq(titled(/^run/i)[0].start, '2026-10-22T18:30');
  eq(titled(/assignments/i)[0].start, '2026-10-22T20:30');
});

await test('a swap keeps the times the model gave, even though they overlap mid-way', async () => {
  cal.replaceAll([ev('26', '12:00', '13:00', 'Dentist'), { ...ev('05', '09:00', '09:30', 'Passport renewal'), start: '2026-11-05T09:00', end: '2026-11-05T09:30' }]);
  const [d, p] = cal.all().map(e => e.id);
  scripted([['move_event', { event_id: d, new_start: '2026-11-05T09:00' }], ['move_event', { event_id: p, new_start: '2026-10-26T12:00' }]], [['finish', {}]]);
  await chat('swap the dentist and the passport renewal');
  eq(titled(/dentist/i)[0].start, '2026-11-05T09:00');
  eq(titled(/passport/i)[0].start, '2026-10-26T12:00');
});

await test('"every weekday" with unit "day" still skips the weekend', async () => {
  cal.replaceAll([]);
  beginRun('chat', 'DSA practice every weekday at 7:30pm till 6 nov');
  await TOOLS.create_event({ title: 'DSA practice', start: '2026-10-21T19:30', duration_minutes: 60, repeat: { unit: 'day', weekdays: ['MO', 'TU', 'WE', 'TH', 'FR'], until: '2026-11-06' } });
  const all = titled(/dsa/i);
  eq(all.length, 13);
  ok(all.every(e => ![0, 6].includes(T.dow(T.day(e.start)))), 'no weekend');
});

await test('"the first one" points at the list the last reply showed', async () => {
  cal.replaceAll([ev('21', '15:00', '16:00', 'AI Lecture'), ev('23', '11:00', '12:00', 'AI Lecture'), ev('23', '21:00', '22:30', 'Project Deep Dive')]);
  await chat("what's on friday?"); // answered in code; it remembers what it listed
  const ctx = wrapUserMessage('cancel the first one');
  ok(/your last reply listed, in order[^\n]*1\. Fri 2026-10-23 11:00–12:00 AI Lecture/.test(ctx), ctx);
});

await test('a new event made by mistake in the same request can be taken back', async () => {
  cal.replaceAll([]);
  scripted([['create_event', { title: 'Gym', start: '2026-10-22T17:00', duration_minutes: 60 }]], [['create_event', { title: 'Gym', start: '2026-10-22T18:00', duration_minutes: 60 }], ['delete_events', { event_ids: ['E1'] }]], [['finish', {}]]);
  await chat('gym tomorrow evening and something else');
  eq(titled(/gym/i).map(e => e.start), ['2026-10-22T18:00']);
});

await test('v6 upgrade: the stronger model answers first; old announcements leave the chat', async () => {
  saveSettings({ aiOrder: ['gemini', 'groq', 'workers-ai'], workersAiModel: '@cf/qwen/qwen3-30b-a3b-fp8' });
  const st = load('state'); st.schema = 5;
  load('chat').messages.push({ role: 'assistant', text: '🚀 Upgraded to v3. New: lots', time: T.nowStr(), actions: [] }, { role: 'assistant', text: "🎉 I've been upgraded. New: x", time: T.nowStr(), actions: [] }, { role: 'user', text: 'hi', time: T.nowStr() });
  migrate();
  const s = load('settings');
  eq(s.workersAiModel, '@cf/openai/gpt-oss-120b'); eq(s.aiOrder[0], 'workers-ai');
  eq(load('chat').messages.map(m => m.text), ['hi']);
});

// ─── Scheduling algorithm (see eval/plan-bench.js for the full benchmark) ───
const lectures = () => { const out = []; for (let i = 0; i < 7; i++) { const d = T.addDays('2026-10-21', i); if (![0, 6].includes(T.dow(d))) out.push({ ...ev('', '09:30', '12:30', 'OS Lecture'), start: d + 'T09:30', end: d + 'T12:30' }); } return out; };
const sessionsOf = id => cal.all().filter(e => e.taskId === id);
const minsOf = list => list.reduce((n, e) => n + T.diffMin(e.start, e.end), 0);

await test('crunch: 20h of exam prep in 5 days is fully booked (rules relax), never overlapping', async () => {
  cal.replaceAll(lectures());
  beginRun('chat', '');
  await TOOLS.add_task({ title: 'Exam prep', minutes: 1200, due: '2026-10-26T09:00' });
  const t = load('tasks').items[0], mine = sessionsOf(t.id);
  eq(minsOf(mine), 1200, 'all 20h booked');
  ok(!t.atRisk, 'not flagged'); ok(t.crunch, 'marked tight');
  ok(mine.every(a => !cal.all().some(b => b.id !== a.id && T.overlaps(a, b))), 'no overlaps');
  const perDay = {}; for (const e of mine) perDay[T.day(e.start)] = (perDay[T.day(e.start)] || 0) + T.diffMin(e.start, e.end);
  ok(Math.max(...Object.values(perDay)) <= 600, 'no day over 10h of focus');
});

await test('a normal week keeps the comfortable rules: ≤ 2 sessions a day, nothing on the deadline day', async () => {
  cal.replaceAll(lectures());
  beginRun('chat', '');
  await TOOLS.add_task({ title: 'OS assignment', minutes: 240, due: '2026-10-25' });
  const mine = sessionsOf(load('tasks').items[0].id);
  eq(minsOf(mine), 240);
  const days = mine.map(e => T.day(e.start));
  ok(days.every(d => days.filter(x => x === d).length <= 2), 'at most 2 a day');
  ok(!days.includes('2026-10-25'), 'a day of slack');
  ok(!load('tasks').items[0].crunch);
});

await test('night owl (awake 11:00–02:00): work is booked in waking hours; chat bookings too', async () => {
  saveSettings({ dayStart: '11:00', dayEnd: '02:00', workStart: '12:00' });
  cal.replaceAll([]);
  beginRun('chat', '');
  await TOOLS.add_task({ title: 'Side project', minutes: 480, due: '2026-10-24' });
  const mine = sessionsOf(load('tasks').items[0].id);
  eq(minsOf(mine), 480);
  ok(mine.every(e => T.mins(e.start) >= 660 || T.mins(e.end) <= 120), 'only in waking hours');
  beginRun('chat', 'add reading tomorrow');
  const r = await TOOLS.create_event({ title: 'Reading', start: '2026-10-22' });
  ok(T.mins(r.event.start) >= 660, 'a chat booking lands in waking hours: ' + r.event.start);
});

await test('a missed session is booked again; a done one is not', async () => {
  cal.replaceAll(lectures());
  beginRun('chat', '');
  await TOOLS.add_task({ title: 'OS assignment', minutes: 240, due: '2026-10-25' });
  const first = sessionsOf(load('tasks').items[0].id).sort((a, b) => a.start.localeCompare(b.start))[0];
  T.setNow(T.addMin(first.end, 10));
  beginRun('auto'); await plan();
  eq(sessionsToConfirm().map(x => x.eventId), [first.id], 'asks about it');
  const futureBefore = minsOf(sessionsOf(load('tasks').items[0].id).filter(e => e.start > T.nowStr()));
  beginRun('chat', '');
  const r = await TOOLS.session_status({ event_id: first.id, status: 'missed' });
  ok(/booked again/.test(r.result), r.result);
  const futureAfter = minsOf(sessionsOf(load('tasks').items[0].id).filter(e => e.start > T.nowStr()));
  eq(futureAfter - futureBefore, T.diffMin(first.start, first.end), 'the missed time is back in the plan');
  eq(sessionsToConfirm().length, 0, 'answered');
});

await test('"I skipped my OS session" in chat: marked missed and re-booked, without the AI', async () => {
  cal.replaceAll(lectures());
  beginRun('chat', '');
  await TOOLS.add_task({ title: 'OS assignment', minutes: 240, due: '2026-10-25' });
  const first = sessionsOf(load('tasks').items[0].id).sort((a, b) => a.start.localeCompare(b.start))[0];
  T.setNow(T.addMin(first.end, 30));
  let calls = 0; setAiBinding({ async run() { calls++; return { response: 'x' }; } });
  const r = await chat('I skipped my OS session');
  ok(/booked again/.test(r.reply), r.reply);
  eq(calls, 0);
  ok(load('tasks').items[0].sessions.find(x => x.eventId === first.id).missed);
});

await test('plan my day lines are read in code: "5k run around 7pm" stays near 7pm even when deep work wants the evening', async () => {
  const { parseDayItem } = await import('../src/dayplan.js');
  eq(parseDayItem('5k run around 7pm'), { around: '19:00', title: '5k run' });
  eq(parseDayItem('CFA study 2h'), { minutes: 120, title: 'CFA study' });
  eq(parseDayItem('Weekly review in the evening 30 min'), { minutes: 30, after: '17:00', title: 'Weekly review' });
  cal.replaceAll([ev('22', '11:00', '12:00', 'AI Lecture'), ev('22', '20:00', '20:45', 'College Study Block')]);
  beginRun('chat', 'plan my day');
  const r = await TOOLS.plan_day({ date: '2026-10-22', items: ['CFA study 2h', 'Side project 3h', '5k run around 7pm', 'Weekly review in the evening 30 min'].map(parseDayItem) });
  const run = r.timeline.find(l => /5k run/.test(l));
  ok(run && Math.abs(T.hm(run.slice(0, 5)) - 19 * 60) <= 60, run);
});

await test('week load: commitments, focus and deadlines per day; heavy days flagged', async () => {
  cal.replaceAll([ev('21', '09:00', '19:00', 'Hackathon')]);
  beginRun('chat', '');
  await TOOLS.add_task({ title: 'Report', minutes: 120, due: '2026-10-23' });
  const w = weekLoad();
  eq(w.length, 7);
  ok(w[0].busy >= 540 && w[0].heavy, 'today is heavy');
  eq(w[2].due.map(x => x.title), ['Report']);
  eq(w.reduce((n, d) => n + d.focus, 0), 120);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
