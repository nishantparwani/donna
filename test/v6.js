// Offline checks for v6: colour priorities, invites only when asked, and the date/time readings the
// Nov 2026 assessment found wrong (all in English; every case runs with the AI off unless it scripts one).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { useFsStore } from '../src/node-store.js';
import { load, saveSettings, settings } from '../src/store.js';
import * as T from '../src/time.js';
import * as cal from '../src/calendar.js';
import { beginRun, TOOLS, realId, describe, applyPriority } from '../src/engine.js';
import { chat } from '../src/agent.js';
import { setAiBinding, useFetch, configured } from '../src/llm.js';
import { useTransport, resetSync, fromBridge } from '../src/sync.js';
import { whenIn, timeIn, rangeIn, impossibleDate } from '../src/when.js';
import { colorIn, userColor, order, colorName } from '../src/colors.js';
import { findConflicts } from '../src/planner.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'donna-v6-'));
  await useFsStore(dir);
  T.setNow('2026-11-09T09:00'); // Monday
  T.setTimeZone('Asia/Kolkata');
  useTransport(null); resetSync(); cal.useLocal(); setAiBinding(null); useFetch(null);
  saveSettings({ autonomous: false, workersAiModel: '@cf/test/model', aiOrder: ['workers-ai'], dayStart: '07:00', dayEnd: '23:00', workStart: '09:00', workEnd: '18:00' });
  try { await fn(); passed++; console.log('✅', name); }
  catch (e) { failed++; console.log('❌', name, '\n   ', e.stack.split('\n').slice(0, 3).join('\n    ')); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const eq = (a, b, msg) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg || 'expected'}: ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); };
const ok = (v, msg) => { if (!v) throw new Error(msg || 'assertion failed'); };
const ev = (d, s, e, title, x = {}) => ({ title, start: `2026-11-${d}T${s}`, end: `2026-11-${d}T${e}`, kind: 'task', guests: [], organizer: true, ...x });
const titled = re => cal.all().filter(e => re.test(e.title));

// ─── Colours = priorities ───

await test('colour words and priority words are read; the rest of the text is left alone', async () => {
  eq(colorIn('travel to new york from 12 noon today till 3pm color red').color, '11');
  eq(colorIn('bring mango from market colour yellow').color, '5');
  eq(colorIn('gym at 6 in green').color, '10');
  eq(colorIn('dentist tomorrow 4pm (blue)').color, '7');
  eq(colorIn('exam prep tomorrow at 5 high priority').color, '11', 'high = the top colour');
  eq(colorIn('laundry low priority').color, '8', 'low = the bottom colour');
  eq(colorIn('dinner at Red Lobster at 8').color, '', 'a name is not a colour');
  eq(colorIn('lunch in the sun').color, '');
  ok(/travel to new york from 12 noon today till 3pm$/.test(colorIn('travel to new york from 12 noon today till 3pm color red').rest));
  eq(order().slice(0, 3).map(colorName), ['red', 'orange', 'yellow'], 'red is the top priority');
});

await test('your example: red travel 12–3 cancels the lower-priority tasks inside it, in one reply, with Undo', async () => {
  cal.replaceAll([
    ev('09', '12:30', '13:00', 'Bring apples from market', { color: '5' }),
    ev('09', '14:00', '15:00', 'Laundry', { color: '8' }),
    ev('09', '16:00', '17:00', 'Gym', { color: '10' }),
    ev('09', '13:00', '14:00', 'Team sync', { color: '6', guests: ['a@x.com'] }),
  ]);
  const r = await chat('travel to new york from 12 noon today till 3pm color red');
  const t = titled(/new york/i)[0];
  ok(t, 'travel booked: ' + r.reply);
  eq([t.start, t.end, t.color], ['2026-11-09T12:00', '2026-11-09T15:00', '11']);
  eq(titled(/apples|laundry/i).length, 0, 'lower-priority tasks inside 12–3 are cancelled');
  ok(titled(/gym/i).length === 1, 'outside the window: untouched');
  ok(titled(/team sync/i).length === 1, 'an event with guests is never cancelled silently (it would email them)');
  ok(/cancelled the lower-priority/i.test(r.reply) && /Team sync/.test(r.reply), r.reply);
  const u = await chat('undo');
  ok(titled(/apples/i).length === 1 && titled(/laundry/i).length === 1 && !titled(/new york/i).length, 'one undo restores everything: ' + u.reply);
});

await test('your example: same colour overlapping = simultaneous (both kept, no clash warning, no conflict)', async () => {
  cal.replaceAll([ev('09', '17:00', '17:30', 'Bring apples from market', { color: '5' })]);
  const r = await chat('bring mango from market today at 5pm for 30 min color yellow');
  eq(titled(/market/i).length, 2, 'both errands kept: ' + r.reply);
  ok(/alongside/i.test(r.reply) && !/overlaps/i.test(r.reply), r.reply);
  eq(findConflicts('2026-11-09').length, 0, 'same colour is not a conflict for the planner or autopilot');
});

await test('lower priority booked over higher: booked as asked, with a heads-up; nothing cancelled', async () => {
  cal.replaceAll([ev('10', '10:00', '12:00', 'Mid-sem exam', { color: '11' })]);
  const r = await chat('library run tomorrow at 11am color yellow');
  ok(titled(/library/i).length === 1 && titled(/exam/i).length === 1, r.reply);
  ok(/higher-priority Mid-sem exam/i.test(r.reply), r.reply);
});

await test('uncoloured events have no priority: reported as an overlap, never cancelled', async () => {
  cal.replaceAll([ev('09', '13:00', '14:00', 'Lunch with Sam')]);
  const r = await chat('call mom today from 1pm to 2pm color red');
  ok(titled(/lunch/i).length === 1, 'uncoloured lunch kept');
  ok(/overlaps Lunch with Sam/i.test(r.reply), r.reply);
});

await test('the model path: colour the user named is applied even if the model forgets it; cancellations still happen', async () => {
  cal.replaceAll([ev('10', '18:00', '19:00', 'Groceries', { color: '8' })]);
  setAiBinding({ async run() { return { response: '', tool_calls: [{ name: 'create_event', arguments: { title: 'Interview prep', start: '2026-11-10T17:30', end: '2026-11-10T19:30' } }] }; } });
  const r = await chat('block interview prep tomorrow 5:30 to 7:30pm, make it red, it matters');
  const p = titled(/interview/i)[0];
  ok(p && p.color === '11', 'colour from the user\'s words: ' + JSON.stringify(p));
  eq(titled(/groceries/i).length, 0, r.reply);
});

await test('recolour an event in chat (no AI); recolouring alone reports, never cancels', async () => {
  cal.replaceAll([ev('10', '16:00', '17:00', 'Dentist'), ev('10', '16:30', '17:30', 'Laundry', { color: '8' })]);
  const r = await chat('make the dentist red');
  eq(titled(/dentist/i)[0].color, '11', r.reply);
  ok(titled(/laundry/i).length === 1, 'nothing cancelled by a colour change');
  ok(/lower-priority Laundry/i.test(r.reply), r.reply);
});

await test('moving a coloured event onto lower-priority ones cancels them (you moved it there)', async () => {
  cal.replaceAll([ev('10', '09:00', '10:00', 'Flight to Delhi', { color: '11' }), ev('10', '15:00', '16:00', 'Laundry', { color: '8' })]);
  const r = await chat('move the flight to delhi to 3pm');
  eq(titled(/flight/i)[0].start, '2026-11-10T15:00', r.reply);
  eq(titled(/laundry/i).length, 0, r.reply);
});

await test("Donna's own blocks and its automatic kind colours are not priorities", async () => {
  // Bridge colours Donna-made tasks Banana by kind: that is not the user picking yellow.
  const auto = fromBridge({ id: 'g1', title: 'Gym', start: '2026-11-09T18:00', end: '2026-11-09T19:00', color: '5', meta: { agent: true, kind: 'task' } });
  eq(userColor(auto), '', 'automatic kind colour');
  const chosen = fromBridge({ id: 'g2', title: 'Gym', start: '2026-11-09T18:00', end: '2026-11-09T19:00', color: '5', meta: { agent: true, kind: 'task', colorSet: true } });
  eq(userColor(chosen), '5', 'picked in chat');
  const recoloured = fromBridge({ id: 'g3', title: 'Gym', start: '2026-11-09T18:00', end: '2026-11-09T19:00', color: '11', meta: { agent: true, kind: 'task' } });
  eq(userColor(recoloured), '11', 'recoloured in Google');
  const session = fromBridge({ id: 'g4', title: 'OS assignment', start: '2026-11-09T18:00', end: '2026-11-09T19:00', color: '11', meta: { agent: true, kind: 'task', taskId: 'T1' } });
  eq(userColor(session), '', 'study sessions move instead (planner)');
  eq(describe(chosen).color, 'yellow');
});

await test('the colour switch: priorityCancel off = report only', async () => {
  saveSettings({ priorityCancel: false });
  cal.replaceAll([ev('09', '13:00', '13:30', 'Laundry', { color: '8' })]);
  const r = await chat('study block today from 1pm to 2pm color red');
  ok(titled(/laundry/i).length === 1, r.reply);
  ok(/Left as is/i.test(r.reply), r.reply);
});

await test('custom priority order from Settings', async () => {
  saveSettings({ colorPriority: 'green, red' });
  eq(order().slice(0, 3), ['10', '11', '6']);
  cal.replaceAll([ev('09', '13:00', '13:30', 'Laundry', { color: '11' })]);
  await chat('run today from 1pm to 2pm color green');
  eq(titled(/laundry/i).length, 0, 'green outranks red in this order');
});

// ─── Invites only when asked ───

await test('a known contact is not emailed unless the user asks; "invite Riya" then sends it', async () => {
  load('people').items.push({ id: 'P1', name: 'Mom', email: 'mom@x.com' }, { id: 'P2', name: 'Riya', email: 'riya@x.com' });
  cal.replaceAll([]);
  const r = await chat('dinner with mom on saturday at 8pm');
  const d = titled(/dinner/i)[0];
  eq([d.start, d.guests, d.meet], ['2026-11-14T20:00', [], false], 'no invite, no Meet link');
  ok(/Didn't invite Mom/.test(r.reply), r.reply);
  beginRun('chat', 'call with riya tomorrow at 3pm and invite her');
  const c = await TOOLS.create_event({ title: 'Call with Riya', start: '2026-11-10T15:00', kind: 'meeting', guests: 'Riya' });
  eq(c.invited, ['riya@x.com']);
  ok(cal.get(realId(c.event.id)).meet, 'work call with an invite gets Meet');
  beginRun('chat', 'add riya to it');
  let refused = '';
  try { await TOOLS.update_event({ event_id: titled(/call with riya/i)[0].id, guests: 'Riya, Mom' }); } catch (e) { refused = e.message; }
  ok(/did not ask to invite/.test(refused), 'adding a guest without being asked is refused: ' + refused);
});

await test('an email address typed in the message is consent to invite it', async () => {
  beginRun('chat', 'sync with a@corp.com tomorrow at 11am');
  const r = await TOOLS.create_event({ title: 'Sync', start: '2026-11-10T11:00', kind: 'meeting', guests: 'a@corp.com' });
  eq(r.invited, ['a@corp.com']);
});

// ─── Dates and times (English) ───

await test('morning / evening / meal words decide am or pm', async () => {
  for (const [msg, want] of [
    ['gym tomorrow morning at 6', '2026-11-10T06:00'],
    ['dinner tomorrow at 8', '2026-11-10T20:00'],
    ['dinner at 8:30 tomorrow', '2026-11-10T20:30'],
    ['breakfast with sam tomorrow at 8', '2026-11-10T08:00'],
    ['standup tomorrow at 4 in the morning', '2026-11-10T04:00'],
    ['read tomorrow at 9', '2026-11-10T09:00'],
    ['walk tomorrow at 6', '2026-11-10T18:00'],
  ]) {
    cal.replaceAll([]);
    const r = await chat(msg);
    const e = cal.all()[0];
    ok(e && e.start === want, `${msg} → ${e && e.start} (${r.reply})`);
  }
});

await test('an existing evening gym no longer swallows a morning one', async () => {
  cal.replaceAll([ev('10', '18:00', '19:00', 'Gym')]);
  const r = await chat('gym tomorrow morning at 6');
  eq(titled(/gym/i).map(e => e.start).sort(), ['2026-11-10T06:00', '2026-11-10T18:00'], r.reply);
});

await test('"move gym to 9 tonight" is 21:00', async () => {
  cal.replaceAll([ev('09', '18:00', '19:00', 'Gym')]);
  await chat('move gym to 9 tonight');
  eq(titled(/gym/i)[0].start, '2026-11-09T21:00');
});

await test('dates that do not exist are never rolled over', async () => {
  eq(whenIn('the 31st').days, ['2026-12-31'], 'November has no 31st: the next month that has one');
  eq(whenIn('30 feb').days, [], 'not a date');
  ok(/February has no 30th/.test(impossibleDate('add exam on 30 feb at 10am')));
  ok(/April has no 31st/.test(impossibleDate('31/04')));
  const r = await chat('add exam on 30 feb at 10am');
  eq(cal.all().length, 0, r.reply);
  ok(/February has no 30th/.test(r.reply), r.reply);
  await chat('book haircut on the 31st at 4pm');
  eq(titled(/haircut/i)[0].start, '2026-12-31T16:00');
});

await test('"sat", "sun" and "wed" are words unless they point at a day', async () => {
  eq(whenIn('SAT practice test tomorrow'.toLowerCase()).days, ['2026-11-10']);
  eq(whenIn('lunch in the sun tomorrow').days, ['2026-11-10']);
  eq(whenIn('on sat').days, ['2026-11-14']);
  eq(whenIn('this sun').days, ['2026-11-15']);
  eq(whenIn('friday').days, ['2026-11-13']);
  const r = await chat('SAT practice test tomorrow at 10am');
  eq(titled(/sat practice/i).map(e => e.start), ['2026-11-10T10:00'], r.reply);
});

await test('day after tomorrow, DD/MM, "in 3 days"', async () => {
  eq(whenIn('day after tomorrow').days, ['2026-11-11']);
  eq(whenIn('on 20/11').days, ['2026-11-20']);
  eq(whenIn('5/1').days, ['2027-01-05'], 'past this year: next year');
  eq(whenIn('in 3 days').days, ['2026-11-12']);
  const r = await chat('meeting with prof day after tomorrow at 11am');
  eq(titled(/prof/i).map(e => e.start), ['2026-11-11T11:00'], r.reply);
});

await test('time ranges', async () => {
  const r = (t, part) => { const x = rangeIn(t, { part }); return x && [T.toHM(x.start), T.toHM(x.end % 1440)]; };
  eq(r('from 12 noon till 3pm'), ['12:00', '15:00']);
  eq(r('4-6pm'), ['16:00', '18:00']);
  eq(r('11-1pm'), ['11:00', '13:00']);
  eq(r('from 10 till 2'), ['10:00', '14:00']);
  eq(r('10:30 to 12'), ['10:30', '12:00']);
  eq(r('9pm till midnight'), ['21:00', '00:00']);
  eq(r('2 to 3 people'), null);
  eq(timeIn('at 12 noon').minutes, 720);
});

// ─── Private AI ───

await test('Gemini is used by default; Private AI (opt-in) skips providers that may train on prompts', async () => {
  saveSettings({ geminiApiKey: 'k1', openrouterApiKey: 'k2', groqApiKey: 'k3', aiOrder: ['workers-ai', 'gemini', 'groq', 'openrouter'] });
  setAiBinding({ async run() { return { response: 'hi' }; } });
  eq(configured(), ['workers-ai', 'gemini', 'groq', 'openrouter'], 'default: every key is used');
  saveSettings({ privateAi: true });
  eq(configured(), ['workers-ai', 'groq'], 'opted in: Gemini free tier and OpenRouter free models are skipped');
});

// ─── Platform: key vault, writer lock, read-only views (with a fake Cloudflare backend) ───

await test('keys move out of the settings row into the vault; views take no lock and save nothing', async () => {
  const rows = { settings: JSON.stringify({ userName: 'N', geminiApiKey: 'gem-secret', bridgeToken: 'tok-secret', calendarMode: 'local' }) };
  let vaultText = null, locks = 0;
  const { useBackend, hydrate, flush, settings: cur, saveSettings: put, withWriteLock } = await import('../src/store.js');
  const { handle } = await import('../src/api.js');
  useBackend({
    immediate: false,
    async readAll() { return { ...rows, ...(vaultText ? { vault: vaultText } : {}) }; },
    async readOne(n) { return rows[n]; },
    async write(n, t) { rows[n] = t; },
    async readVault(t) { return t ? JSON.parse(t.replace(/^SEALED:/, '')) : {}; },
    async writeVault(v) { vaultText = 'SEALED:' + JSON.stringify(v); },
    async lock(fn) { locks++; return fn(); },
  });
  await hydrate();
  eq([cur().geminiApiKey, cur().bridgeToken], ['gem-secret', 'tok-secret'], 'still usable');
  await flush();
  ok(!/secret/.test(rows.settings), 'no plaintext key left in settings: ' + rows.settings);
  ok(/gem-secret/.test(vaultText), 'vault holds them');
  await hydrate();
  put({ groqApiKey: 'groq-secret' });
  await flush();
  ok(!/groq-secret/.test(rows.settings) && /groq-secret/.test(vaultText), 'new keys go straight to the vault');
  await withWriteLock(async () => {});
  eq(locks, 1);
  const before = rows.state;
  const r = await handle('GET', '/api/settings', new URLSearchParams(), async () => '', {});
  eq(r.status, 200);
  eq(r.body.geminiApiKey, '••••cret', 'masked');
  eq(locks, 1, 'a view takes no lock');
  eq(rows.state, before, 'a view writes nothing');
  await handle('POST', '/api/settings', new URLSearchParams(), async () => JSON.stringify({ userName: 'Harvey' }), {});
  eq(locks, 2, 'a change takes the lock');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
