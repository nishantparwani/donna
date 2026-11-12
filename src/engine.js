// Deterministic core: classification, guardrails, tools, action log, undo.
// Rules live here (in code), so the model cannot talk its way past them.
import * as T from './time.js';
import * as cal from './calendar.js';
import { load, save, settings, saveSettings } from './store.js';
import { googleMode, hasV3, searchRemote, ensureRange, loadedRange, bridgeVersion } from './sync.js';
import { colorId, colorIn, colorName, relation, sameColor, userColor } from './colors.js';
import { demandOf, scoreSlot, freeAround, reasonFor } from './smart.js';
import { rhythmBias, noteBlock } from './rhythm.js';
import { datesIn, contentWords, timeIn, dayPart } from './when.js';

const MAX_WRITES_PER_RUN = 40;
const MAX_SERIES_EVENTS = 300;
const MAX_BULK_DELETE = 400;

// ─── Per-run context ───
export const RUN = { id: '', writes: 0, source: 'chat', actions: [], userText: '', inPlanner: false, alias: new Map(), real: new Map(), planNeeded: false };
let runSeq = 0;
export function beginRun(source, userText = '') {
  // One id per user request, so "undo that" can revert everything that one request changed.
  const id = Date.now().toString(36) + (++runSeq).toString(36);
  Object.assign(RUN, { id, writes: 0, source, actions: [], listed: [], userText, prevUserText: '', inPlanner: false, alias: new Map(), real: new Map(), planNeeded: false });
}
/** Did the user's own message ask to cancel / delete / decline something? Nothing is cancelled otherwise. */
export const userAskedToCancel = (text = RUN.userText) => /\b(cancel+(?:ed|led|s)?|clear (?:out |off )?(?:my|the|all|everything|tomorrow|today|tonight|this|next|[a-z]+day)|empty (?:my|the)|delete[sd]?|remove[sd]?|drop(?:ped)?|scrap|decline|erase|get rid|wipe|kill|nuke|trash|take (?:it|that|them) off|call(?:ed)? off|don'?t need|do not need|no need|not needed|no longer|not (?:going|attending|happening)|can'?t (?:make|attend|go)|cannot (?:make|attend|go)|won'?t (?:make|attend|go)|skip(?:ping)?)\b/i.test(text || '');
/** This message, or the one it follows up on ("the vendor one", "and the run too"), asked to cancel. */
const cancelRequested = () => userAskedToCancel(RUN.userText) || (!!RUN.prevUserText && userAskedToCancel(RUN.prevUserText));
/** Did the user say the times must stay as they are (e.g. "rename … keep the existing times")? */
export const userSaidKeepTimes = (text = RUN.userText) => /\b(?:keep|don'?t (?:change|touch|move)|without (?:changing|moving))\b[^.\n]{0,40}\b(?:times?|timings?|slots?|schedule)\b|\btimes? (?:un ?changed|as (?:they are|is))\b|\bdon'?t (?:move|reschedule) (?:them|anything|any)\b/i.test(text || '');
/** Did the user's message name a time of day? Then they may place things outside the usual hours. */
export const userGaveTime = (text = RUN.userText) => /\bto \d{1,2}\b|\b(?:make it|start at|starts at|by) \d|\b\d{1,2}[:.]\d{2}\b|\b\d{1,2}\s*(am|pm|a\.m\.|p\.m\.)|\bat\s+\d|\b\d+\s*(min|mins|minutes?|hours?|hrs?|ghante?|ghanta)\b|\bevery\b|morning|afternoon|evening|night|midnight|noon|midday|lunch|\beod\b|early|late|first thing|emergency/i.test(text || '');
/** The one length the user stated ("for 10 mins", "90 minutes", "half an hour"), or 0. Ignores "every 2 hours" / "in 2 hours". */
export function userGaveDuration(text = RUN.userText) {
  const t = String(text || '').toLowerCase();
  const found = new Set();
  for (const m of t.matchAll(/(\w+\s+)?(\d+(?:\.\d+)?)\s*(min|mins|minutes?|hours?|hrs?)\b/g)) {
    if (/^(every|in|within|after)\s/.test(m[1] || '')) continue;
    const n = Number(m[2]) * (/^h/.test(m[3]) ? 60 : 1);
    if (/^h/.test(m[3]) && !/^for\s/.test(m[1] || '')) continue; // "2 hours" alone is often a gap, not a length
    found.add(n);
  }
  if (/\bhalf an? hour\b/.test(t) && !/\b(in|every)\s+half an? hour\b/.test(t)) found.add(30);
  return found.size === 1 ? [...found][0] : 0;
}

/** The one clock time the user stated ("7:30pm", "19:30", "at 6 pm"), as HH:MM, or '' (none or several). */
export function userGaveClock(text = RUN.userText) {
  // "12 noon till 3pm" is a range, not one time.
  const t = String(text || '').toLowerCase().replace(/\b(?:12\s*)?noon\b|\bmidday\b/g, '12pm').replace(/\b(?:12\s*)?midnight\b/g, '12am');
  if (/\b\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?\s*(?:to|till|until|-|–)\s*\d/.test(t)) return '';
  const found = new Set();
  for (const m of t.matchAll(/\b(\d{1,2})[:.](\d{2})\s*(am|pm|a\.m\.|p\.m\.)?|\b(\d{1,2})\s*(am|pm|a\.m\.|p\.m\.)/g)) {
    const h = Number(m[1] ?? m[4]), mi = Number(m[2] || 0), ap = m[3] || m[5] || '';
    if (h > 23 || mi > 59) continue;
    if (!ap && h <= 12) { const c = timeIn(`at ${h}:${String(mi).padStart(2, '0')}`, { part: dayPart(t) }); if (c) { found.add(T.toHM(c.minutes)); continue; } }
    const hh = /p/.test(ap) && h < 12 ? h + 12 : /a/.test(ap) && h === 12 ? 0 : h;
    found.add(`${String(hh).padStart(2, '0')}:${String(mi).padStart(2, '0')}`);
  }
  if (!found.size) {
    const bareHour = t.match(/\bat\s+\d{1,2}\b/g);
    if (bareHour && bareHour.length === 1) { const c = timeIn(t, { part: dayPart(t) }); if (c) found.add(T.toHM(c.minutes)); }
  }
  return found.size === 1 ? [...found][0] : '';
}

// ─── Short references: the model sees E1, E2 … instead of 40-character Google ids ───
export function ref(id) {
  if (!id) return '';
  if (!RUN.alias.has(id)) { const a = 'E' + (RUN.alias.size + 1); RUN.alias.set(id, a); RUN.real.set(a, id); }
  return RUN.alias.get(id);
}
export const realId = x => { const s = String(x || '').trim(); return RUN.real.get(s) || (/^E\d+$/i.test(s) ? RUN.real.get(s.toUpperCase()) : '') || s; };

// ─── Classification ───
const kwList = s => String(s || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
const textOf = e => ` ${e.title} ${e.description || ''} `.toLowerCase();
const hasWord = (text, k) => new RegExp(`(^|[^a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?([^a-z0-9]|$)`).test(text);

export const SOFT = ['focus', 'buffer', 'habit', 'task'];
export const isActive = e => e.myStatus !== 'declined';
/** Blocks the agent placed itself; they yield to real commitments and get re-planned. */
export const isAgentBlock = e => !!e.agent && SOFT.includes(e.kind) && (e.kind === 'buffer' || e.kind === 'focus' || !!e.taskId || !!e.habitId);
export const isTimed = e => !e.allDay && isActive(e);
/** The weekly "Reminders: a + b + c" event (src/reminders.js) is recognised by this line in its notes. */
export const REMINDER_LIST_MARK = 'Kept up to date by Donna from your Reminders.';
export const isReminderList = e => String(e.description || '').includes(REMINDER_LIST_MARK);
/** Short solo events (≤15 min, no guests) and the weekly reminder list never block time or count as clashes. */
export const isPing = e => isReminderList(e) || !e.allDay && !(e.guests || []).length && !e.readOnly && T.diffMin(e.start, e.end) <= 15 && !['buffer', 'meeting'].includes(e.kind);
export function isHighStakes(e, s = settings()) {
  if (isAgentBlock(e)) return false;
  const t = textOf(e);
  if (e.highStakes || t.includes('#highstakes')) return true;
  // A keyword in a 15-minute reminder ("viva grill prompt") doesn't make it an exam.
  return T.diffMin(e.start, e.end) >= 30 && kwList(s.highStakesKeywords).some(k => hasWord(t, k));
}
export function isProtected(e, s = settings()) {
  if (isAgentBlock(e)) return false;
  const t = textOf(e);
  return !!e.protected || e.kind === 'personal' || !!e.readOnly || t.includes('#protected') || kwList(s.protectedKeywords).some(k => hasWord(t, k));
}
export const isFlexible = e => !!e.flexible || textOf(e).includes('#flexible');
const guestCount = e => (e.guests || []).length;

/** Compact, model-facing view of an event. */
export function describe(e) {
  const s = settings();
  const d = { id: ref(e.id), title: e.title, start: e.start, end: e.end };
  if (e.allDay) d.allDay = true;
  if (guestCount(e)) d.guests = guestCount(e);
  if (!e.organizer && !e.readOnly) d.invite = true;
  if (e.readOnly) d.otherCalendar = e.calendarName || true;
  if (e.recurringId) d.recurring = true;
  if (e.groupId) d.group = true;
  if (isProtected(e, s)) d.protected = true;
  if (!isActive(e)) d.declined = true;
  if (userColor(e)) d.color = colorName(userColor(e));
  return d;
}

// ─── Action log ───
function summarize(type, b, a, extra = {}) {
  const t = (a || b || {}).title;
  const n = extra.count > 1 ? ` (${extra.count} events)` : '';
  switch (type) {
    case 'create': return extra.count > 1 ? `Created "${t}"${n}, first ${T.span(a.start, a.end)}${extra.repeat ? ' · ' + extra.repeat : ''}` : `Created "${t}" · ${T.span(a.start, a.end)}`;
    case 'move': return `Moved "${t}"${extra.scope === 'series' ? ' (whole series)' : ''} · ${T.span(b.start, b.end)} → ${T.span(a.start, a.end)}`;
    case 'delete': return extra.scope === 'bulk' ? `Cancelled ${extra.count} event${extra.count === 1 ? '' : 's'}: ${extra.titles}` : `Cancelled "${t}"${extra.scope === 'series' ? ' (whole series)' : ''}${n} · ${T.span(b.start, b.end)}`;
    case 'decline': return `Declined "${t}"${extra.scope === 'series' ? ' (whole series)' : ''} · ${T.span(b.start, b.end)}`;
    case 'update': return `Updated "${t}"${extra.scope === 'series' ? ' (whole series)' : ''}`;
    default: return `${type} "${t}"`;
  }
}

export function logAction(type, before, after, rationale, extra = {}) {
  const log = load('actions');
  const id = 'ACT-' + (++log.counter);
  const r = after || before || {};
  const auto = !!extra.auto || RUN.inPlanner || RUN.source === 'auto';
  const summary = summarize(type, before, after, extra);
  // Snapshots are stored without default-valued fields: the log is read on every request.
  if (extra.snapshots) extra = { ...extra, snapshots: extra.snapshots.map(cal.compact) };
  log.items.push({ id, time: T.nowStr(), type, title: r.title || '', eventId: r.id || '', before: cal.compact(before), after: cal.compact(after), extra,
    rationale: rationale || RUN.userText.slice(0, 120), summary, status: 'active', feedback: '', source: RUN.source, auto, run: RUN.id });
  save('actions');
  RUN.actions.push({ id, summary, rationale: rationale || RUN.userText.slice(0, 120), auto });
  return id;
}
export const findAction = id => load('actions').items.find(a => a.id === String(id).trim().toUpperCase());
export function setAction(a, patch) { Object.assign(a, patch); save('actions'); }

export function markWrite(n = 1) {
  RUN.writes += n;
  if (RUN.writes > MAX_WRITES_PER_RUN + (RUN.inPlanner ? 60 : 0)) throw new Error('Safety cap reached: too many separate changes in one run. Stop and report what you have done.');
}

// ─── Hours & guardrails ───
const meetingKinds = ['meeting'];
/** The window a kind of event may be auto-placed in on day d, or null if not on that day. */
export function windowFor(d, kind, s = settings()) {
  if (meetingKinds.includes(kind)) return s.workDays.includes(T.dow(d)) ? [T.hm(s.workStart), T.hm(s.workEnd)] : null;
  const [lo, hi] = [T.hm(s.dayStart), T.hm(s.dayEnd)];
  return [lo, hi > lo ? hi : 1440]; // a night owl's day runs to midnight here; awakeRanges adds the hours after it
}
/**
 * Waking hours on a calendar date as minute ranges. Someone up 11:00–02:00 is awake 00:00–02:00 (the end of the
 * previous evening) and 11:00–24:00 on every date; an ordinary 07:00–23:00 day is one range.
 */
export function awakeRanges(s = settings()) {
  const lo = T.hm(s.dayStart), hi = T.hm(s.dayEnd);
  if (hi > lo) return [[lo, hi]];
  return hi > 0 ? [[0, hi], [lo, 1440]] : [[lo, 1440]];
}
/** Is [start, end) inside waking hours? */
export function isAwake(start, end, s = settings()) {
  const a = T.mins(start), b = T.day(end) === T.day(start) ? (T.mins(end) || 1440) : 1440 + T.mins(end);
  return awakeRanges(s).some(([x, y]) => a >= x && b <= y) || (T.hm(s.dayEnd) <= T.hm(s.dayStart) && a >= T.hm(s.dayStart) && b <= 1440 + T.hm(s.dayEnd));
}
/** End of the user's day on date d (a night owl's day ends after midnight; a deadline on d then means 23:59). */
export const dayEndOn = (d, s = settings()) => T.hm(s.dayEnd) > T.hm(s.dayStart) ? `${d}T${s.dayEnd}` : `${d}T23:59`;

/** "06:00-08:00, 17:00-21:00" → [[360, 480], [1020, 1260]] (invalid parts are dropped). */
export function parseWindows(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/(\d{1,2}:\d{2})\s*(?:-|–|to)\s*(\d{1,2}:\d{2})/g)) {
    if (!T.isHM(m[1]) || !(T.isHM(m[2]) || m[2] === '24:00')) continue;
    const a = T.hm(m[1]), b = T.hm(m[2]) || 1440;
    if (b > a) out.push([a, b]);
  }
  return out;
}
/**
 * The user's time windows for an activity ("run" → 06:00–08:00 or 17:00–21:00), or null if none applies.
 * They come from settings.activityWindows, learned from their words and 👎 feedback.
 */
export function activityWindows(title, s = settings()) {
  const t = ` ${String(title || '').toLowerCase()} `;
  for (const a of s.activityWindows || []) {
    const words = kwList(a.match);
    if (!words.length || !words.some(k => hasWord(t, k))) continue;
    const w = parseWindows(a.windows);
    if (w.length) return { windows: w, label: a.windows, match: a.match };
  }
  return null;
}
const inAnyWindow = (start, end, ws) => ws.some(([a, b]) => T.mins(start) >= a && (T.day(end) === T.day(start) ? T.mins(end) || 1440 : 1440) <= b);

/** Returns '' if [start,end) is allowed, else a precise, actionable error for the model. */
export function checkPlacement(start, end, { ignore = [], kind = 'meeting', explicit = false, allowOverlap = false, title = '', color = '' } = {}) {
  const s = settings();
  if (!(end > start)) return 'End must be after start.';
  if (start < T.addMin(T.nowStr(), -5)) return `${T.human(start)} is in the past (now is ${T.human(T.nowStr())}).`;
  if (!explicit) {
    const w = windowFor(T.day(start), kind, s);
    if (!w) return `${T.DAY_NAMES[T.dow(T.day(start))]} is not a working day, so meetings are not placed there unless the user names that day and time.`;
    const inside = kind === 'meeting' ? !(T.day(start) !== T.day(end) || T.mins(start) < w[0] || (T.mins(end) || 1440) > w[1]) : isAwake(start, end, s);
    if (!inside)
      return `Outside the allowed hours ${T.toHM(w[0])}–${T.toHM(w[1])} for a ${kind}. Pick a time inside them (find_free_slots), unless the user named this exact time.`;
    const act = title && activityWindows(title, s);
    if (act && !inAnyWindow(start, end, act.windows))
      return `The user only does "${act.match}" at ${act.label}. Pick a time inside that (find_free_slots with title), unless the user named this exact time.`;
  }
  const clashes = T.diffMin(start, end) <= 15 && kind !== 'meeting' ? [] : clashesWith(start, end, ignore, { color }); // a reminder may sit on top of anything
  // A time the user named is theirs to choose: it is booked, and the overlap is reported (overlapNote).
  if (clashes.length && !allowOverlap && !(explicit && namedTime())) {
    return 'Overlaps ' + clashes.map(e => `${ref(e.id)} "${e.title}" ${T.clock(e.start)}–${T.clock(e.end)}${isProtected(e) ? ' (protected)' : ''}`).join(', ') +
      '. Choose a free time (find_free_slots) or first move the lower-priority event.';
  }
  return '';
}
/** The user's own message named a clock time (or "noon"/"midnight"), so the time is not ours to second-guess. */
const namedTime = () => RUN.source === 'chat' && /\d|noon|midnight/.test(RUN.userText || '');
/** "swap the dentist and the passport renewal": each takes the other's time, so they overlap for a moment. */
const SWAP = /\b(swap|switch|exchange|interchange)\b/i;
/** "Heads-up: this overlaps AI Lecture (15:00–16:00)." or undefined; told to the user after booking at a time they named. */
export function overlapNote(start, end, ignore = [], color = '') {
  if (T.diffMin(start, end) <= 15) return undefined;
  // With a colour, coloured overlaps are priority matters that applyPriority reports.
  const c = clashesWith(start, end, ignore, { color, uncolored: !!color });
  return c.length ? 'Heads-up: this overlaps ' + c.slice(0, 3).map(e => `${e.title} (${T.day(e.start) !== T.day(start) ? T.human(e.start) : T.clock(e.start)}–${T.clock(e.end)})`).join(', ') + '.' : undefined;
}
/**
 * Real commitments overlapping [start, end). Agent blocks yield, so they never count; nor do events of the
 * same colour as `color` (they are simultaneous). With a colour, other coloured events are priority matters
 * (applyPriority reports them), so overlap notes only list uncoloured ones.
 */
export function clashesWith(start, end, ignore = [], { color = '', uncolored = false } = {}) {
  const skip = new Set(ignore);
  return cal.list(start, end).filter(e => isTimed(e) && !skip.has(e.id) && !isAgentBlock(e) && !(e.agent && e.kind === 'buffer') && !isPing(e)
    && !(color && sameColor(e, { color })) && !(uncolored && userColor(e)));
}

/**
 * Colour priorities after `ev` is placed (just created or moved at the user's request):
 *   • lower-priority events it overlaps are cancelled, if the user owns them and nobody else is on them
 *     (cancelling a shared event would email the guests, so those are only reported);
 *   • events of the same colour run alongside it (simultaneous);
 *   • higher-priority ones are reported.
 * cancel = false: report only.
 */
export function applyPriority(ev, { cancel = true } = {}) {
  if (!ev || !userColor(ev) || ev.allDay) return {};
  const out = { cancelled: [], alongside: [], kept: [], above: [] };
  const allow = cancel && settings().priorityCancel !== false;
  for (const e of cal.list(ev.start, ev.end)) {
    if (e.id === ev.id || !isTimed(e) || isAgentBlock(e) || (e.agent && e.kind === 'buffer') || e.end <= T.nowStr()) continue;
    const rel = relation(ev, e);
    if (rel === 'same') out.alongside.push(e.title);
    else if (rel === 'lower') out.above.push(`${e.title} (${colorName(e.color)})`);
    else if (rel === 'higher') {
      const guests = (e.guests || []).length > 0, mine = e.organizer && !e.readOnly;
      if (!allow || guests || !mine) {
        out.kept.push(`${e.title} (${colorName(e.color)}${guests ? '; it has guests, so cancelling it would email them' : !mine ? '; not yours to cancel' : ''})`);
        continue;
      }
      markWrite();
      removeOne(e, false, `Lower priority (${colorName(e.color)}) than "${ev.title}" (${colorName(ev.color)})`);
      out.cancelled.push(`${e.title} (${colorName(e.color)}, ${T.clock(e.start)}–${T.clock(e.end)})`);
    }
  }
  const lines = [];
  if (out.cancelled.length) lines.push(`Priority ${colorName(ev.color)}: cancelled the lower-priority ${out.cancelled.join(', ')}. Undo brings ${out.cancelled.length === 1 ? 'it' : 'them'} back.`);
  if (out.kept.length) lines.push(`Priority ${colorName(ev.color)}: overlaps lower-priority ${out.kept.join(', ')}. Left as is${allow ? '' : '; say "cancel" with its name to remove it'}.`);
  if (out.alongside.length) lines.push(`Runs alongside ${out.alongside.join(', ')} (same colour, so they happen together).`);
  if (out.above.length) lines.push(`Heads-up: overlaps higher-priority ${out.above.join(', ')}.`);
  if (googleMode() && bridgeVersion() < 5) lines.push('Colours show in Google Calendar once the bridge is updated (Settings → Calendar).');
  return { note: lines.join('\n') || undefined, cancelled: out.cancelled };
}
/** The colour the user named in this request ("color red", "in yellow", "high priority"), else ''. */
export const userGaveColor = (text = RUN.userText) => colorIn(text || '').color;

/** Stops the model acting on a lookalike ("move the marathon" → Run) or guessing what "it" means with nothing to go on. */
function guardTarget(ev) {
  if (RUN.source !== 'chat' || !RUN.userText || RUN.inPlanner) return;
  const msg = RUN.userText;
  if (/\b(everything|all|clear|free up|make room|conflicts?|emergency|after|before)\b/i.test(msg)) return; // sweeps name no single event
  if (load('actions').items.slice(-12).some(x => x.status === 'active' && !x.auto && x.source === 'chat' && (x.after || x.before || {}).id === ev.id && T.diffMin(x.time, T.nowStr()) <= 60)) return;
  const title = tokens(ev.title);
  const inTitle = w => title.some(x => sameWord(x, w));
  if (/\b(it|that|them|those|these|both|this one|the one|first one|last one|second one)\b/i.test(msg)) {
    const recent = load('actions').items.slice(-6).some(x => x.status === 'active' && !x.auto && x.source === 'chat' && T.diffMin(x.time, T.nowStr()) <= 60);
    if (!RUN.prevUserText && !recent && !contentWords(msg).some(inTitle)) throw new Error('Nothing says which event the user means. Change nothing and ask them.');
    return;
  }
  const words = contentWords(msg);
  if (!words.length || words.some(inTitle) || contentWords(RUN.prevUserText || '').some(inTitle)) return;
  if (ev.guests && ev.guests.some(g => words.some(w => g.toLowerCase().includes(w)))) return;
  if (userGaveClock(msg) === T.clock(ev.start)) return;
  throw new Error(`Nothing called "${words.join(' ')}" is on the calendar; "${ev.title}" is a different event. Change nothing: say you can't find it (you may ask whether they mean "${ev.title}").`);
}

function guardEditable(ev, { explicitTarget, needOrganizer }) {
  if (ev.readOnly) throw new Error(`"${ev.title}" is on another calendar (${ev.calendarName || 'read-only'}); it can only be changed there.`);
  if (ev.allDay && needOrganizer) throw new Error(`"${ev.title}" is an all-day event; all-day events are left alone.`);
  if (isProtected(ev) && !explicitTarget)
    throw new Error(`"${ev.title}" is protected. Change it only when the user's own message names this event; never as a side effect.`);
  if (needOrganizer && !ev.organizer)
    throw new Error(`The user did not organize "${ev.title}", so its time cannot be changed. Options: leave it, or decline it with delete_events.`);
}

/** Does the user's message itself name this event? (Protected events may then be changed.) */
function namedByUser(ev) {
  if (RUN.source !== 'chat') return false;
  const text = `${RUN.userText || ''} ${RUN.prevUserText || ''}`;
  if (/emergency/i.test(text)) return true;
  // "my 4pm tomorrow" or a day plus a time names it as well as its title does.
  if (userGaveClock(RUN.userText) === T.clock(ev.start) && (!datesIn(RUN.userText).length || datesIn(RUN.userText).includes(T.day(ev.start)))) return true;
  // "move it to 5" right after changing it.
  if (load('actions').items.slice(-12).some(a => a.status === 'active' && !a.auto && a.source === 'chat' && (a.after || a.before || {}).id === ev.id)) return true;
  const said = tokens(text);
  // Course codes count ("SE", "AI", "OS"), as do typos ("lecutre"); filler words do not.
  const words = tokens(ev.title).filter(w => w.length >= 2 && !['the', 'and', 'with', 'for', 'block', 'session', 'meeting', 'call', 'of', 'to', 'in', 'on', 'at'].includes(w));
  return words.some(w => said.some(x => sameWord(x, w)));
}
const tokens = s => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
/** Same word, allowing one typo (swap, missing, extra or wrong letter) in words of 5+ letters, and plurals. */
export function sameWord(a, b) {
  if (a === b || a === b + 's' || b === a + 's') return true;
  if (a.length < 5 || b.length < 5 || Math.abs(a.length - b.length) > 1) return false;
  // Damerau–Levenshtein distance ≤ 1
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length] <= 1;
}

const STOP = new Set(['the', 'and', 'with', 'for', 'my', 'move', 'cancel', 'delete', 'remove', 'push', 'shift', 'reschedule', 'to', 'from', 'on', 'at', 'by', 'this', 'that',
  'today', 'tomorrow', 'next', 'week', 'pm', 'am', 'min', 'mins', 'minutes', 'hour', 'hours', 'please', 'can', 'you', 'event', 'events', 'meeting', 'call', 'all', 'it', 'its', 'one',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'morning', 'afternoon', 'evening', 'night', 'later', 'earlier', 'decline', 'kal', 'aaj']);
const wordsOf = s => String(s || '').toLowerCase().replace(/[^a-z0-9:\s]/g, ' ').split(/\s+/).filter(w => w.length > 1 && !STOP.has(w) && !/^\d+(:\d+)?(am|pm)?$/.test(w));

/**
 * Code-level ambiguity check: if the words the user used to name this event also fit other, differently
 * titled events in the next two weeks, the model must ask "which one" instead of guessing.
 */
function ambiguity(ev) {
  if (RUN.source !== 'chat' || !RUN.userText) return '';
  const said = new Set(wordsOf(RUN.userText));
  const mine = wordsOf(ev.title).filter(w => said.has(w));
  if (!mine.length) return '';
  const others = new Map();
  const named = datesIn(RUN.userText);
  for (const e of cal.list(T.nowStr(), T.addDays(T.today(), 14) + 'T00:00')) {
    if (e.id === ev.id || e.title === ev.title || isAgentBlock(e) || e.kind === 'buffer') continue;
    if (named.length && !named.includes(T.day(e.start))) continue;
    const w = new Set(wordsOf(e.title));
    if (mine.every(x => w.has(x)) && !others.has(e.title)) others.set(e.title, e);
  }
  // The user typed this event's exact title → not ambiguous.
  if (!others.size || RUN.userText.toLowerCase().includes(ev.title.toLowerCase())) return '';
  const list = [ev, ...others.values()].slice(0, 4).map(e => `${e.title} (${T.human(e.start)})`).join(', ');
  return `Ambiguous: "${mine.join(' ')}" matches ${list}. Change nothing and ask the user one short question: which one?`;
}

const DUP_STOP = new Set(['the', 'and', 'with', 'for', 'to', 'from', 'of', 'a', 'an', 'my', 'at', 'on', 'in']);
const titleWords = t => new Set(String(t || '').toLowerCase().replace(/([a-z])-(\d)/g, '$1 $2').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w && !DUP_STOP.has(w)));
/** How alike two titles are, 0–1 (shared words over all words). */
export function titleSimilarity(a, b) {
  const x = titleWords(a), y = titleWords(b);
  if (!x.size || !y.size) return 0;
  let n = 0;
  for (const w of x) if (y.has(w)) n++;
  return n / (x.size + y.size - n);
}
/**
 * An event already on the calendar that a new one would duplicate: same time (overlapping most of it)
 * and a similar title, e.g. a flight Google added from Gmail and the same flight typed in chat.
 */
export function findDuplicate(title, start, end) {
  const len = T.diffMin(start, end);
  for (const e of cal.list(start, end)) {
    if (e.allDay || !isActive(e) || e.kind === 'buffer') continue;
    const overlap = T.diffMin([start, e.start].sort()[1], [end, e.end].sort()[0]);
    if (overlap < Math.min(len, T.diffMin(e.start, e.end)) * 0.6) continue;
    const a = String(title).toLowerCase().trim(), b = e.title.toLowerCase().trim();
    if (a === b || (a.length > 5 && b.includes(a)) || (b.length > 5 && a.includes(b))) return e;
    // Similar titles are one thing only when neither names something the other lacks:
    // "Flight to Delhi" vs "Flight AI 101 to Delhi" is a duplicate; "Bring apples" vs "Bring mangoes" is not.
    const x = titleWords(a), y = titleWords(b);
    const subset = [...x].every(w => y.has(w)) || [...y].every(w => x.has(w));
    const sim = titleSimilarity(a, b);
    const sharedCode = [...x].some(w => /\d/.test(w) && w.length >= 3 && y.has(w)); // a flight / train / booking number
    if (sim >= 0.75 || (sim >= 0.5 && (subset || sharedCode))) return e;
  }
  return null;
}

/** Agent blocks under a new placement are removed; the planner re-places them. */
function yieldBlocks(start, end, reason) {
  for (const e of cal.list(start, end)) {
    if (!isAgentBlock(e) || e.kind === 'buffer') continue;
    cal.remove(e.id);
    markCreate(e.id, 'yielded');
    logAction('delete', e, null, reason, { auto: true });
    RUN.planNeeded = true;
  }
}

/** Keeps the original "create" record in sync when an agent block disappears. */
export function markCreate(eventId, status) {
  load('actions').items.filter(a => a.type === 'create' && a.eventId === eventId && a.status === 'active').forEach(a => { a.status = status; });
  save('actions');
}

const mustGet = id => {
  const ev = cal.get(realId(id));
  if (!ev) throw new Error(`No event "${id}". Use an id from <context>, list_events or search_events.`);
  return ev;
};

/**
 * Scores free starts ("HH:MM") on day d for a block of dur minutes: the best ones first.
 * Meetings favour the user's alert hours; study the peak; light work the dips (see smart.js).
 */
export function rankStarts(d, dur, starts, { title = '', kind = 'meeting', dayIndex = 0 } = {}) {
  const s = settings();
  const wake = T.hm(s.dayStart), sleep = T.hm(s.dayEnd) || 1440;
  const demand = demandOf(title, kind);
  const evs = cal.list(T.at(d, 0), T.addDays(d, 1) + 'T00:00').filter(e => isTimed(e) && !isAgentBlock(e) && !(e.agent && e.kind === 'buffer') && !isPing(e));
  const ranges = evs.map(e => [T.day(e.start) < d ? 0 : T.mins(e.start), T.day(e.end) > d ? 1440 : (T.mins(e.end) || 1440)]);
  const neighbors = evs.map((e, i) => ({ a: ranges[i][0], b: ranges[i][1], demand: demandOf(e.title, e.kind) }));
  const first = starts.length ? T.hm(starts[0]) : wake;
  const rhythm = rhythmBias(demand);
  return starts.map(hhmm => {
    const m = T.hm(hhmm);
    const sc = scoreSlot(m, dur, { demand, wake, sleep, from: first, earlyWeight: 0.1, free: freeAround(m, dur, ranges, s.breakMinutes, 0, 1440), neighbors, brk: s.breakMinutes, rhythm })
      - 0.35 * dayIndex - (kind === 'meeting' && m < T.hm(s.workStart) ? 1 : 0);
    return { date: d, start: hhmm, sc, why: reasonFor(m, dur, demand, wake, sleep, rhythm) };
  });
}

/** Same clock time on another day if allowed, else the allowed time closest to it. */
function bestTimeOnDay(d, ev, dur, kind, explicit, ignore) {
  const s = settings();
  const want = T.mins(ev.start);
  const w = explicit ? [0, 1440] : (windowFor(d, kind, s) || [T.hm(s.dayStart), T.hm(s.dayEnd)]);
  const options = [];
  for (let m = w[0]; m + dur <= w[1]; m += 15) options.push(m);
  options.sort((x, y) => Math.abs(x - want) - Math.abs(y - want) || x - y);
  for (const m of options) {
    const start = T.at(d, m);
    if (!checkPlacement(start, T.addMin(start, dur), { ignore, kind, explicit, title: ev.title })) return start;
  }
  throw new Error(`No free ${dur}-minute slot on ${d} for "${ev.title}". Try another day.`);
}

// ─── People ───
/** Plans with friends or family: no video link even when someone is invited. */
const SOCIAL = /\b(dinner|lunch|breakfast|brunch|coffee|drinks?|party|movie|birthday|date|hangout|trip|picnic|game night|family|mom|mum|dad|brother|sister|friends?)\b/i;
/** Emailing someone else can't be undone, so invites go out only when the user asks (or typed the address). */
export function mayInvite(text = `${RUN.userText || ''} ${RUN.prevUserText || ''}`) {
  if (RUN.source !== 'chat' || !RUN.userText) return RUN.source !== 'auto'; // the app's own forms say so explicitly
  return /\b(invite[sd]?|send (?:an? |the )?(?:invite|invitation)|send it to|share (?:it |this )?with|notify|loop in|add (?:\w+ ){0,2}as (?:a )?guests?|cc)\b/i.test(text) || /[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(RUN.userText);
}
export function personName(email) {
  const p = load('people').items.find(x => x.email && x.email.toLowerCase() === String(email).toLowerCase());
  return p ? p.name : String(email);
}
export function resolveGuests(text) {
  const people = load('people').items;
  const emails = [], names = [];
  for (const raw of String(text || '').split(/[,;]| and /).map(x => x.trim()).filter(Boolean)) {
    if (/@/.test(raw)) { emails.push(raw); continue; }
    const p = people.find(x => x.name.toLowerCase() === raw.toLowerCase()) || people.find(x => x.name.toLowerCase().split(' ')[0] === raw.toLowerCase());
    if (p && p.email) emails.push(p.email); else names.push(raw);
  }
  return { emails: [...new Set(emails)], names };
}

// ─── Recurrence ───
const UNITS = { hour: 60, hours: 60, day: 1440, days: 1440, daily: 1440, week: 10080, weeks: 10080, weekly: 10080, month: 0, months: 0, monthly: 0 };
/** Builds an RRULE (for Google) and the expanded occurrences (for checks, local mode and old bridges). */
export function planRepeat(start, dur, r) {
  const unit = String(r.unit || '').toLowerCase();
  if (!(unit in UNITS)) throw new Error('repeat.unit must be hour, day, week or month.');
  const every = Math.max(1, Math.min(52, Number(r.every) || 1));
  const days = (r.weekdays || []).map(x => String(x).slice(0, 2).toUpperCase()).filter(x => T.DAY_CODES.includes(x));
  let until = r.until ? T.day(T.norm(r.until)) : '';
  const count = Number(r.count) || 0;
  if (!until && !count) until = T.addDays(T.day(start), unit.startsWith('hour') ? 7 : unit.startsWith('month') ? 365 : 180);
  const hardEnd = T.addDays(T.today(), 400);
  if (until > hardEnd) until = hardEnd;
  const occ = [];
  const limit = count || 10000;
  const pushIf = s => { if ((!until || T.day(s) <= until) && occ.length < limit) occ.push(s); };
  if (unit.startsWith('hour')) {
    for (let s = start; occ.length < limit && (!until || T.day(s) <= until); s = T.addMin(s, every * 60)) pushIf(s);
  } else if (unit.startsWith('month')) {
    for (let i = 0; occ.length < limit && i < 400; i += every) { const s = T.addMonths(start, i); if (until && T.day(s) > until) break; pushIf(s); }
  } else if (unit.startsWith('week') && days.length) {
    const ws = T.weekStart(T.day(start));
    for (let w = 0; occ.length < limit && w < 520; w += every) {
      for (const code of ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']) {
        if (!days.includes(code)) continue;
        const d = T.addDays(ws, w * 7 + ((T.DAY_CODES.indexOf(code) + 6) % 7));
        const s = d + 'T' + T.clock(start);
        if (s < start) continue;
        if (until && d > until) { w = 9999; break; }
        pushIf(s);
      }
    }
  } else {
    const step = UNITS[unit] * every;
    for (let s = start; occ.length < limit && (!until || T.day(s) <= until); s = T.addMin(s, step)) pushIf(s);
  }
  let rrule = null;
  if (!unit.startsWith('hour')) {
    const freq = unit.startsWith('day') || unit === 'daily' ? 'DAILY' : unit.startsWith('week') ? 'WEEKLY' : 'MONTHLY';
    rrule = `RRULE:FREQ=${freq}${every > 1 ? ';INTERVAL=' + every : ''}${freq === 'WEEKLY' && days.length ? ';BYDAY=' + days.join(',') : ''}${count ? ';COUNT=' + count : ';UNTIL=' + until.replace(/-/g, '') + 'T235959Z'}`;
  }
  const label = `every ${every > 1 ? every + ' ' : ''}${unit.replace(/s$|ly$/, '').replace('dai', 'day')}${every > 1 ? 's' : ''}${days.length ? ' on ' + days.join(',') : ''}${until ? ' until ' + until : ''}${count ? ` × ${count}` : ''}`;
  return { occurrences: occ.map(s => ({ start: s, end: T.addMin(s, dur) })), rrule, label };
}

// ─── Tools (model-facing) ───
const STR = (description = '', extra = {}) => ({ type: 'string', ...(description ? { description } : {}), ...extra });
const INT = (description = '') => ({ type: 'integer', ...(description ? { description } : {}) });
const BOOL = (description = '') => ({ type: 'boolean', ...(description ? { description } : {}) });
const STRS = { type: 'array', items: { type: 'string' } };
const scope = STR('default "this"; "series" = every occurrence', { enum: ['this', 'series'] });
const obj = (properties, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}) });
const tool = (name, description, parameters = obj({})) => ({ name, description, parameters });

export const TOOL_DECLS = [
  tool('search_events', 'Find events by title words across all dates.', obj({ query: STR(), start_date: STR(), end_date: STR() }, ['query'])),
  tool('list_events', 'Events on a date range (max 62 days).', obj({ start_date: STR(), end_date: STR() }, ['start_date', 'end_date'])),
  tool('find_free_slots', 'Free start times on a day or range.', obj({ date: STR(), end_date: STR(), duration_minutes: INT(), earliest: STR('HH:MM'), latest: STR('HH:MM'), kind: STR(), title: STR() }, ['date', 'duration_minutes'])),
  tool('create_event', 'Create one event, optionally repeating.', obj({
    title: STR(), start: STR('YYYY-MM-DDTHH:MM or YYYY-MM-DD'), end: STR(), duration_minutes: INT(), kind: STR('', { enum: ['meeting', 'task', 'focus', 'personal'] }),
    guests: STR('names or emails; invites are sent only if the user asked'), description: STR(), location: STR(), meet: BOOL(), reminder_minutes: INT(), color: STR('priority colour: red (highest), orange, yellow, green, blue, purple, pink, grey (lowest)'),
    repeat: obj({ every: INT(), unit: STR('', { enum: ['hour', 'day', 'week', 'month'] }), weekdays: { ...STRS, description: 'MO,TU,…' }, until: STR('YYYY-MM-DD'), count: INT() }),
    allow_overlap: BOOL('only if the user insists') }, ['title', 'start'])),
  tool('move_event', 'Change when an event happens or how long it is.', obj({ event_id: STR(), new_start: STR('YYYY-MM-DDTHH:MM'), new_date: STR('YYYY-MM-DD'), shift_minutes: INT('+later, -earlier'), duration_minutes: INT('new length'), scope, allow_overlap: BOOL() }, ['event_id'])),
  tool('update_event', 'Change title, notes, location, guests, colour or reminder of one event.', obj({ event_id: STR(), title: STR(), description: STR(), location: STR(), guests: STR(), meet: BOOL(), reminder_minutes: INT(), color: STR('priority colour: red (highest), orange, yellow, green, blue, purple, pink, grey (lowest)'), scope }, ['event_id'])),
  tool('delete_events', 'Cancel events: by event_ids, or by query and/or from/to. Invitations get declined.', obj({ event_ids: STRS, scope, query: STR('title words; commas = alternatives'), from: STR('YYYY-MM-DD'), to: STR('YYYY-MM-DD') })),
  tool('undo', 'Undo the last request\'s changes.', obj({ action_id: STR(), count: INT() })),
  tool('finish', 'End the turn; the changes are reported automatically.', obj({ note: STR('only what the user must know beyond the changes') })),
  // Offered only when the message calls for them (see toolsFor in agent.js).
  tool('create_events', 'Create many events from a list.', obj({ events: { type: 'array', items: obj({ title: STR(), start: STR(), end: STR(), duration_minutes: INT(), kind: STR(), description: STR(), location: STR(), reminder_minutes: INT(), color: STR() }, ['title', 'start']) }, allow_overlap: BOOL() }, ['events'])),
  tool('update_events', 'Rename or annotate many events without moving them.', obj({ updates: { type: 'array', items: obj({ event_id: STR(), title: STR(), description: STR(), location: STR(), reminder_minutes: INT() }, ['event_id']) } }, ['updates'])),
  tool('rename_in_order', 'Rename events in time order per day; titles copied exactly.', obj({ days: { type: 'array', items: obj({ date: STR(), titles: STRS }, ['date', 'titles']) }, match: STR('current title contains') }, ['days'])),
  tool('plan_day', 'Build or re-plan one day around fixed commitments; never cancels.', obj({
    date: STR(), start: STR('"now" or HH:MM'), end: STR('HH:MM'),
    items: { type: 'array', items: obj({ title: STR(), minutes: INT(), kind: STR(), event_id: STR('existing event'), at: STR('HH:MM fixed'), after: STR('HH:MM'), before: STR('HH:MM'), around: STR('HH:MM'), priority: STR(), split: BOOL(), fill: BOOL(), notes: STR() }, ['title']) },
    reflow: BOOL('also re-place movable events on that day'), include_missed: BOOL(), fill_gaps: BOOL(), meals: BOOL(), compress: BOOL(), break_minutes: INT() }, ['date'])),
  tool('add_task', 'A to-do that gets work sessions booked before its due date.', obj({ title: STR(), minutes: INT(), due: STR(), priority: STR(), session_minutes: INT(), notes: STR() }, ['title', 'minutes', 'due'])),
  tool('session_status', 'The user did, skipped or half-did a work session that has ended ("I skipped my OS session"). Missed work is re-booked.', obj({ event_id: STR(), task_id: STR(), status: STR('', { enum: ['done', 'missed', 'partial'] }), minutes_done: INT() }, ['status'])),
  tool('update_task', 'Change, complete or delete a task.', obj({ task_id: STR(), status: STR('', { enum: ['done', 'open', 'deleted'] }), title: STR(), minutes: INT(), due: STR(), priority: STR() }, ['task_id'])),
  tool('add_habit', 'Recurring block placed in the best free time inside a daily window.', obj({ title: STR(), minutes: INT(), days: STR('"daily" or MO,TU,…'), window_start: STR(), window_end: STR(), ideal_time: STR(), kind: STR() }, ['title', 'minutes', 'window_start', 'window_end'])),
  tool('remove_habit', 'Stop a habit.', obj({ habit_id: STR() }, ['habit_id'])),
  tool('set_goal', 'A weekly time goal.', obj({ title: STR(), hours_per_week: { type: 'number' }, counts: STR() }, ['title', 'hours_per_week'])),
  tool('remove_goal', 'Stop a weekly goal.', obj({ goal_id: STR() }, ['goal_id'])),
  tool('save_rule', 'Save a lasting preference as one imperative rule.', obj({ rule: STR(), applies_to: STR('activity words'), allowed_times: STR('06:00-08:00, 17:00-21:00') }, ['rule'])),
  tool('update_preferences', 'Save wake-up, sleep, focus, break or meeting hours.', obj({ wake_time: STR(), sleep_time: STR(), focus_minutes: INT(), break_minutes: INT(), work_start: STR(), work_end: STR() })),
  tool('remember_person', 'Remember a contact\'s email.', obj({ name: STR(), email: STR(), note: STR() }, ['name'])),
];
const CORE = ['search_events', 'list_events', 'find_free_slots', 'create_event', 'move_event', 'update_event', 'delete_events', 'undo', 'finish'];
const GROUPS = {
  plan: { tools: ['plan_day'], re: /\b(plan|replan|re-plan|timetable|time table|optimi[sz]e|productiv\w*|woke|wake|running late|shift my day|reschedule (?:everything|my day)|fill|overwrite|to-?do)\b/i },
  tasks: { tools: ['add_task', 'update_task', 'session_status'], re: /\b(task|tasks|assignment|due|deadline|finish\w* \w+ by|done with|finished|skipped|missed|didn'?t (?:do|study|finish|get to)|couldn'?t (?:do|study|finish))\b/i },
  habits: { tools: ['add_habit', 'remove_habit'], re: /\b(habit|sometime between|window)\b/i },
  goals: { tools: ['set_goal', 'remove_goal'], re: /\b(goal|(?:hours?|hrs?|h) (?:of \w+ )?(?:a|per|each|every) week)\b/i },
  memory: { tools: ['save_rule', 'update_preferences', 'remember_person'], re: /\b(always|never|from now on|i prefer|i wake|i sleep|wake up at|focus for|email)\b/i },
  bulk: { tools: ['create_events', 'update_events', 'rename_in_order'], re: /\n|\b(in order|titles|1st|2nd|3rd|following events|these events|rename (?:all|these|them|the))\b/i },
};
/** The tool groups a message needs beyond the core CRUD tools. */
export const groupsFor = text => Object.keys(GROUPS).filter(g => GROUPS[g].re.test(text));
/** Tool schemas are the largest part of every call, so only the ones this message can use are sent. */
export function toolsFor(groups = [], only = null) {
  const names = new Set(only || [...CORE, ...groups.flatMap(g => GROUPS[g].tools)]);
  return TOOL_DECLS.filter(t => names.has(t.name));
}

const kindFor = ev => ev.agent && SOFT.includes(ev.kind) ? ev.kind : (isProtected(ev) ? 'personal' : ev.kind);
const rangeDays = (a, b, max) => {
  const from = T.day(T.norm(a));
  const to = T.day(T.norm(b || a));
  if (to < from) throw new Error('end_date is before start_date.');
  if (T.diffMin(from + 'T00:00', to + 'T00:00') > max * 1440) throw new Error(`Range too long; at most ${max} days at a time.`);
  return [from, to];
};

/**
 * The title exactly as the user typed it. Models like to "tidy" titles ("[W1 Acad] IVP audit" → "IVP audit");
 * if a line of the user's message ends with the model's title, that whole line (minus "1." / "-") is used.
 */
export function exactTitle(title, text = RUN.userText) {
  const t = String(title || '').trim();
  if (!t || !text) return t;
  const low = t.toLowerCase();
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/^\s*(?:\d+[.)]|[-•*])\s*/, '').replace(/\s*[|].*$/, '').trim();
    const l = line.toLowerCase();
    if (l.length > t.length && l.length <= t.length + 40 && l.endsWith(low) && /^[[(【{#]/.test(line)) return line;
  }
  return t;
}


export const TOOLS = {
  async list_events({ start_date, end_date }) {
    const [from, to] = rangeDays(start_date, end_date || start_date, 62);
    await ensureRange(from, to);
    const evs = cal.list(from + 'T00:00', T.addDays(to, 1) + 'T00:00').filter(e => !(e.agent && e.kind === 'buffer'));
    return { range: `${from} to ${to}`, count: evs.length, events: evs.slice(0, 150).map(describe), truncated: evs.length > 150 || undefined };
  },

  async search_events({ query, start_date, end_date }) {
    const q = String(query || '').trim();
    if (!q) throw new Error('query is empty.');
    const from = start_date ? T.day(T.norm(start_date)) : T.addDays(T.today(), -7);
    const to = end_date ? T.day(T.norm(end_date)) : T.addDays(T.today(), 183);
    if (T.diffMin(from + 'T00:00', to + 'T00:00') > 400 * 1440) throw new Error('Range too long; at most 400 days.');
    const hits = await searchRemote(q, from, to);
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const match = e => words.every(w => textOf(e).includes(w));
    let evs = cal.list(from + 'T00:00', T.addDays(to, 1) + 'T00:00');
    evs = hits ? evs.filter(e => hits.includes(e.id) && match(e)) : evs.filter(match);
    // One row per recurring series keeps the answer short.
    const rows = [], seen = new Map();
    for (const e of evs) {
      const key = e.recurringId || e.groupId;
      if (key && seen.has(key)) { seen.get(key).occurrences++; seen.get(key).last = e.start; continue; }
      const row = { ...describe(e), occurrences: 1 };
      if (key) seen.set(key, row);
      rows.push(row);
    }
    rows.forEach(r => { if (r.occurrences === 1) delete r.occurrences; });
    const partial = !hits && googleMode() ? `Only ${loadedRange()?.from}…${loadedRange()?.to} could be searched (old bridge).` : undefined;
    return { query: q, range: `${from} to ${to}`, matches: rows.slice(0, 80), total_events: evs.length, note: partial,
      hint: rows.some(r => r.recurring || r.group) ? 'For every occurrence of a recurring/group row use delete_events/move_event with scope "series" on that id.' : undefined };
  },

  async find_free_slots({ date, end_date, duration_minutes, earliest, latest, kind = 'meeting', title = '' }) {
    const s = settings();
    const act = !earliest && !latest && title ? activityWindows(title, s) : null;
    const dur = Number(duration_minutes);
    if (!(dur > 0)) throw new Error('duration_minutes must be positive.');
    const [from, to] = rangeDays(date, end_date || date, 14);
    await ensureRange(from, to);
    const days = [], ranked = [];
    for (let d = from; d <= to; d = T.addDays(d, 1)) {
      const w = windowFor(d, kind, s);
      if (!w && !earliest) continue;
      // Solo work defaults to civilised hours (from the start of the working day), not the crack of dawn.
      let lo = earliest ? T.hm(earliest) : (kind === 'meeting' ? w[0] : Math.max(w[0], T.hm(s.workStart))), hi = latest ? T.hm(latest) : (w ? w[1] : 1440);
      let first = T.at(d, lo);
      if (d === T.today()) first = [first, T.roundUp15(T.nowStr())].sort()[1];
      const slots = [];
      for (let t = first; T.mins(t) + dur <= hi && T.day(t) === d; t = T.addMin(t, 15)) {
        const end = T.addMin(t, dur);
        if (act && !inAnyWindow(t, end, act.windows)) continue;
        if (!clashesWith(t, end).length) slots.push(T.clock(t));
      }
      if (slots.length) days.push({ date: d, weekday: T.DAY_NAMES[T.dow(d)], starts: compress(slots, from === to ? 24 : 6) });
      ranked.push(...rankStarts(d, dur, slots, { title, kind, dayIndex: Math.round(T.diffMin(from + 'T00:00', d + 'T00:00') / 1440) }));
    }
    const best = ranked.sort((x, y) => y.sc - x.sc).slice(0, 3).map(({ date, start, why }) => ({ date, start, why }));
    return { duration_minutes: dur, kind, best: best.length ? best : undefined, days, user_times: act ? `${act.match}: ${act.label}` : undefined,
      note: days.length ? 'Use best[0] unless the user asked for something else. Times are start times. Reserved focus/habit/task blocks count as free (they move automatically).' : 'No free slot in this window. Try another day, a different window, or move a lower-priority event.' };
  },

  async create_event(a) {
    const s = settings();
    if (a.repeat && !a.repeat.unit && (a.repeat.weekdays?.length || a.repeat.until || a.repeat.count || a.repeat.every)) a = { ...a, repeat: { ...a.repeat, unit: a.repeat.weekdays?.length ? 'week' : 'day' } };
    // "every weekday": named weekdays only make sense weekly, whatever unit the model picked.
    if (a.repeat && a.repeat.weekdays?.length && /^(day|daily)/.test(String(a.repeat.unit || '')) && !(Number(a.repeat.every) > 1)) a = { ...a, repeat: { ...a.repeat, unit: 'week' } };
    const kind = ['meeting', 'task', 'focus', 'personal'].includes(a.kind) ? a.kind : (a.guests || /\b(with|call|meet|meeting|sync|interview)\b/i.test(a.title || '') ? 'meeting' : 'task');
    // Only a day given ("gym tomorrow", "CFA 2h on Friday"): the code picks the best time that day, in the same step.
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(a.start || '').trim()) && !(a.repeat && a.repeat.unit) && !(RUN.source === 'chat' && userGaveClock())) {
      const d = String(a.start).trim();
      const len = Number(a.duration_minutes) || (RUN.source === 'chat' ? userGaveDuration() : 0) || (kind === 'meeting' ? 30 : 60);
      const r = await TOOLS.find_free_slots({ date: d, duration_minutes: len, kind, title: a.title });
      const pick = (r.best || []).find(b => b.date === d);
      if (!pick) throw new Error(`No free ${len}-minute slot on ${d} for "${a.title}". Try another day, or move something first.`);
      a = { ...a, start: `${d}T${pick.start}`, duration_minutes: len, end: undefined, rationale: `${a.rationale || 'Best time that day'} (${pick.why})` };
    }
    // The user said one exact time ("7:30pm"): that is the time, whatever the model typed.
    const said = RUN.source === 'chat' && !a._batch ? userGaveClock() : '';
    const start = said && T.clock(T.norm(a.start)) !== said ? T.day(T.norm(a.start)) + 'T' + said : T.norm(a.start);
    const stated = RUN.source === 'chat' && !a._batch ? userGaveDuration() : 0;
    const isReminder = RUN.source === 'chat' && !a._batch && !a.end && !stated && /\bremind\b/i.test(RUN.userText) && !/\b\d+(?:\.\d+)?\s*(?:min|mins|minutes?|h|hrs?|hours?)\b/i.test(RUN.userText);
    const dur = isReminder ? 15 : a.end ? T.diffMin(start, T.norm(a.end)) : (Number(a.duration_minutes) || stated || (kind === 'meeting' ? 30 : 60));
    if (!(dur > 0) || dur > 24 * 60) throw new Error('Duration must be between 1 minute and 24 hours.');
    const explicit = RUN.source === 'chat' && userGaveTime();
    const { emails: asked, names } = resolveGuests(a.guests);
    // "Call with Riya": a known contact named in a meeting's title is a guest even if the model forgot.
    if (kind === 'meeting' && !asked.length) {
      const title = ` ${String(a.title).toLowerCase()} `;
      for (const p of load('people').items) if (p.email && new RegExp(`[^a-z]${p.name.toLowerCase().split(' ')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^a-z]`).test(title)) asked.push(p.email);
    }
    // Inviting emails another person and can't be undone, so it happens only when the user asked for it.
    const consent = mayInvite();
    const emails = consent ? asked : [];
    const held = consent ? [] : asked;
    const withNames = [...names, ...held.map(personName)];
    const description = [a.description || '', withNames.length ? `With: ${withNames.join(', ')}` : ''].filter(Boolean).join('\n');
    const meet = emails.length > 0 && (a.meet !== undefined ? !!a.meet : (s.meetDefault && kind === 'meeting' && !SOCIAL.test(a.title || '')));
    const color = colorId(a.color) || (RUN.source === 'chat' && !a._batch ? userGaveColor() : '');
    if (a.color && !colorId(a.color)) throw new Error(`"${a.color}" is not a calendar colour. Use red, orange, yellow, green, light green, blue, dark blue, purple, lavender, pink or grey.`);
    const base = { title: exactTitle(a.title).slice(0, 200), kind, agent: true, guests: emails, description, location: a.location || '',
      meet, reminder: a.reminder_minutes !== undefined ? Number(a.reminder_minutes) : null, color, colorSet: !!color };
    const inviteNote = held.length ? `Didn't invite ${held.map(personName).join(', ')}: nobody is emailed unless you ask. Say "invite ${personName(held[0])}" to send it.` : undefined;

    if (a.repeat && a.repeat.unit) {
      const plan = planRepeat(start, dur, a.repeat);
      let occ = plan.occurrences.filter(o => o.start >= T.addMin(T.nowStr(), -5));
      if (!occ.length) throw new Error('Every occurrence would be in the past. Check the start and until dates.');
      // "Every 5 hours" means while awake: occurrences in sleeping hours are skipped unless the user asked for nights too.
      let asleep = 0;
      if (String(a.repeat.unit).startsWith('hour') && !/\b(night|nights|24\/7|round the clock|around the clock|even (?:when|while) (?:i'?m )?(?:asleep|sleeping)|midnight|raat)\b/i.test(RUN.userText || '')) {
        const lo = T.hm(s.dayStart), hi = T.hm(s.dayEnd);
        const awake = occ.filter(o => T.inWindow(T.mins(o.start), lo, hi));
        asleep = occ.length - awake.length;
        if (awake.length) occ = awake;
      }
      if (occ.length > MAX_SERIES_EVENTS && !plan.rrule) throw new Error(`That is ${occ.length} separate events; the limit is ${MAX_SERIES_EVENTS}. Use a shorter range or a larger interval.`);
      // A repeating plan is always the user's explicit wish: only "not in the past" is checked here.
      const err = checkPlacement(occ[0].start, occ[0].end, { kind, explicit: true, allowOverlap: true });
      if (err) throw new Error(err);
      const clashing = occ.filter(o => clashesWith(o.start, o.end).length).length;
      markWrite();
      let first, made = [];
      if (plan.rrule && hasV3()) {
        first = cal.create({ ...base, ...occ[0], recurrence: plan.rrule }, { recurrence: plan.rrule });
        made = [first.id];
      } else {
        // Local mode, old bridge, or sub-daily cadence: separate events that share one group id.
        const groupId = 'g' + Date.now().toString(36);
        for (const o of occ.slice(0, MAX_SERIES_EVENTS)) {
          const ev = cal.create({ ...base, ...o, groupId, ...(googleMode() ? {} : { recurringId: groupId }) });
          made.push(ev.id);
        }
        first = cal.get(made[0]);
      }
      const id = logAction('create', null, first, a.rationale, { count: plan.rrule && hasV3() ? occ.length : made.length, repeat: plan.label, ids: made, series: !!(plan.rrule && hasV3()) });
      return { ok: true, action_id: id, first: describe(first), occurrences: occ.length, repeat: plan.label, overlapping_occurrences: clashing || undefined,
        skipped_while_asleep: asleep ? `${asleep} occurrences fell between ${s.dayEnd} and ${s.dayStart} (sleep) and were left out` : undefined };
    }

    const end = T.addMin(start, dur);
    const dup = findDuplicate(base.title, start, end);
    if (dup) return { ok: true, duplicate: true, existing: describe(dup), note: `"${dup.title}" is already on the calendar at ${T.span(dup.start, dup.end)}, so nothing new was created. Say so in the report.` };
    let finalEnd = end;
    if (RUN.source === 'chat' && !a._batch && !a.end && !a.allow_overlap && !stated && !/\b\d+(?:\.\d+)?\s*(?:min|mins|minutes?|h|hrs?|hours?)\b|\bhalf an? hour\b|\ban hour\b/i.test(RUN.userText)) {
      const next = clashesWith(start, end, [], { color }).filter(e => e.start > start).map(e => e.start).sort()[0];
      if (next && !clashesWith(start, next, [], { color }).length && T.diffMin(start, next) >= 30) finalEnd = next;
    }
    const err = checkPlacement(start, finalEnd, { kind, explicit, allowOverlap: !!a.allow_overlap && RUN.source === 'chat', title: base.title, color });
    if (err) throw new Error(err);
    yieldBlocks(start, finalEnd, `Made room for "${a.title}"`);
    markWrite();
    const ev = cal.create({ ...base, start, end: finalEnd });
    const id = logAction('create', null, ev, a.rationale);
    // A colour the user gave in this request is a priority call: lower-priority overlaps are cancelled.
    const pr = color ? applyPriority(ev, { cancel: RUN.source === 'chat' && !!userGaveColor(`${RUN.userText} ${RUN.prevUserText || ''}`) }) : {};
    const overlaps = overlapNote(start, finalEnd, [ev.id], color);
    return { ok: true, action_id: id, event: describe(ev), overlaps, priority: pr.note, invited: emails.length ? emails : undefined, not_invited: [names.length ? `${names.join(', ')}: no email known, so no invite was sent. Mention that the user can share their email to send invites.` : '', inviteNote || ''].filter(Boolean).join(' ') || undefined };
  },

  async move_event(a) {
    if (RUN.source === 'chat' && userSaidKeepTimes()) throw new Error('The user said to keep the times as they are, so nothing may be moved. Change titles/notes with update_events instead.');
    const ev = mustGet(a.event_id);
    guardTarget(ev);
    const amb = ambiguity(ev);
    if (amb) throw new Error(amb);
    const explicitTarget = namedByUser(ev);
    guardEditable(ev, { explicitTarget, needOrganizer: true });
    const dur = T.diffMin(ev.start, ev.end);
    const kind = kindFor(ev);
    const explicit = RUN.source === 'chat' && (userGaveTime() || SWAP.test(RUN.userText) || /\bsame time\b/i.test(RUN.userText));
    const series = a.scope === 'series' && (ev.recurringId || ev.groupId);
    const siblings = series ? cal.series(ev) : [ev];
    const ignore = siblings.map(x => x.id);
    if (a.shift_minutes) a = { ...a, new_start: T.addMin(ev.start, Number(a.shift_minutes)), new_date: undefined };
    const resize = Number(a.duration_minutes) > 0 ? Number(a.duration_minutes) : 0;
    if (!a.new_start && !a.new_date && (resize || a.new_end)) a = { ...a, new_start: ev.start };
    let start;
    // "Move it to Friday" names no time: keep the event's own clock time when that is free, whatever time the model picked.
    // A swap ("swap the dentist and the passport renewal") takes the other event's time on purpose.
    if (a.new_start && !a.new_date && !a.shift_minutes && RUN.source === 'chat' && !explicit && !series && !SWAP.test(RUN.userText)) {
      const day = T.day(T.norm(a.new_start)), same = day + 'T' + ev.start.slice(11);
      if (day !== T.day(ev.start) && !clashesWith(same, T.addMin(same, dur), ignore).length && !checkPlacement(same, T.addMin(same, dur), { ignore, kind, explicit: false, title: ev.title })) a = { ...a, new_start: same, new_end: undefined };
    }
    if (a.new_start && !a.new_date) start = T.norm(a.new_start);
    else if (a.new_date || a.new_start) start = bestTimeOnDay(T.day(T.norm(a.new_date || a.new_start)), ev, dur, kind, explicit, ignore);
    else throw new Error('Give new_start (exact time) or new_date (another day).');
    const end = resize ? T.addMin(start, resize) : a.new_end && !a.new_date ? T.norm(a.new_end) : T.addMin(start, dur);
    if (start === ev.start && end === ev.end) return { ok: true, note: 'Already at that time; nothing changed.' };
    const err = checkPlacement(start, end, { ignore, kind, explicit: explicit || T.clock(start) === T.clock(ev.start) || !!a.shift_minutes || !!resize || (series && explicitTarget), allowOverlap: (!!a.allow_overlap && RUN.source === 'chat') || !!series || (RUN.source === 'chat' && SWAP.test(RUN.userText)), title: ev.title });
    if (err) throw new Error(err);
    if (!series) yieldBlocks(start, end, `Made room for "${ev.title}"`);
    markWrite();
    const ds = T.diffMin(ev.start, start), de = T.diffMin(ev.end, end);
    let after;
    if (series && googleMode() && ev.recurringId && hasV3()) {
      after = cal.update(ev.id, { start, end }, { scope: 'series' });
      for (const x of siblings) if (x.id !== ev.id) cal.update(x.id, { start: T.addMin(x.start, ds), end: T.addMin(x.end, de) }, { scope: 'local' });
    } else {
      for (const x of siblings) {
        const nx = cal.update(x.id, { start: T.addMin(x.start, ds), end: T.addMin(x.end, de) });
        if (x.id === ev.id) after = nx;
      }
    }
    const id = logAction('move', ev, after, a.rationale, { scope: series ? 'series' : 'this', ds, de, ids: series ? ignore : undefined });
    // A coloured event the user moved keeps its priority where it lands.
    const pr = !series && userColor(after) ? applyPriority(after, { cancel: RUN.source === 'chat' && !RUN.inPlanner }) : {};
    return { ok: true, action_id: id, event: describe(after), overlaps: series || SWAP.test(RUN.userText) ? undefined : overlapNote(after.start, after.end, [after.id], userColor(after)), priority: pr.note, moved: series ? `${siblings.length} loaded occurrences (and the rest of the series)` : undefined };
  },

  async update_event(a) {
    const ev = mustGet(a.event_id);
    if (ev.readOnly) throw new Error(`"${ev.title}" is on another calendar; change it there.`);
    guardTarget(ev);
    const amb = ambiguity(ev);
    if (amb) throw new Error(amb);
    const patch = {};
    for (const k of ['title', 'description', 'location']) if (a[k] !== undefined) patch[k] = String(a[k]);
    if (a.guests !== undefined) {
      const want = resolveGuests(a.guests).emails;
      const added = want.filter(g => !(ev.guests || []).includes(g));
      if (added.length && !mayInvite()) throw new Error(`The user did not ask to invite anyone; adding ${added.map(personName).join(', ')} would email them. Change nothing about guests and tell the user they can say "invite ${personName(added[0])}".`);
      patch.guests = want;
    }
    if (a.meet !== undefined) patch.meet = !!a.meet;
    if (a.color !== undefined) {
      const c = colorId(a.color);
      if (!c) throw new Error(`"${a.color}" is not a calendar colour. Use red, orange, yellow, green, light green, blue, dark blue, purple, lavender, pink or grey.`);
      patch.color = c; patch.colorSet = true;
    }
    if (a.reminder_minutes !== undefined) patch.reminder = Number(a.reminder_minutes);
    if (a.flexible !== undefined) patch.flexible = !!a.flexible;
    if (a.high_stakes !== undefined) patch.highStakes = !!a.high_stakes;
    if (a.protected !== undefined) patch.protected = !!a.protected;
    if (!Object.keys(patch).length) throw new Error('Nothing to update. Pass at least one field.');
    if (!ev.organizer && Object.keys(patch).some(k => !['flexible', 'highStakes', 'protected', 'reminder', 'color'].includes(k))) throw new Error(`The user did not organize "${ev.title}", so only its colour, flags and reminder can change.`);
    markWrite();
    const series = a.scope === 'series' && ev.recurringId && hasV3();
    const after = cal.update(ev.id, patch, { scope: series ? 'series' : 'this' });
    const id = logAction('update', ev, after, a.rationale, { scope: series ? 'series' : 'this' });
    // A new colour is reported against what it overlaps; nothing is cancelled by recolouring alone.
    const pr = patch.color && !series ? applyPriority(after, { cancel: false }) : {};
    return { ok: true, action_id: id, event: describe(after), priority: pr.note, invited: patch.guests && patch.guests.length ? patch.guests : undefined };
  },

  async delete_events(a) {
    if (!(Array.isArray(a.event_ids) ? a.event_ids.length : a.event_ids || a.event_id)) return deleteMatching(a);
    const list = (Array.isArray(a.event_ids) ? a.event_ids : String(a.event_ids || a.event_id || '').split(',')).map(x => String(x).trim()).filter(Boolean);
    if (!list.length) throw new Error('event_ids is empty.');
    const results = [], errors = [];
    const doneSeries = new Set();
    for (const x of list) {
      try {
        const ev = mustGet(x);
        const key = ev.recurringId || ev.groupId;
        const series = a.scope === 'series' && key;
        if (series && doneSeries.has(key)) continue;
        const amb = list.length === 1 && !series ? ambiguity(ev) : '';
        if (amb) throw new Error(amb);
        // A cancel the user asked for is explicit: "protected" only guards against side effects.
        guardEditable(ev, { explicitTarget: namedByUser(ev) || (RUN.source === 'chat' && cancelRequested()), needOrganizer: false });
        guardCancel(ev);
        if (list.length === 1) guardTarget(ev);
        markWrite();
        if (series) doneSeries.add(key);
        results.push(removeOne(ev, series, a.rationale));
      } catch (e) { errors.push(`${x}: ${e.message}`); }
    }
    if (!results.length) throw new Error(errors.join(' · '));
    return { ok: true, done: results, errors: errors.length ? errors : undefined };
  },

  async undo(a) {
    // Only an actual "undo / put it back" may revert things; "no, cancel it" is a new instruction, not an undo.
    if (RUN.source === 'chat' && RUN.userText && !/\b(undo|revert|put (?:it|them|that|those) back|restore|bring (?:it|them|that|those) back|reverse|go back|changed my mind)\b/i.test(RUN.userText)) {
      throw new Error(`The user did not ask to undo anything ("${RUN.userText.slice(0, 80)}"). Do what they asked instead — read it together with their previous message.`);
    }
    if (a.action_id) return { ok: true, result: revertAction(a.action_id, a.reason || 'Undo requested') };
    // "Undo that" reverts everything the last request changed (a whole day plan, not just its last block).
    const n = Math.max(1, Math.min(10, Number(a.count) || 1));
    const mine = load('actions').items.filter(x => x.status === 'active' && x.type !== 'revert' && !x.auto && x.source === 'chat');
    const runs = [...new Set(mine.map(x => x.run || x.id))].slice(-n);
    const picks = mine.filter(x => runs.includes(x.run || x.id)).reverse();
    if (!picks.length) return { ok: true, result: 'Nothing to undo.' };
    return { ok: true, undone: picks.map(x => revertAction(x.id, a.reason || 'Undo requested')) };
  },

  async save_rule(a) {
    const rule = String(a.rule || '').trim();
    if (!rule) throw new Error('Empty rule.');
    const merged = addRule(rule, 'chat');
    const win = a.applies_to && a.allowed_times ? addActivityWindow(a.applies_to, a.allowed_times) : null;
    return { ok: true, saved: rule, replaced_similar_rule: merged || undefined, enforced_times: win || undefined };
  },

  async update_preferences(a) {
    const patch = {};
    const map = { wake_time: 'dayStart', sleep_time: 'dayEnd', work_start: 'workStart', work_end: 'workEnd' };
    for (const [k, key] of Object.entries(map)) {
      if (a[k] === undefined || a[k] === '') continue;
      if (!T.isHM(a[k])) throw new Error(`${k} must look like 09:30.`);
      patch[key] = a[k];
    }
    if (a.focus_minutes !== undefined) patch.focusSpan = Math.max(25, Math.min(240, Number(a.focus_minutes) || 90));
    if (a.break_minutes !== undefined) patch.breakMinutes = Math.max(0, Math.min(60, Number(a.break_minutes) || 0));
    if (!Object.keys(patch).length) throw new Error('Nothing to change. Pass wake_time, sleep_time, focus_minutes, break_minutes, work_start or work_end.');
    const before = settings();
    const wake = T.hm(patch.dayStart || before.dayStart), down = T.hm(patch.dayEnd || before.dayEnd);
    // Sleeping after midnight is fine ("I sleep at 2") as long as the night is a real night.
    if (wake === down || (down < wake && (down > 6 * 60 || wake - down < 5 * 60))) throw new Error('Wake-up and sleep times must leave at least 5 hours of sleep (sleep after midnight, e.g. 02:00, is fine).');
    saveSettings(patch);
    const names = { dayStart: 'wake_time', dayEnd: 'sleep_time', focusSpan: 'focus_minutes', breakMinutes: 'break_minutes', workStart: 'work_start', workEnd: 'work_end' };
    return { ok: true, saved: Object.fromEntries(Object.entries(patch).map(([k, v]) => [names[k], v])) };
  },

  async create_events(a) {
    const list = Array.isArray(a.events) ? a.events : [];
    if (!list.length) throw new Error('events is empty.');
    if (list.length > 40) throw new Error('At most 40 events at a time.');
    const created = [], skipped = [], errors = [];
    for (const e of list) {
      try {
        const r = await TOOLS.create_event({ ...e, kind: e.kind || 'task', allow_overlap: a.allow_overlap || e.allow_overlap, rationale: a.rationale || 'from the list the user gave', _batch: true });
        if (r.duplicate) skipped.push(`${e.title}: already on the calendar`);
        else created.push(`${T.span(r.event.start, r.event.end)} ${r.event.title}`);
      } catch (err) { errors.push(`${e.title || '?'} (${e.start || 'no time'}): ${err.message}`); }
    }
    if (!created.length && !skipped.length) throw new Error(errors.join(' · '));
    return { ok: true, created, skipped: skipped.length ? skipped : undefined, errors: errors.length ? errors : undefined };
  },

  /** "Replace the titles in order (1st, 2nd, 3rd…) for each date" — matched in code, never moved. */
  async rename_in_order(a) {
    const days = Array.isArray(a.days) ? a.days : [];
    if (!days.length) throw new Error('days is empty.');
    const match = String(a.match || '').trim().toLowerCase();
    const done = [], errors = [];
    for (const d of days) {
      const day = T.day(T.norm(d.date));
      await ensureRange(day, day);
      const titles = (Array.isArray(d.titles) ? d.titles : []).map(t => exactTitle(t)).filter(Boolean);
      const evs = cal.list(day + 'T00:00', T.addDays(day, 1) + 'T00:00')
        .filter(e => T.day(e.start) === day && !e.allDay && isActive(e) && e.kind !== 'buffer' && e.organizer && !e.readOnly && (!match || textOf(e).includes(match)));
      if (evs.length < titles.length) errors.push(`${day}: ${titles.length} titles but only ${evs.length} matching event${evs.length === 1 ? '' : 's'}${match ? ` ("${match}")` : ''}; renamed the first ${evs.length}`);
      evs.slice(0, titles.length).forEach((ev, i) => {
        markWrite();
        const after = cal.update(ev.id, { title: titles[i].slice(0, 200) }, { scope: 'this' });
        logAction('update', ev, after, a.rationale || 'renamed in order');
        done.push(`${day} ${T.clock(ev.start)} "${ev.title}" → "${after.title}"`);
      });
    }
    if (!done.length) throw new Error(errors.join(' · ') || 'Nothing matched.');
    return { ok: true, renamed: done, warnings: errors.length ? errors : undefined, note: 'Times were not changed.' };
  },

  async update_events(a) {
    const list = Array.isArray(a.updates) ? a.updates : [];
    if (!list.length) throw new Error('updates is empty.');
    if (list.length > 60) throw new Error('At most 60 updates at a time.');
    const done = [], errors = [];
    for (const u of list) {
      try {
        const ev = mustGet(u.event_id);
        if (ev.readOnly) throw new Error(`"${ev.title}" is on another calendar; change it there.`);
        if (!ev.organizer) throw new Error(`The user did not organize "${ev.title}".`);
        const patch = {};
        for (const k of ['title', 'description', 'location']) if (u[k] !== undefined) patch[k] = (k === 'title' ? exactTitle(u[k]) : String(u[k])).slice(0, k === 'description' ? 4000 : 200);
        if (u.reminder_minutes !== undefined) patch.reminder = Number(u.reminder_minutes);
        if (!Object.keys(patch).length) throw new Error('nothing to change');
        markWrite();
        const after = cal.update(ev.id, patch, { scope: 'this' });
        logAction('update', ev, after, a.rationale || 'batch edit');
        done.push(`${T.human(ev.start)} "${ev.title}"${patch.title && patch.title !== ev.title ? ` → "${patch.title}"` : ''}`);
      } catch (err) { errors.push(`${u.event_id}: ${err.message}`); }
    }
    if (!done.length) throw new Error(errors.join(' · '));
    return { ok: true, updated: done, errors: errors.length ? errors : undefined };
  },

  async remember_person(a) {
    const name = String(a.name || '').trim();
    if (!name) throw new Error('name is empty.');
    const email = String(a.email || '').trim();
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error(`"${email}" is not an email address.`);
    const p = load('people');
    let row = p.items.find(x => x.name.toLowerCase() === name.toLowerCase());
    if (!row) { row = { id: 'P' + (++p.seq), name, email: '', note: '' }; p.items.push(row); }
    if (email) row.email = email;
    if (a.note) row.note = String(a.note).slice(0, 300);
    save('people');
    return { ok: true, person: row };
  },
};

/** Compresses a list of HH:MM starts into short ranges: "09:00–11:30 (every 15 min)". */
function compress(slots, maxRanges) {
  const ranges = [];
  for (const t of slots) {
    const last = ranges[ranges.length - 1];
    if (last && T.hm(t) - T.hm(last[1]) === 15) last[1] = t; else ranges.push([t, t]);
  }
  return ranges.slice(0, maxRanges).map(([a, b]) => a === b ? a : `${a}–${b}`);
}

/** Nothing is cancelled unless the user asked for it: to make room, events are moved, never deleted. */
function guardCancel(ev) {
  if (RUN.source === 'chat' && !RUN.userText) return; // the app's own buttons
  if (RUN.source === 'chat' && cancelRequested()) return;
  if (RUN.source !== 'chat' && isAgentBlock(ev)) return;
  // Taking back something made earlier in this same request is a correction, not a cancellation.
  if (load('actions').items.some(a => a.run === RUN.id && a.type === 'create' && a.status === 'active' && a.eventId === ev.id)) return;
  throw new Error(`The user did not ask to cancel anything, so "${ev.title}" stays. To make room, move it (find_free_slots / plan_day) or leave it and say so.`);
}

/** Cancels what a request describes instead of listing ids: one action, one undo, instances only when a date bounds it. */
async function deleteMatching(a) {
  const query = String(a.query || '').trim();
  if (!query && !a.to) throw new Error('Give event_ids, a query, or a to date.');
  if (RUN.source !== 'chat' || (RUN.userText && !cancelRequested())) throw new Error('The user did not ask to cancel anything, so nothing was cancelled.');
  const from = a.from ? T.day(T.norm(a.from)) : T.today();
  const to = a.to ? T.day(T.norm(a.to)) : T.addDays(T.today(), 183);
  if (to < from) throw new Error('to is before from.');
  const alts = query.toLowerCase().split(',').map(q => tokens(q).filter(w => !['the', 'all', 'my', 'of'].includes(w))).filter(x => x.length);
  // A query must come from the user's words (or the request they follow up on), never from the model's guess.
  if (RUN.source === 'chat' && alts.length) {
    const said = tokens(`${RUN.userText || ''} ${RUN.prevUserText || ''}`);
    const recent = load('actions').items.slice(-8).some(x => x.status === 'active' && !x.auto && x.source === 'chat' && T.diffMin(x.time, T.nowStr()) <= 60);
    if (!recent && !alts.some(q => q.some(w => said.some(x => sameWord(x, w))))) throw new Error(`The user never named "${query}". Change nothing and ask which event they mean.`);
  }
  await ensureRange(from, to);
  const hit = e => !alts.length || alts.some(q => q.every(w => tokens(e.title).some(x => sameWord(x, w))));
  const now = T.nowStr();
  const evs = cal.list(from + 'T00:00', T.addDays(to, 1) + 'T00:00').filter(e => e.end > now && T.day(e.start) >= from && isActive(e) && !e.readOnly && hit(e));
  const real = evs.filter(e => !(e.agent && e.kind === 'buffer'));
  if (!real.length) return { ok: true, cancelled: 0, note: `Nothing matches ${query ? '"' + query + '"' : 'that'} from ${from} to ${to}. Say so.` };
  if (real.length > MAX_BULK_DELETE) throw new Error(`That is ${real.length} events; narrow the dates.`);
  const done = [];
  const seriesDone = new Set();
  const single = [];
  for (const e of evs) {
    const key = e.recurringId || e.groupId;
    if (!a.to && query && key) { if (!seriesDone.has(key)) { seriesDone.add(key); markWrite(); done.push(removeOne(e, true, a.rationale)); } continue; }
    if (!e.organizer) { markWrite(); done.push(removeOne(e, false, a.rationale)); continue; }
    single.push(e);
  }
  if (single.length) {
    for (const e of single) { cal.remove(e.id); markCreate(e.id, isAgentBlock(e) ? 'removed_by_user' : 'deleted'); }
    const shown = single.filter(e => !(e.agent && e.kind === 'buffer'));
    const counts = new Map();
    for (const e of shown) counts.set(e.title, (counts.get(e.title) || 0) + 1);
    const titles = [...counts].slice(0, 8).map(([t, n]) => n > 1 ? `${t} ×${n}` : t).join(', ') + (counts.size > 8 ? ` and ${counts.size - 8} more` : '');
    logAction('delete', single[0], null, a.rationale, { scope: 'bulk', count: shown.length, titles, snapshots: single });
    done.push({ cancelled: shown.length });
  }
  RUN.planNeeded = true;
  return { ok: true, done: done.length };
}

function removeOne(ev, series, rationale) {
  const scope = series ? 'series' : 'this';
  if (!ev.organizer && !ev.readOnly) {
    const after = cal.update(ev.id, { myStatus: 'declined' }, { scope });
    if (series) for (const x of cal.series(ev)) if (x.id !== ev.id) cal.update(x.id, { myStatus: 'declined' }, { scope: 'local' });
    const id = logAction('decline', ev, after, rationale, { scope });
    return { action_id: id, declined: ev.title };
  }
  if (!series) {
    cal.remove(ev.id);
    markCreate(ev.id, isAgentBlock(ev) ? 'removed_by_user' : 'deleted');
    const id = logAction('delete', ev, null, rationale);
    return { action_id: id, cancelled: ev.title, start: ev.start };
  }
  const siblings = cal.series(ev);
  if (googleMode() && ev.recurringId && hasV3()) {
    cal.remove(ev.id, { scope: 'series' });
    cal.dropLocal(x => x.recurringId === ev.recurringId);
  } else {
    // Old bridge / local / agent group: remove every loaded occurrence individually.
    for (const x of siblings) cal.remove(x.id);
  }
  const id = logAction('delete', ev, null, rationale, { scope: 'series', count: siblings.length, snapshots: siblings.slice(0, 120) });
  return { action_id: id, cancelled: `${ev.title} (series, ${siblings.length} loaded occurrences)` };
}

export function runTool(name, args) {
  if (!TOOLS[name]) throw new Error(`Unknown tool "${name}".`);
  return TOOLS[name](args || {});
}

// ─── Memory helpers used by tools ───
const RULE_STOP = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'for', 'of', 'in', 'on', 'at', 'when', 'user', 'users', 'event', 'events', 'never', 'do', 'not', 'don', 't', 'always', 'any', 'all', 'is', 'are', 'be', 'it', 'that', 'this', 'with', 'my', 'i']);
// Crude but enough for rules: "cancellations" / "canceling" → "cancel", "classes" → "class".
const stem = w => { const x = w.replace(/(ing|ed|es|(?<!s)s)$/, ''); return x.length > 6 ? x.slice(0, 6) : x; };
const ruleWords = t => new Set(String(t || '').toLowerCase().replace(/[^a-z0-9:\s]/g, ' ').split(/\s+/).filter(w => w && !RULE_STOP.has(w)).map(stem));
/** How alike two rules are, 0–1 ("Do not cancel study blocks…" ≈ "Never cancel study block events…"). */
export function ruleSimilarity(a, b) {
  const x = ruleWords(a), y = ruleWords(b);
  if (!x.size || !y.size) return 0;
  let n = 0;
  for (const w of x) if (y.has(w)) n++;
  // Same rule reworded: most words of the shorter one appear in the other, and a fair share overall.
  const jac = n / (x.size + y.size - n), cover = n / Math.min(x.size, y.size);
  return cover >= 0.7 && jac >= 0.35 ? Math.max(jac, 0.5) : jac;
}

/** Saves a rule; a near-duplicate of an active rule replaces it instead. Returns the replaced text, if any. */
export function addRule(text, source) {
  const m = load('memory');
  if (m.rules.some(r => r.active && r.text.toLowerCase() === text.toLowerCase())) return '';
  const same = m.rules.filter(r => r.active).map(r => [r, ruleSimilarity(r.text, text)]).filter(([, x]) => x >= 0.5).sort((a, b) => b[1] - a[1]).map(([r]) => r)[0];
  if (same) {
    const old = same.text;
    Object.assign(same, { text, source, time: T.nowStr() });
    save('memory');
    return old;
  }
  m.rules.push({ id: 'r' + (++m.seq), text, source, active: true, time: T.nowStr() });
  save('memory');
  return '';
}

/** "run, jog" + "06:00-08:00, 17:00-21:00" → an enforced time window for that activity. Returns its label. */
export function addActivityWindow(match, windows) {
  const w = parseWindows(windows);
  const words = kwList(match);
  if (!w.length || !words.length) return '';
  const label = w.map(([a, b]) => `${T.toHM(a)}-${T.toHM(b)}`).join(', ');
  const list = (settings().activityWindows || []).filter(x => !kwList(x.match).some(k => words.includes(k)));
  list.push({ match: words.join(', '), windows: label });
  saveSettings({ activityWindows: list });
  return `${words.join('/')}: ${label}`;
}

// ─── Undo ───
export function revertAction(actionId, reason) {
  const a = findAction(actionId);
  if (!a) return `No action ${actionId} found.`;
  if (a.status === 'reverted') return `${a.id} was already undone.`;
  if (a.type === 'revert') return `${a.id} is itself an undo; nothing to revert.`;
  const x = a.extra || {};
  markWrite();
  let what;
  if (a.type === 'create') {
    if (x.series && googleMode()) {
      const ev = cal.get(a.after.id);
      if (ev) { cal.remove(ev.id, { scope: 'series' }); if (ev.recurringId) cal.dropLocal(e => e.recurringId === ev.recurringId); }
      else cal.queueDelete(a.after.id, 'series');
    } else for (const id of x.ids || [a.after.id]) { if (cal.get(id)) cal.remove(id); else cal.queueDelete(id); }
    what = `Removed "${a.title}"${x.count > 1 ? ` (${x.count} events)` : ''}`;
  } else if (a.type === 'move') {
    if (!cal.get(a.after.id)) return `"${a.title}" no longer exists, so ${a.id} cannot be undone.`;
    if (x.scope === 'series') {
      const ev = cal.get(a.after.id);
      const sib = cal.series(ev);
      if (googleMode() && ev.recurringId && hasV3()) {
        cal.update(ev.id, { start: a.before.start, end: a.before.end }, { scope: 'series' });
        for (const s of sib) if (s.id !== ev.id) cal.update(s.id, { start: T.addMin(s.start, -x.ds), end: T.addMin(s.end, -x.de) }, { scope: 'local' });
      } else for (const s of sib) cal.update(s.id, { start: T.addMin(s.start, -x.ds), end: T.addMin(s.end, -x.de) });
    } else cal.update(a.after.id, { start: a.before.start, end: a.before.end });
    what = `Moved "${a.title}" back to ${T.span(a.before.start, a.before.end)}`;
  } else if (a.type === 'delete') {
    if (x.scope === 'series' || x.scope === 'bulk') {
      const snaps = x.snapshots || [a.before];
      for (const s of snaps) cal.restore(s);
      what = x.scope === 'bulk' ? `Restored ${snaps.length} event${snaps.length === 1 ? '' : 's'}` : `Restored ${snaps.length} occurrence(s) of "${a.title}"${googleMode() ? ' as single events' : ''}`;
    } else {
      cal.restore(a.before);
      what = `Restored "${a.title}" at ${T.span(a.before.start, a.before.end)}`;
    }
  } else if (a.type === 'decline') {
    cal.update(a.before.id, { myStatus: 'accepted' }, { scope: x.scope || 'this' });
    what = `Re-accepted "${a.title}"`;
  } else if (a.type === 'update') {
    const { title, description, location, guests, flexible, highStakes, protected: prot, reminder } = cal.withDefaults(a.before);
    cal.update(a.before.id, { title, description, location, guests, flexible, highStakes, protected: prot, reminder }, { scope: x.scope || 'this' });
    what = `Restored the details of "${a.title}"`;
  } else {
    return `${a.id} cannot be undone.`;
  }
  setAction(a, { status: 'reverted', feedback: a.feedback || `undo: ${reason}` });
  const log = load('actions');
  const id = 'ACT-' + (++log.counter);
  const summary = `${what} (undo of ${a.id})`;
  log.items.push({ id, time: T.nowStr(), type: 'revert', title: a.title, eventId: a.eventId, before: null, after: null,
    rationale: reason, summary, status: 'active', feedback: '', source: RUN.source, reverts: a.id });
  save('actions');
  RUN.actions.push({ id, summary, rationale: reason });
  RUN.planNeeded = true;
  return summary;
}

/** Called when the user edits the calendar by hand: learn from changes to agent blocks. */
export function noteUserEdit(before, after) {
  if (!before || !isAgentBlock(before)) return;
  const m = load('memory');
  // What the edit says about the hour (src/rhythm.js): a drag to another time is strong, a delete is weak.
  if (before.kind !== 'buffer' && before.end > T.nowStr()) {
    if (!after) noteBlock(false, before, 0.5);
    else if (T.clock(after.start) !== T.clock(before.start)) { noteBlock(false, before, 0.7); noteBlock(true, after, 0.7); }
  }
  if (!after) {
    markCreate(before.id, 'removed_by_user');
    m.adjustments.push(`${T.today()}: user deleted agent ${before.kind} "${before.title}" at ${T.span(before.start, before.end)}`);
  } else if (after.start !== before.start) {
    m.adjustments.push(`${T.today()}: user moved agent ${before.kind} "${before.title}" from ${T.clock(before.start)} to ${T.clock(after.start)} (${T.DAY_NAMES[T.dow(T.day(after.start))]})`);
  }
  m.adjustments = m.adjustments.slice(-25);
  save('memory');
}
