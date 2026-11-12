// Offline checks for v9:
//   • the WhatsApp channel is gone, and anything it stored is cleaned up
//   • people's names that are also Hinglish words ("Kal", "Sham") stay names
//   • a request's rows are saved in one transaction
//   • the planner learns which hours work for you from check-ins, drags and undos (src/rhythm.js)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { useFsStore } from '../src/node-store.js';
import { saveSettings, load, save, useBackend, hydrate, flush, settings, DEFAULT_SETTINGS, SECRETS } from '../src/store.js';
import * as T from '../src/time.js';
import * as cal from '../src/calendar.js';
import { setAiBinding, useFetch } from '../src/llm.js';
import { useTransport, resetSync } from '../src/sync.js';
import { chat } from '../src/agent.js';
import { handle } from '../src/api.js';
import { migrate } from '../src/migrate.js';
import { hinglish } from '../src/when.js';
import { scoreSlot } from '../src/smart.js';
import { noteRhythm, rhythmBias, rhythmView, resetRhythm } from '../src/rhythm.js';
import { TOOLS, beginRun, isAwake } from '../src/engine.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'donna-v9-'));
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
  return handle(method, u.pathname, u.searchParams, async () => body ? JSON.stringify(body) : '');
};
const sessionsOf = title => cal.all().filter(e => e.taskId && e.title.includes(title)).sort((a, b) => a.start.localeCompare(b.start)).map(e => structuredClone(e));
/** n days of the same outcome at one time of day, as the Today check-in would record them. */
const history = (good, hhmm, n, demand = 'deep', minutes = 90) => {
  for (let i = 1; i <= n; i++) { const start = `${T.addDays(T.today(), -i)}T${hhmm}`; noteRhythm(good, demand, start, T.addMin(start, minutes)); }
};

// ─── WhatsApp removed ───
await test('WhatsApp is gone: no route, no settings, no secrets', async () => {
  eq((await call('POST', '/api/whatsapp/test', {})).status, 404, 'test route');
  eq((await call('GET', '/api/whatsapp')).status, 404, 'webhook route');
  ok(!Object.keys(DEFAULT_SETTINGS).some(k => /whatsapp/i.test(k)), 'no WhatsApp settings');
  ok(!SECRETS.some(k => /whatsapp/i.test(k)), 'no WhatsApp secrets');
  const s = (await call('GET', '/api/settings')).body;
  ok(!Object.keys(s).some(k => /whatsapp/i.test(k)), 'settings sent to the app have no WhatsApp fields');
});

await test('upgrade removes what WhatsApp stored (settings, seen ids, "via" tags)', async () => {
  Object.assign(load('settings'), { whatsappEnabled: true, whatsappPhoneId: '123', whatsappAllowed: '919876543210', whatsappVerifyToken: 'donna-abc', whatsappToken: 'tok' });
  const st = load('state'); st.schema = 7; st.waSeen = ['wamid.1'];
  load('chat').messages.push({ role: 'user', text: 'gym at 7', time: T.nowStr(), actions: [], via: 'whatsapp' });
  migrate();
  ok(!Object.keys(load('settings')).some(k => /whatsapp/i.test(k)), 'settings cleaned');
  ok(!('waSeen' in load('state')), 'seen ids gone');
  ok(!load('chat').messages.some(m => m.via), 'via tags gone');
  eq(load('state').schema, 8);
  ok(!Object.keys(settings()).some(k => /whatsapp/i.test(k)), 'nothing leaks back through settings()');
});

await test('retired secrets leave the encrypted vault on the next save', async () => {
  const rows = { vault: JSON.stringify({ geminiApiKey: 'g-key', whatsappToken: 'tok', whatsappAppSecret: 'sec' }) };
  let written = null;
  useBackend({ immediate: false, readAll: async () => ({ ...rows }), readVault: async text => JSON.parse(text || '{}'),
    writeVault: async v => { written = { ...v }; }, write: async (n, t) => { rows[n] = t; } });
  await hydrate();
  eq(settings().geminiApiKey, 'g-key', 'other keys kept');
  await flush();
  eq(written, { geminiApiKey: 'g-key' }, 'vault rewritten without the WhatsApp secrets');
});

// ─── Names are names ───
await test('"Lunch with Kal at 1pm": Kal is a person, not "tomorrow"', async () => {
  for (const t of ['Lunch with Kal at 1pm', 'Call Sham at 5pm', 'Coffee with Subah on Friday at 4pm', 'Dinner with Raat at 8pm', 'Review with Aaj at 3pm']) eq(hinglish(t), t, 'left as written');
  await chat('Lunch with Kal at 1pm');
  const ev = cal.all().find(e => /lunch/i.test(e.title));
  eq([ev.title, ev.start], ['Lunch with Kal', '2026-11-10T13:00']);
  await chat('Call Sham at 5pm');
  eq(cal.all().find(e => /call/i.test(e.title)).title, 'Call Sham');
  // The forms no English sentence has are still read.
  eq(hinglish('kal shaam 6 baje gym'), 'tomorrow evening at 6 gym');
});

// ─── One transaction per request ───
await test('a request saves all its rows in one transaction, vault included', async () => {
  const batches = [], singles = [];
  useBackend({ immediate: false, readAll: async () => ({}), readVault: async () => ({}),
    writeVault: async () => { singles.push('vault'); }, write: async n => { singles.push(n); },
    writeMany: async (rows, secrets) => { batches.push({ names: rows.map(r => r[0]).sort(), secrets: secrets && { ...secrets } }); } });
  await hydrate();
  load('tasks').items.push({ id: 'T1' }); save('tasks');
  load('state').x = 1; save('state');
  saveSettings({ geminiApiKey: 'g-key', userName: 'N' });
  await flush();
  eq(singles, [], 'no row written on its own');
  eq(batches.length, 1, 'one batch');
  eq(batches[0].names, ['settings', 'state', 'tasks']);
  eq(batches[0].secrets, { geminiApiKey: 'g-key' }, 'the key travels in the same batch, never in the settings row');
  ok(!JSON.stringify(load('settings')).includes('g-key'), 'settings row holds no key');
  await flush();
  eq(batches.length, 1, 'nothing to save → no write');
});

await test('a failed save keeps everything pending, so a retry writes it all', async () => {
  let fail = true; const batches = [];
  useBackend({ immediate: false, readAll: async () => ({}), write: async () => {},
    writeMany: async rows => { if (fail) throw new Error('D1 unavailable'); batches.push(rows.map(r => r[0]).sort()); } });
  await hydrate();
  load('tasks').items.push({ id: 'T1' }); save('tasks');
  load('state').x = 1; save('state');
  let threw = false;
  try { await flush(); } catch { threw = true; }
  ok(threw, 'the error reaches the caller');
  fail = false;
  await flush();
  eq(batches, [['state', 'tasks']], 'both rows written together on the retry');
});

// ─── Learned rhythm ───
await test('no evidence: the planner behaves exactly as before', async () => {
  eq(rhythmBias('deep'), null);
  const base = { demand: 'deep', wake: 420, sleep: 1380 };
  eq(scoreSlot(600, 90, base), scoreSlot(600, 90, { ...base, rhythm: null }));
  history(false, '09:00', 1, 'deep', 60);
  eq(rhythmBias('deep'), null, 'one bad hour proves nothing');
  eq(rhythmView().kinds[0].ready, false);
});

await test('missed mornings + finished evenings move new focus work to the evening', async () => {
  beginRun('chat');
  await TOOLS.add_task({ title: 'OS assignment', minutes: 90, due: T.addDays(T.today(), 4) });
  const before = sessionsOf('OS assignment')[0];
  ok(T.mins(before.start) < 13 * 60, `a stranger gets a morning session (got ${before.start})`);
  history(false, '09:30', 6); history(true, '19:30', 6);
  const bias = rhythmBias('deep');
  ok(bias[10] < -0.5 && bias[20] > 0.5, `mornings down, evenings up (10:00 ${bias[10]}, 20:00 ${bias[20]})`);
  eq(bias[14], 0, 'hours with no evidence are untouched');
  beginRun('chat');
  const r = await TOOLS.add_task({ title: 'DSA sheet', minutes: 90, due: T.addDays(T.today(), 4) });
  const after = sessionsOf('DSA sheet')[0];
  ok(T.mins(after.start) >= 17 * 60, `the next task is booked in the evening (got ${after.start})`);
  ok(isAwake(after.start, after.end), 'still inside waking hours');
  ok(load('actions').items.some(a => /a time that has worked for you/.test(a.rationale || '')), 'and the reason says why');
  ok(r.ok);
});

await test('evidence never beats a hard limit: nothing lands asleep or on a commitment', async () => {
  history(true, '23:30', 20, 'deep', 120); history(false, '10:00', 20); history(false, '15:00', 20); history(false, '19:00', 20);
  cal.create({ title: 'Lab', start: `${T.addDays(T.today(), 1)}T20:00`, end: `${T.addDays(T.today(), 1)}T22:30`, kind: 'meeting' });
  beginRun('chat');
  await TOOLS.add_task({ title: 'Thesis draft', minutes: 240, due: T.addDays(T.today(), 3) });
  const ses = sessionsOf('Thesis draft');
  ok(ses.length >= 2, 'booked');
  for (const e of ses) {
    ok(isAwake(e.start, e.end), `${e.start} is inside waking hours`);
    ok(!cal.list(e.start, e.end).some(x => x.id !== e.id && !x.agent), `${e.start} is free`);
  }
  ok(Math.max(...rhythmBias('deep').map(Math.abs)) <= 1.2, 'one hour can add or take at most 1.2 points');
});

await test('someone who misses a third of everything is not told every hour is bad', async () => {
  for (const t of ['09:00', '14:00', '19:00']) { history(true, t, 6, 'deep', 60); history(false, t, 3, 'deep', 60); }
  const bias = rhythmBias('deep');
  ok(!bias || bias.every(b => Math.abs(b) < 0.2), `same rate everywhere → no preference (${bias && bias.filter(Boolean)})`);
  eq(rhythmView().kinds[0].usual, 66, 'their usual rate is reported');
});

await test('check-ins teach it: Done and Missed on Today, each counted once', async () => {
  beginRun('chat');
  await TOOLS.add_task({ title: 'CFA mock', minutes: 180, due: T.addDays(T.today(), 2) });
  const [a, b] = sessionsOf('CFA mock');
  T.setNow(T.addMin(b.end, 30));
  eq((await call('POST', '/api/session', { eventId: a.id, status: 'missed' })).status, 200);
  eq((await call('POST', '/api/session', { eventId: b.id, status: 'done' })).status, 200);
  const k = rhythmView().kinds.find(x => x.id === 'deep');
  const sum = f => +k.hours.reduce((n, h) => n + h[f], 0).toFixed(2);
  eq([sum('worked'), sum('didnt')], [T.diffMin(b.start, b.end) / 60, T.diffMin(a.start, a.end) / 60], 'hours of evidence');
  await call('POST', '/api/session', { eventId: a.id, status: 'missed' });
  eq(sum('didnt'), T.diffMin(a.start, a.end) / 60, 'a repeat check-in is not counted twice');
  eq(rhythmView().signals, 2);
});

await test('dragging a block Donna placed teaches it; your own events teach nothing', async () => {
  beginRun('chat');
  await TOOLS.add_task({ title: 'Project report', minutes: 60, due: T.addDays(T.today(), 3) });
  const ses = sessionsOf('Project report')[0];
  const to = `${T.day(ses.start)}T21:00`;
  eq((await call('POST', '/api/events/update', { id: ses.id, origStart: ses.start, start: to, end: T.addMin(to, 60) })).status, 200);
  const k = rhythmView().kinds.find(x => x.id === 'deep');
  eq(k.hours[21].worked, 0.7, 'the hour you chose');
  ok(k.hours[Math.floor(T.mins(ses.start) / 60)].didnt > 0, 'the hour you left');
  const mine = cal.create({ title: 'Study group', start: `${T.addDays(T.today(), 1)}T16:00`, end: `${T.addDays(T.today(), 1)}T17:00`, kind: 'meeting' });
  const n = rhythmView().signals;
  await call('POST', '/api/events/update', { id: mine.id, origStart: mine.start, start: `${T.addDays(T.today(), 1)}T18:00`, end: `${T.addDays(T.today(), 1)}T19:00` });
  eq(rhythmView().signals, n, 'moving your own event is not evidence about Donna');
});

await test('old evidence fades, kinds are separate, and "start over" forgets', async () => {
  history(false, '08:00', 120, 'deep', 120);
  const k = rhythmView().kinds.find(x => x.id === 'deep');
  ok(k.evidence <= 120.5, `capped (${k.evidence})`);
  history(true, '08:00', 60, 'deep', 120);
  const share = h => { const x = rhythmView().kinds.find(y => y.id === 'deep').hours[h]; return x.worked / (x.worked + x.didnt); };
  ok(share(8) > 0.45, `recent weeks outweigh the old ones (${share(8).toFixed(2)})`);
  eq(rhythmBias('physical'), null, 'focus history says nothing about exercise');
  eq(rhythmBias('meal'), null, 'meals and meetings are never learned');
  eq((await call('POST', '/api/rhythm/reset', {})).body.rhythm.kinds, []);
  eq(rhythmBias('deep'), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
