// Wall-clock time helpers. Every time in the app is a "YYYY-MM-DDTHH:MM" string in the user's
// time zone. Internally those are encoded as UTC Date fields, so arithmetic is identical on a
// laptop and on a server running in UTC.

let fixedNow = null; // set by tests/eval for deterministic scenarios
let TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

// Building an Intl formatter costs ~0.1 ms — far too much to do per call on a 10 ms CPU budget — so cache it.
let fmtCache = { tz: '', f: null };
function formatter() {
  if (fmtCache.tz !== TZ) fmtCache = { tz: TZ, f: new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) };
  return fmtCache.f;
}
export function setTimeZone(tz) { if (tz && tz !== TZ) { try { new Intl.DateTimeFormat('en', { timeZone: tz }); TZ = tz; } catch { /* keep */ } } }
export const tzName = () => TZ;
export function setNow(s) { fixedNow = s ? parse(s) : null; }

/** Converts a real instant to the user's wall-clock time (encoded as UTC fields). */
export function wall(instant) {
  const p = {};
  for (const x of formatter().formatToParts(instant)) p[x.type] = x.value;
  return new Date(Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute));
}
// Wall-clock minutes only change once a minute: reuse the last answer for the same minute.
let nowCache = { key: -1, tz: '', d: null };
export function now() {
  if (fixedNow) return new Date(fixedNow);
  const key = Math.floor(Date.now() / 60000);
  if (nowCache.key !== key || nowCache.tz !== TZ) nowCache = { key, tz: TZ, d: wall(new Date()) };
  return new Date(nowCache.d);
}

const RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?/;
const p2 = n => String(n).padStart(2, '0');
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function parse(s) {
  if (s instanceof Date) return new Date(s);
  const m = String(s ?? '').trim().match(RE);
  if (!m) throw new Error(`Invalid time "${s}". Use YYYY-MM-DDTHH:MM (24-hour, local).`);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)));
}
export function fmt(d) {
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}T${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}
export const norm = s => fmt(parse(s));
export const nowStr = () => fmt(now());
export const today = () => nowStr().slice(0, 10);
export const day = s => String(s).slice(0, 10);
export const clock = s => String(s).slice(11, 16);
export const mins = s => +s.slice(11, 13) * 60 + +s.slice(14, 16);
export const hm = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
export const at = (d, minutes) => minutes >= 1440 ? `${d}T23:59` : `${d}T${p2(Math.floor(minutes / 60))}:${p2(minutes % 60)}`;
export const addMin = (s, m) => fmt(new Date(parse(s).getTime() + m * 60000));
export function addDays(d, n) { const x = parse(d); x.setUTCDate(x.getUTCDate() + n); return fmt(x).slice(0, 10); }
export const dow = d => parse(d).getUTCDay();
export const hourNow = () => now().getUTCHours();
export const diffMin = (a, b) => Math.round((parse(b) - parse(a)) / 60000);
export const overlaps = (a, b) => a.start < b.end && a.end > b.start;
export function roundUp15(s) { const d = parse(s); const m = d.getUTCMinutes(); d.setUTCMinutes(m + ((15 - (m % 15)) % 15)); return fmt(d); }
export function human(s) { const d = parse(s); return `${DAY_NAMES[d.getUTCDay()].slice(0, 3)} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${clock(s)}`; }
export const span = (a, b) => day(a) === day(b) ? `${human(a)}–${clock(b)}` : `${human(a)} – ${human(b)}`;

/** Monday of the week containing day d. */
export function weekStart(d) { const w = dow(d); return addDays(d, w === 0 ? -6 : 1 - w); }

export function addMonths(d, n) {
  const x = parse(d);
  const want = x.getUTCDate();
  x.setUTCDate(1); x.setUTCMonth(x.getUTCMonth() + n);
  const last = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate();
  x.setUTCDate(Math.min(want, last));
  return fmt(x).slice(0, 10) + String(d).slice(10);
}
export const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
export const toHM = m => `${p2(Math.floor(m / 60))}:${p2(m % 60)}`;
/** "HH:MM" → whether it is a valid 24-hour clock time. */
export const isHM = s => /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(s || ''));
/** Is minute-of-day m inside [a, b)? Handles windows that wrap past midnight (e.g. sleep 23:00–07:00). */
export const inWindow = (m, a, b) => a <= b ? m >= a && m < b : m >= a || m < b;
