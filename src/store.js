// Persistence with a pluggable backend:
//   • laptop:     JSON files (src/node-store.js), loaded once, written immediately
//   • Cloudflare: one D1 table (worker.js), loaded per request, written at the end
// Code everywhere else calls load()/save() synchronously.
import { colorId } from './colors.js';

const NAMES = ['calendar', 'actions', 'memory', 'chat', 'settings', 'state', 'tasks', 'habits', 'people', 'bookings', 'move', 'push', 'goals', 'reminders'];
const DEFAULTS = {
  calendar: { seq: 0, events: [] },
  actions: { counter: 100, items: [] },
  memory: { rules: [], approved: [], lessons: [], adjustments: [], profile: {}, seq: 0 },
  chat: { messages: [] },
  settings: {},
  state: {},
  tasks: { seq: 0, items: [] },
  habits: { seq: 0, items: [] },
  people: { seq: 0, items: [] },
  bookings: { items: [] },
  move: { resources: [], backup: null },
  push: { subscriptions: [] },
  goals: { seq: 0, items: [] },
  reminders: { seq: 0, items: [] },
};
// Big, rarely needed collections are not read on every request; call loadLazy(name) first.
const LAZY = ['move'];
// Every request parses these, so they stay small (the Worker has a 10 ms CPU budget).
const LIMITS = { actions: ['items', 350], chat: ['messages', 160], bookings: ['items', 300] };

export const DEFAULT_BOOKING = {
  enabled: false, slug: '', title: '', intro: '', durations: [30], daysAhead: 14, minNoticeHours: 12,
  start: '10:00', end: '17:00', days: [1, 2, 3, 4, 5], maxPerDay: 3, bufferMinutes: 10,
};

export const DEFAULT_SETTINGS = {
  agentName: 'Donna',
  userName: '',
  userEmail: '',
  timeZone: '',
  // AI providers (tried in order; any that is out of quota is skipped automatically)
  // Gemini answers in ~1–2 s and plans best; Workers AI (no key) is the always-there fallback.
  aiOrder: ['workers-ai', 'gemini', 'groq', 'cerebras', 'openrouter', 'mistral'],
  workersAiModel: '@cf/openai/gpt-oss-120b',
  geminiApiKey: '', geminiModel: 'gemini-flash-lite-latest',
  groqApiKey: '', groqModel: 'openai/gpt-oss-120b',
  cerebrasApiKey: '', cerebrasModel: 'gpt-oss-120b',
  openrouterApiKey: '', openrouterModel: 'openai/gpt-oss-120b:free',
  mistralApiKey: '', mistralModel: 'mistral-small-latest',
  // Private AI (off by default, your choice): when on, calendar text never goes to free tiers that may train on it
  // (Gemini's free tier, OpenRouter's free models). Off = every key you add is used, Gemini included.
  privateAi: false,
  // Meeting hours: where the agent puts meetings on its own
  workStart: '09:00', workEnd: '18:00', workDays: [1, 2, 3, 4, 5],
  // Waking hours: tasks, habits and personal plans may go anywhere inside them (dayStart = wake-up, dayEnd = wind-down)
  dayStart: '07:00', dayEnd: '23:00',
  // Day planning: longest single focus block, break between blocks
  focusSpan: 90, breakMinutes: 10,
  // Night owl: before this time, "tomorrow" still means the day you wake up into ('' = off)
  nightOwl: '04:00',
  // When certain activities may happen, e.g. [{ match: 'run, jog', windows: '06:00-08:00, 17:00-21:00' }]
  activityWindows: [],
  // Where in-person classes happen; trips away from it are checked against classes
  homeCity: '',
  bufferMinutes: 15,
  highStakesKeywords: 'exam, interview, viva, presentation, board, investor, client, pitch, demo',
  protectedKeywords: 'lecture, lab, class, tutorial, exam, family, doctor, dentist, gym, pickup, personal, flight',
  planDaysAhead: 3,
  autonomous: true,
  meetDefault: true,
  defaultReminder: 10,
  morningBriefing: '07:30',
  eveningReview: '21:30',
  emailBriefing: false,
  calendarMode: 'local',  // 'local' | 'google'
  bridgeUrl: '',
  bridgeToken: '',
  ignoreCalendars: [],
  siriKey: '',
  notify: { briefings: true, changes: true, bookings: true },
  booking: DEFAULT_BOOKING,
  // Colours = priorities, highest first (Google colour ids; empty = red, orange, yellow, green, light green, blue,
  // dark blue, purple, lavender, pink, grey). priorityCancel: a higher-priority booking cancels lower-priority overlaps.
  colorPriority: [],
  priorityCancel: true,
  // Today's ticker alternates your reminders with these lines (one per line; empty = the built-in set).
  affirmations: '',
  // Every open reminder also shows as one event, Monday 09:00–10:00, so any calendar app (iPhone too) has the list.
  reminderEvent: true,
};
const SECRET_KEYS = ['geminiApiKey', 'groqApiKey', 'cerebrasApiKey', 'openrouterApiKey', 'mistralApiKey', 'bridgeToken', 'siriKey'];
// Secrets of features that no longer exist: dropped from the vault the next time it is written.
const RETIRED_SECRETS = ['whatsappToken', 'whatsappAppSecret'];
const NUM_KEYS = ['bufferMinutes', 'planDaysAhead', 'defaultReminder', 'focusSpan', 'breakMinutes'];
const TIME_KEYS = ['workStart', 'workEnd', 'dayStart', 'dayEnd'];

let cache = {};
const dirty = new Set();
const transient = new Set(); // collections never persisted (e.g. calendar pulled from Google)
// Default backend keeps everything in memory (used until a real one is installed).
let backend = { immediate: true, readAll: async () => ({}), writeSync() {}, write: async () => {} };

export function useBackend(b) { backend = b; cache = {}; vault = null; dirty.clear(); transient.clear(); }
export function setTransient(name, on) { on ? transient.add(name) : transient.delete(name); }

const parseRaw = (raw, name) => {
  let v = {};
  try { v = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {}; } catch { v = {}; }
  return Object.assign(structuredClone(DEFAULTS[name]), v);
};

/** Loads all collections from the backend (Cloudflare: every request; laptop: once). */
export async function hydrate() {
  if (backend.immediate && Object.keys(cache).length) return;
  const raw = await backend.readAll(LAZY);
  const fresh = {};
  for (const n of NAMES) {
    if (LAZY.includes(n)) { if (backend.immediate && raw[n] !== undefined) fresh[n] = parseRaw(raw[n], n); continue; }
    fresh[n] = transient.has(n) && cache[n] ? cache[n] : parseRaw(raw[n], n);
  }
  cache = fresh;
  dirty.clear();
  // Keys and tokens live encrypted in their own row (never in the data rows, exports or backups).
  if (backend.readVault) {
    vault = { values: await backend.readVault(raw.vault), dirty: false };
    const st = cache.settings;
    let moved = false;
    for (const k of SECRET_KEYS) if (k in st) { if (st[k] && !vault.values[k]) vault.values[k] = st[k]; delete st[k]; moved = true; }
    if (moved) { vault.dirty = true; dirty.add('settings'); }
    for (const k of RETIRED_SECRETS) if (k in vault.values) { delete vault.values[k]; vault.dirty = true; }
  } else vault = null;
}
/** Secrets kept apart from the data (Cloudflare: encrypted row). null = the backend keeps them in settings (laptop). */
let vault = null;

/** Re-reads one collection from the backend (e.g. local calendar after leaving Google mode). */
export async function reload(name) { cache[name] = parseRaw((await backend.readAll())[name], name); }

export async function loadLazy(name) {
  if (cache[name]) return cache[name];
  const raw = backend.readOne ? await backend.readOne(name) : (await backend.readAll())[name];
  cache[name] = parseRaw(raw, name);
  return cache[name];
}

export function load(name) {
  if (!cache[name]) cache[name] = structuredClone(DEFAULTS[name]);
  return cache[name];
}

export function save(name) {
  if (transient.has(name)) return;
  const lim = LIMITS[name];
  if (lim && cache[name][lim[0]].length > lim[1]) cache[name][lim[0]] = cache[name][lim[0]].slice(-lim[1]);
  if (backend.immediate) backend.writeSync(name, JSON.stringify(cache[name], null, 1));
  else dirty.add(name);
}

/** Daily copy of every data row inside the database (Cloudflare), keeping `keep` days. Secrets are never copied. */
export async function snapshot(day, keep) { return backend.snapshot ? backend.snapshot(day, keep) : false; }
/** Everything needed to rebuild Donna's memory, without secrets (for "Download a backup"). */
export async function exportData() {
  const out = {};
  // "move" (a calendar move in progress) and push keys hold tokens: left out.
  for (const n of NAMES) if (n !== 'move') out[n] = load(n);
  const s = { ...out.settings };
  for (const k of SECRET_KEYS) delete s[k];
  const st = { ...out.state };
  delete st.move;
  return { ...out, settings: s, state: st, push: { devices: (out.push.subscriptions || []).length } };
}

/** Runs fn as the only writer across every server instance (Cloudflare: a Durable Object lease). */
export function withWriteLock(fn) { return backend.lock ? backend.lock(fn) : fn(); }
/** A read-only request: drop whatever it changed in memory instead of writing it (it could overwrite a writer). */
export function discard() { dirty.clear(); if (vault) vault.dirty = false; }

export async function flush() {
  const rows = [...dirty].map(n => [n, JSON.stringify(cache[n])]);
  const secrets = vault && vault.dirty ? vault.values : null;
  if (!rows.length && !secrets) return;
  if (backend.writeMany) {
    // One transaction: a request's rows (the action log, tasks, chat, state…) are saved together or not at all,
    // so a Worker that dies mid-save can't leave a change logged without its task, or keys out of the vault but not in it.
    await backend.writeMany(rows, secrets);
  } else {
    // The vault first: settings may have just had its plaintext keys removed.
    if (secrets) await backend.writeVault(secrets);
    for (const [n, text] of rows) await backend.write(n, text);
  }
  if (vault) vault.dirty = false;
  dirty.clear();
}

/** Raw rows outside the collections (e.g. the saved Google calendar copy). Never part of hydrate(). */
export async function readRow(name) {
  return backend.readOne ? backend.readOne(name) : (await backend.readAll())[name];
}
/**
 * Writes a raw row. With guard = { field, below }, the write only happens if the stored row's
 * JSON field is missing or smaller than below (so a slow background read never overwrites newer data).
 */
export async function writeRow(name, text, guard) {
  if (backend.writeRow) return backend.writeRow(name, text, guard);
  if (guard) {
    let cur = null;
    try { cur = JSON.parse(await readRow(name) || 'null'); } catch { cur = null; }
    if (cur && Number(cur[guard.field] || 0) >= guard.below) return false;
  }
  if (backend.immediate) backend.writeSync(name, text); else await backend.write(name, text);
  return true;
}

export function settings() {
  const raw = load('settings');
  const s = { ...DEFAULT_SETTINGS, ...raw, ...(vault ? vault.values : {}), booking: { ...DEFAULT_BOOKING, ...(raw.booking || {}) } };
  const env = typeof process !== 'undefined' && process.env ? process.env : {};
  if (!s.geminiApiKey && env.GEMINI_API_KEY) s.geminiApiKey = env.GEMINI_API_KEY;
  return s;
}

const cleanDays = v => (Array.isArray(v) ? v : String(v).split(',')).map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6);

export function saveSettings(patch) {
  const s = load('settings');
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (!(k in patch)) continue;
    let v = patch[k];
    if (SECRET_KEYS.includes(k)) {
      if (!(v === null || v === '__clear__') && (!String(v).trim() || String(v).startsWith('••'))) continue; // blank / masked = keep
      const val = v === null || v === '__clear__' ? '' : String(v).trim();
      if (vault) { vault.values[k] = val; vault.dirty = true; } else s[k] = val;
      continue;
    }
    if (NUM_KEYS.includes(k)) v = Math.max(0, Math.min(1440, Number(v) || 0));
    if (k === 'workDays') v = cleanDays(v);
    if (TIME_KEYS.includes(k) && !/^\d{1,2}:\d{2}$/.test(v)) throw new Error(`${k} must look like 09:00`);
    if ((k === 'morningBriefing' || k === 'eveningReview') && v && !/^\d{1,2}:\d{2}$/.test(v)) throw new Error(`${k} must look like 07:30 (or empty to turn it off)`);
    if (['autonomous', 'meetDefault', 'emailBriefing', 'privateAi', 'priorityCancel', 'reminderEvent'].includes(k)) v = v === true || v === 'true';
    if (k === 'colorPriority') v = [...new Set((Array.isArray(v) ? v : String(v || '').split(',')).map(x => colorId(x)).filter(Boolean))];
    if (k === 'calendarMode' && !['local', 'google'].includes(v)) continue;
    if (k === 'nightOwl' && v && !/^\d{1,2}:\d{2}$/.test(v)) throw new Error('nightOwl must look like 04:00 (or empty to turn it off)');
    if (k === 'focusSpan') v = Math.max(25, Math.min(240, v || 90));
    if (k === 'activityWindows') {
      // Rows like { match: 'run, jog', windows: '06:00-08:00, 17:00-21:00' }, or text lines "run, jog: 06:00-08:00, 17:00-21:00".
      const rows = Array.isArray(v) ? v : String(v || '').split('\n').map(line => { const i = line.indexOf(':'); return i > 0 && !/^\s*\d/.test(line) ? { match: line.slice(0, i), windows: line.slice(i + 1) } : null; });
      v = rows.filter(r => r && String(r.match || '').trim() && /\d{1,2}:\d{2}\s*(?:-|–|to)\s*\d{1,2}:\d{2}/.test(r.windows || ''))
        .map(r => ({ match: String(r.match).trim().slice(0, 120), windows: String(r.windows).trim().slice(0, 120) })).slice(0, 30);
    }
    if (k === 'notify') v = { briefings: true, changes: true, bookings: true, ...(s.notify || {}), ...Object.fromEntries(Object.entries(v || {}).map(([a, b]) => [a, b === true || b === 'true'])) };
    if (k === 'ignoreCalendars') v = (Array.isArray(v) ? v : String(v).split(',')).map(x => String(x).trim()).filter(Boolean);
    if (k === 'aiOrder') v = (Array.isArray(v) ? v : String(v).split(',')).map(x => String(x).trim()).filter(Boolean);
    if (k === 'booking') {
      const b = { ...DEFAULT_BOOKING, ...(s.booking || {}), ...(v || {}) };
      b.enabled = b.enabled === true || b.enabled === 'true';
      b.durations = (Array.isArray(b.durations) ? b.durations : String(b.durations).split(',')).map(Number).filter(n => n >= 10 && n <= 240);
      if (!b.durations.length) b.durations = [30];
      b.days = cleanDays(b.days);
      for (const n of ['daysAhead', 'minNoticeHours', 'maxPerDay', 'bufferMinutes']) b[n] = Math.max(0, Math.min(365, Number(b[n]) || 0));
      if (!/^\d{1,2}:\d{2}$/.test(b.start) || !/^\d{1,2}:\d{2}$/.test(b.end)) throw new Error('Booking hours must look like 10:00');
      b.slug = String(b.slug || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
      v = b;
    }
    s[k] = typeof v === 'string' ? v.trim() : v;
  }
  save('settings');
  return settings();
}

export const isSecretKey = k => SECRET_KEYS.includes(k);
export const SECRETS = SECRET_KEYS;
