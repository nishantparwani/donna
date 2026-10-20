// Calendar backend used by the engine (synchronous, in memory).
//   • local mode:  events live in the app's own store; recurring series are stored expanded
//   • google mode: events are pulled from Google at the start of each run (src/sync.js);
//                  every change is also queued as an op and pushed to Google at the end.
import { load, save, setTransient } from './store.js';
import * as T from './time.js';

const FIELDS = {
  title: '', start: '', end: '', allDay: false, description: '', location: '', guests: [],
  organizer: true, kind: 'meeting', agent: false, flexible: false, highStakes: false,
  protected: false, myStatus: 'accepted', anchor: null,
  calendarId: 'primary', calendarName: '', readOnly: false,
  recurringId: '', recurrence: '', groupId: '', meet: false, meetLink: '', reminder: null, color: '',
  taskId: '', habitId: '',
};
const clone = e => e && structuredClone(e);

let remote = false;
let ops = [];
let tmpSeq = 0;
const persist = () => { if (!remote) save('calendar'); };

export const isRemote = () => remote;
export const withDefaults = e => ({ ...structuredClone(FIELDS), ...e });
/** The event without fields that hold their default value (for storage: about half the size). */
export function compact(e) {
  if (!e) return e;
  const out = {};
  for (const [k, v] of Object.entries(e)) {
    const d = FIELDS[k];
    if (d !== undefined && (v === d || (Array.isArray(v) && !v.length && Array.isArray(d)) || (v === null && d === null) || (v === undefined))) continue;
    out[k] = v;
  }
  return out;
}

/** Switches to google mode with a fresh set of events. */
export function setRemoteEvents(events) {
  remote = true;
  setTransient('calendar', true);
  load('calendar').events = events.map(withDefaults);
  ops = [];
}
/** Adds newly fetched Google events (widening the loaded range) without touching queued changes. */
export function mergeRemoteEvents(events) {
  const c = load('calendar');
  const have = new Set(c.events.map(e => e.id));
  for (const e of events) if (!have.has(e.id)) c.events.push(withDefaults(e));
}
export function useLocal() {
  if (!remote) return;
  remote = false;
  setTransient('calendar', false);
  ops = [];
}

export function all() { return load('calendar').events; }

/** Events overlapping [from, to), sorted by start. */
export function list(from, to) {
  return all().filter(e => e.start < to && e.end > from).sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end)).map(clone);
}

export function get(id) { return clone(all().find(e => e.id === id)); }

/** All loaded events of one recurring series (or one agent group). */
export function series(ev) {
  if (ev.recurringId) return all().filter(e => e.recurringId === ev.recurringId).map(clone);
  if (ev.groupId) return all().filter(e => e.groupId === ev.groupId).map(clone);
  return [clone(ev)];
}

export function create(fields, { recurrence = null } = {}) {
  const c = load('calendar');
  const id = remote ? `tmp${++tmpSeq}_${Date.now().toString(36)}` : 'e' + (++c.seq);
  const ev = { ...withDefaults(fields), id };
  ev.start = T.norm(ev.start);
  ev.end = T.norm(ev.end);
  c.events.push(ev);
  if (remote) ops.push({ op: 'create', id, recurrence }); else persist();
  return clone(ev);
}

export function update(id, patch, { scope = 'this' } = {}) {
  const ev = all().find(e => e.id === id);
  if (!ev) throw new Error(`No event ${id}.`);
  Object.assign(ev, patch);
  if (patch.start) ev.start = T.norm(ev.start);
  if (patch.end) ev.end = T.norm(ev.end);
  // scope 'local': mirror a change Google makes by itself (other instances of a moved series).
  if (remote) { if (scope !== 'local') ops.push({ op: 'update', id, scope }); } else persist();
  return clone(ev);
}

/** Google mode: deletes an event (or its whole series) by id even if it is not loaded right now. */
export function queueDelete(id, scope = 'this') {
  if (remote) ops.push({ op: 'delete', id, scope });
  else remove(id);
}

export function remove(id, { scope = 'this' } = {}) {
  const c = load('calendar');
  const i = c.events.findIndex(e => e.id === id);
  if (i < 0) return null;
  const [ev] = c.events.splice(i, 1);
  if (remote) ops.push({ op: 'delete', id, scope, recurringId: ev.recurringId || '' }); else persist();
  return ev;
}

/** Removes loaded instances of a series from memory only (Google deletes the rest itself). */
export function dropLocal(pred) {
  const c = load('calendar');
  c.events = c.events.filter(e => !pred(e));
  if (!remote) persist();
}

/** Puts a deleted event back (same id locally; Google gives it a new id, remapped after push). */
export function restore(snapshot) {
  const c = load('calendar');
  if (!c.events.some(e => e.id === snapshot.id)) {
    const ev = withDefaults(structuredClone(snapshot));
    if (remote) { ev.recurringId = ''; ev.recurrence = ''; } // a restored instance comes back as a single event
    c.events.push(ev);
    if (remote) ops.push({ op: 'create', id: snapshot.id }); else persist();
  }
  return clone(snapshot);
}

export function replaceAll(events) {
  if (remote) throw new Error('Not available while connected to Google Calendar.');
  const c = load('calendar');
  c.events = [];
  c.seq = 0;
  events.forEach(e => c.events.push({ ...withDefaults(e), id: 'e' + (++c.seq) }));
  persist();
}

/**
 * Collapses the queued ops into the minimal set to send to Google:
 * one entry per event: create / update (with the final event) / delete.
 */
export function takeOps() {
  const state = new Map(); // id → { s: 'create'|'update'|'delete'|'noop', scope, recurrence, recurringId }
  for (const o of ops) {
    const cur = state.get(o.id) || { s: '', scope: 'this' };
    if (o.op === 'create') cur.s = cur.s === 'delete' ? 'update' : 'create';
    else if (o.op === 'update') cur.s = cur.s === 'create' ? 'create' : (cur.s === 'delete' ? 'delete' : 'update');
    else if (o.op === 'delete') cur.s = cur.s === 'create' && String(o.id).startsWith('tmp') ? 'noop' : 'delete';
    if (o.scope === 'series') cur.scope = 'series';
    if (o.recurrence) cur.recurrence = o.recurrence;
    if (o.recurringId) cur.recurringId = o.recurringId;
    state.set(o.id, cur);
  }
  ops = [];
  const out = [];
  for (const [id, x] of state) {
    if (x.s === 'noop') continue;
    if (x.s === 'delete') { out.push({ op: 'delete', id, scope: x.scope, recurringId: x.recurringId || '' }); continue; }
    const ev = get(id);
    if (ev) out.push({ op: x.s, id, ev, scope: x.scope, recurrence: x.recurrence || null });
  }
  return out;
}
export const pendingOps = () => ops.length;

/** Applies Google's new ids (for created / recurring-moved events) everywhere. */
export function remapIds(map) {
  const pairs = Object.entries(map).filter(([a, b]) => b && a !== b);
  if (!pairs.length) return;
  for (const e of all()) {
    if (map[e.id]) e.id = map[e.id];
    if (e.anchor && map[e.anchor.id]) e.anchor.id = map[e.anchor.id];
  }
  for (const [name, key] of [['actions', 'items'], ['tasks', 'items'], ['bookings', 'items']]) {
    const col = load(name);
    let text = JSON.stringify(col[key]);
    for (const [a, b] of pairs) text = text.split(JSON.stringify(a)).join(JSON.stringify(b));
    col[key] = JSON.parse(text);
    save(name);
  }
}
