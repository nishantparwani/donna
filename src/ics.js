// Imports a Google Calendar .ics export (Settings → Import & export → Export).
// Weekly/daily recurring events are expanded for the next 60 days and last 60 days.
import * as T from './time.js';
import * as cal from './calendar.js';
import { load, save } from './store.js';

function unfold(text) { return text.replace(/\r?\n[ \t]/g, ''); }

function parseDate(value, params) {
  // 20261017T100000Z | 20261017T100000 | 20261017 (all-day)
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  if (!m[4]) return { s: `${m[1]}-${m[2]}-${m[3]}T00:00`, allDay: true };
  if (m[7]) return { s: T.fmt(T.wall(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])))), allDay: false };
  return { s: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`, allDay: false }; // TZID or floating: treat as local
}

function parseEvents(text) {
  const out = [];
  const blocks = unfold(text).split('BEGIN:VEVENT').slice(1).map(b => b.split('END:VEVENT')[0]);
  for (const b of blocks) {
    const f = {};
    for (const line of b.split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const [name, ...params] = line.slice(0, i).split(';');
      const key = name.toUpperCase();
      const value = line.slice(i + 1);
      if (key === 'ATTENDEE') (f.ATTENDEE = f.ATTENDEE || []).push({ value, params: params.join(';') });
      else if (!(key in f)) f[key] = { value, params: params.join(';') };
    }
    if (!f.DTSTART || (f.STATUS && /CANCELLED/i.test(f.STATUS.value))) continue;
    const st = parseDate(f.DTSTART.value, f.DTSTART.params);
    if (!st) continue;
    let en = f.DTEND && parseDate(f.DTEND.value, f.DTEND.params);
    if (!en) en = { s: st.allDay ? T.addDays(T.day(st.s), 1) + 'T00:00' : T.addMin(st.s, 60), allDay: st.allDay };
    const clean = s => String(s || '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1').trim();
    const attendees = (f.ATTENDEE || []).map(a => a.value.replace(/^mailto:/i, ''));
    const organizer = f.ORGANIZER ? f.ORGANIZER.value.replace(/^mailto:/i, '') : '';
    const me = attendees.length ? null : organizer;
    out.push({
      title: clean(f.SUMMARY && f.SUMMARY.value) || '(no title)',
      start: st.s, end: en.s, allDay: st.allDay,
      description: clean(f.DESCRIPTION && f.DESCRIPTION.value).slice(0, 1000),
      location: clean(f.LOCATION && f.LOCATION.value),
      guests: attendees.filter(x => x && x !== organizer),
      organizerEmail: organizer, me,
      rrule: f.RRULE && f.RRULE.value,
      kind: attendees.length > 1 ? 'meeting' : 'task',
    });
  }
  return out;
}

function expand(ev) {
  if (!ev.rrule || ev.allDay) return [ev];
  const r = Object.fromEntries(ev.rrule.split(';').map(p => p.split('=')));
  const step = r.FREQ === 'DAILY' ? (+r.INTERVAL || 1) : r.FREQ === 'WEEKLY' ? 7 * (+r.INTERVAL || 1) : 0;
  if (!step) return [ev];
  if (r.FREQ === 'WEEKLY' && r.BYDAY) {
    // Expand each listed weekday as its own weekly run.
    const days = r.BYDAY.split(',').map(x => T.DAY_CODES.indexOf(x.slice(-2))).filter(x => x >= 0);
    const base = T.day(ev.start);
    return days.flatMap(wd => {
      let d = base;
      while (T.dow(d) !== wd) d = T.addDays(d, 1);
      const { BYDAY, ...rest } = r;
      return expand({ ...ev, start: d + ev.start.slice(10), end: T.addMin(d + ev.start.slice(10), T.diffMin(ev.start, ev.end)),
        rrule: Object.entries(rest).map(([k, v]) => k + '=' + v).join(';') });
    });
  }
  const dur = T.diffMin(ev.start, ev.end);
  const until = r.UNTIL ? parseDate(r.UNTIL, '').s : T.addDays(T.today(), 60) + 'T23:59';
  const from = T.addDays(T.today(), -60) + 'T00:00';
  const limit = [until, T.addDays(T.today(), 60) + 'T23:59'].sort()[0];
  const out = [];
  let count = 0;
  for (let s = ev.start; s <= limit; s = T.addMin(s, step * 1440)) {
    if (r.COUNT && ++count > +r.COUNT) break;
    if (s >= from) out.push({ ...ev, start: s, end: T.addMin(s, dur) });
  }
  return out;
}

/** Imports events from .ics text. Returns how many were added. */
export function importIcs(text, { replace = false, myEmail = '' } = {}) {
  const parsed = parseEvents(text).flatMap(expand);
  const lo = T.addDays(T.today(), -60) + 'T00:00', hi = T.addDays(T.today(), 60) + 'T23:59';
  const events = parsed.filter(e => e.end >= lo && e.start <= hi).map(e => ({
    title: e.title, start: e.start, end: e.end, allDay: e.allDay, description: e.description,
    location: e.location, guests: e.guests, kind: e.kind,
    organizer: !e.organizerEmail || !myEmail || e.organizerEmail.toLowerCase() === myEmail.toLowerCase(),
  }));
  if (replace) cal.replaceAll(events);
  else events.forEach(e => cal.create(e));
  return events.length;
}

/** A realistic sample fortnight around today (college timetable + study + a few meetings). */
export function loadDemo() {
  const t = T.today();
  const ev = [];
  const add = (d, st, en, title, extra = {}) => ev.push({ title, start: `${d}T${st}`, end: `${d}T${en}`, kind: 'meeting', organizer: true, ...extra });
  for (let i = -21; i < 21; i++) {
    const d = T.addDays(t, i);
    const w = T.dow(d);
    const cls = { kind: 'task', organizer: true };
    if (w === 1) { add(d, '09:00', '10:00', 'MAD Lecture', cls); add(d, '10:00', '12:00', 'OS Lab', cls); add(d, '13:00', '14:00', 'SE Lecture', cls); add(d, '16:00', '17:00', 'Project sync', { guests: ['riya@college.edu', 'arjun@college.edu'] }); }
    if (w === 2) { add(d, '09:00', '11:00', 'DBMS Lab', cls); add(d, '11:15', '12:15', 'OS Lecture', cls); add(d, '15:00', '15:30', '1:1 with mentor', { guests: ['mentor@company.com'], flexible: true }); }
    if (w === 3) { add(d, '10:00', '11:00', 'SE Lecture', cls); add(d, '11:00', '11:30', 'Club meeting', { guests: ['club@college.edu'] }); add(d, '14:00', '16:00', 'OE I', cls); }
    if (w === 4) { add(d, '09:00', '10:00', 'MAD Lecture', cls); add(d, '10:30', '11:30', 'Internship interview', { guests: ['hr@startup.io'], organizer: false }); add(d, '11:00', '11:30', 'Team standup', { guests: ['team@startup.io'] }); }
    if (w === 5) { add(d, '09:00', '12:00', 'CN Lab', cls); add(d, '17:00', '18:00', 'Gym', { kind: 'personal' }); }
    if (w >= 1 && w <= 5) add(d, '19:30', '20:30', 'DSA Study and LeetCode Practice', { kind: 'task' });
    if (w === 6) add(d, '09:00', '11:30', 'CFA: Study Block and Quiz', { kind: 'task' });
    if (w === 0) add(d, '18:00', '19:00', 'Family dinner', { kind: 'personal' });
  }
  cal.replaceAll(ev);
  const a = load('actions'); a.items = []; a.counter = 100; save('actions');
  const c = load('chat'); c.messages = []; save('chat');
  const tk = load('tasks'); tk.items = []; tk.seq = 0; save('tasks');
  return ev.length;
}
