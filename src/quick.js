// Answers that need no AI: "what's tomorrow?", "what's next?", "I woke up just now" (re-plans the day),
// "running 30 min late". Instant, free, and they still work when every AI quota is used up.
import * as T from './time.js';
import * as cal from './calendar.js';
import { TOOLS, isPing } from './engine.js';
import { lateNight } from './prompt.js';
import { ensureRange } from './sync.js';

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const lineOf = e => `${e.allDay ? 'All day' : `${T.clock(e.start)}–${T.clock(e.end)}`} ${e.title}`;

/** "today" / "tomorrow" / "kal" / "friday" → a date (night owl: "tomorrow" before sleeping = today). */
export function dayFromWord(w) {
  const t = T.today();
  w = String(w || '').toLowerCase().trim();
  if (/^(today|aaj|tonight|now)$/.test(w)) return t;
  if (/^(tomorrow|tmrw|tmr|kal)$/.test(w)) return lateNight() ? t : T.addDays(t, 1);
  if (/^(day after tomorrow|parso)$/.test(w)) return T.addDays(t, lateNight() ? 1 : 2);
  const i = DAYS.findIndex(d => d.startsWith(w.slice(0, 3)) && w.length >= 3);
  if (i >= 0) { let d = lateNight() ? t : T.addDays(t, 1); while (T.dow(d) !== i) d = T.addDays(d, 1); if (T.dow(t) === i && !lateNight()) return t; return d; }
  return '';
}

function agenda(d) {
  const evs = cal.list(T.at(d, 0), T.addDays(d, 1) + 'T00:00').filter(e => e.myStatus !== 'declined' && e.kind !== 'buffer');
  const label = d === T.today() ? 'Today' : d === T.addDays(T.today(), 1) ? 'Tomorrow' : T.DAY_NAMES[T.dow(d)];
  const head = `${label} (${T.human(d + 'T00:00').slice(0, -6)})`;
  return evs.length ? `${head}:\n${evs.map(lineOf).join('\n')}` : `${head}: nothing scheduled.`;
}

const AGENDA = /^\s*(?:what(?:'?s| is| does)?|show(?: me)?|how(?:'?s| does| is)?|kya hai)?\s*(?:on |in )?(?:my )?(?:schedule|plan|calendar|agenda|day)?\s*(?:for |on )?(today|tonight|aaj|tomorrow|tmrw|kal|parso|day after tomorrow|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)(?:'?s)?\s*(?:schedule|plan|calendar|agenda)?\s*(?:look(?:s)? like|kaisa hai|ka plan)?\s*[?!.]*\s*$/i;
const NEXT = /^\s*(?:what(?:'?s| is)\s+)?(?:my\s+)?next(?:\s+(?:event|thing|up|meeting|class))?\s*[?!.]*\s*$/i;
const WOKE = /^\s*(?:i\s*(?:'?ve|have)?\s*(?:just\s+)?(?:woke|woken|got)\s+up|just\s+woke\s+up|i'?m\s+(?:up|awake)|uth gaya|utha)(?:\s+(?:just\s+)?(?:now|right now|rn|late))?(?:\s+at\s+(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?)?\s*[.,!]*\s*(?:(?:please\s+)?(?:re-?plan|redo|reschedule|shift|fix|adjust|sort|rearrange)\s+(?:my|the|today'?s)?\s*(?:day|schedule|plan|everything)?(?:\s+accordingly)?)?\s*[.!]*\s*$/i;
const LATE = /^\s*(?:i'?m\s+)?running\s+(?:(\d+)\s*(?:min(?:ute)?s?|m)\s+)?late\s*[.!]*\s*$/i;

function planText(r) {
  const lines = [`Re-planned ${r.date === T.today() ? 'today' : r.date} from ${r.planned_window.split('–')[0]}:`, ...r.timeline];
  if (r.moved_to_next_day) lines.push('Moved to tomorrow: ' + r.moved_to_next_day.join('; '));
  if (r.not_placed) lines.push("Didn't fit: " + r.not_placed.join('; '));
  return lines.join('\n');
}

/** Returns a reply, or null when the AI is needed. */
export async function quickAnswer(message) {
  const m = String(message || '');
  let x = AGENDA.exec(m);
  if (x) {
    const d = dayFromWord(x[1]);
    if (d) { await ensureRange(d, d); return agenda(d); }
  }
  if (NEXT.test(m)) {
    const now = T.nowStr();
    await ensureRange(T.today(), T.addDays(T.today(), 7));
    const cur = cal.list(now, T.addMin(now, 1)).find(e => !e.allDay && e.myStatus !== 'declined' && e.kind !== 'buffer' && !isPing(e));
    const next = cal.list(now, T.addDays(T.today(), 8) + 'T00:00').find(e => !e.allDay && e.start > now && e.myStatus !== 'declined' && e.kind !== 'buffer');
    if (!next && !cur) return 'Nothing else on your calendar this week.';
    return [cur && `Now: ${cur.title} until ${T.clock(cur.end)}.`, next && `Next: ${next.title} at ${T.clock(next.start)}${T.day(next.start) !== T.today() ? ` (${T.human(next.start).slice(0, 10)})` : ''} — in ${dur(T.diffMin(now, next.start))}.`].filter(Boolean).join(' ');
  }
  x = WOKE.exec(m);
  if (x) {
    let start = 'now';
    if (x[1]) { let h = Number(x[1]) % 12 + (/pm/i.test(x[3] || '') ? 12 : 0); if (!x[3] && Number(x[1]) < 7) h += 12; start = T.toHM(h * 60 + Number(x[2] || 0)); }
    const r = await TOOLS.plan_day({ date: T.today(), start, reflow: true, include_missed: true, rationale: 'You woke up; re-planned the rest of the day' });
    return planText(r);
  }
  x = LATE.exec(m);
  if (x) {
    const r = await TOOLS.plan_day({ date: T.today(), start: T.toHM(Math.min(1435, T.mins(T.nowStr()) + Number(x[1] || 0))), reflow: true, rationale: 'Running late; shifted what comes next' });
    return planText(r);
  }
  return null;
}
const CREATE = /^\s*(?:please\s+)?(?:add|book|schedule|put|set(?: up)?|create|block)?\s*(?:a |an )?(.+?)\s+(?:(today|tonight|tomorrow|kal|aaj|parso|(?:on |this |next )?(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?)\s+)?at\s+(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?(?:\s+(?:today|tomorrow|kal))?(?:\s+for\s+(\d+(?:\.\d+)?)\s*(min|mins|minutes?|h|hrs?|hours?))?\s*[.!]*\s*$/i;

/**
 * When no AI model is available: "gym tomorrow at 7am for 1 hour" → one event, parsed in code.
 * Returns a reply, or null when the message isn't that simple.
 */
export async function quickCreate(message) {
  const x = CREATE.exec(String(message || ''));
  if (!x) return null;
  const title = x[1].replace(/^(?:a|an|my)\s+/i, '').replace(/\s+(?:today|tomorrow|kal)$/i, '').trim();
  if (!title || title.split(/\s+/).length > 8) return null;
  const word = (x[2] || (/\b(tomorrow|kal)\b/i.test(message) ? 'tomorrow' : 'today')).replace(/^(on|this|next)\s+/i, '');
  const d = dayFromWord(word);
  if (!d) return null;
  let h = Number(x[3]) % 12;
  if (/pm/i.test(x[5] || '') || (!x[5] && Number(x[3]) >= 1 && Number(x[3]) <= 6) || (!x[5] && /tonight/i.test(word))) h += 12;
  if (Number(x[3]) === 12 && !/am/i.test(x[5] || '')) h = 12;
  const start = T.at(d, h * 60 + Number(x[4] || 0));
  const minutes = x[6] ? Math.round(Number(x[6]) * (/^h/i.test(x[7]) ? 60 : 1)) : 60;
  const r = await TOOLS.create_event({ title: title[0].toUpperCase() + title.slice(1), start, duration_minutes: minutes, kind: /\b(with|call|meet|sync)\b/i.test(title) ? 'meeting' : 'task', rationale: 'Parsed without AI (all AI models were busy)' });
  if (r.duplicate) return `"${r.existing.title}" is already on your calendar then.`;
  return `Added ${r.event.title} · ${T.span(r.event.start, r.event.end)}. (The AI models are resting right now, so I handled this one myself.)`;
}

const dur = m => m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ' ' + (m % 60) + 'm' : ''}` : `${m} min`;
