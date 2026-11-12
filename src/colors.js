// Event colours = priorities. Google Calendar has 11 event colours (colorId "1"–"11"); Donna reads and writes the
// same ids, so a colour set in chat shows in Google and a colour set in Google counts here.
//   • a higher-priority event booked over lower-priority ones cancels them (one Undo brings them back)
//   • two events of the same colour may overlap: they are simultaneous (e.g. two errands on one market trip)
//   • events without a colour have no priority: overlaps are reported, nothing is cancelled
import { settings } from './store.js';

/** Google's event colours, by colorId. */
export const COLORS = {
  11: { name: 'red', google: 'Tomato', hex: '#d50000' },
  6: { name: 'orange', google: 'Tangerine', hex: '#f4511e' },
  5: { name: 'yellow', google: 'Banana', hex: '#f6bf26' },
  10: { name: 'green', google: 'Basil', hex: '#0b8043' },
  2: { name: 'light green', google: 'Sage', hex: '#33b679' },
  7: { name: 'blue', google: 'Peacock', hex: '#039be5' },
  9: { name: 'dark blue', google: 'Blueberry', hex: '#3f51b5' },
  3: { name: 'purple', google: 'Grape', hex: '#8e24aa' },
  1: { name: 'lavender', google: 'Lavender', hex: '#7986cb' },
  4: { name: 'pink', google: 'Flamingo', hex: '#e67c73' },
  8: { name: 'grey', google: 'Graphite', hex: '#616161' },
};
/** Highest priority first. Red is the top; grey the bottom. */
export const DEFAULT_ORDER = ['11', '6', '5', '10', '2', '7', '9', '3', '1', '4', '8'];

const ALIASES = [
  ['11', 'red|tomato'], ['6', 'orange|tangerine'], ['5', 'yellow|banana'],
  ['2', 'light green|sage'], ['10', 'green|basil|dark green'],
  ['9', 'dark blue|navy|navy blue|blueberry|indigo'], ['7', 'light blue|blue|peacock|cyan|sky blue'],
  ['1', 'lavender|light purple|lilac'], ['3', 'purple|grape|violet'],
  ['4', 'pink|flamingo'], ['8', 'grey|gray|graphite|black'],
];
const WORD = ALIASES.map(([, w]) => w).join('|');

/** "red" / "Tomato" / "11" → "11"; '' if not a colour. */
export function colorId(word) {
  const w = String(word || '').trim().toLowerCase();
  if (COLORS[w]) return w;
  for (const [id, names] of ALIASES) if (new RegExp(`^(?:${names})$`).test(w)) return id;
  return '';
}
export const colorName = id => (COLORS[id] ? COLORS[id].name : '');

/** The user's priority order (colour ids, highest first). Colours left out of a custom order rank after it, in default order. */
export function order(s = settings()) {
  const custom = (Array.isArray(s.colorPriority) ? s.colorPriority : String(s.colorPriority || '').split(',')).map(colorId).filter(Boolean);
  return [...new Set([...custom, ...DEFAULT_ORDER])];
}

const LEVELS = { urgent: 0, critical: 0, top: 0, highest: 0, high: 0, medium: 2, normal: 2, low: -1, lowest: -1 };
const level = (word, s) => { const o = order(s); const i = LEVELS[word.toLowerCase()]; return i < 0 ? o[o.length - 1] : o[i]; };

const PATTERNS = [
  new RegExp(`\\b(?:colou?r(?:ed)?|mark(?:ed)?|tag(?:ged)?|label(?:led)?|make)\\s+(?:it|this|that|them)?\\s*(?:as|in|to)?\\s*(${WORD})(?:\\s+colou?r)?\\b`, 'i'),
  new RegExp(`\\b(?:in|with)\\s+(${WORD})\\s+colou?r\\b`, 'i'),
  new RegExp(`\\b(${WORD})\\s+colou?r(?:ed)?\\b`, 'i'),
  new RegExp(`\\bcolou?r\\s*[:=]\\s*(${WORD})\\b`, 'i'),
  new RegExp(`\\((${WORD})\\)`, 'i'),
  new RegExp(`\\bin\\s+(${WORD})\\s*[.!]*\\s*$`, 'i'),
];
const PRIORITY = [
  /\b(?:priority|prio)\s*(?:[:=]|is|as|of)?\s*(urgent|critical|top|highest|high|medium|normal|lowest|low)\b/i,
  /\b(urgent|critical|top|highest|high|medium|normal|lowest|low)[\s-]+priority\b/i,
];

/** { color, rest } for a colour or priority the user named ("color red", "in yellow", "high priority"), else { color: '', rest: text }. */
export function colorIn(text, s = settings()) {
  const t = String(text || '');
  for (const re of PATTERNS) {
    const m = re.exec(t);
    if (m) return { color: colorId(m[1]), rest: (t.slice(0, m.index) + ' ' + t.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim() };
  }
  for (const re of PRIORITY) {
    const m = re.exec(t);
    if (m) return { color: level(m[1], s), rest: (t.slice(0, m.index) + ' ' + t.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim() };
  }
  return { color: '', rest: t };
}

/** Colours the bridge gives Donna's own blocks by kind (Google shows them; they are not priorities). */
const AUTO = { focus: '10', buffer: '8', task: '5', habit: '2' };
const block = e => !!e.agent && ['focus', 'habit', 'task', 'buffer'].includes(e.kind) && (!!e.taskId || !!e.habitId || e.kind !== 'task');
/**
 * The colour the user chose for an event, or ''. Donna's own blocks have none, and an event Donna created still
 * wearing the automatic colour of its kind has none either, unless the user picked that colour (colorSet).
 */
export function userColor(e) {
  const c = e ? String(e.color || '') : '';
  if (!COLORS[c] || block(e)) return '';
  if (e.agent && !e.colorSet && AUTO[e.kind] === c) return '';
  return c;
}

/** 0 = highest priority; null = no colour (no priority). */
export function rank(ev, s = settings()) {
  const c = userColor(ev);
  return c ? order(s).indexOf(c) : null;
}

/**
 * How a new/moved event `ev` relates to an existing one it overlaps:
 *   'same'   both have the same colour → simultaneous, not a conflict
 *   'higher' ev outranks other → other may be cancelled
 *   'lower'  other outranks ev
 *   null     either has no colour
 */
export function relation(ev, other, s = settings()) {
  const a = rank(ev, s), b = rank(other, s);
  if (a === null || b === null) return null;
  if (a === b) return 'same';
  return a < b ? 'higher' : 'lower';
}
export const sameColor = (a, b) => !!userColor(a) && userColor(a) === userColor(b);

/** The colour to paint an event with in the app (the user's colour only). */
export function paintOf(e) {
  const c = userColor(e);
  return c ? COLORS[c].hex : '';
}
