// Reminders: things to remember that have no date or time ("renew passport", "call the bank").
// They never touch the calendar. Anything with a day or a time in it is an event and goes to the calendar instead.
import * as T from './time.js';
import * as cal from './calendar.js';
import { load, save, settings } from './store.js';
import { whenIn, timeIn } from './when.js';
import { REMINDER_LIST_MARK, isReminderList } from './engine.js';
import { ensureRange } from './sync.js';

const MAX_OPEN = 60, KEEP_DONE = 30;
const clean = s => String(s || '').replace(/\s+/g, ' ').trim().replace(/[.!]+$/, '').slice(0, 200);
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

/** Open reminders (pinned first, then oldest first), then the most recently finished ones. */
export function remindersView() {
  const items = load('reminders').items;
  const open = items.filter(r => !r.done).sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || a.created.localeCompare(b.created));
  const done = items.filter(r => r.done).sort((a, b) => b.doneAt.localeCompare(a.doneAt)).slice(0, 10);
  return { open, done };
}

export function addReminder(text) {
  const t = cap(clean(text));
  if (!t) throw new Error('Write what to remember.');
  const r = load('reminders');
  const same = r.items.find(x => !x.done && x.text.toLowerCase() === t.toLowerCase());
  if (same) return { reminder: same, duplicate: true };
  if (r.items.filter(x => !x.done).length >= MAX_OPEN) throw new Error(`You already have ${MAX_OPEN} open reminders. Tick a few off first.`);
  const item = { id: 'n' + (++r.seq), text: t, done: false, pinned: false, created: T.nowStr(), doneAt: '' };
  r.items.push(item);
  save('reminders');
  return { reminder: item };
}

/** patch: { done?, pinned?, text?, remove? } */
export function updateReminder(id, patch = {}) {
  const r = load('reminders');
  const item = r.items.find(x => x.id === id);
  if (!item) throw new Error('That reminder no longer exists.');
  if (patch.remove) r.items = r.items.filter(x => x.id !== id);
  else {
    if (patch.text !== undefined) { const t = cap(clean(patch.text)); if (!t) throw new Error('Write what to remember.'); item.text = t; }
    if (patch.pinned !== undefined) item.pinned = !!patch.pinned;
    if (patch.done !== undefined) { item.done = !!patch.done; item.doneAt = item.done ? T.nowStr() : ''; if (item.done) item.pinned = false; }
    // Finished reminders are kept only for a while (enough to undo a mis-tap).
    const done = r.items.filter(x => x.done).sort((a, b) => b.doneAt.localeCompare(a.doneAt));
    if (done.length > KEEP_DONE) { const drop = new Set(done.slice(KEEP_DONE).map(x => x.id)); r.items = r.items.filter(x => !drop.has(x.id)); }
  }
  save('reminders');
  return item;
}

// "remind me to X", "add a reminder: X", "note to self X", "don't let me forget to X", "reminder: X"
const ADD = /^\s*(?:please\s+|pls\s+|hey\s+)?(?:remind me (?:to|about|that)\s+|(?:add|make|set|create)\s+(?:a\s+)?reminder(?:\s+(?:to|for|about|that))?\s*[:\-–,]?\s*|(?:add|put)\s+(.+?)\s+(?:to|on|in)\s+(?:my\s+)?reminders\s*$|reminder\s*[:\-–]\s*|note to self\s*[:\-–,]?\s*|don'?t let me forget (?:to\s+|about\s+)?)(.*)$/i;
// Words that tie it to a moment: then it belongs on the calendar, not in the list.
const TIMED = /\b(?:today|tonight|tomorrow|tmrw|tmr|morning|afternoon|evening|noon|midnight|weekend|later today|next week|this week|every|daily|weekly|in \d+\s*(?:min|mins|minutes?|h|hrs?|hours?|days?)|in an? (?:hour|minute|bit)|before \d|by \d|\d{1,2}\s*(?:am|pm)|\d{1,2}[:.]\d{2})\b/i;

/** The reminder text in a chat message, or null when it isn't one (or names a time, which is an event). */
export function reminderIn(message) {
  const m = ADD.exec(String(message || '').replace(/[’]/g, "'"));
  if (!m) return null;
  const text = clean(m[1] || m[2]);
  if (!text || text.length < 2) return null;
  if (TIMED.test(text) || whenIn(text).days.length || timeIn(text)) return null;
  return text;
}

const LIST = /^\s*(?:what(?:'s| are| is)?\s+(?:on\s+)?(?:my|the)\s+reminders?|(?:show|list|read)\s+(?:me\s+)?(?:my\s+)?reminders?|my reminders?|reminders?)\s*[?!.]*\s*$/i;

// ─── The weekly calendar event: every open reminder in one Monday 09:00–10:00 event, so they show on any calendar app ───
const TITLE_MAX = 180;
/** "Reminders: Renew passport + Msg Alex + Fill form" (shortened with "+ N more" when long). */
export function listTitle(texts) {
  let title = 'Reminders: ';
  for (let i = 0; i < texts.length; i++) {
    const next = title + (i ? ' + ' : '') + texts[i];
    const left = texts.length - i - 1;
    // Stop when this one (plus room for "+ N more") would make the title too long; the notes hold the full list.
    if (i && (next + (left ? ` + ${left} more` : '')).length > TITLE_MAX) return `${title} + ${texts.length - i} more`;
    title = next;
  }
  return title;
}
/** The Monday the list lives on: today if it is Monday, otherwise the coming one. */
export const listDay = (d = T.today()) => T.dow(d) === 1 ? d : T.addDays(T.weekStart(d), 7);

/**
 * Brings the reminder event(s) in line with the open reminders: the coming Monday's event gets the full list
 * (created if missing, deleted when nothing is left), and this week's Monday event, if any, is kept the same.
 * Older weeks' events are left as they were. Never logged as a change: it only mirrors the list.
 */
export async function syncReminderEvent() {
  const target = listDay();
  const from = T.weekStart(T.today());
  await ensureRange(from, target);
  const evs = cal.list(from + 'T00:00', T.addDays(target, 1) + 'T00:00').filter(isReminderList);
  const open = remindersView().open.map(r => r.text);
  if (!open.length || settings().reminderEvent === false) {
    for (const e of evs) cal.remove(e.id);
    return { removed: evs.length };
  }
  const title = listTitle(open);
  const description = `${open.map(t => '• ' + t).join('\n')}\n\n${REMINDER_LIST_MARK}`;
  let changed = 0;
  for (const e of evs) if (e.title !== title || e.description !== description) { cal.update(e.id, { title, description }); changed++; }
  if (!evs.some(e => T.day(e.start) === target)) {
    cal.create({ title, description, start: `${target}T09:00`, end: `${target}T10:00`, kind: 'personal', organizer: true, flexible: false, guests: [], location: '', meet: false });
    changed++;
  }
  return { changed };
}

/** Chat, in code: adds or lists reminders. null = not about reminders. */
export async function quickReminder(message) {
  if (LIST.test(message)) {
    const { open } = remindersView();
    return open.length ? `Reminders (${open.length}):\n${open.map(r => '- ' + r.text).join('\n')}` : 'No reminders. Say "remind me to …" without a time to add one.';
  }
  const text = reminderIn(message);
  if (text === null) return null;
  const r = addReminder(text);
  if (!r.duplicate) await syncReminderEvent();
  return r.duplicate ? `Already on your reminders: ${r.reminder.text}.` : `Added to your reminders: ${r.reminder.text}. It stays on Today until you tick it off.`;
}
