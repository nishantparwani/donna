// Offline checks for v8: reminders (things to remember with no date). They never touch the calendar;
// anything with a day or a time in it still becomes an event.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { useFsStore } from '../src/node-store.js';
import { saveSettings, load } from '../src/store.js';
import * as T from '../src/time.js';
import * as cal from '../src/calendar.js';
import { setAiBinding, useFetch } from '../src/llm.js';
import { useTransport, resetSync } from '../src/sync.js';
import { chat } from '../src/agent.js';
import { handle } from '../src/api.js';
import { reminderIn, listTitle, listDay } from '../src/reminders.js';
import { findConflicts } from '../src/planner.js';
import { isReminderList } from '../src/engine.js';
const listEvents = () => cal.all().filter(isReminderList).sort((a, b) => a.start.localeCompare(b.start));

let passed = 0, failed = 0;
async function test(name, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'donna-v8-'));
  await useFsStore(dir);
  T.setNow('2026-11-10T09:00'); T.setTimeZone('Asia/Kolkata');
  useTransport(null); resetSync(); cal.useLocal(); setAiBinding(null); useFetch(null);
  saveSettings({ autonomous: false, aiOrder: ['workers-ai'], dayStart: '07:00', dayEnd: '23:00' });
  try { await fn(); passed++; console.log('✅', name); }
  catch (e) { failed++; console.log('❌', name, '\n   ', e.stack.split('\n').slice(0, 3).join('\n    ')); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const eq = (a, b, msg) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg || 'expected'}: ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); };
const ok = (v, msg) => { if (!v) throw new Error(msg || 'assertion failed'); };
const call = async (method, p, body) => {
  const u = new URL('http://x' + p);
  const r = await handle(method, u.pathname, u.searchParams, async () => body ? JSON.stringify(body) : '');
  if (r.status !== 200) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};

await test('undated phrasings are reminders; anything with a day or time is not', async () => {
  eq(reminderIn('remind me to renew my passport'), 'renew my passport');
  eq(reminderIn('Remind me about the library fine'), 'the library fine');
  eq(reminderIn('add a reminder: buy a phone charger'), 'buy a phone charger');
  eq(reminderIn('note to self, return the router'), 'return the router');
  eq(reminderIn("don't let me forget to call the bank"), 'call the bank');
  eq(reminderIn('add milk to my reminders'), 'milk');
  eq(reminderIn('remind me to call mom at 5pm'), null, 'a time = an event');
  eq(reminderIn('remind me to submit the form tomorrow'), null, 'a day = an event');
  eq(reminderIn('remind me to stretch every day'), null, 'repeating = an event');
  eq(reminderIn('remind me to pay rent on friday'), null);
  eq(reminderIn('remind me in 20 minutes to check the oven'), null);
  eq(reminderIn('gym tomorrow at 7am'), null);
});

await test('chat: "remind me to X" adds a reminder and leaves the calendar alone', async () => {
  const r = await chat('remind me to renew my passport');
  ok(/Added to your reminders: Renew my passport/.test(r.reply), r.reply);
  eq(cal.all().filter(e => !isReminderList(e)).length, 0, 'no event of its own');
  eq(listEvents().map(e => [e.title, e.start, e.end]), [['Reminders: Renew my passport', '2026-11-16T09:00', '2026-11-16T10:00']], 'on the Monday list');
  eq(load('reminders').items.map(x => [x.text, x.done]), [['Renew my passport', false]]);
  const again = await chat('remind me to renew my passport');
  ok(/Already on your reminders/.test(again.reply), again.reply);
  eq(load('reminders').items.length, 1, 'no duplicate');
  const list = await chat('what are my reminders?');
  ok(/Reminders \(1\):\n- Renew my passport/.test(list.reply), list.reply);
});

await test('chat: a reminder with a time is left to the calendar path, not the list', async () => {
  // (Offline there is no AI, so the event itself isn't created here; the point is it never lands in the list.)
  const r = await chat('remind me to call mom tomorrow at 6pm');
  eq(load('reminders').items.length, 0, 'not a list reminder');
  ok(!/reminders/i.test(r.reply), r.reply);
});

await test('API: add, pin, tick off, reopen, delete; Today gets the open ones', async () => {
  await call('POST', '/api/reminders', { text: 'buy a charger.' });
  const b = await call('POST', '/api/reminders', { text: 'return library books' });
  eq(b.open.map(x => x.text), ['Buy a charger', 'Return library books'], 'oldest first, tidied');
  const id2 = b.open[1].id, id1 = b.open[0].id;
  let r = await call('POST', '/api/reminders', { id: id2, pinned: true });
  eq(r.open.map(x => x.text), ['Return library books', 'Buy a charger'], 'pinned first');
  r = await call('POST', '/api/reminders', { id: id1, done: true });
  eq(r.open.map(x => x.id), [id2]);
  eq(r.done.map(x => x.id), [id1]);
  const home = await call('GET', '/api/home');
  eq(home.reminders.map(x => x.text), ['Return library books'], 'Today shows open reminders');
  r = await call('POST', '/api/reminders', { id: id1, done: false });
  eq(r.open.length, 2, 'reopened');
  r = await call('POST', '/api/reminders', { id: id1, remove: true });
  eq(r.open.map(x => x.id), [id2]);
  eq(cal.all().filter(e => !isReminderList(e)).length, 0, 'nothing else on the calendar');
  const u = new URL('http://x/api/reminders');
  let refused = '';
  try { await handle('POST', u.pathname, u.searchParams, async () => JSON.stringify({ text: '   ' })); } catch (e) { refused = e.message; }
  eq(refused, 'Write what to remember.', 'empty text refused');
});

await test('Monday event: one 09:00–10:00 event lists every open reminder and follows ticks', async () => {
  eq(listDay('2026-11-10'), '2026-11-16', 'Tuesday → coming Monday');
  eq(listDay('2026-11-16'), '2026-11-16', 'Monday → today');
  eq(listDay('2026-11-15'), '2026-11-16', 'Sunday → tomorrow');
  const a = await call('POST', '/api/reminders', { text: 'renew passport' });
  const b = await call('POST', '/api/reminders', { text: 'msg Alex' });
  await call('POST', '/api/reminders', { text: 'fill the form' });
  eq(b.listDay, '2026-11-16');
  let evs = listEvents();
  eq(evs.map(e => [e.title, e.start, e.end]), [['Reminders: Renew passport + Msg Alex + Fill the form', '2026-11-16T09:00', '2026-11-16T10:00']]);
  ok(evs[0].description.startsWith('• Renew passport\n• Msg Alex\n• Fill the form'), evs[0].description);
  await call('POST', '/api/reminders', { id: b.reminder.id, done: true });
  eq(listEvents().map(e => e.title), ['Reminders: Renew passport + Fill the form'], 'ticked one leaves the title');
  await call('POST', '/api/reminders', { id: b.reminder.id, done: false });
  eq(listEvents().map(e => e.title), ['Reminders: Renew passport + Msg Alex + Fill the form'], 'reopened one comes back in its place');
  let r = await call('POST', '/api/reminders', { reminderEvent: false });
  eq(r.reminderEvent, false); eq(listEvents().length, 0, 'switched off = removed');
  await call('POST', '/api/reminders', { reminderEvent: true });
  eq(listEvents().length, 1, 'switched on = back');
  for (const x of (await call('GET', '/api/reminders')).open) await call('POST', '/api/reminders', { id: x.id, done: true });
  eq(listEvents().length, 0, 'all done = no event');
  eq(a.reminder.text, 'Renew passport');
});

await test('Monday event: never a clash, and this week\'s past Monday copy stays in step', async () => {
  cal.create({ title: 'DBMS Lab', start: '2026-11-16T09:00', end: '2026-11-16T11:00', kind: 'meeting' });
  cal.create({ title: 'Reminders: Old', description: 'Old\n\nKept up to date by Donna from your Reminders.', start: '2026-11-09T09:00', end: '2026-11-09T10:00', kind: 'personal' });
  cal.create({ title: 'Reminders: Last month', description: 'x\n\nKept up to date by Donna from your Reminders.', start: '2026-11-02T09:00', end: '2026-11-02T10:00', kind: 'personal' });
  await call('POST', '/api/reminders', { text: 'renew passport' });
  eq(listEvents().map(e => [T.day(e.start), e.title]), [['2026-11-02', 'Reminders: Last month'], ['2026-11-09', 'Reminders: Renew passport'], ['2026-11-16', 'Reminders: Renew passport']]);
  eq(findConflicts('2026-11-16'), [], 'overlapping a lab is not a conflict');
});

await test('Monday event: on a Monday the list goes on today; long lists are shortened in the title only', async () => {
  T.setNow('2026-11-16T07:30');
  await call('POST', '/api/reminders', { text: 'renew passport' });
  eq(listEvents().map(e => e.start), ['2026-11-16T09:00']);
  const many = Array.from({ length: 12 }, (_, i) => `Reminder number ${i + 1}`);
  const t = listTitle(many);
  ok(t.length <= 200 && /\+ \d+ more$/.test(t), t);
  const n = Number(/\+ (\d+) more$/.exec(t)[1]);
  eq(t.split(' + ').length - 1 + n, 12, 'shown + "more" adds up to all: ' + t);
});

await test('affirmations setting is saved as text', async () => {
  const s = saveSettings({ affirmations: 'Keep going.\nOne thing at a time.' });
  eq(s.affirmations, 'Keep going.\nOne thing at a time.');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
