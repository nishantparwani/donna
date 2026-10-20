// Radar (no AI): what is coming that matters — exams, evaluations, presentations, deadlines, task due
// dates and trips — plus the classes that fall while the user is away. Feeds the Today view, the
// briefings and the model's context.
import * as T from './time.js';
import * as cal from './calendar.js';
import { load, settings } from './store.js';
import { isPing } from './engine.js';

const BIG = /\b(exams?|mid-?terms?|end-?sems?|finals?|viva|quiz|tests?|ica|assessment|evaluation|eval|presentation|submission|deadline|due|demo|interview|hackathon|placement)\b/i;
const OWN_WORK = /\b(study (?:block|session)|self[- ]study|practice|revision|revise|prep|preparation|block|session|leetcode|dsa|homework|deep dive|mock)\b/i;
const TRAVEL = /\b(flight|train|bus|travel|trip|drive)\b/i;
const CLASS = /\b(lecture|lab|class|tutorial|seminar|oe ?i{1,3}|practical)s?\b/i;
// A short all-caps all-day title ("SE", "OS", "IVP") on a college calendar is an exam day.
const COURSE_CODE = /^[A-Z]{2,5}( ?[IVX\d]{1,3})?$/;

const whenText = (d, today) => {
  const n = Math.round(T.diffMin(today + 'T00:00', d + 'T00:00') / 1440);
  return n === 0 ? 'today' : n === 1 ? 'tomorrow' : n < 7 ? T.DAY_NAMES[T.dow(d)] : `in ${n} days`;
};

/** Where a trip goes: "Flight BOS to ORD" → "ORD", "Train to Chicago Union" → "Chicago". */
export function destination(title) {
  const m = /\bto\s+([A-Za-z][A-Za-z.]+(?:\s+(?!jn\b|\(|from\b)[A-Z][a-z]+)?)/i.exec(String(title));
  return m ? m[1].replace(/\.$/, '') : '';
}

/**
 * @param {number} days how far ahead to look
 * @returns {{items: {date: string, when: string, kind: string, title: string, time: string}[], away: object[]}}
 */
export function radar(days = 21) {
  const today = T.today();
  const to = T.addDays(today, days);
  const evs = cal.list(T.nowStr(), to + 'T00:00').filter(e => e.myStatus !== 'declined' && !isPing(e) && !e.taskId && !e.habitId && e.kind !== 'buffer');
  const items = [], seen = new Set();
  for (const e of evs) {
    const d = T.day(e.start) < today ? today : T.day(e.start);
    const text = `${e.title} ${e.allDay ? '' : e.description || ''}`;
    let kind = '';
    if (TRAVEL.test(e.title)) kind = 'travel';
    else if (BIG.test(text) && !OWN_WORK.test(e.title)) kind = /present|demo|viva/i.test(text) ? 'presentation' : /deadline|due|submission/i.test(text) ? 'deadline' : 'exam';
    else if (e.allDay && COURSE_CODE.test(e.title.trim())) kind = 'exam';
    if (!kind) continue;
    const key = kind === 'travel' ? `travel|${e.start}` : (e.recurringId || e.title).toLowerCase(); // one row per trip, even if Gmail added it too
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ date: d, when: whenText(d, today), kind, title: e.title, time: e.allDay ? '' : T.clock(e.start), id: e.id });
  }
  for (const t of load('tasks').items.filter(x => x.status === 'open' && !x.goalId && T.day(x.due) <= to)) {
    items.push({ date: T.day(t.due), when: whenText(T.day(t.due), today), kind: 'task', title: t.title, time: t.due.length > 10 ? T.clock(t.due) : '', atRisk: !!t.atRisk });
  }
  items.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));

  // Trips: from arriving somewhere until the next trip, in-person classes can't happen.
  const trips = evs.filter(e => TRAVEL.test(e.title) && !e.allDay).sort((a, b) => a.start.localeCompare(b.start));
  // homeCity may list aliases: 'Boston, Cambridge, BOS, CBG'.
  const home = String(settings().homeCity || '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
  const isHome = dest => !!dest && home.some(h => dest.toLowerCase().startsWith(h.slice(0, Math.max(3, Math.min(5, h.length)))));
  const away = [];
  for (let i = 0; i < trips.length; i++) {
    const out = trips[i];
    const dest = destination(out.title);
    if (!home.length || isHome(dest) || !dest) continue; // only trips away from home
    const back = trips.slice(i + 1).find(x => x.start > out.end && isHome(destination(x.title)));
    const until = back ? back.start : T.addDays(T.day(out.end), 7) + 'T23:59';
    const classes = cal.list(out.end, until).filter(e => !e.allDay && CLASS.test(e.title) && !OWN_WORK.test(e.title) && e.myStatus !== 'declined');
    if (classes.length) away.push({ trip: out.title, from: out.end, until, back: back ? back.title : '', classes: classes.length,
      text: `${out.title} (${T.human(out.start)}): ${classes.length} class${classes.length === 1 ? '' : 'es'} fall while you're away${back ? ` until ${T.human(back.start)}` : ' (no return trip on the calendar)'}.` });
    if (back) i = trips.indexOf(back); // the return leg is not a new departure
  }
  return { items, away };
}

/** Compact lines for the model's context. */
export function radarLines(max = 8) {
  const r = radar(21);
  const lines = r.items.slice(0, max).map(x => `${x.date} (${x.when})${x.time ? ' ' + x.time : ''} ${x.kind}: ${x.title}${x.atRisk ? ' — AT RISK' : ''}`);
  return [...lines, ...r.away.map(a => 'away: ' + a.text)];
}

/** When the morning briefing should go out on day d: the set time, or 45 min before the first commitment if earlier. */
export function morningTime(d = T.today(), s = settings()) {
  if (!s.morningBriefing) return '';
  const first = cal.list(T.at(d, 0), T.addDays(d, 1) + 'T00:00').find(e => !e.allDay && e.myStatus !== 'declined' && !isPing(e) && T.day(e.start) === d && T.mins(e.start) >= 5 * 60);
  const set = T.hm(s.morningBriefing);
  const early = first ? T.mins(first.start) - 45 : set;
  return T.toHM(Math.max(6 * 60, Math.min(set, early)));
}
