// Requests that need no AI: reading a day, "when is my X", and simple create / move / rename / cancel.
// Instant, free, and they still work when every AI quota is used up. Anything not fully understood
// here returns null and goes to the model, so these parsers only ever act on what they completely read.
import * as T from './time.js';
import * as cal from './calendar.js';
import { TOOLS, RUN, isPing, isActive, sameWord } from './engine.js';
import { lateNight, whenIn, timeIn, lengthIn, rangeIn, dayPart, impossibleDate } from './when.js';
import { colorIn, colorId } from './colors.js';
import { ensureRange } from './sync.js';
import { load } from './store.js';

const lineOf = e => `${e.allDay ? 'All day' : `${T.clock(e.start)}–${T.clock(e.end)}`} ${e.title}`;
const dur = m => m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ' ' + (m % 60) + 'm' : ''}` : `${m} min`;
const words = s => String(s || '').toLowerCase().replace(/'s\b/g, '').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
const FILLER = new Set(['the', 'my', 'a', 'an', 'please', 'pls', 'can', 'could', 'you', 'kindly', 'for', 'me', 'just', 'on', 'of']);
const horizon = () => T.addDays(T.today(), 42);

/** "tomorrow" / "friday" → a date (kept for callers that have one word). */
export function dayFromWord(w) { return whenIn(w).days[0] || ''; }

function agenda(d) {
  const evs = cal.list(T.at(d, 0), T.addDays(d, 1) + 'T00:00').filter(e => isActive(e) && e.kind !== 'buffer');
  const label = d === T.today() ? 'Today' : d === T.addDays(T.today(), 1) ? 'Tomorrow' : T.DAY_NAMES[T.dow(d)];
  const head = `${label} (${T.human(d + 'T00:00').slice(0, -6)})`;
  RUN.listed.push(...evs.map(e => e.id));
  return evs.length ? `${head}:\n${evs.map(lineOf).join('\n')}` : `${head}: nothing scheduled.`;
}

const READ_WORDS = new Set(['what', 'whats', 'looking', 'going', 'did', 'had', 'what s', 'do', 'i', 'have', 'on', 'is', 'my', 'the', 'schedule', 'calendar', 'agenda', 'plan', 'for', 'show', 'me', 'list', 'see', 'look', 'looks', 'like', 'day', 'how', 'hows', 'does', 'got', 'anything', 'events', 'in', 's', 'tell', 'about']);
const NEXT = /^\s*(?:what(?:'?s| is)\s+)?(?:my\s+)?next(?:\s+(?:event|thing|up|meeting|class))?\s*[?!.]*\s*$/i;
const WOKE = /^\s*(?:i\s*(?:'?ve|have)?\s*(?:just\s+)?(?:woke|woken|got)\s+up|just\s+woke\s+up|i'?m\s+(?:up|awake))(?:\s+(?:just\s+)?(?:now|right now|rn|late))?(?:\s+at\s+(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?)?\s*[.,!]*\s*(?:(?:please\s+)?(?:re-?plan|redo|reschedule|shift|fix|adjust|sort|rearrange)\s+(?:my|the|today'?s)?\s*(?:day|schedule|plan|everything)?(?:\s+accordingly)?)?\s*[.!]*\s*$/i;
const LATE = /^\s*(?:i'?m\s+)?running\s+(?:(\d+)\s*(?:min(?:ute)?s?|m)\s+)?late\s*[.!]*\s*$/i;
const WHEN_IS = /^\s*(?:when(?:'?s| is| are| do i have)?|what time(?:'?s| is))\s+(.+?)\s*[?!.]*\s*$/i;
const WHEN_SKIP = new Set(['my', 'the', 'next', 'appointment', 'a', 'an', 'upcoming', 'event']);

export function planText(r, verb = 'Planned') {
  const lines = [`${verb} ${r.date === T.today() ? 'today' : r.date} from ${r.planned_window.split('–')[0]}:`, ...r.timeline];
  if (r.moved_to_next_day) lines.push('Moved to tomorrow: ' + r.moved_to_next_day.join('; '));
  if (r.not_placed) lines.push("Didn't fit: " + r.not_placed.join('; '));
  return lines.join('\n');
}

const titleHas = (title, said) => { const t = words(title); return said.every(w => t.some(x => sameWord(x, w))); };
/** Upcoming events whose title contains every word said, in time order. */
function findByWords(said, days) {
  const now = T.nowStr();
  const from = days.length ? days[0] + 'T00:00' : now, to = days.length ? T.addDays(days[days.length - 1], 1) + 'T00:00' : horizon() + 'T00:00';
  return cal.list(from, to).filter(e => e.end > now && isActive(e) && e.kind !== 'buffer' && (!days.length || days.includes(T.day(e.start))) && titleHas(e.title, said));
}
/** The one event meant, or a question when several differently titled events fit, or null when unsure. */
function pick(said, days) {
  if (!said.length) return null;
  const hits = findByWords(said, days);
  if (!hits.length) return null;
  const exact = hits.filter(e => words(e.title).join(' ') === said.join(' '));
  const pool = exact.length ? exact : hits;
  const titles = [...new Set(pool.map(e => e.title))];
  if (titles.length > 1) {
    const firsts = titles.slice(0, 4).map(t => { const e = pool.find(x => x.title === t); return `${e.title} (${T.human(e.start)})`; });
    return { ask: `Which one: ${firsts.join(' or ')}?` };
  }
  return { ev: pool[0] };
}

const NOT_SIMPLE = /\b(all|every|everything|each|and|till|until|from|through|between|series|recurring|them|it|that|those|these|both|one|ones|first|second|last|anything|except|instead|too|also|if)\b|[,;\n]/i;

async function quickDelete(text) {
  const m = /^(?:please\s+)?(cancel|delete|remove|drop|scrap)\s+(.+)$/i.exec(text);
  if (!m || NOT_SIMPLE.test(m[2])) return null;
  const { days, rest } = whenIn(m[2]);
  if (/\d/.test(rest)) return null;
  const said = words(rest).filter(w => !FILLER.has(w));
  const hit = pick(said, days);
  if (!hit) return null;
  if (hit.ask) return hit.ask;
  if (hit.ev.readOnly) return `"${hit.ev.title}" is on another calendar, so it can only be changed there.`;
  await TOOLS.delete_events({ event_ids: [hit.ev.id] });
  return '';
}

async function quickMove(text) {
  let m = /^(?:please\s+)?(?:move|shift|reschedule|push|postpone|prepone|delay)\s+(.+?)\s+(?:back\s+by|back|by)\s+(\d+|an?|half an?)\s*(min(?:ute)?s?|h(?:ou)?rs?|hours?)(?:\s+later)?$/i.exec(text);
  if (m) {
    if (NOT_SIMPLE.test(m[1])) return null;
    const { days, rest } = whenIn(m[1]);
    const hit = pick(words(rest).filter(w => !FILLER.has(w)), days);
    if (!hit) return null;
    if (hit.ask) return hit.ask;
    const n = /^half/i.test(m[2]) ? 0.5 : /^an?$/i.test(m[2]) ? 1 : Number(m[2]);
    const sign = /prepone/i.test(text) ? -1 : 1;
    const r = await TOOLS.move_event({ event_id: hit.ev.id, shift_minutes: sign * Math.round(n * (/^h/i.test(m[3]) ? 60 : 1)) });
    return r.overlaps || '';
  }
  // "move gym to 5", and titles that contain "to" themselves: "move the flight to delhi to 3pm".
  for (const re of [/^(?:please\s+)?(?:move|shift|reschedule|push|postpone|prepone)\s+(.+?)\s+(?:to|at)\s+(.+)$/i, /^(?:please\s+)?(?:move|shift|reschedule|push|postpone|prepone)\s+(.+)\s+(?:to|at)\s+(.+)$/i]) {
    const r = await moveTo(re.exec(text));
    if (r !== null) return r;
  }
  return null;
}

async function moveTo(m) {
  if (!m || NOT_SIMPLE.test(m[1]) || NOT_SIMPLE.test(m[2])) return null;
  const target = whenIn(m[1]);
  const said = words(target.rest).filter(w => !FILLER.has(w));
  const tail = whenIn(m[2].replace(/^(\d{1,2})$/, 'at $1'));
  const clock = timeIn(/^\d{1,2}$/.test(tail.rest) ? 'at ' + tail.rest : tail.rest, { part: dayPart(m[2]) });
  const left = clock ? clock.rest : tail.rest;
  if (words(left).filter(w => !FILLER.has(w)).length || (!clock && !tail.days.length) || tail.days.length > 1) return null;
  const hit = pick(said, target.days);
  if (!hit) return null;
  if (hit.ask) return hit.ask;
  const day = tail.days[0] || T.day(hit.ev.start);
  const r = await TOOLS.move_event({ event_id: hit.ev.id, ...(clock ? { new_start: T.at(day, clock.minutes) } : { new_date: day }) });
  return [r.priority, r.overlaps, r.note].filter(Boolean).join('\n');
}

async function quickRename(text) {
  const m = /^(?:please\s+)?rename\s+(.+?)\s+(?:to|as)\s+(.+)$/i.exec(text);
  if (!m || NOT_SIMPLE.test(m[1])) return null;
  const { days, rest } = whenIn(m[1]);
  const hit = pick(words(rest).filter(w => !FILLER.has(w)), days);
  if (!hit) return null;
  if (hit.ask) return hit.ask;
  await TOOLS.update_event({ event_id: hit.ev.id, title: m[2].trim().replace(/^["']|["'.!]$/g, '') });
  return '';
}

const NOT_A_BOOKING = /^(?:what|whats|when|where|why|how|is|are|am|do|does|did|can|could|should|will|would|i|yes|no|ok|okay|actually|and|also|but|then|remind|move|shift|cancel|delete|remove|drop|rename|change|make|undo|colou?r|mark)\b/i;
const CREATE_VERB = /^(?:please\s+)?(?:add|book|schedule|put|set(?: up)?|create|block)\s+/i;
/**
 * "gym tomorrow at 7am for 1 hour", "coffee with Riya on Monday at 5pm", "5 PM walk tomorrow",
 * "travel to new york from 12 noon today till 3pm color red".
 */
export async function quickCreate(message) {
  const text = String(message || '').trim().replace(/[.!]+$/, '');
  if (/[?,;\n:]$|[,;\n]/.test(text.replace(/\b\d{1,2}:\d{2}\b/g, '')) || NOT_A_BOOKING.test(text)) return null;
  const bad = impossibleDate(text);
  if (bad) return bad;
  // Colour, dates and the time range come out first, so their words ("from", "till", "day after") don't block a simple booking.
  const color = colorIn(text);
  const part = dayPart(text);
  const when = whenIn(color.rest.replace(CREATE_VERB, ''));
  const range = rangeIn(when.rest, { part });
  const plain = (range ? range.rest : when.rest).replace(/\bthis (?:\w+day|morning|afternoon|evening|week|weekend)\b/gi, '');
  if (/\b(every|daily|weekly|each|till|until|from(?=\s+\d)|between|and|it|that|this|them|instead|in \d|before|after|around|sometime|should|must|needs?|wants?|starts?|begins?|ends?|moved?|earlier|later|have|has|had|was|were|is|invite|with \S+@)\b/i.test(plain)) return null;
  const clock = range ? { minutes: range.start, rest: range.rest } : timeIn(when.rest, { part });
  if (!clock) return null;
  const len = range ? null : lengthIn(clock.rest);
  const title = (len ? len.rest : clock.rest).replace(/\b(?:in the |this )?(?:morning|afternoon|evening|night)\b/gi, ' ').replace(/\s+/g, ' ').trim().replace(/\b(?:on|for|at|the)\s*$/i, '').replace(/^(?:a|an|my|the)\s+/i, '').replace(/\s+(?:on|at)\s+/gi, ' ').trim();
  const n = words(title).length;
  if (!n || n > 7 || /\d/.test(title.replace(/\b1:1\b/, ''))) return null;
  const pretty = text.match(new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'), 'i'));
  const d = when.days.length === 1 ? when.days[0] : when.days.length ? '' : T.today();
  if (!d) return null;
  if (d < T.today()) return `${T.human(T.at(d, clock.minutes))} is in the past, so nothing was booked.`;
  const shown = pretty ? pretty[0] : title;
  const isMeeting = /\b(with|call|meet|meeting|sync|interview)\b/i.test(title);
  const start = T.at(d, clock.minutes);
  const r = await TOOLS.create_event({ title: shown[0].toUpperCase() + shown.slice(1), start, ...(range ? { end: T.addMin(start, range.end - range.start) } : { duration_minutes: len ? len.minutes : (isMeeting ? 30 : 60) }), kind: isMeeting ? 'meeting' : 'task', ...(color.color ? { color: color.color } : {}) });
  if (r.duplicate) return `"${r.existing.title}" is already on your calendar then (${T.span(r.existing.start, r.existing.end)}).`;
  return [r.priority, r.overlaps, r.not_invited].filter(Boolean).join('\n');
}

/** "color gym red", "make the dentist yellow", "mark travel as high priority". */
async function quickColor(text) {
  const m = /^(?:please\s+)?(?:colou?r|make|mark|set|change)\s+(.+?)\s+(?:to\s+|as\s+|in\s+)?((?:light |dark |navy |sky )?[a-z]+)(?:\s+colou?r|\s+priority)?$/i.exec(text);
  if (!m) return null;
  const pr = /\bpriority$/i.test(text) ? colorIn(`${m[2]} priority`).color : colorId(m[2]);
  if (!pr || NOT_SIMPLE.test(m[1])) return null;
  const { days, rest } = whenIn(m[1].replace(/^(?:the|my)\s+/i, ''));
  const hit = pick(words(rest).filter(w => !FILLER.has(w) && !['colour', 'color'].includes(w)), days);
  if (!hit) return null;
  if (hit.ask) return hit.ask;
  const r = await TOOLS.update_event({ event_id: hit.ev.id, color: pr });
  return r.priority || '';
}

/** Returns a reply ('' = the change itself is the reply), or null when the AI is needed. */
export async function quickAnswer(message) {
  const m = String(message || '').trim();
  if (!m || m.length > 160 || /\n/.test(m)) return null;
  const when = whenIn(m.replace(/[?!.]+$/, ''));
  if (when.days.length && when.days.length <= 7 && words(when.rest).every(w => READ_WORDS.has(w))) {
    await ensureRange(when.days[0], when.days[when.days.length - 1]);
    return when.days.map(agenda).join('\n\n');
  }
  if (NEXT.test(m)) {
    const now = T.nowStr();
    await ensureRange(T.today(), T.addDays(T.today(), 7));
    const cur = cal.list(now, T.addMin(now, 1)).find(e => !e.allDay && isActive(e) && e.kind !== 'buffer' && !isPing(e));
    const next = cal.list(now, T.addDays(T.today(), 8) + 'T00:00').find(e => !e.allDay && e.start > now && isActive(e) && e.kind !== 'buffer');
    if (!next && !cur) return 'Nothing else on your calendar this week.';
    return [cur && `Now: ${cur.title} until ${T.clock(cur.end)}.`, next && `Next: ${next.title} at ${T.clock(next.start)}${T.day(next.start) !== T.today() ? ` (${T.human(next.start).slice(0, 10)})` : ''} — in ${dur(T.diffMin(now, next.start))}.`].filter(Boolean).join(' ');
  }
  let x = WHEN_IS.exec(m);
  if (x) {
    const said = words(x[1]).filter(w => !WHEN_SKIP.has(w));
    const hits = said.length ? findByWords(said, []) : [];
    if (hits.length && new Set(hits.map(e => e.title)).size === 1) {
      const later = hits.slice(1, 3).map(e => T.human(e.start));
      return `${hits[0].title}: ${T.span(hits[0].start, hits[0].end)}${later.length ? `\nThen: ${later.join(', ')}` : ''}`;
    }
    return null;
  }
  x = WOKE.exec(m);
  if (x) {
    let start = 'now';
    if (x[1]) { let h = Number(x[1]) % 12 + (/pm/i.test(x[3] || '') ? 12 : 0); if (!x[3] && Number(x[1]) < 7) h += 12; start = T.toHM(h * 60 + Number(x[2] || 0)); }
    return planText(await TOOLS.plan_day({ date: T.today(), start, reflow: true, include_missed: true, rationale: 'You woke up; re-planned the rest of the day' }), 'Re-planned');
  }
  // "I skipped my OS session", "missed the CFA block today", "did the DSA session": a check-in, in code.
  x = /^\s*(?:i\s+)?(skipped|missed|didn'?t do|did not do|couldn'?t do|could not do|did|finished|completed|done with)\s+(?:my\s+|the\s+)?(.+?)(?:\s+(?:session|block|study block|work))?(?:\s+(?:today|yesterday|this morning|this evening|tonight))?\s*[.!]*\s*$/i.exec(m);
  if (x) {
    const said = words(x[2]).filter(w => !FILLER.has(w) && !['session', 'block', 'study'].includes(w));
    const now = T.nowStr();
    const hits = [];
    for (const t of load('tasks').items) for (const ses of t.sessions || []) {
      if (ses.end <= now && ses.end >= T.addMin(now, -48 * 60) && !ses.missed && !ses.done && said.length && said.every(w => words(t.title).some(y => sameWord(y, w)))) hits.push({ t, ses });
    }
    if (hits.length) {
      const { ses } = hits.sort((a, b) => b.ses.start.localeCompare(a.ses.start))[0];
      const status = /skipped|missed|n'?t|not/i.test(x[1]) ? 'missed' : 'done';
      return (await TOOLS.session_status({ event_id: ses.eventId, status })).result;
    }
  }
  x = LATE.exec(m);
  if (x) return planText(await TOOLS.plan_day({ date: T.today(), start: T.toHM(Math.min(1435, T.mins(T.nowStr()) + Number(x[1] || 0))), reflow: true, rationale: 'Running late; shifted what comes next' }), 'Re-planned');
  // Writes: a failure (a clash, a guard) goes to the model, which can work around it.
  const text = m.replace(/[.!]+$/, '');
  for (const fn of [quickDelete, quickMove, quickRename, quickColor, quickCreate]) {
    try {
      const r = await fn(text);
      if (r !== null) return r;
    } catch (e) {
      return null;
    }
  }
  return null;
}

export { lateNight };
