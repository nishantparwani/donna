// Offline checks for v4: the saved Google copy (speed), smart placement, live issues, passkeys, time budget.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { useFsStore } from '../src/node-store.js';
import { load, save, saveSettings, readRow, writeRow } from '../src/store.js';
import * as T from '../src/time.js';
import * as cal from '../src/calendar.js';
import { beginRun, TOOLS } from '../src/engine.js';
import { chat, setChatBudget } from '../src/agent.js';
import { setAiBinding, useFetch } from '../src/llm.js';
import { useTransport, resetSync } from '../src/sync.js';
import { handle } from '../src/api.js';
import { energy, demandOf } from '../src/smart.js';
import { newChallenge, verifyRegistration, verifyLogin, b64u } from '../src/passkey.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'donna-v4-'));
  await useFsStore(dir);
  T.setNow('2026-10-21T08:30'); // Wednesday
  T.setTimeZone('Asia/Kolkata');
  useTransport(null); resetSync(); cal.useLocal(); setAiBinding(null); useFetch(null);
  saveSettings({ autonomous: false, workersAiModel: '@cf/test/model', dayStart: '09:30', dayEnd: '23:30', workStart: '09:00', focusSpan: 90, breakMinutes: 10,
    activityWindows: [{ match: 'run, running, jog', windows: '06:00-08:00, 17:00-21:00' }] });
  try { await fn(); passed++; console.log('✅', name); }
  catch (e) { failed++; console.log('❌', name, '\n   ', e.stack.split('\n').slice(0, 3).join('\n    ')); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); setChatBudget(40000); }
}
const eq = (a, b, msg) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg || 'expected'}: ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); };
const ok = (v, msg) => { if (!v) throw new Error(msg || 'assertion failed'); };
const ev = (d, s, e, title, x = {}) => ({ title, start: `2026-10-${d}T${s}`, end: `2026-10-${d}T${e}`, kind: 'task', guests: [], ...x });
const gev = (id, title, start, end) => ({ id, title, start, end, guests: [], organizer: true, myStatus: 'accepted', meta: {} });
const req = async (method, p, body) => handle(method, p.split('?')[0], new URLSearchParams(p.split('?')[1] || ''), async () => body ? JSON.stringify(body) : '', { authEnabled: true });

function fakeBridge(events) {
  const calls = [];
  useTransport(async p => {
    calls.push(p.action);
    if (process.env.DBG) console.log('bridge', p.action, p.from, p.to, new Error().stack.split('\n').slice(2, 9).join(' <- '));
    if (p.action === 'list') return { version: 4, timeZone: 'Asia/Kolkata', events: events.filter(e => e.start < p.to && e.end > p.from) };
    if (p.action === 'batch') return { results: p.ops.map(o => o.op === 'create' ? { id: o.id, newId: 'g_' + o.id } : { id: o.id }) };
    return {};
  });
  saveSettings({ calendarMode: 'google', bridgeUrl: 'https://x/exec', bridgeToken: 'tok' });
  return calls;
}

// ─── Speed: the saved copy ───
await test('views read Google once, then the saved copy (a new isolate needs no Google call)', async () => {
  const calls = fakeBridge([gev('a1', 'OS Lecture', '2026-10-21T10:00', '2026-10-21T11:00')]);
  const r1 = await req('GET', '/api/state?view=day&date=2026-10-21');
  eq(r1.body.events.map(e => e.title), ['OS Lecture']);
  eq(calls.filter(c => c === 'list').length, 1, 'first open reads Google');
  resetSync(); // a fresh Worker isolate: no in-memory cache
  { const old = JSON.parse(await readRow('gcache')); old.at -= 3600e3; await writeRow('gcache', JSON.stringify(old)); } // an hour later: old, but a view may use it
  const r2 = await req('GET', '/api/state?view=week&date=2026-10-21');
  eq(calls.filter(c => c === 'list').length, 1, 'no second Google read');
  ok(r2.body.sync && r2.body.sync.ageSec >= 0, 'tells the app how old the copy is');
  const saved = JSON.parse(await readRow('gcache'));
  ok(saved.from <= '2026-10-14' && saved.to >= '2026-12-01', 'one read covers ~6 weeks: ' + saved.from + '..' + saved.to);
});

await test('/api/sync reports a change made in Google; chat trusts only a young copy', async () => {
  const events = [gev('a1', 'OS Lecture', '2026-10-21T10:00', '2026-10-21T11:00')];
  const calls = fakeBridge(events);
  await req('GET', '/api/state?view=day&date=2026-10-21');
  eq((await req('POST', '/api/sync', {})).body.changed, false, 'nothing changed yet');
  events.push(gev('a2', 'Dentist', '2026-10-22T16:00', '2026-10-22T17:00')); // added on the phone
  eq((await req('POST', '/api/sync', {})).body.changed, true, 'the phone edit is noticed');
  resetSync();
  const before = calls.length;
  T.setNow('2026-10-21T08:33');
  setAiBinding({ async run() { return { response: 'You have the OS Lecture at 10:00.' }; } });
  await req('POST', '/api/chat', { message: 'what is on today' });
  eq(calls.slice(before).filter(c => c === 'list').length, 0, 'copy 3 min old: chat skips the Google read');
  resetSync();
  const old = JSON.parse(await readRow('gcache')); old.at -= 3600e3; await writeRow('gcache', JSON.stringify(old)); // an hour old
  const mid = calls.length;
  await req('POST', '/api/chat', { message: 'what is on today' });
  eq(calls.slice(mid).filter(c => c === 'list').length, 1, 'copy 1 h old: chat reads Google first');
});

await test('a change pushed to Google lands in the saved copy with its Google id', async () => {
  fakeBridge([]);
  const r = await req('POST', '/api/events', { title: 'Gym', start: '2026-10-22T18:00', end: '2026-10-22T19:00', kind: 'personal' });
  eq(r.body.problems, []);
  resetSync();
  const st = await req('GET', '/api/state?view=day&date=2026-10-22');
  const gym = st.body.events.find(e => e.title === 'Gym');
  ok(gym && gym.id.startsWith('g_'), 'saved with the id Google gave it: ' + (gym && gym.id));
});

// ─── Live issues ───
await test('"Needs attention" is computed live: a resolved leftover never shows, a real clash does', async () => {
  load('state').lastIssuesList = ['Conflict on 2026-10-19: E1 "Old thing" overlaps E2 "Fixed already"'];
  save('state');
  cal.replaceAll([ev(21, '10:00', '11:00', 'Lecture'), ev(21, '10:30', '11:30', 'Call with Riya', { kind: 'meeting', guests: ['r@x.co'] })]);
  const r = await req('GET', '/api/state?view=day&date=2026-10-21');
  ok(!r.body.issues.some(i => /Old thing/.test(i)), 'old leftover gone');
  ok(r.body.issues.some(i => /Lecture/.test(i) && /Riya/.test(i)), r.body.issues.join(' | '));
  cal.update(cal.all().find(e => /Riya/.test(e.title)).id, { start: '2026-10-21T12:00', end: '2026-10-21T13:00' });
  eq((await req('GET', '/api/state?view=day&date=2026-10-21')).body.issues, [], 'fixed → gone at once');
});

// ─── Smart placement ───
await test('energy follows the user\'s own day: a 09:30 riser peaks late morning, dips after lunch, winds down', async () => {
  const wake = 9 * 60 + 30, sleep = 23 * 60 + 30;
  ok(energy(11 * 60, wake, sleep) > energy(9 * 60 + 40, wake, sleep), 'warming up first');
  ok(energy(11 * 60, wake, sleep) > energy(15 * 60, wake, sleep), 'post-lunch dip');
  ok(energy(18 * 60, wake, sleep) > energy(23 * 60, wake, sleep), 'winding down');
  eq([demandOf('CFA study'), demandOf('Reply to emails', 'task'), demandOf('5k run'), demandOf('Dinner'), demandOf('Call with Riya', 'meeting')], ['deep', 'light', 'physical', 'meal', 'social']);
});

await test('create_event with only a day: study lands in focus hours, emails in a dip — not the first free slot', async () => {
  cal.replaceAll([ev(22, '14:00', '16:00', 'DBMS Lab')]);
  beginRun('chat', 'CFA study 2h tomorrow');
  const a = await TOOLS.create_event({ title: 'CFA study', start: '2026-10-22', duration_minutes: 120, kind: 'task', rationale: 't' });
  const cfa = cal.get(cal.all().find(e => e.title === 'CFA study').id);
  ok(a.ok !== false && cfa.start >= '2026-10-22T10:15' && cfa.end <= '2026-10-22T14:00', 'study in the morning peak, not at 09:30 wake-up: ' + cfa.start);
  beginRun('chat', 'reply to emails tomorrow');
  await TOOLS.create_event({ title: 'Reply to emails', start: '2026-10-22', duration_minutes: 30, kind: 'task', rationale: 't' });
  const mail = cal.all().find(e => e.title === 'Reply to emails');
  const m = T.mins(mail.start);
  ok(m < 10 * 60 + 15 || m >= 16 * 60, 'light work keeps out of the peak: ' + mail.start);
});

await test('plan_day: deep work gets the peak, not "first come first placed"; parts spread; meals kept', async () => {
  T.setNow('2026-10-21T01:30');
  cal.replaceAll([ev(21, '11:00', '12:00', 'MAD Lecture'), ev(21, '15:00', '17:00', 'IVP Lab')]);
  beginRun('chat', 'plan my day: emails 30 min, CFA 2h, DSA 1.5h, run');
  const r = await TOOLS.plan_day({ date: '2026-10-21', fill_gaps: false, items: [
    { title: 'Emails', minutes: 30 }, { title: 'CFA study', minutes: 120 }, { title: 'DSA practice', minutes: 90 }, { title: 'Run', minutes: 45 }], rationale: 't' });
  ok(r.ok, JSON.stringify(r));
  const get = re => cal.all().filter(e => re.test(e.title)).sort((a, b) => a.start.localeCompare(b.start));
  const emails = get(/Emails/)[0];
  ok(emails.start !== '2026-10-21T09:30' || get(/CFA/)[0].start > '2026-10-21T09:30', 'not just stacked from wake-up');
  ok(get(/CFA|DSA/).every(e => energy(T.mins(e.start), 570, 1410) >= 0.8), 'deep blocks in good-energy time: ' + get(/CFA|DSA/).map(e => e.start).join(', '));
  const parts = get(/CFA/);
  if (parts.length > 1) ok(T.diffMin(parts[0].end, parts[1].start) >= 60, 'parts of one item are spread out');
  const run = get(/Run/)[0];
  ok(run.start >= '2026-10-21T17:00', 'run in its window');
});

await test('plan_day on a packed day: no 25-min scraps, nothing double-booked, dinner kept', async () => {
  T.setNow('2026-10-21T01:30');
  cal.replaceAll([ev(21, '10:00', '11:00', 'MAD Lecture'), ev(21, '11:00', '13:00', 'MAD Lab'), ev(21, '14:00', '15:00', 'IVP Lecture'), ev(21, '16:30', '17:30', 'CFA class')]);
  beginRun('chat', 'max productivity: CFA 2h, project, run, assignments 1.5h, emails 30m');
  const r = await TOOLS.plan_day({ date: '2026-10-21', fill_gaps: true, items: [
    { title: 'CFA study', minutes: 120 }, { title: 'Personal project', minutes: 90, fill: true }, { title: 'Run', minutes: 45 },
    { title: 'College assignments', minutes: 90 }, { title: 'Emails', minutes: 30 }], rationale: 't' });
  ok(r.ok);
  const day = cal.list('2026-10-21T00:00', '2026-10-22T00:00').sort((a, b) => a.start.localeCompare(b.start));
  for (let i = 1; i < day.length; i++) ok(day[i].start >= day[i - 1].end, `no overlap: ${day[i - 1].title} / ${day[i].title}`);
  ok(day.some(e => /Dinner/.test(e.title)), 'dinner kept: ' + r.timeline.join(' | '));
  ok(day.filter(e => e.agent && !/Lunch|Dinner/.test(e.title)).every(e => T.diffMin(e.start, e.end) >= 30), 'no blocks under 30 min');
});

await test('task sessions: spread over days, a day of slack before the deadline, not crammed into today', async () => {
  cal.replaceAll([ev(21, '10:00', '13:00', 'MAD Lab'), ev(21, '14:00', '17:00', 'IVP Lab'), ev(22, '10:00', '11:00', 'OS Lecture'), ev(23, '09:30', '12:30', 'Lectures')]);
  beginRun('chat', 'OS assignment due Friday 6pm, about 4 hours');
  const r = await TOOLS.add_task({ title: 'OS assignment', minutes: 240, due: '2026-10-23T18:00' });
  const s = cal.all().filter(e => e.taskId === r.task.id).sort((a, b) => a.start.localeCompare(b.start));
  eq(s.reduce((n, e) => n + T.diffMin(e.start, e.end), 0), 240, 'all 4 hours booked');
  ok(new Set(s.map(e => T.day(e.start))).size >= 2, 'more than one day: ' + s.map(e => e.start).join(', '));
  ok(s.every(e => T.day(e.start) < '2026-10-23'), 'done before the due day');
  for (const d of new Set(s.map(e => T.day(e.start)))) {
    const same = s.filter(e => T.day(e.start) === d);
    if (same.length === 2) ok(T.diffMin(same[0].end, same[1].start) >= 90, 'two sessions in a day are far apart');
  }
});

// ─── Time budget ───
await test('a model that hangs: the reply comes back within the budget, saying so (no endless spinner)', async () => {
  setChatBudget(4000);
  setAiBinding({ run: () => new Promise(() => {}) }); // never answers
  const t0 = Date.now();
  const r = await chat('book gym tomorrow evening');
  ok(Date.now() - t0 < 6000, 'answered in ' + (Date.now() - t0) + ' ms');
  ok(/too long|too slow|try again/i.test(r.reply), r.reply);
});

// ─── Passkeys ───
async function fakeAuthenticator(rpId, origin) {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey));
  const rpHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rpId)));
  const authData = (flags, counter) => { const a = new Uint8Array(37); a.set(rpHash); a[32] = flags; new DataView(a.buffer).setUint32(33, counter); return a; };
  const client = (type, challenge, o = origin) => new TextEncoder().encode(JSON.stringify({ type, challenge, origin: o }));
  // Raw r||s → DER, the way authenticators send it.
  const toDer = raw => {
    const int = b => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; b = b.slice(i); if (b[0] & 0x80) b = Uint8Array.of(0, ...b); return [0x02, b.length, ...b]; };
    const body = [...int(raw.slice(0, 32)), ...int(raw.slice(32))];
    return Uint8Array.of(0x30, body.length, ...body);
  };
  return {
    spki, authData, client,
    async sign(ad, cd) {
      const h = new Uint8Array(await crypto.subtle.digest('SHA-256', cd));
      const data = new Uint8Array(ad.length + h.length); data.set(ad); data.set(h, ad.length);
      return toDer(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, data)));
    },
  };
}
await test('passkey: register, then sign in with the device; wrong site, tampered or replayed-old requests fail', async () => {
  const ctx = { secret: 's3cret', origin: 'https://donna.example.com', rpId: 'donna.example.com' };
  const dev = await fakeAuthenticator(ctx.rpId, ctx.origin);
  const ch1 = await newChallenge(ctx.secret);
  const key = await verifyRegistration({ id: 'cred1', clientDataJSON: b64u(dev.client('webauthn.create', ch1)), authenticatorData: b64u(dev.authData(0x05, 0)), publicKey: b64u(dev.spki), alg: -7, name: 'Windows laptop' }, ctx);
  eq(key.name, 'Windows laptop');
  const login = async ({ challenge, flags = 0x05, origin = ctx.origin, tamper = false } = {}) => {
    const ch = challenge || await newChallenge(ctx.secret);
    const cd = dev.client('webauthn.get', ch, origin), ad = dev.authData(flags, 0);
    const sig = await dev.sign(ad, cd);
    if (tamper) sig[sig.length - 1] ^= 1;
    return verifyLogin({ id: 'cred1', clientDataJSON: b64u(cd), authenticatorData: b64u(ad), signature: b64u(sig) }, [key], ctx);
  };
  ok((await login()).lastUsed, 'signs in');
  const fails = async (o, re) => { let err = ''; try { await login(o); } catch (e) { err = e.message; } ok(re.test(err), `expected ${re}, got "${err}"`); };
  await fails({ origin: 'https://evil.example' }, /another site/);
  await fails({ tamper: true }, /signature/);
  await fails({ flags: 0x01 }, /verify you/);
  const forged = b64u(new TextEncoder().encode(`abc.${Date.now()}.notasignature`));
  await fails({ challenge: forged }, /expired/);
});

// ─── Real conversation from 2026-10-20 ───
await test('"cancel se and ai lecutre write CFA": named lectures (codes + typo) are cancelled; "no cancel it dude" is never an undo', async () => {
  saveSettings({ protectedKeywords: 'lecture, lab, class' });
  cal.replaceAll([ev(21, '10:00', '11:00', 'SE Lecture'), ev(21, '11:00', '12:00', 'AI Lecture'), ev(21, '14:00', '15:00', 'DBMS Lecture'), ev(20, '13:00', '13:30', 'Tiffin Confirmation')]);
  beginRun('chat', 'earlier');
  await TOOLS.create_event({ title: 'Tiffin Confirmation', start: '2026-10-21T16:00', duration_minutes: 15, kind: 'personal', rationale: 'earlier request' });
  const id = re => cal.all().find(e => re.test(e.title)).id;
  beginRun('chat', 'cancel se and ai lecutre write CFA');
  const d = await TOOLS.delete_events({ event_ids: [id(/^SE/), id(/^AI/)], rationale: 'asked' });
  eq(d.errors, undefined, 'both cancelled');
  ok(!cal.all().some(e => /^(SE|AI) Lecture/.test(e.title)) && cal.all().some(e => /DBMS/.test(e.title)), 'only the two named lectures went');
  beginRun('chat', 'no cancel it dude');
  let err = '';
  try { await TOOLS.undo({ count: 1 }); } catch (e) { err = e.message; }
  ok(/did not ask to undo/.test(err), err);
  ok(cal.all().some(e => e.title === 'Tiffin Confirmation' && e.start === '2026-10-21T16:00'), 'unrelated earlier change untouched');
});

// ─── Evening autopilot ───
await test('opening the app after 18:00 gets tomorrow ready once; Today lists the decisions; Undo reverts one', async () => {
  saveSettings({ autonomous: true });
  load('habits').items.push({ id: 'H1', title: 'Gym', minutes: 60, days: 'daily', windowStart: '17:00', windowEnd: '21:00', idealTime: '18:00', kind: 'personal', active: true });
  save('habits');
  T.setNow('2026-10-21T14:00');
  eq((await req('POST', '/api/autoplan', {})).body.skipped, 'not evening');
  T.setNow('2026-10-21T19:30');
  const r = await req('POST', '/api/autoplan', {});
  eq(r.body.target, '2026-10-22');
  ok(r.body.changes > 0, 'made changes: ' + JSON.stringify(r.body));
  ok(cal.all().some(e => e.habitId === 'H1' && e.start.startsWith('2026-10-22')), 'tomorrow has its gym block');
  eq((await req('POST', '/api/autoplan', {})).body.skipped, 'already planned', 'once per evening');
  const home = await req('GET', '/api/home');
  eq(home.body.autoPlan.done, true);
  const d = home.body.decisions.find(x => /Gym/.test(x.summary) && !x.undone);
  ok(d, 'decision listed: ' + JSON.stringify(home.body.decisions));
  const u = await req('POST', '/api/feedback', { id: d.id, verdict: 'undo' });
  ok(/↩️/.test(u.body.text), u.body.text);
  ok((await req('GET', '/api/home')).body.decisions.find(x => x.id === d.id).undone, 'shown as undone');
  eq(load('memory').lessons.length, 0, 'a plain undo is not a lesson');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
