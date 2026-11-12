// Realistic CRUD scenarios, checked against the calendar state afterwards (not the wording of the reply).
// Fixture: a student's calendar. "Now" is Wed 2026-10-21 10:00 (Thu 22 = tomorrow, Sat 24, Mon 26, Tue 27).
export const NOW = '2026-10-21T10:00';
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const weekly = (first, s, e, title, id, x = {}) => { const out = []; for (let d = first; d <= '2026-12-06'; d = addDays(d, 7)) out.push({ title, start: `${d}T${s}`, end: `${d}T${e}`, kind: 'task', recurringId: id, ...x }); return out; };
const one = (d, s, e, title, x = {}) => ({ title, start: `2026-${d}T${s}`, end: `2026-${d}T${e}`, kind: 'task', ...x });
export const FIXTURE = [
  ...weekly('2026-10-26', '10:00', '12:00', 'OS Lab', 'r-os'),
  ...weekly('2026-10-26', '13:00', '14:00', 'SE Lecture', 'r-se1'),
  ...weekly('2026-10-27', '14:00', '15:00', 'SE Lecture', 'r-se2'),
  ...weekly('2026-10-26', '14:00', '16:00', 'SE Lab', 'r-sel'),
  ...weekly('2026-10-21', '15:00', '16:00', 'AI Lecture', 'r-ai1'),
  ...weekly('2026-10-23', '11:00', '12:00', 'AI Lecture', 'r-ai2'),
  ...weekly('2026-10-24', '17:00', '21:00', 'CFA class', 'r-cfa1'),
  ...weekly('2026-10-25', '08:00', '12:00', 'CFA class', 'r-cfa2'),
  ...weekly('2026-10-24', '09:00', '11:30', 'CFA: Study Block and Quiz', 'r-sb1'),
  ...weekly('2026-10-25', '13:30', '16:00', 'CFA: Study Block and Quiz', 'r-sb2'),
  one('10-21', '19:00', '20:30', 'Project Deep Dive'),
  one('10-22', '21:00', '22:30', 'Project Deep Dive'),
  one('10-23', '21:00', '22:30', 'Project Deep Dive'),
  one('10-22', '11:00', '11:30', 'Vendor sync', { kind: 'meeting', guests: ['a@vendor.com'] }),
  one('10-22', '13:00', '13:30', '1:1 with Priya', { kind: 'meeting', guests: ['priya@x.com'] }),
  one('10-22', '16:00', '17:00', 'Product review', { kind: 'meeting', guests: ['b@x.com'] }),
  one('10-22', '18:00', '19:00', 'Run'),
  one('10-22', '20:00', '20:45', 'College Assignments'),
  one('10-23', '20:00', '20:45', 'College Study Block'),
  one('10-23', '12:00', '13:00', 'All-hands', { kind: 'meeting', organizer: false, guests: ['ceo@x.com'] }),
  one('10-23', '13:30', '14:00', 'Team sync', { kind: 'meeting', guests: ['c@x.com'] }),
  one('10-26', '12:00', '13:00', 'Dentist'),
  one('10-27', '18:05', '20:30', 'Flight to Chicago', { location: 'Boston T2' }),
  one('10-29', '09:00', '10:00', 'Company holiday', { readOnly: true, calendarName: 'Work' }),
  one('11-05', '09:00', '09:30', 'Passport renewal'),
  one('11-27', '17:00', '23:59', 'Diljit Concert', { kind: 'personal' }),
  one('11-19', '10:00', '13:00', 'AI Exam'),
];

// ─── helpers: c = { events, reply, diff: {removed, added, changed}, calls } ───
const at = (c, re, day) => c.events.filter(e => re.test(e.title) && (!day || e.start.startsWith('2026-' + day)));
const single = (c, re, day) => { const f = at(c, re, day); return f.length === 1 ? f[0] : null; };
const span = (e, s, en) => !!e && e.start.endsWith('T' + s) && (!en || e.end.endsWith('T' + en));
const gone = (c, re) => c.diff.removed.filter(e => re.test(e.title));
const added = (c, re) => c.diff.added.filter(e => re.test(e.title));
const inHours = (e, a, b) => !!e && e.start.slice(11) >= a && e.end.slice(11) <= b;
const dow = e => new Date(e.start.slice(0, 10) + 'T00:00:00Z').getUTCDay();
const NO_ASK = c => !/\?\s*$/.test(c.reply.trim());
const asked = c => /\?/.test(c.reply);
const NOT_FOUND = c => /(\bno\b|\bnot\b|couldn|can.t find|don.t see|nothing)/i.test(c.reply);

// touch: regex of titles allowed to change; null = nothing may change. Checked for every scenario.
const S = (group, say, touch, checks) => ({ group, name: `${group} · ${Array.isArray(say) ? say.join(' → ') : say}`.slice(0, 90), say: Array.isArray(say) ? say : [say], touch, checks });

export const SCENARIOS = [
  // ─── create ───
  S('create', 'add haircut for toorrow', /haircut/i, { 'one Haircut tomorrow': c => !!single(c, /haircut/i, '10-22'), 'inside waking hours': c => inHours(single(c, /haircut/i), '09:30', '23:30'), 'no question': NO_ASK }),
  S('create', 'coffee with Riya on Monday at 5pm', /riya/i, { 'Mon 17:00': c => span(single(c, /riya/i, '10-26'), '17:00') }),
  S('create', '5 PM walk tomorrow', /walk/i, { 'Thu 17:00': c => span(single(c, /walk/i, '10-22'), '17:00') }),
  S('create', 'remind me to call mom at 3', /mom/i, { 'today 15:00': c => span(single(c, /mom/i, '10-21'), '15:00') }),
  S('create', 'block 2 hours for CFA on tuesday morning', /cfa/i, { 'one 2h block Tue morning': c => { const f = added(c, /cfa/i); const e = f[0]; return f.length === 1 && e.start.startsWith('2026-10-27') && e.start.slice(11) < '12:00' && Number(e.end.slice(11, 13)) - Number(e.start.slice(11, 13)) === 2 && e.end.slice(14) === e.start.slice(14); } }),
  S('create', 'add this: Indigo 6E-204 Boston to Delhi, 5 Nov 2026, departs 6:05 PM arrives 8:15 PM, PNR XY12Z', /6E|indigo|delhi/i, { 'Nov 5 18:05–20:15': c => { const e = added(c, /6E|indigo|delhi/i)[0]; return span(e, '18:05', '20:15') && e.start.startsWith('2026-11-05'); } }),
  S('create', 'DSA practice every weekday at 7:30pm till 6 nov', /dsa/i, { 'repeats on weekdays at 19:30': c => { const f = at(c, /dsa/i); return f.length >= 10 && f.length <= 13 && f.every(e => e.start.endsWith('19:30') && ![0, 6].includes(dow(e))); }, 'stops by Nov 6': c => at(c, /dsa/i).every(e => e.start.slice(0, 10) <= '2026-11-06') }),
  S('create', 'dinner with parents tonight', /dinner/i, { 'today evening': c => { const e = single(c, /dinner/i, '10-21'); return !!e && e.start.slice(11) >= '17:00'; }, 'no clash': c => { const e = single(c, /dinner/i); return !!e && (e.end <= '2026-10-21T19:00' || e.start >= '2026-10-21T20:30'); } }),
  S('create', 'schedule a call with Rahul next Tuesday afternoon', /rahul/i, { 'Tue 27 afternoon': c => inHours(single(c, /rahul/i, '10-27'), '12:00', '17:00'), 'avoids SE Lecture': c => { const e = single(c, /rahul/i); return !!e && (e.end <= '2026-10-27T14:00' || e.start >= '2026-10-27T15:00'); } }),
  S('create', 'concert on 13 november from 8 to 11 pm', /concert/i, { 'Nov 13 20:00–23:00': c => span(single(c, /concert/i, '11-13'), '20:00', '23:00') }),
  S('create', 'add yoga on saturday at 6pm', /yoga/i, { 'booked Sat 18:00': c => span(single(c, /yoga/i, '10-24'), '18:00'), 'warns about CFA class': c => /(overlap|clash|conflict)/i.test(c.reply) && /cfa/i.test(c.reply), 'CFA class kept': c => !!single(c, /cfa class/i, '10-24') }),
  S('create', 'put gym on Saturday at noon for 45 min', /gym/i, { 'Sat 12:00–12:45': c => span(single(c, /gym/i, '10-24'), '12:00', '12:45') }),
  S('create', 'i need to get groceries friday evening', /grocer/i, { 'Fri evening': c => { const e = single(c, /grocer/i, '10-23'); return !!e && e.start.slice(11) >= '17:00'; } }),
  // ─── read ───
  S('read', 'what do I have tomorrow', null, { 'lists tomorrow': c => /vendor sync/i.test(c.reply) && /product review/i.test(c.reply) }),
  S('read', 'when is my dentist appointment', null, { 'says Oct 26 noon': c => /26/.test(c.reply) && /(12:00|12 ?pm|noon)/i.test(c.reply) }),
  S('read', 'am i free on friday at 4?', null, { 'says free': c => /\b(free|nothing|yes|open|clear)\b/i.test(c.reply) }),
  S('read', "what's on next monday", null, { 'lists Mon 26': c => /dentist/i.test(c.reply) && /os lab/i.test(c.reply) }),
  S('read', 'when is my next cfa class', null, { 'Sat 24 at 17:00': c => /24/.test(c.reply) && /(17:00|5 ?pm)/i.test(c.reply) }),
  S('read', 'do i have anything after 6 today', null, { 'names Project Deep Dive': c => /project deep dive/i.test(c.reply) }),
  S('read', 'how many cfa classes this weekend', null, { 'two': c => /\b(2|two)\b/i.test(c.reply) }),
  S('read', 'is my flight still on the calendar?', null, { 'Oct 27': c => /27/.test(c.reply) && /flight/i.test(c.reply) }),
  // ─── update ───
  S('update', 'move the dentist to 5pm', /dentist/i, { 'Mon 17:00–18:00': c => span(single(c, /dentist/i, '10-26'), '17:00', '18:00') }),
  S('update', 'move the dentist to 3pm', /dentist/i, { 'Mon 15:00': c => span(single(c, /dentist/i, '10-26'), '15:00', '16:00'), 'warns about SE Lab': c => /(overlap|clash|conflict)/i.test(c.reply) && /se lab/i.test(c.reply) }),
  S('update', 'push vendor sync back an hour', /vendor/i, { 'Thu 12:00–12:30': c => span(single(c, /vendor/i, '10-22'), '12:00', '12:30') }),
  S('update', "move priya's 1:1 to friday", /priya/i, { 'Fri 13:00': c => span(single(c, /priya/i, '10-23'), '13:00', '13:30') }),
  S('update', 'rename product review to Roadmap review', /product review|roadmap/i, { 'renamed, same time': c => span(single(c, /roadmap review/i, '10-22'), '16:00', '17:00') && !at(c, /product review/i).length }),
  S('update', 'extend vendor sync by 30 minutes', /vendor/i, { '11:00–12:00': c => span(single(c, /vendor/i, '10-22'), '11:00', '12:00') }),
  S('update', 'shorten the project deep dive on friday to 1 hour', /project/i, { 'Fri 21:00–22:00': c => span(single(c, /project/i, '10-23'), '21:00', '22:00') }),
  S('update', 'add location Apollo Clinic to the dentist', /dentist/i, { 'location set, same time': c => { const e = single(c, /dentist/i); return !!e && /apollo/i.test(e.location) && span(e, '12:00', '13:00'); } }),
  S('update', "move tomorrow's run to 7pm", /^run/i, { 'Thu 19:00': c => span(single(c, /^run/i, '10-22'), '19:00', '20:00') }),
  S('update', 'move the cfa class this saturday to 6pm', /cfa class/i, { 'Sat 18:00, only that one': c => span(single(c, /cfa class/i, '10-24'), '18:00', '22:00') && span(single(c, /cfa class/i, '10-31'), '17:00', '21:00') }),
  S('update', 'the sync on friday should start at 2', /team sync/i, { 'Team sync 14:00': c => span(single(c, /team sync/i, '10-23'), '14:00', '14:30') }),
  S('update', 'change the title of project deep dive on thursday to DSA practice', /project|dsa/i, { 'only Thursday renamed': c => span(single(c, /dsa practice/i, '10-22'), '21:00', '22:30') && !!single(c, /project/i, '10-23') && !!single(c, /project/i, '10-21') }),
  S('update', 'postpone the passport renewal to next week same time', /passport/i, { 'Nov 9–13 09:00': c => { const e = single(c, /passport/i); return !!e && e.start.slice(0, 10) >= '2026-11-09' && e.start.slice(0, 10) <= '2026-11-15' && e.start.endsWith('09:00'); } }),
  S('update', 'move all my tuesday SE lectures to 4pm', /se lecture/i, { 'every Tuesday at 16:00': c => { const f = at(c, /se lecture/i).filter(e => dow(e) === 2); return f.length >= 5 && f.every(e => e.start.endsWith('16:00')); }, 'Mondays untouched': c => at(c, /se lecture/i).filter(e => dow(e) === 1).every(e => e.start.endsWith('13:00')) }),
  S('update', 'take college assignments an hour earlier', /college assignments/i, { 'Thu 19:00': c => span(single(c, /college assignments/i, '10-22'), '19:00', '19:45') }),
  S('update', 'add a note to team sync: bring the Q3 numbers', /team sync/i, { 'note added, time kept': c => { const e = single(c, /team sync/i); return !!e && /q3/i.test(e.description) && span(e, '13:30'); } }),
  // ─── delete ───
  S('delete', 'cancel the dentist', /dentist/i, { 'gone': c => !at(c, /dentist/i).length }),
  S('delete', "delete tomorrow's run", /^run/i, { 'gone': c => !at(c, /^run/i).length }),
  S('delete', 'remove the ai lecture on friday', /ai lecture/i, { 'only Fri Oct 23': c => gone(c, /ai lecture/i).length === 1 && gone(c, /ai lecture/i)[0].start.startsWith('2026-10-23') }),
  S('delete', 'cancel the ai lecutre today', /ai lecture/i, { 'only today': c => gone(c, /ai lecture/i).length === 1 && gone(c, /ai lecture/i)[0].start.startsWith('2026-10-21') }),
  S('delete', 'cancel all cfa classes till 17 november', /cfa class/i, { 'none until Nov 17': c => !at(c, /cfa class/i).some(e => e.start.slice(0, 10) <= '2026-11-17'), 'later ones stay': c => at(c, /cfa class/i).some(e => e.start.slice(0, 10) > '2026-11-17'), 'study blocks stay': c => !gone(c, /study block/i).length }),
  S('delete', 'delete everything on saturday', /./, { 'Sat empty': c => !c.events.filter(e => e.start.startsWith('2026-10-24') && !e.agent).length, 'other days stay': c => c.diff.removed.every(e => e.start.startsWith('2026-10-24')) }),
  S('delete', 'cancel everything till 3 november', /./, { 'nothing left to Nov 3': c => !c.events.filter(e => e.start >= '2026-10-21T10:00' && e.start.slice(0, 10) <= '2026-11-03' && !e.readOnly && e.myStatus !== 'declined' && !e.agent).length, 'after Nov 3 stays': c => c.diff.removed.every(e => e.start.slice(0, 10) <= '2026-11-03') }),
  S('delete', 'drop all the project deep dive sessions', /project/i, { 'all three gone': c => !at(c, /project/i).length }),
  S('delete', "i can't make it to the all hands", /all-hands/i, { 'declined': c => single(c, /all-hands/i)?.myStatus === 'declined' }),
  S('delete', 'get rid of the vendor sync and the team sync', /vendor|team sync/i, { 'both gone': c => !at(c, /vendor|team sync/i).length }),
  S('delete', 'cancel the sync', null, { 'asks which one': asked }),
  S('delete', 'cancel my 4pm tomorrow', /product review/i, { 'Product review gone': c => !at(c, /product review/i).length }),
  S('delete', 'i dont need the college study block anymore', /college study/i, { 'gone': c => !at(c, /college study/i).length }),
  S('delete', 'scrap all my labs next week', /lab/i, { 'OS + SE lab Oct 26 only': c => gone(c, /lab/i).length === 2 && gone(c, /lab/i).every(e => e.start.startsWith('2026-10-26')) }),
  // ─── follow-ups / context ───
  S('context', ['add gym on monday at 6pm', 'actually make it 7pm'], /gym/i, { 'one gym at 19:00': c => span(single(c, /gym/i, '10-26'), '19:00') }),
  S('context', ['book a call with Rahul on Monday at 5pm', 'rename it to Investor call', 'delete it'], /rahul|investor/i, { 'none left': c => !at(c, /rahul|investor/i).length }),
  S('context', ['cancel the sync', 'the vendor one'], /vendor/i, { 'vendor gone, team stays': c => !at(c, /vendor/i).length && !!single(c, /team sync/i) }),
  S('context', ['move the dentist to 4pm', 'undo that'], null, { 'back at 12:00': c => span(single(c, /dentist/i, '10-26'), '12:00', '13:00') }),
  S('context', ["what's on friday?", 'cancel the first one'], /ai lecture/i, { 'Fri AI Lecture gone': c => gone(c, /ai lecture/i).length === 1 && gone(c, /ai lecture/i)[0].start.startsWith('2026-10-23') }),
  S('context', ['add study session on monday at 6pm and tuesday at 4pm', 'delete both'], /study session/i, { 'none left': c => !at(c, /study session/i).length }),
  S('context', ['cancel the vendor sync', 'no wait, put it back'], null, { 'back': c => span(single(c, /vendor/i, '10-22'), '11:00', '11:30') }),
  S('context', ['add haircut tomorrow', 'move it to the evening'], /haircut/i, { 'tomorrow evening': c => { const e = single(c, /haircut/i, '10-22'); return !!e && e.start.slice(11) >= '17:00'; } }),
  S('context', ['lunch with sam at 1 on tuesday', 'make it 12:30', 'add a note: bring the contract'], /sam/i, { 'Tue 12:30, note kept': c => { const e = single(c, /sam/i, '10-27'); return !!e && e.start.endsWith('12:30') && /contract/i.test(e.description); } }),
  S('context', ['show my project deep dive sessions', 'delete all of them'], /project/i, { 'gone': c => !at(c, /project/i).length }),
  S('context', ['move vendor sync to friday', 'no, thursday at 3pm'], /vendor/i, { 'Thu 15:00': c => span(single(c, /vendor/i, '10-22'), '15:00', '15:30') }),
  S('context', ['add yoga on saturday at 7pm', 'ok put it at 9:30pm instead'], /yoga/i, { 'one yoga Sat 21:30, class kept': c => span(single(c, /yoga/i, '10-24'), '21:30') && !!single(c, /cfa class/i, '10-24') }),
  S('context', ['cancel the run', 'and the college assignments too'], /^run|college assignments/i, { 'both gone': c => !at(c, /^run|college assignments/i).length }),
  // ─── dates / times ───
  S('datetime', 'add a quick call in 2 hours', /call/i, { '12:00 today': c => span(single(c, /call/i, '10-21'), '12:00') }),
  S('datetime', 'team lunch day after tomorrow at 4pm', /lunch/i, { 'Fri 16:00': c => span(single(c, /lunch/i, '10-23'), '16:00') }),
  S('datetime', 'book a demo next friday at 10am', /demo/i, { 'Oct 30 10:00': c => span(single(c, /demo/i, '10-30'), '10:00') }),
  S('datetime', 'bank visit on the 5th at 11am', /bank/i, { 'Nov 5 11:00': c => span(single(c, /bank/i, '11-05'), '11:00') }),
  S('datetime', 'hiking this sunday at 5pm', /hik/i, { 'Oct 25 17:00': c => span(single(c, /hik/i, '10-25'), '17:00') }),
  S('datetime', 'study group tomorrow at half past five', /study group/i, { 'Thu 17:30': c => span(single(c, /study group/i, '10-22'), '17:30') }),
  S('datetime', 'doctor call at quarter to 12 on tuesday', /doctor/i, { 'Tue 11:45': c => span(single(c, /doctor/i, '10-27'), '11:45') }),
  S('datetime', 'piano at 9 tonight', /piano/i, { 'today 21:00': c => span(single(c, /piano/i, '10-21'), '21:00') }),
  S('datetime', 'piano at 8 tonight', /piano/i, { 'today 20:00': c => span(single(c, /piano/i, '10-21'), '20:00'), 'warns about Project Deep Dive': c => /(overlap|clash|conflict)/i.test(c.reply) && /project deep dive/i.test(c.reply) }),
  S('datetime', 'move the flight to 28 october at 7am', /flight/i, { 'Oct 28 07:00': c => span(single(c, /flight/i, '10-28'), '07:00') }),
  // ─── errors / edge ───
  S('edge', 'cancel my yoga class', null, { 'says not found': NOT_FOUND }),
  S('edge', 'move the marathon to 5', null, { 'says not found': NOT_FOUND }),
  S('edge', 'add a meeting yesterday at 3pm', null, { 'refuses the past': c => /(past|yesterday|already)/i.test(c.reply) }),
  S('edge', 'cancel the company holiday', null, { 'explains other calendar': c => /(calendar|can.t|cannot|only)/i.test(c.reply) }),
  S('edge', "what's the capital of france", null, { 'stays on topic': c => !/paris/i.test(c.reply) }),
  S('edge', 'thanks', null, {}),
  S('edge', 'cancel it', null, { 'asks what': asked }),
  // ─── harder, everyday phrasing ───
  S('real', 'kal shaam 6 baje gym', /gym/i, { 'Thu 18:00': c => span(single(c, /gym/i, '10-22'), '18:00') }),
  S('real', 'when am i free tomorrow for 2 hours', null, { 'names 13:30': c => /(13:30|1:30)/.test(c.reply) }),
  S('real', 'push everything after 6pm tomorrow by 30 minutes', /^run|college assignments|project deep dive/i, { 'Run 18:30': c => span(single(c, /^run/i, '10-22'), '18:30', '19:30'), 'Assignments 20:30': c => span(single(c, /college assignments/i, '10-22'), '20:30'), 'Deep dive 21:30': c => span(single(c, /project deep dive/i, '10-22'), '21:30') }),
  S('real', 'clear my evening tomorrow', /^run|college assignments|project deep dive/i, { 'Run and assignments gone': c => !at(c, /^run|college assignments/i).length, 'Product review kept': c => !!single(c, /product review/i, '10-22') }),
  S('real', 'meeting with priya tomorrow', /priya/i, { 'one new meeting tomorrow, in work hours, no clash': c => { const f = added(c, /priya/i); const e = f[0]; return f.length === 1 && e.start.startsWith('2026-10-22') && inHours(e, '09:00', '18:00') && !c.events.some(x => x.id !== e.id && x.start < e.end && x.end > e.start && !x.agent); } }),
  S('real', 'remind me to submit the form at 9pm tomorrow', /form/i, { 'Thu 21:00, short': c => { const e = single(c, /form/i, '10-22'); return span(e, '21:00') && e.end <= '2026-10-22T21:30'; } }),
  S('real', 'add Call with Sam tomorrow 3-4pm', /sam/i, { 'Thu 15:00–16:00': c => span(single(c, /sam/i, '10-22'), '15:00', '16:00') }),
  S('real', 'swap the dentist and the passport renewal', /dentist|passport/i, { 'dentist Nov 5 09:00': c => !!single(c, /dentist/i, '11-05') && single(c, /dentist/i).start.endsWith('09:00'), 'passport Oct 26 12:00': c => !!single(c, /passport/i, '10-26') && single(c, /passport/i).start.endsWith('12:00') }),
  S('real', "how's my week looking", null, { 'covers the week': c => /vendor/i.test(c.reply) && /cfa/i.test(c.reply) }),
  S('real', ["what's on friday?", 'cancel the last one'], /project deep dive/i, { 'Fri deep dive gone': c => gone(c, /project deep dive/i).length === 1 && gone(c, /project deep dive/i)[0].start.startsWith('2026-10-23') }),
  S('real', 'cancel everything tomorrow after 5pm', /^run|college assignments|project deep dive/i, { 'evening gone': c => !c.events.some(e => e.start.startsWith('2026-10-22') && e.start.slice(11) >= '17:00' && !e.agent), 'Product review kept': c => !!single(c, /product review/i, '10-22') }),
  S('real', 'move the cfa study block on saturday to sunday', /cfa: study/i, { 'Sat one moved to Sun, no clash': c => !at(c, /cfa: study/i, '10-24').length && at(c, /cfa: study/i, '10-25').length === 2 && at(c, /cfa: study/i, '10-25').every(e => !c.events.some(x => x.id !== e.id && !/cfa: study/i.test(x.title) && x.start < e.end && x.end > e.start)) }),
  S('real', 'i have a doctor appointment on thursday at 4, 1 hour', /doctor/i, { 'Thu 16:00–17:00': c => span(single(c, /doctor/i, '10-22'), '16:00', '17:00'), 'warns about Product review': c => /product review/i.test(c.reply) }),
  S('real', 'what did i have yesterday', null, { 'answers, no change': c => !/(created|cancelled|moved)/i.test(c.reply) }),
];
