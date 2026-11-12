// Dates and times in ordinary English, resolved in code so the model (and its tokens) aren't needed for them.
import * as T from './time.js';
import { settings } from './store.js';

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WD = '(sun|mon|tue|wed|thu|fri|sat)(?:day|s|nes|nesday|sday|urs|ursday|ur|urday)?s?';
const MON = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*';

/** Is it between midnight and the night-owl cutoff (the user is still up from "yesterday")? */
export const lateNight = (s = settings()) => !!s.nightOwl && T.mins(T.nowStr()) < T.hm(s.nightOwl);

const tomorrow = () => lateNight() ? T.today() : T.addDays(T.today(), 1);
/** The coming <weekday>: today if it is that day, else the next one. */
function coming(i) {
  const t = T.today();
  if (T.dow(t) === i) return t;
  let d = lateNight() ? t : T.addDays(t, 1);
  while (T.dow(d) !== i) d = T.addDays(d, 1);
  return d;
}
const nextWeek = i => T.addDays(T.addDays(T.weekStart(T.today()), 7), (i + 6) % 7);
/** Days in month m (1–12) of year y. */
export const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
/** A real calendar date, or '' ("30 Feb" is not one: it must never roll over into March). */
function dateOf(y, m, n) {
  if (m < 1 || m > 12 || n < 1 || n > daysInMonth(y, m)) return '';
  return `${y}-${String(m).padStart(2, '0')}-${String(n).padStart(2, '0')}`;
}
/** Day n of month m (1–12): this year if still ahead (or today), else next year. A year given is kept. */
function dayOfMonth(m, n, year) {
  if (year) return dateOf(year < 100 ? 2000 + year : year, m, n);
  const y = Number(T.today().slice(0, 4));
  const here = dateOf(y, m, n);
  if (here && here >= T.today()) return here;
  return dateOf(y + 1, m, n) || (m === 2 && n === 29 ? dateOf(y + 4 - (y % 4), 2, 29) : '');
}
function monthDay(mon, day, year) {
  const m = MONTHS.indexOf(mon.slice(0, 3));
  return m < 0 ? '' : dayOfMonth(m + 1, Number(day), Number(year) || 0);
}
/** "the 31st": this month if it has that day and it is still ahead, else the next month that has it. */
function ordinalDay(day) {
  const n = Number(day);
  if (n < 1 || n > 31) return '';
  const t = T.today();
  let y = Number(t.slice(0, 4)), m = Number(t.slice(5, 7));
  for (let i = 0; i < 12; i++) {
    const d = dateOf(y, m, n);
    if (d && d >= t) return d;
    m++; if (m > 12) { m = 1; y++; }
  }
  return '';
}
/** A date the user wrote that doesn't exist ("30 Feb", "31/04"), as a sentence to say back, or ''. */
export function impossibleDate(text) {
  const t = String(text || '').toLowerCase();
  const say = (m, n) => `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1]} has no ${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}, so nothing was booked. Which date did you mean?`;
  let x = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MON}\\b`).exec(t) || new RegExp(`\\b${MON}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`).exec(t);
  if (x) {
    const n = Number(/^\d/.test(x[1]) ? x[1] : x[2]), m = MONTHS.indexOf((/^\d/.test(x[1]) ? x[2] : x[1]).slice(0, 3)) + 1;
    if (m && n >= 1 && n > daysInMonth(2028, m)) return say(m, n); // 2028: a leap year, so 29 Feb is allowed
  }
  x = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(t);
  if (x && Number(x[2]) >= 1 && Number(x[2]) <= 12 && Number(x[1]) > daysInMonth(2028, Number(x[2]))) return say(Number(x[2]), Number(x[1]));
  return '';
}
const week = from => Array.from({ length: 7 }, (_, i) => T.addDays(from, i));

/**
 * Hinglish time words → English, so the code-level parsers read "kal shaam 6 baje gym" as "tomorrow evening at 6 gym".
 * Only whole words are replaced; the model still gets the user's own text.
 */
export function hinglish(text) {
  const t = String(text || '');
  // "kal", "sham", "raat", "subah" are also people's names: "Lunch with Kal at 1pm" must stay as written.
  // The words are only read as Hinglish next to a form no English sentence has ("6 baje", "saade 9", "2 ghante").
  if (!/\b\d{1,2}(?:[:.]\d{2})?\s*baje\b|\bsaade\s+\d|\b\d+\s*ghant[ae]\b/i.test(t)) return t;
  return t
    .replace(/\b(\d{1,2})(?:[:.](\d{2}))?\s*baje\b/gi, (_, h, m) => `at ${h}${m ? ':' + m : ''}`)
    .replace(/\bsaade\s+(\d{1,2})\b/gi, (_, h) => `at ${h}:30`)
    .replace(/\bparso[n]?\b/gi, 'day after tomorrow')
    .replace(/\bkal\b/gi, 'tomorrow').replace(/\baaj\b/gi, 'today')
    .replace(/\bsubah\b/gi, 'morning').replace(/\b(?:shaam|sham)\b/gi, 'evening').replace(/\braat\b/gi, 'night').replace(/\bdopahar\b/gi, 'afternoon')
    .replace(/\b(\d+)\s*ghant[ae]\b/gi, '$1 hours');
}

const PATTERNS = [
  [/\b(?:yesterday|yday)(?:'s)?\b/g, () => [T.addDays(T.today(), -1)]],
  [new RegExp(`\\blast\\s+${WD}(?:'s)?\\b`, 'g'), m => { let d = T.addDays(T.today(), -1); while (T.dow(d) !== DAYS.indexOf(m[1])) d = T.addDays(d, -1); return [d]; }],
  [/\bday after to+m*o*r+o*w\b/g, () => [T.addDays(tomorrow(), 1)]],
  [/\b(?:today|tonight|this (?:morning|afternoon|evening))(?:'s)?\b/g, () => [T.today()]],
  [/\bto+m+o*r+o*w(?:'s)?\b|\btmrw\b|\btmr\b/g, () => [tomorrow()]],
  [/\b\d{4}-\d{2}-\d{2}\b/g, m => [m[0]]],
  [new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MON}(?:,?\\s+(\\d{4}))?\\b`, 'g'), m => [monthDay(m[2], m[1], m[3])]],
  [new RegExp(`\\b${MON}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'g'), m => [monthDay(m[1], m[2], m[3])]],
  // Day first, as written in India: 20/11, 20/11/2026.
  [/\b(?:on\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?\b/g, m => [dayOfMonth(Number(m[2]), Number(m[1]), Number(m[3]) || 0)]],
  [/\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\b/g, m => [ordinalDay(m[1])]],
  [/\bin\s+(\d{1,2}|a|one|two|three|four|five|six|seven)\s+days?\b/g, m => [T.addDays(T.today(), Number(m[1]) || { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 }[m[1]])]],
  [/\bnext week(?:'s)?\b/g, () => week(T.addDays(T.weekStart(T.today()), 7))],
  [/\b(?:this|my|the) week(?:'s)?\b/g, () => week(T.today()).filter(d => d <= T.addDays(T.weekStart(T.today()), 6))],
  [/\bnext weekend\b/g, () => [T.addDays(T.weekStart(T.today()), 12), T.addDays(T.weekStart(T.today()), 13)]],
  [/\b(?:this )?weekend(?:'s)?\b/g, () => [T.addDays(T.weekStart(T.today()), 5), T.addDays(T.weekStart(T.today()), 6)]],
  [new RegExp(`\\bnext\\s+${WD}(?:'s)?\\b`, 'g'), m => [nextWeek(DAYS.indexOf(m[1]))]],
  // "sat", "sun" and "wed" alone are ordinary words ("SAT prep", "lunch in the sun"): as days they need "on/this/coming/by".
  [new RegExp(`\\b(?:(?:this|coming|on|by|till|until)\\s+)?${WD}(?:'s)?\\b`, 'g'), m => /^(?:sat|sun|wed)$/.test(m[0]) ? null : [coming(DAYS.indexOf(m[1]))]],
];

/** { days: dates named in the text, rest: the text with those phrases removed }. */
export function whenIn(text) {
  let rest = String(text || '').toLowerCase().replace(/[’]/g, "'");
  const days = [];
  for (const [re, fn] of PATTERNS) {
    rest = rest.replace(re, (...a) => { const got = fn(a); if (!got) return a[0]; days.push(...got.filter(Boolean)); return ' '; });
  }
  return { days: [...new Set(days)].sort(), rest: rest.replace(/\s+/g, ' ').trim() };
}
export const datesIn = text => whenIn(text).days;

const WORD_HOURS = { noon: 720, midday: 720, midnight: 0 };
/** Bare hours ("at 3", "at 8") mean the next waking occurrence: hours before wake-up are PM. */
function bare(h, s = settings()) {
  if (h === 12 || h === 0 || h > 12) return h * 60 || 0;
  return (h < Math.floor(T.hm(s.dayStart) / 60) ? h + 12 : h) * 60;
}
const CLOCK = /\b(?:at\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])|\b(?:at\s+)?(\d{1,2})[:.](\d{2})\b|\bat\s+(\d{1,2})\b|\b(?:at\s+)?(?:12\s+)?(noon|midday|midnight)\b/;

/**
 * The part of the day a message points at, for hours written without am/pm:
 * words ("tomorrow morning", "tonight") first, then what the plan is ("dinner at 8" is 20:00, "breakfast at 8" is 08:00).
 */
export function dayPart(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(?:morning|sunrise|dawn|breakfast)\b/.test(t)) return 'morning';
  if (/\b(?:tonight|evening|night|dinner|supper|party|drinks|movie|club|late night)\b/.test(t)) return 'evening';
  if (/\b(?:afternoon|lunch)\b/.test(t)) return 'afternoon';
  return '';
}
/** A bare hour (1–12) read with the part of the day; '' part = the next waking occurrence. */
function hourOf(h, part) {
  if (h > 12) return h * 60;
  if (part === 'morning') return (h === 12 ? 0 : h) * 60;
  if (part === 'evening') return (h === 12 ? 12 : h + 12) * 60;
  if (part === 'afternoon') return (h >= 1 && h <= 8 ? h + 12 : h) * 60;
  return bare(h);
}
/**
 * { minutes, rest } for the first clock time in the text, or null.
 * part: 'morning' | 'afternoon' | 'evening' (evening: true is the older spelling of part: 'evening').
 */
export function timeIn(text, { evening = false, part = '' } = {}) {
  const t = String(text || '').toLowerCase();
  const m = CLOCK.exec(t);
  if (!m) return null;
  const p = part || (evening ? 'evening' : '');
  let minutes;
  if (m[7]) minutes = WORD_HOURS[m[7]];
  else if (m[3]) { const h = Number(m[1]) % 12 + (/p/.test(m[3]) ? 12 : 0); minutes = h * 60 + Number(m[2] || 0); }
  else if (m[4]) { const h = Number(m[4]); if (Number(m[5]) > 59) return null; minutes = hourOf(h, p) + Number(m[5]); }
  else minutes = hourOf(Number(m[6]), p);
  if (minutes >= 1440) return null;
  return { minutes, rest: (t.slice(0, m.index) + ' ' + t.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim() };
}

const TIME = String.raw`(?:\d{1,2}(?:[:.]\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?|(?:12\s+)?(?:noon|midday|midnight))`;
const RANGE = new RegExp(String.raw`\b(?:from\s+)?(${TIME})\s*(?:-|–|to|till|until|til)\s*(${TIME})(?![\d:])`);
/**
 * { start, end, rest } (minutes) for a time range ("from 12 noon till 3pm", "4-6pm", "10:30 to 12"), or null.
 * An end without am/pm that would come before the start is read in the afternoon/evening ("10 to 2" = 10:00–14:00).
 */
export function rangeIn(text, { part = '' } = {}) {
  const t = String(text || '').toLowerCase();
  const m = RANGE.exec(t);
  if (!m) return null;
  const marked = x => /a\.?m|p\.?m|noon|midday|midnight|[:.]\d/.test(x);
  // "2 to 3 people" is not a time: a range needs "from", a dash, or a clearly written time.
  if (!/^from\s/.test(m[0]) && !/[-–]/.test(m[0]) && !marked(m[1]) && !marked(m[2])) return null;
  const clock = (x, p) => timeIn(/^\d{1,2}$/.test(x.trim()) ? `at ${x}` : x, { part: p });
  const b = clock(m[2], part);
  if (!b) return null;
  let end = b.minutes;
  // "4-6pm": the start shares the end's am/pm when that keeps it before the end ("11-1pm" stays 11:00).
  const ap = /(a\.?m\.?|p\.?m\.?)/.exec(m[2]);
  let a = !marked(m[1]) && ap ? clock(`${m[1]} ${ap[1]}`, part) : null;
  if (!a || a.minutes >= end) a = clock(m[1], part);
  if (!a) return null;
  const start = a.minutes;
  if (end <= start && !marked(m[2]) && end + 720 > start) end += 720; // "from 10 till 2" = 10:00–14:00
  if (end <= start && end === 0) end = 1440;                         // "till midnight"
  if (end <= start) return null;
  return { start, end, rest: (t.slice(0, m.index) + ' ' + t.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim() };
}

/** { minutes, rest } for a stated length ("for 45 min", "for 2 hours"), or null. */
export function lengthIn(text) {
  const t = String(text || '').toLowerCase();
  const m = /\bfor\s+(\d+(?:\.\d+)?|an?|half an?)\s*(min(?:ute)?s?|h(?:ou)?rs?|hours?)\b/.exec(t);
  if (!m) return null;
  const n = /^half/.test(m[1]) ? 0.5 : /^an?$/.test(m[1]) ? 1 : Number(m[1]);
  return { minutes: Math.round(n * (/^h/.test(m[2]) ? 60 : 1)), rest: (t.slice(0, m.index) + ' ' + t.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim() };
}

const NOISE = new Set(('the my a an and or of to at on in by for from with this that these those it them both one ones first second third last next all every any everything please pls can could you i me we is are am do does did have has need want get got let make made put set add book schedule create block move shift push pull postpone prepone reschedule change rename update edit extend shorten cancel delete remove drop scrap rid clear take bring keep start end show list what whats when where how many much time times today tonight tomorrow week weekend morning afternoon evening night hour hours min mins minutes back later earlier before after till until instead actually again also too no yes ok okay wait not sure see note notes title location meeting event events appointment session sessions dont cant anymore fix conflict conflicts room up free').split(' '));
/** The words of a message that could name an event (dates, verbs and filler removed). */
export const contentWords = text => whenIn(text).rest.replace(/'s\b/g, '').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(x => x.length > 1 && !NOISE.has(x) && !/^\d+$/.test(x) && !/^\d+(am|pm)$/.test(x));
