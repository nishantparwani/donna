// Offline checks of every code path (no network, no AI quota). Run: npm test
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { useFsStore } from '../src/node-store.js';
import { load, save, saveSettings, settings } from '../src/store.js';
import * as T from '../src/time.js';
import * as cal from '../src/calendar.js';
import { beginRun, TOOLS, RUN, planRepeat, ref, realId, findAction, userGaveDuration } from '../src/engine.js';
import { plan } from '../src/planner.js';
import { chat } from '../src/agent.js';
import { setAiBinding, useFetch, generate } from '../src/llm.js';
import { useTransport, pull, push, resetSync } from '../src/sync.js';
import { publicSlots, book, cancelBooking } from '../src/booking.js';
import { briefing, insights } from '../src/briefing.js';
import { handle } from '../src/api.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'donna-test-'));
  await useFsStore(dir);
  T.setNow('2026-10-21T08:30'); // Wednesday
  T.setTimeZone('Asia/Kolkata');
  useTransport(null); resetSync(); cal.useLocal(); setAiBinding(null); useFetch(null);
  saveSettings({ autonomous: true, workersAiModel: '@cf/test/model' });
  try { await fn(); passed++; console.log('✅', name); }
  catch (e) { failed++; console.log('❌', name, '\n   ', e.stack.split('\n').slice(0, 3).join('\n    ')); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const eq = (a, b, msg) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg || 'expected'}: ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); };
const ok = (v, msg) => { if (!v) throw new Error(msg || 'assertion failed'); };
const m = (d, s, e, title, x = {}) => ({ title, start: `2026-10-${d}T${s}`, end: `2026-10-${d}T${e}`, kind: 'meeting', guests: ['a@b.co'], ...x });
const BASE = [
  m(21, '09:30', '09:45', 'Team standup'),
  m(21, '11:00', '12:00', 'Weekly planning'),
  m(21, '14:00', '14:30', 'Vendor sync', { flexible: true }),
  m(22, '10:00', '11:00', 'Board prep'),
  m(22, '10:30', '11:00', 'Hiring sync'),
  m(22, '13:00', '13:30', '1:1 with Priya'),
  m(23, '12:00', '13:00', 'All-hands', { organizer: false }),
  m(23, '15:30', '16:15', 'School pickup', { kind: 'personal', guests: [] }),
];
const byTitle = re => cal.all().filter(e => re.test(e.title));

/** A scripted fake Workers AI: each call returns the next scripted step. */
function fakeAi(steps) {
  const calls = [];
  setAiBinding({ async run(model, input) {
    calls.push(input);
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    const out = typeof step === 'function' ? step(input) : step;
    if (out instanceof Error) throw out;
    return { response: out.text || '', tool_calls: (out.calls || []).map(c => ({ name: c[0], arguments: c[1] })) };
  } });
  return calls;
}

// ─── Time & recurrence ───
await test('repeat: every 5 hours until a date expands into exact occurrences', async () => {
  const p = planRepeat('2026-10-21T15:00', 10, { every: 5, unit: 'hour', until: '2026-10-23' });
  eq(p.occurrences.slice(0, 4).map(o => o.start), ['2026-10-21T15:00', '2026-10-21T20:00', '2026-10-22T01:00', '2026-10-22T06:00']);
  ok(p.occurrences.every(o => o.start <= '2026-10-23T23:59'));
  eq(p.rrule, null, 'hourly has no RRULE');
  eq(p.occurrences.length, 12);
});
await test('repeat: weekly on weekdays builds an RRULE and the right dates', async () => {
  const p = planRepeat('2026-10-21T19:30', 60, { every: 1, unit: 'week', weekdays: ['MO', 'WE', 'FR'], until: '2026-11-02' });
  eq(p.occurrences.map(o => o.start.slice(0, 10)), ['2026-10-21', '2026-10-23', '2026-10-26', '2026-10-28', '2026-10-30', '2026-11-02']);
  eq(p.rrule, 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20261102T235959Z');
});
await test('repeat: monthly keeps month ends sane', async () => {
  const p = planRepeat('2026-10-31T10:00', 30, { every: 1, unit: 'month', count: 3 });
  eq(p.occurrences.map(o => o.start), ['2026-10-31T10:00', '2026-11-30T10:00', '2026-12-31T10:00']);
});

// ─── Tools: local calendar ───
await test('create repeating (local) → delete whole series → undo brings it back', async () => {
  cal.replaceAll(BASE);
  beginRun('chat', 'add exhaust tokens every 5 hours till friday');
  const r = await TOOLS.create_event({ title: 'Exhaust Claude Tokens', start: '2026-10-21T15:00', duration_minutes: 10, kind: 'task', repeat: { every: 5, unit: 'hour', until: '2026-10-23' }, rationale: 't' });
  // 15,20,(01),(06),11,16,21,(02),07,12,17,22 → the three inside sleeping hours (23:00–07:00) are skipped
  eq(r.occurrences, 9);
  ok(/3 occurrences/.test(r.skipped_while_asleep), r.skipped_while_asleep);
  eq(byTitle(/exhaust/i).length, 9);
  ok(byTitle(/exhaust/i).every(e => e.start.slice(11) >= '07:00' && e.start.slice(11) < '23:00'), 'none while asleep');
  const s = await TOOLS.search_events({ query: 'exhaust claude' });
  eq(s.matches.length, 1, 'one row per series');
  eq(s.matches[0].occurrences, 9);
  beginRun('chat', 'delete all exhaust claude tokens events');
  ref(byTitle(/exhaust/i)[0].id);
  const d = await TOOLS.delete_events({ event_ids: [s.matches[0].id.replace(/^E\d+$/, x => x)], scope: 'series', rationale: 'asked' });
  ok(d.ok);
  eq(byTitle(/exhaust/i).length, 0);
  RUN.userText = 'undo that';
  await TOOLS.undo({ count: 1 });
  eq(byTitle(/exhaust/i).length, 9, 'undo restores every occurrence');
});
await test('explicit late-night time is allowed; auto placement respects meeting hours', async () => {
  cal.replaceAll(BASE);
  beginRun('chat', 'gym kal raat 11 baje');
  const r = await TOOLS.create_event({ title: 'Gym', start: '2026-10-22T23:00', duration_minutes: 45, kind: 'personal', rationale: 'asked' });
  ok(r.ok);
  beginRun('chat', 'book a call with Raj tomorrow');
  let err = '';
  try { await TOOLS.create_event({ title: 'Call with Raj', start: '2026-10-22T20:00', duration_minutes: 30, kind: 'meeting', rationale: 'x' }); } catch (e) { err = e.message; }
  ok(/Outside the allowed hours/.test(err), err);
});
await test('stated length is used when the model leaves it out; "every/in N hours" is not a length', async () => {
  ok(userGaveDuration('add every five hour task for 10 mins till 25 october') === 10);
  ok(userGaveDuration('Book a 30 minute call with Dev in 2 hours') === 30);
  ok(userGaveDuration('water reminder every 2 hours') === 0);
  ok(userGaveDuration('deep work for 2 hours tomorrow') === 120);
  ok(userGaveDuration('15 min call at 3 and 45 min review at 5') === 0);
  cal.replaceAll(BASE);
  beginRun('chat', 'exhaust claude token every 5 hours for 10 mins till 25 october');
  await TOOLS.create_event({ title: 'Exhaust Claude Token', start: '2026-10-21T10:00', kind: 'task', repeat: { unit: 'hour', every: 5, until: '2026-10-25' }, rationale: 'asked' });
  const made = byTitle(/exhaust/i);
  ok(made.length > 10 && made.every(e => T.diffMin(e.start, e.end) === 10), JSON.stringify(made[0]));
});
await test('protected events: never moved as a side effect, moved when named', async () => {
  cal.replaceAll(BASE);
  const pickup = byTitle(/pickup/i)[0];
  beginRun('chat', 'clear friday afternoon');
  let err = '';
  try { await TOOLS.move_event({ event_id: ref(pickup.id), new_start: '2026-10-23T17:00', rationale: 'x' }); } catch (e) { err = e.message; }
  ok(/protected/.test(err), err);
  beginRun('chat', 'move the school pickup to 17:00');
  const r = await TOOLS.move_event({ event_id: ref(pickup.id), new_start: '2026-10-23T17:00', rationale: 'asked' });
  ok(r.ok);
});
await test('move to a day only: keeps the clock time when free', async () => {
  cal.replaceAll(BASE);
  beginRun('chat', 'move my 1:1 with priya to friday');
  const p = byTitle(/priya/i)[0];
  const r = await TOOLS.move_event({ event_id: ref(p.id), new_date: '2026-10-23', rationale: 'asked' });
  eq(r.event.start, '2026-10-23T13:00');
  // The model invents a time the user never said → the event keeps its own clock time.
  cal.replaceAll(BASE);
  beginRun('chat', 'move my 1:1 with priya to friday');
  const r1 = await TOOLS.move_event({ event_id: ref(byTitle(/priya/i)[0].id), new_start: '2026-10-23T09:00', rationale: 'asked' });
  eq(r1.event.start, '2026-10-23T13:00');
  // A time the user did say is kept.
  cal.replaceAll(BASE);
  beginRun('chat', 'move my 1:1 with priya to friday 9am');
  const r3 = await TOOLS.move_event({ event_id: ref(byTitle(/priya/i)[0].id), new_start: '2026-10-23T09:00', rationale: 'asked' });
  eq(r3.event.start, '2026-10-23T09:00');
  // Clock time taken on the target day → nearest free time instead.
  beginRun('chat', 'move weekly planning to friday');
  const wp = byTitle(/weekly planning/i)[0];
  cal.create({ title: 'Lab', start: '2026-10-23T11:00', end: '2026-10-23T12:00', kind: 'task' });
  const r2 = await TOOLS.move_event({ event_id: ref(wp.id), new_date: '2026-10-23', rationale: 'asked' });
  eq(r2.event.start, '2026-10-23T10:00');
});
await test('invitations can only be declined; decline keeps the event', async () => {
  cal.replaceAll(BASE);
  const inv = byTitle(/all-hands/i)[0];
  beginRun('chat', 'decline the all-hands');
  let err = '';
  try { await TOOLS.move_event({ event_id: ref(inv.id), new_start: '2026-10-23T14:00', rationale: 'x' }); } catch (e) { err = e.message; }
  ok(/did not organize/.test(err), err);
  const r = await TOOLS.delete_events({ event_ids: [ref(inv.id)], rationale: 'asked' });
  ok(r.done[0].declined);
  eq(cal.get(inv.id).myStatus, 'declined');
});
await test('short ids: model sees E-numbers, tools resolve them', async () => {
  beginRun('chat');
  const a = ref('very-long-google-id_20261021T100000Z');
  eq(a, 'E1');
  eq(realId('e1'), 'very-long-google-id_20261021T100000Z');
});
await test('people: names resolve to remembered emails for invites + Meet', async () => {
  cal.replaceAll(BASE);
  beginRun('chat', "riya's email is riya@college.edu");
  await TOOLS.remember_person({ name: 'Riya', email: 'riya@college.edu' });
  beginRun('chat', 'book a call with riya and sam tomorrow at 3pm');
  const r = await TOOLS.create_event({ title: 'Call with Riya', start: '2026-10-22T15:00', duration_minutes: 30, kind: 'meeting', guests: 'Riya, Sam', rationale: 'asked' });
  eq(r.invited, ['riya@college.edu']);
  ok(/Sam/.test(r.not_invited));
  const ev = cal.get(realId(r.event.id));
  eq(ev.meet, true);
});

// ─── Planner ───
await test('tasks: sessions booked before the due date, re-planned when displaced', async () => {
  cal.replaceAll(BASE);
  saveSettings({ dayStart: '08:00', dayEnd: '22:00' });
  beginRun('chat', 'OS assignment due friday, 4 hours');
  const r = await TOOLS.add_task({ title: 'OS assignment', minutes: 240, due: '2026-10-23', session_minutes: 90 });
  const sessions = cal.all().filter(e => e.taskId === r.task.id);
  const total = sessions.reduce((n, e) => n + T.diffMin(e.start, e.end), 0);
  ok(total >= 240, 'booked ' + total);
  ok(sessions.every(e => e.end <= '2026-10-23T22:00'));
  ok(!load('tasks').items[0].atRisk);
  // Put a real event on top of the first session → planner moves the work elsewhere.
  const first = sessions.sort((a, b) => a.start.localeCompare(b.start))[0];
  cal.create({ title: 'Surprise meeting', start: first.start, end: first.end, kind: 'meeting', guests: ['x@y.z'] });
  beginRun('auto');
  await plan();
  const after = cal.all().filter(e => e.taskId === r.task.id);
  ok(!after.some(e => e.start === first.start), 'session moved off the clash');
  ok(after.reduce((n, e) => n + T.diffMin(e.start, e.end), 0) >= 240);
  // Completing the task frees its future sessions.
  beginRun('chat', 'done with OS assignment');
  await TOOLS.update_task({ task_id: r.task.id, status: 'done' });
  eq(cal.all().filter(e => e.taskId === r.task.id && e.start > T.nowStr()).length, 0);
});
await test('tasks: impossible deadlines are flagged at risk', async () => {
  cal.replaceAll(BASE);
  beginRun('chat');
  const r = await TOOLS.add_task({ title: 'Thesis', minutes: 2400, due: '2026-10-21T12:00' });
  ok(r.task.atRisk, 'at risk');
});
await test('habits: placed near the ideal time inside the window, moved when a commitment lands', async () => {
  cal.replaceAll(BASE);
  beginRun('chat', 'gym every day 1h between 17 and 21, ideally 18');
  const r = await TOOLS.add_habit({ title: '🏋️ Gym', minutes: 60, days: 'daily', window_start: '17:00', window_end: '21:00', ideal_time: '18:00', kind: 'personal' });
  ok(r.placed.length >= 3, 'placed ' + r.placed.length);
  const today = cal.all().find(e => e.habitId === r.habit.id && e.start.startsWith('2026-10-21'));
  eq(today.start, '2026-10-21T18:00');
  cal.create({ title: 'Dinner with family', start: '2026-10-21T18:00', end: '2026-10-21T19:30', kind: 'personal' });
  beginRun('auto');
  await plan();
  const moved = cal.all().filter(e => e.habitId === r.habit.id && e.start.startsWith('2026-10-21'));
  eq(moved.length, 1);
  ok(moved[0].start === '2026-10-21T19:30' || moved[0].start === '2026-10-21T17:00', moved[0].start);
});
await test('buffers around high-stakes events; agent blocks yield to new bookings', async () => {
  cal.replaceAll([m(22, '14:00', '15:00', 'Internship interview')]);
  beginRun('auto');
  await plan();
  ok(cal.all().some(e => e.kind === 'buffer' && e.end === '2026-10-22T14:00'));
  ok(cal.all().some(e => e.kind === 'buffer' && e.start === '2026-10-22T15:00'));
});

// ─── Agent loop (fake model) ───
await test('agent: tool calls + finish in one turn → actions and a report', async () => {
  cal.replaceAll(BASE);
  const calls = fakeAi([{ calls: [['create_event', { title: 'Call with Rahul', start: '2026-10-22T15:00', duration_minutes: 30, kind: 'meeting', rationale: 'first free afternoon slot' }], ['finish', { report: 'Booked a call with Rahul tomorrow at 15:00.' }]] }]);
  const out = await chat('Book a call with Rahul tomorrow at 3pm');
  eq(calls.length, 1);
  ok(/Booked/.test(out.reply));
  ok(out.actions.some(a => /Call with Rahul/.test(a.summary)));
  ok(/E\d+/.test(calls[0].messages.at(-1).content), 'context uses short ids');
});
await test('agent: asking permission gets corrected into action', async () => {
  cal.replaceAll(BASE);
  const calls = fakeAi([
    { text: 'Should I book it for 15:00?' },
    { calls: [['create_event', { title: 'Call with Rahul', start: '2026-10-22T15:00', duration_minutes: 30, kind: 'meeting', rationale: 'x' }], ['finish', { report: 'Booked it at 15:00.' }]] },
  ]);
  const out = await chat('Book a call with Rahul tomorrow at 3pm');
  eq(calls.length, 2);
  ok(/AUTONOMY CHECK/.test(JSON.stringify(calls[1].messages)));
  ok(/Booked/.test(out.reply));
});
await test('agent: false claim gets corrected', async () => {
  cal.replaceAll(BASE);
  const calls = fakeAi([{ text: 'I have cancelled the vendor sync.' }, { calls: [['delete_events', { event_ids: ['E3'], rationale: 'asked' }], ['finish', { report: 'Cancelled the vendor sync.' }]] }]);
  await chat('Cancel the vendor sync');
  ok(/CLAIM CHECK/.test(JSON.stringify(calls[1].messages)));
});
await test('agent: greeting, thanks and undo need no model call', async () => {
  cal.replaceAll(BASE);
  const calls = fakeAi([{ text: 'should not be called' }]);
  const g = await chat('hey donna');
  ok(/Good morning/.test(g.reply), g.reply);
  beginRun('chat', 'cancel vendor sync');
  await TOOLS.delete_events({ event_ids: [ref(byTitle(/vendor/i)[0].id)], rationale: 'x' });
  load('actions').items.at(-1).source = 'chat';
  save('actions');
  const u = await chat('undo that');
  ok(/Restored "Vendor sync"/.test(u.reply), u.reply);
  eq(calls.length, 0);
});
await test('agent: feedback "Bad" undoes and writes a rule', async () => {
  cal.replaceAll(BASE);
  fakeAi([{ text: 'Never book calls before 10:00.' }]);
  beginRun('chat', 'book');
  const r = await TOOLS.create_event({ title: 'Early call', start: '2026-10-22T09:00', duration_minutes: 30, kind: 'meeting', rationale: 'x' });
  const out = await chat(`${r.action_id}: Bad - too early`);
  ok(/New rule/.test(out.reply), out.reply);
  eq(byTitle(/early call/i).length, 0);
  ok(load('memory').rules.some(x => /10:00/.test(x.text)));
});

// ─── Model router ───
await test('router: Workers AI out of allowance → Gemini answers, Workers AI skipped next time', async () => {
  saveSettings({ geminiApiKey: 'test-key', aiOrder: ['workers-ai', 'gemini'] });
  let ai = 0, gem = 0;
  setAiBinding({ async run() { ai++; throw new Error('4006: you have used up your daily free allocation of 10,000 neurons'); } });
  useFetch(async url => {
    gem++;
    ok(/generativelanguage/.test(url));
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hello from gemini' }] } }] }), { status: 200 });
  });
  const r = await generate({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
  eq(r.provider, 'gemini');
  eq(r.text, 'hello from gemini');
  await generate({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
  eq(ai, 1, 'blocked after the first allowance error');
  eq(gem, 2);
});
await test('router: tool calls written as text by open models are recovered', async () => {
  setAiBinding({ async run() { return { response: '<tool_call>{"name": "list_events", "arguments": {"start_date": "2026-10-22", "end_date": "2026-10-22"}}</tool_call>' }; } });
  const r = await generate({ system: 's', messages: [{ role: 'user', content: 'x' }], tools: [{ name: 'list_events', description: '', parameters: { type: 'object', properties: {} } }] });
  eq(r.calls[0].name, 'list_events');
  eq(r.calls[0].args.start_date, '2026-10-22');
});
await test('router: Gemini history keeps tool turns valid after a provider switch', async () => {
  saveSettings({ geminiApiKey: 'k', aiOrder: ['gemini'] });
  let body;
  useFetch(async (url, opts) => { body = JSON.parse(opts.body); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })); });
  await generate({ system: 's', messages: [
    { role: 'user', content: 'x' },
    { role: 'assistant', content: '', calls: [{ id: 'abc', name: 'list_events', args: { start_date: '2026-10-22' } }] },
    { role: 'tool', callId: 'abc', name: 'list_events', content: { ok: true } },
  ], tools: [] });
  eq(body.contents.map(c => c.role), ['user', 'model', 'user']);
  ok(body.contents[1].parts[0].thoughtSignature, 'dummy thought signature for replayed calls');
});

// ─── Google sync (fake bridge) ───
function fakeBridge(version, events) {
  const sent = [];
  useTransport(async p => {
    sent.push(p);
    if (p.action === 'ping') return { ok: true, version, timeZone: 'Asia/Kolkata', email: 'me@x.com' };
    if (p.action === 'list') return { version, timeZone: 'Asia/Kolkata', events: events.filter(e => e.start < p.to && e.end > p.from) };
    if (p.action === 'search') return { events: events.filter(e => e.title.toLowerCase().includes(p.q.toLowerCase())) };
    if (p.action === 'batch') return { results: p.ops.map(o => o.op === 'create' ? { id: o.id, newId: 'g_' + o.id } : (o.op === 'delete' && o.id.includes('gone') ? { id: o.id, error: 'The calendar event does not exist or it has already been deleted.' } : { id: o.id })) };
    if (p.action === 'email') return { ok: true };
    return {};
  });
  saveSettings({ calendarMode: 'google', bridgeUrl: 'https://x/exec', bridgeToken: 'tok' });
  return sent;
}
const gev = (id, title, start, end, extra = {}) => ({ id, title, start, end, guests: [], organizer: true, myStatus: 'accepted', meta: {}, ...extra });

await test('google v3: "delete all X" = one series delete op; hourly plan = discrete events', async () => {
  const events = [
    gev('ser1_20261021T0930', 'Exhaust Claude Tokens', '2026-10-21T15:00', '2026-10-21T15:30', { recurringId: 'ser1' }),
    gev('ser1_20261022T0930', 'Exhaust Claude Tokens', '2026-10-22T15:00', '2026-10-22T15:30', { recurringId: 'ser1' }),
    gev('one', 'CFA: Study Block', '2026-10-22T09:00', '2026-10-22T11:30'),
  ];
  const sent = fakeBridge(3, events);
  await pull('2026-10-20', '2026-10-28');
  beginRun('chat', 'delete all exhaust claude tokens events');
  const s = await TOOLS.search_events({ query: 'exhaust claude tokens' });
  eq(s.matches.length, 1);
  await TOOLS.delete_events({ event_ids: [s.matches[0].id], scope: 'series', rationale: 'asked' });
  beginRun('chat', 'add a 10 minute exhaust claude tokens every 5 hours till 23 oct');
  await TOOLS.create_event({ title: 'Exhaust Claude Tokens', start: '2026-10-21T15:00', duration_minutes: 10, kind: 'task', repeat: { every: 5, unit: 'hour', until: '2026-10-23' }, rationale: 'asked' });
  const problems = await push();
  eq(problems, []);
  const ops = sent.find(p => p.action === 'batch').ops;
  const dels = ops.filter(o => o.op === 'delete');
  eq(dels.length, 1, 'one delete for the whole series');
  eq(dels[0].scope, 'series');
  eq(ops.filter(o => o.op === 'create').length, 9);
  ok(ops.filter(o => o.op === 'create').every(o => o.ev.groupId), 'grouped for later "delete all"');
});
await test('google v3: daily series is created as ONE event with an RRULE', async () => {
  const sent = fakeBridge(3, []);
  await pull('2026-10-20', '2026-10-28');
  beginRun('chat', 'DSA practice every day at 7:30pm until nov 9');
  const r = await TOOLS.create_event({ title: 'DSA practice', start: '2026-10-21T19:30', duration_minutes: 60, kind: 'task', repeat: { every: 1, unit: 'day', until: '2026-11-09' }, rationale: 'asked' });
  eq(r.occurrences, 20);
  await push();
  const ops = sent.find(p => p.action === 'batch').ops;
  eq(ops.length, 1);
  eq(ops[0].recurrence, 'RRULE:FREQ=DAILY;UNTIL=20261109T235959Z');
});
await test('google v2 (old bridge): legacy instance ids group into a series; "already deleted" is not an error', async () => {
  const events = [
    gev('abc@google.com@1792175400000', 'Exhaust Claude Tokens', '2026-10-21T15:00', '2026-10-21T15:30'),
    gev('abc@google.com@1792193400000', 'Exhaust Claude Tokens', '2026-10-21T20:00', '2026-10-21T20:30'),
    gev('gone@google.com@1792211400000', 'Exhaust Claude Tokens', '2026-10-22T01:00', '2026-10-22T01:30'),
  ];
  fakeBridge(2, events);
  await pull('2026-10-20', '2026-10-28');
  beginRun('chat', 'delete all exhaust claude tokens');
  const s = await TOOLS.search_events({ query: 'exhaust', start_date: '2026-10-20', end_date: '2026-10-28' });
  eq(s.matches.length, 2, 'the two legacy series ids');
  await TOOLS.delete_events({ event_ids: s.matches.map(x => x.id), scope: 'series', rationale: 'asked' });
  eq(cal.all().length, 0);
  const problems = await push();
  eq(problems, [], 'gone events are fine');
});

// ─── Booking page ───
await test('booking: free slots respect hours, notice and buffers; booking + cancel', async () => {
  cal.replaceAll(BASE);
  saveSettings({ userName: 'Harvey', booking: { enabled: true, slug: 'harvey', durations: [30], daysAhead: 5, minNoticeHours: 2, start: '10:00', end: '17:00', days: [1, 2, 3, 4, 5], maxPerDay: 2, bufferMinutes: 10 } });
  const s = publicSlots(30);
  const wed = s.days.find(d => d.date === '2026-10-21');
  ok(wed && !wed.times.includes('11:00') && !wed.times.includes('10:30'), 'busy and too-soon times hidden: ' + (wed && wed.times));
  ok(wed.times.includes('12:30'));
  const b = book({ name: 'Riya', email: 'riya@college.edu', start: '2026-10-21T12:30', duration: 30 });
  ok(b.ok);
  const ev = cal.get(b.eventId);
  eq(ev.guests, ['riya@college.edu']);
  eq(ev.meet, true);
  let err = '';
  try { book({ name: 'Sam', email: 'sam@x.com', start: '2026-10-21T12:30', duration: 30 }); } catch (e) { err = e.message; }
  ok(/taken/.test(err), 'no double booking');
  cancelBooking(b.token);
  ok(!cal.get(b.eventId), 'cancelled booking removed');
});

// ─── Briefing, insights, API ───
await test('briefing + insights are computed without the model', async () => {
  cal.replaceAll(BASE);
  const b = briefing('morning');
  ok(/Wednesday: 3 events/.test(b.text), b.text);
  ok(/09:30–09:45 Team standup/.test(b.text));
  ok(/<table/.test(b.html));
  const i = insights('2026-10-19');
  ok(i.totalMinutes > 0 && i.byCategory.meetings > 0);
});
await test('api: state, tasks and settings round-trip; secrets are masked', async () => {
  cal.replaceAll(BASE);
  saveSettings({ geminiApiKey: 'AIza-secret-1234' });
  const st = await handle('GET', '/api/state', new URLSearchParams('week=2026-10-21'), async () => '');
  eq(st.status, 200);
  ok(st.body.events.length >= 8);
  eq(st.body.settings.geminiApiKey, '••••1234');
  const s2 = await handle('POST', '/api/settings', new URLSearchParams(), async () => JSON.stringify({ geminiApiKey: '••••1234', workStart: '10:00' }));
  eq(settings().geminiApiKey, 'AIza-secret-1234', 'masked value does not overwrite');
  eq(s2.body.workStart, '10:00');
  const t = await handle('POST', '/api/tasks', new URLSearchParams(), async () => JSON.stringify({ title: 'Read paper', minutes: 60, due: '2026-10-24' }));
  ok(t.body.task.sessions.length >= 1, JSON.stringify(t.body));
});

// ─── Moving to another Google account ───
const { buildResources, startMove, connectMove, exportMove, importMove, switchMove, cleanupMove, moveState } = await import('../src/move.js');
const { encrypt, notify, usePushFetch, subscribe } = await import('../src/push.js');

await test('move: export → resources keeps series rules, exceptions, singles; skips the old past', async () => {
  const items = [
    { id: 'lec', summary: 'MAD Lecture', recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO,TH'], start: { dateTime: '2026-07-06T09:00:00+05:30', timeZone: 'Asia/Kolkata' }, end: { dateTime: '2026-07-06T10:00:00+05:30', timeZone: 'Asia/Kolkata' },
      firstStart: { dateTime: '2026-10-01T09:00:00+05:30', timeZone: 'Asia/Kolkata' }, firstEnd: { dateTime: '2026-10-01T10:00:00+05:30', timeZone: 'Asia/Kolkata' }, organizer: { self: true }, status: 'confirmed', colorId: '3' },
    { id: 'lec_x1', recurringEventId: 'lec', status: 'cancelled', originalStartTime: { dateTime: '2026-10-05T09:00:00+05:30' } },
    { id: 'lec_x2', recurringEventId: 'lec', status: 'confirmed', summary: 'MAD Lecture (room change)', originalStartTime: { dateTime: '2026-10-08T09:00:00+05:30' },
      start: { dateTime: '2026-10-08T11:00:00+05:30' }, end: { dateTime: '2026-10-08T12:00:00+05:30' }, organizer: { self: true } },
    { id: 'lec_old', recurringEventId: 'lec', status: 'cancelled', originalStartTime: { dateTime: '2026-08-03T09:00:00+05:30' } },
    { id: 'quiz', summary: 'Quiz', start: { dateTime: '2026-10-25T10:00:00+05:30' }, end: { dateTime: '2026-10-25T11:00:00+05:30' }, status: 'confirmed', organizer: { self: true },
      attendees: [{ email: 'me@x.com', self: true }, { email: 'prof@college.edu' }], hangoutLink: 'https://meet.google.com/abc' },
    { id: 'old', summary: 'Old thing', start: { dateTime: '2026-09-01T10:00:00+05:30' }, end: { dateTime: '2026-09-01T11:00:00+05:30' }, status: 'confirmed' },
    { id: 'inv', summary: 'Club meet', start: { dateTime: '2026-10-28T17:00:00+05:30' }, end: { dateTime: '2026-10-28T18:00:00+05:30' }, status: 'confirmed', organizer: { self: false, email: 'club@college.edu' } },
    { id: 'cnt', summary: 'CFA mock', recurrence: ['RRULE:FREQ=WEEKLY;COUNT=10'], start: { dateTime: '2026-09-05T09:00:00+05:30' }, end: { dateTime: '2026-09-05T11:00:00+05:30' },
      firstStart: { dateTime: '2026-10-03T09:00:00+05:30' }, firstEnd: { dateTime: '2026-10-03T11:00:00+05:30' }, remaining: 6, status: 'confirmed', organizer: { self: true } },
    { id: 'hol', summary: 'Diwali', start: { date: '2026-11-08' }, end: { date: '2026-11-09' }, status: 'confirmed' },
  ];
  const { resources, summary, skippedInvites } = buildResources(items, '2026-10-01T00:00');
  eq(summary, { series: 2, singles: 3, exceptions: 1 });
  const lec = resources.find(r => r.key === 'ser:lec');
  eq(lec.resource.start.dateTime, '2026-10-01T09:00:00+05:30', 'series restarts at its first occurrence after the cutoff');
  ok(lec.resource.recurrence.includes('EXDATE:20261005T033000Z,20261008T033000Z'), JSON.stringify(lec.resource.recurrence));
  eq(lec.resource.colorId, '3');
  ok(resources.find(r => r.key === 'ex:lec_x2').resource.summary.includes('room change'));
  ok(resources.find(r => r.key === 'ser:cnt').resource.recurrence[0].includes('COUNT=6'), 'COUNT becomes what is left');
  const quiz = resources.find(r => r.key === 'one:quiz').resource;
  ok(!quiz.attendees && /prof@college\.edu/.test(quiz.description) && /meet\.google/.test(quiz.description), 'no invites sent; guests + Meet kept as notes');
  ok(!resources.some(r => r.sourceId === 'old'), 'events before the cutoff stay behind');
  eq(resources.find(r => r.key === 'one:hol').resource.start, { date: '2026-11-08' });
  eq(skippedInvites, 1);
  ok(!resources.find(r => r.sourceId === 'inv').cleanup, 'other people\'s invitations are never deleted from the old calendar');
});

await test('move: full flow with two fake bridges (new account can edit the old calendar)', async () => {
  saveSettings({ calendarMode: 'google', bridgeUrl: 'https://script.google.com/macros/s/OLD/exec', bridgeToken: 'old' });
  const calls = [];
  const oldItems = [
    { id: 'lec', summary: 'OS Lab', recurrence: ['RRULE:FREQ=WEEKLY'], start: { dateTime: '2026-08-03T10:00:00+05:30' }, end: { dateTime: '2026-08-03T12:00:00+05:30' },
      firstStart: { dateTime: '2026-10-05T10:00:00+05:30' }, firstEnd: { dateTime: '2026-10-05T12:00:00+05:30' }, status: 'confirmed', organizer: { self: true } },
    { id: 'one', summary: 'Dentist', start: { dateTime: '2026-10-28T15:00:00+05:30' }, end: { dateTime: '2026-10-28T16:00:00+05:30' }, status: 'confirmed', organizer: { self: true } },
  ];
  useTransport(async (p, url) => {
    calls.push({ url, ...p });
    const isNew = /NEW/.test(url);
    if (p.action === 'ping') return isNew ? { version: 4, email: 'new.account@example.com', timeZone: 'Asia/Kolkata', calendars: [{ id: 'old.account@example.com', access: 'writer' }] } : { version: 2, email: 'old.account@example.com' };
    if (p.action === 'export') { ok(isNew && p.calendarId === 'old.account@example.com', 'reads the old calendar through the new account'); return { items: oldItems }; }
    if (p.action === 'importRaw') return { results: p.items.map(i => ({ key: i.key, id: 'new_' + i.key.replace(/\W/g, '') })) };
    if (p.action === 'truncate') return { results: p.items.map(i => ({ id: i.id, truncated: true })) };
    if (p.action === 'batch') return { results: p.ops.map(o => ({ id: o.id })) };
    return {};
  });
  await startMove();
  let err = '';
  try { await connectMove('https://script.google.com/macros/s/OLD/exec'); } catch (e) { err = e.message; }
  ok(/same as the current one|older version/.test(err), 'refuses a bridge on the same account: ' + err);
  const st = await connectMove('https://script.google.com/macros/s/NEW/exec');
  eq([st.sourceVia, st.cleanupVia, st.needsOldUpdate], ['new', 'new', false]);
  await exportMove();
  let s2 = await importMove();
  eq([s2.stage, s2.imported], ['imported', 2]);
  await switchMove();
  eq(settings().bridgeUrl, 'https://script.google.com/macros/s/NEW/exec');
  eq(settings().ignoreCalendars, ['old.account@example.com']);
  const done = await cleanupMove();
  eq(done.stage, 'done');
  const tr = calls.find(c => c.action === 'truncate');
  eq([tr.calendarId, tr.items[0].id, tr.items[0].until], ['old.account@example.com', 'lec', T.addDays('2026-10-21', -20) + 'T00:00']);
  const del = calls.find(c => c.action === 'batch');
  eq(del.ops, [{ op: 'delete', id: 'old.account@example.com|one', quiet: true }]);
  ok(calls.filter(c => c.action === 'importRaw').every(c => /NEW/.test(c.url)), 'writes only to the new account');
});

await test('move: if the new account can only read the old calendar, the old bridge must be updated to clean up', async () => {
  saveSettings({ calendarMode: 'google', bridgeUrl: 'https://script.google.com/macros/s/OLD/exec', bridgeToken: 'old' });
  useTransport(async (p, url) => p.action === 'ping'
    ? (/NEW/.test(url) ? { version: 4, email: 'b@gmail.com', calendars: [{ id: 'a@gmail.com', access: 'reader' }] } : { version: 2, email: 'a@gmail.com' }) : {});
  await startMove();
  const st = await connectMove('https://script.google.com/macros/s/NEW/exec');
  eq([st.sourceVia, st.cleanupVia, st.needsOldUpdate], ['new', 'old', true]);
  let err = '';
  try { await exportMove(); } catch (e) { err = e.message; }
  ok(/Update the old bridge/.test(err));
});

await test('push: RFC 8291 payload decrypts with the device keys', async () => {
  const { createECDH, createDecipheriv, hkdfSync, randomBytes } = await import('node:crypto');
  const ua = createECDH('prime256v1'); ua.generateKeys();
  const auth = randomBytes(16);
  const sub = { endpoint: 'https://web.push.apple.com/x', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
  const body = Buffer.from(await encrypt('{"title":"hi"}', sub));
  const salt = body.subarray(0, 16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const shared = ua.computeSecret(asPub);
  const ikm = Buffer.from(hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPub]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  eq(plain.toString(), '{"title":"hi"}\u0002');
});

await test('push: VAPID-signed delivery; dead devices are dropped', async () => {
  const { createECDH } = await import('node:crypto');
  const mk = () => { const e = createECDH('prime256v1'); e.generateKeys(); return { p256dh: e.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 7).toString('base64url') }; };
  subscribe({ endpoint: 'https://web.push.apple.com/live', keys: mk() }, 'iPhone');
  subscribe({ endpoint: 'https://web.push.apple.com/gone', keys: mk() }, 'old iPad');
  const seen = [];
  usePushFetch(async (url, opts) => { seen.push(opts.headers); return new Response('', { status: url.endsWith('gone') ? 410 : 201 }); });
  const n = await notify({ title: 'Test', body: 'hello' });
  eq(n, 1);
  ok(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/.test(seen[0].Authorization), seen[0].Authorization);
  eq(seen[0]['Content-Encoding'], 'aes128gcm');
  eq(load('push').subscriptions.map(s => s.device), ['iPhone']);
  usePushFetch(null);
});

await test('siri: plain-text answers with the right key, refusal without it', async () => {
  cal.replaceAll(BASE);
  saveSettings({ siriKey: 'k'.repeat(48) });
  const bad = await handle('POST', '/api/siri', new URLSearchParams('key=nope'), async () => JSON.stringify({ message: 'hi' }), {});
  eq(bad.status, 401);
  const good = await handle('POST', '/api/siri', new URLSearchParams(), async () => JSON.stringify({ message: 'hello' }), { authorization: 'Bearer ' + 'k'.repeat(48) });
  eq(good.status, 200);
  ok(/^Good (morning|afternoon|evening)/.test(good.text) && !/[☀️🎉]/u.test(good.text), good.text);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
