// Public booking page (like a scheduling link): others pick a free slot, the agent books it with a
// Meet link and an invite. Off until enabled in Settings → Booking page.
import * as T from './time.js';
import * as cal from './calendar.js';
import { load, save, settings } from './store.js';
import { RUN, beginRun, clashesWith, logAction } from './engine.js';

const EMAIL = /^[^@\s<>"]{1,64}@[^@\s<>"]{1,190}\.[a-z]{2,}$/i;
const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');

export function bookingEnabled(slug) {
  const b = settings().booking;
  return !!b.enabled && !!b.slug && (!slug || slug === b.slug);
}

export function publicInfo() {
  const s = settings();
  const b = s.booking;
  return { title: b.title || `Meet with ${s.userName || s.agentName}`, intro: b.intro || '', durations: b.durations, timeZone: T.tzName(), host: s.userName || '', daysAhead: b.daysAhead };
}

const bookingsOn = d => load('bookings').items.filter(x => x.status !== 'cancelled' && T.day(x.start) === d).length;

/** Free slots for a duration: { days: [{ date, label, times: [HH:MM] }] } */
export function publicSlots(duration) {
  const b = settings().booking;
  const dur = b.durations.includes(Number(duration)) ? Number(duration) : b.durations[0];
  const earliest = T.roundUp15(T.addMin(T.nowStr(), b.minNoticeHours * 60));
  const days = [];
  for (let i = 0; i <= b.daysAhead; i++) {
    const d = T.addDays(T.today(), i);
    if (!b.days.includes(T.dow(d)) || bookingsOn(d) >= b.maxPerDay) continue;
    const times = [];
    for (let m = T.hm(b.start); m + dur <= T.hm(b.end); m += 15) {
      const start = T.at(d, m), end = T.addMin(start, dur);
      if (start < earliest) continue;
      if (clashesWith(T.addMin(start, -b.bufferMinutes), T.addMin(end, b.bufferMinutes)).length) continue;
      times.push(T.clock(start));
    }
    // Offer at most one start per half hour so the page stays readable.
    const thinned = times.filter(t => t.endsWith(':00') || t.endsWith(':30'));
    if (thinned.length) days.push({ date: d, label: `${T.DAY_NAMES[T.dow(d)].slice(0, 3)} ${T.human(d + 'T00:00').slice(4, -6)}`, times: thinned });
  }
  return { duration: dur, timeZone: T.tzName(), days };
}

export function book({ name, email, start, duration, note }) {
  const s = settings();
  const b = s.booking;
  name = String(name || '').replace(/[\r\n<>]/g, ' ').trim().slice(0, 80);
  email = String(email || '').trim().slice(0, 200);
  note = String(note || '').replace(/\r/g, '').trim().slice(0, 1000);
  if (!name) throw new Error('Please enter your name.');
  if (!EMAIL.test(email)) throw new Error('Please enter a valid email address.');
  const slots = publicSlots(duration);
  const st = T.norm(start);
  const day = slots.days.find(x => x.date === T.day(st));
  if (!day || !day.times.includes(T.clock(st))) throw new Error('That time was just taken. Please pick another.');
  beginRun('booking', '');
  const end = T.addMin(st, slots.duration);
  const host = s.userName || s.agentName;
  const ev = cal.create({ title: `${name} × ${host}`, start: st, end, kind: 'meeting', agent: true, guests: [email], meet: true,
    description: `Booked via your booking page by ${name} <${email}>.${note ? '\n\nNote: ' + note : ''}`, reminder: s.defaultReminder || 10 });
  const id = logAction('create', null, ev, `Booked through the booking page by ${name}`, { auto: false });
  const token = randomToken();
  load('bookings').items.push({ id, token, name, email, note, start: st, end, eventId: ev.id, status: 'booked', created: T.nowStr() });
  save('bookings');
  return { ok: true, start: st, end, title: ev.title, eventId: ev.id, token, actionId: id, actions: RUN.actions.slice() };
}

export function cancelBooking(token) {
  const bk = load('bookings').items.find(x => x.token === String(token || ''));
  if (!bk || bk.status === 'cancelled') throw new Error('This booking was not found or is already cancelled.');
  if (bk.start < T.nowStr()) throw new Error('This meeting has already started.');
  beginRun('booking', '');
  const ev = cal.get(bk.eventId);
  if (ev) { cal.remove(ev.id); logAction('delete', ev, null, `${bk.name} cancelled through the booking page`); }
  bk.status = 'cancelled';
  save('bookings');
  return { ok: true, start: bk.start };
}

/** The guest-facing view of one booking (for its cancel link). */
export function bookingByToken(token) {
  const bk = load('bookings').items.find(x => x.token === String(token || ''));
  if (!bk) return null;
  const ev = cal.get(bk.eventId);
  return { name: bk.name, start: bk.start, end: bk.end, status: bk.status, meetLink: ev && ev.meetLink || '', eventId: bk.eventId };
}
