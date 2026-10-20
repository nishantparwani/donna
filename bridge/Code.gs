/**
 * Donna — Google Calendar bridge v4.
 * Lets your agent read your calendars, change events you can edit, copy a calendar between accounts and email you
 * its briefings. Nothing else.
 * Only requests carrying TOKEN are accepted.
 *
 * Install or update (2 minutes; when updating, the URL stays the same):
 *   1. script.google.com → your bridge project → replace Code.gs with this file.
 *   2. Project Settings (⚙) → tick "Show appsscript.json" → replace appsscript.json with the one next to this file.
 *   3. Run → function "test" → allow access (once).
 *   4. Deploy → Manage deployments → ✏️ → Version: New version → Deploy.
 */
const TOKEN = 'CHANGE_ME_to_a_long_random_text';
const VERSION = 4;
const META = 'agentMeta';
const CAL = 'primary';
const MAX_EVENTS = 2500;
const MAX_OTHER_CALENDARS = 12;

function doGet() {
  return ContentService.createTextOutput('Donna bridge v' + VERSION + ' is running' + (fast() ? '.' : ' — but the Google Calendar API service is missing: add it under Services (+).'));
}

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return out({ error: 'bad request' }); }
  if (!req || req.token !== TOKEN) return out({ error: 'unauthorized' });
  if (!fast()) return out({ error: 'Add the "Google Calendar API" service to the bridge project (Services → +), then deploy a new version.' });
  try {
    switch (req.action) {
      case 'ping': return out({ ok: true, version: VERSION, timeZone: tz(), email: Session.getEffectiveUser().getEmail(), fast: true, calendars: calendars() });
      case 'list': return out({ timeZone: tz(), version: VERSION, events: list(req.from, req.to, req.others !== false, req.exclude || []) });
      case 'search': return out({ timeZone: tz(), events: search(req.q, req.from, req.to) });
      case 'batch': return out({ results: (req.ops || []).map(apply) });
      case 'email': return out(email(req));
      case 'export': return out(exportCal(req));
      case 'importRaw': return out({ results: (req.items || []).map(importOne) });
      case 'truncate': return out({ results: (req.items || []).map(it => truncateOne(req.calendarId, it)) });
      case 'freebusy': return out({ busy: freebusy(req.from, req.to, req.emails || []) });
      default: return out({ error: 'unknown action' });
    }
  } catch (err) {
    return out({ error: String(err && err.message || err) });
  }
}

function out(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
function fast() { return typeof Calendar !== 'undefined' && !!Calendar.Events; }
let _tz;
function tz() { return _tz || (_tz = CalendarApp.getDefaultCalendar().getTimeZone()); }
function fmt(d) { return Utilities.formatDate(d, tz(), "yyyy-MM-dd'T'HH:mm"); }
function parse(s) { return Utilities.parseDate(String(s).slice(0, 16), tz(), "yyyy-MM-dd'T'HH:mm"); }
function rfc(s) { return Utilities.formatDate(parse(s), tz(), "yyyy-MM-dd'T'HH:mm:ssXXX"); }
function addMinutes(s, m) { return fmt(new Date(parse(s).getTime() + m * 60000)); }
function metaOf(ev) {
  return JSON.stringify({ agent: !!ev.agent, kind: ev.kind, anchor: ev.anchor || null, flexible: !!ev.flexible, highStakes: !!ev.highStakes,
    protected: !!ev.protected, groupId: ev.groupId || '', taskId: ev.taskId || '', habitId: ev.habitId || '' });
}
const COLORS = { focus: '10', buffer: '8', task: '5', habit: '2' };

// ───────────── Reading ─────────────

function calendars() {
  const res = Calendar.CalendarList.list({ minAccessRole: 'freeBusyReader', fields: 'items(id,summary,summaryOverride,primary,selected,accessRole)' });
  return (res.items || []).map(c => ({ id: c.id, name: c.summaryOverride || c.summary, primary: !!c.primary, selected: !!c.selected, access: c.accessRole }));
}

const FIELDS = 'nextPageToken,items(id,status,eventType,summary,description,location,start,end,attendees(email,self,responseStatus,resource),organizer(self,email),extendedProperties,recurringEventId,hangoutLink,reminders,colorId,transparency)';

function listCal(calId, from, to, extra) {
  const items = [];
  let pageToken;
  do {
    const res = Calendar.Events.list(calId, Object.assign({
      timeMin: rfc(from), timeMax: rfc(to), singleEvents: true, orderBy: 'startTime', maxResults: 2500, pageToken: pageToken, fields: FIELDS,
    }, extra || {}));
    (res.items || []).forEach(e => items.push(e));
    pageToken = res.nextPageToken;
  } while (pageToken && items.length < MAX_EVENTS);
  return items.filter(e => e.status !== 'cancelled' && e.eventType !== 'workingLocation' && e.eventType !== 'birthday');
}

function list(from, to, others, exclude) {
  const events = listCal(CAL, from, to).map(e => fromApi(e, null));
  if (!others) return events;
  calendars().filter(c => !c.primary && c.selected && c.access !== 'freeBusyReader' && (exclude || []).indexOf(c.id) < 0 && !/#holiday@|#contacts@|addressbook#/.test(c.id)).slice(0, MAX_OTHER_CALENDARS).forEach(c => {
    try {
      listCal(c.id, from, to).filter(e => e.transparency !== 'transparent').forEach(e => events.push(fromApi(e, c)));
    } catch (err) { /* calendar not readable right now: skip it */ }
  });
  return events;
}

function search(q, from, to) {
  return listCal(CAL, from, to, { q: String(q || '').slice(0, 200) }).slice(0, 600).map(e => fromApi(e, null));
}

function apiTime(t) { return t.dateTime ? fmt(new Date(t.dateTime)) : t.date + 'T00:00'; }

function fromApi(e, cal) {
  const attendees = e.attendees || [];
  const self = attendees.filter(a => a.self)[0];
  let meta = {};
  try { meta = JSON.parse((e.extendedProperties && e.extendedProperties.private && e.extendedProperties.private[META]) || '{}'); } catch (x) { meta = {}; }
  const rem = e.reminders && !e.reminders.useDefault && e.reminders.overrides && e.reminders.overrides[0];
  return {
    id: cal ? cal.id + '|' + e.id : e.id,
    title: e.summary || '(busy)',
    start: apiTime(e.start), end: apiTime(e.end), allDay: !e.start.dateTime,
    description: cal ? '' : (e.description || '').slice(0, 1000),
    location: e.location || '',
    guests: attendees.filter(a => !a.self && !a.resource).map(a => a.email),
    organizer: cal ? false : (e.organizer ? !!e.organizer.self : true),
    myStatus: self && self.responseStatus === 'declined' ? 'declined' : 'accepted',
    recurringId: e.recurringEventId || '',
    meetLink: e.hangoutLink || '',
    reminder: rem ? rem.minutes : null,
    color: e.colorId || '',
    calendarId: cal ? cal.id : 'primary', calendarName: cal ? cal.name : '', readOnly: !!cal,
    meta: meta,
  };
}

function freebusy(from, to, emails) {
  if (!emails.length) return {};
  const res = Calendar.Freebusy.query({ timeMin: rfc(from), timeMax: rfc(to), items: emails.slice(0, 20).map(id => ({ id: id })) });
  const outp = {};
  Object.keys(res.calendars || {}).forEach(k => {
    const c = res.calendars[k];
    outp[k] = c.errors ? null : (c.busy || []).map(b => ({ start: fmt(new Date(b.start)), end: fmt(new Date(b.end)) }));
  });
  return outp;
}

// ───────────── Writing ─────────────

function gone(err) { return /not found|deleted|410|404|Resource has been deleted/i.test(String(err && err.message || err)); }

function body(e, withTimes) {
  const r = { summary: e.title, description: e.description || '', location: e.location || '',
    extendedProperties: { private: { agentMeta: metaOf(e) } } };
  if (withTimes) {
    r.start = { dateTime: rfc(e.start), timeZone: tz() };
    r.end = { dateTime: rfc(e.end), timeZone: tz() };
  }
  if (e.agent && COLORS[e.kind]) r.colorId = COLORS[e.kind];
  if (e.reminder !== null && e.reminder !== undefined && e.reminder !== '') r.reminders = { useDefault: false, overrides: [{ method: 'popup', minutes: Number(e.reminder) }] };
  return r;
}

let CUR = CAL;
function apply(op) {
  CUR = op.calendarId || CAL;
  const key = op.id;
  if (String(op.id).indexOf('|') > 0) { CUR = String(op.id).split('|')[0]; op = Object.assign({}, op, { id: String(op.id).slice(CUR.length + 1) }); }
  const r = applyHere(op);
  r.id = key;
  return r;
}
function applyHere(op) {
  try {
    if (op.op === 'create') return create(op);
    let cur;
    try { cur = Calendar.Events.get(CUR, op.id); } catch (err) {
      if (op.op === 'delete' && gone(err)) return { id: op.id, gone: true };
      throw err;
    }
    if (!cur || cur.status === 'cancelled') return op.op === 'delete' ? { id: op.id, gone: true } : { id: op.id, error: 'event not found in Google Calendar' };
    const seriesId = op.scope === 'series' && cur.recurringEventId ? cur.recurringEventId : null;
    if (op.op === 'delete') return del(op, cur, seriesId);
    if (op.op === 'update') return update(op, cur, seriesId);
    return { id: op.id, error: 'unknown op' };
  } catch (err) {
    return { id: op.id, error: String(err && err.message || err) };
  }
}

function create(op) {
  const e = op.ev;
  const r = body(e, true);
  const guests = (e.guests || []).filter(g => /@/.test(g));
  if (guests.length) r.attendees = guests.map(g => ({ email: g }));
  if (op.recurrence) r.recurrence = [].concat(op.recurrence);
  let opts = { sendUpdates: guests.length ? 'all' : 'none' };
  if (e.meet) {
    r.conferenceData = { createRequest: { requestId: Utilities.getUuid(), conferenceSolutionKey: { type: 'hangoutsMeet' } } };
    opts.conferenceDataVersion = 1;
  }
  const made = Calendar.Events.insert(r, CUR, opts);
  let newId = made.id;
  if (op.recurrence) {
    // Report the first instance's id so the agent's records point at a real event.
    try {
      const first = Calendar.Events.instances(CUR, made.id, { maxResults: 1, fields: 'items(id)' });
      if (first.items && first.items[0]) newId = first.items[0].id;
    } catch (err) { /* keep the series id */ }
  }
  return { id: op.id, newId: newId, seriesId: op.recurrence ? made.id : '', meetLink: made.hangoutLink || '' };
}

function del(op, cur, seriesId) {
  const owner = cur.organizer ? !!cur.organizer.self : true;
  const others = (cur.attendees || []).filter(a => !a.self).length;
  const target = seriesId || op.id;
  // op.quiet: a calendar move tidying up the old copy: always remove, never decline, never email anyone.
  if (owner || op.quiet) {
    try { Calendar.Events.remove(CUR, target, { sendUpdates: others && !op.quiet ? 'all' : 'none' }); }
    catch (err) { if (!gone(err)) throw err; }
  } else {
    decline(seriesId ? Calendar.Events.get(CUR, seriesId) : cur, target);
  }
  return { id: op.id, series: !!seriesId };
}

function update(op, cur, seriesId) {
  const e = op.ev;
  const owner = cur.organizer ? !!cur.organizer.self : true;
  const others = (cur.attendees || []).filter(a => !a.self).length;
  const now = fromApi(cur, null);
  const patch = {};
  let notify = false;
  const target = seriesId || op.id;
  const base = seriesId ? Calendar.Events.get(CUR, seriesId) : cur;
  if (owner) {
    if (!now.allDay && (e.start !== now.start || e.end !== now.end)) {
      if (seriesId) {
        // Shift the whole series by the same amount as this instance moved.
        const ds = (parse(e.start) - parse(now.start)) / 60000, de = (parse(e.end) - parse(now.end)) / 60000;
        const ms = apiTime(base.start), me = apiTime(base.end);
        patch.start = { dateTime: rfc(addMinutes(ms, ds)), timeZone: tz() };
        patch.end = { dateTime: rfc(addMinutes(me, de)), timeZone: tz() };
      } else {
        patch.start = { dateTime: rfc(e.start), timeZone: tz() };
        patch.end = { dateTime: rfc(e.end), timeZone: tz() };
      }
      notify = true;
    }
    if (e.title !== now.title) patch.summary = e.title;
    if ((e.description || '') !== now.description) patch.description = e.description || '';
    if ((e.location || '') !== now.location) patch.location = e.location || '';
    const want = (e.guests || []).filter(g => /@/.test(g));
    if (want.slice().sort().join() !== now.guests.slice().sort().join()) {
      const keep = (base.attendees || []).filter(a => a.self || a.resource || want.indexOf(a.email) >= 0);
      want.filter(g => !keep.some(a => a.email === g)).forEach(g => keep.push({ email: g }));
      patch.attendees = keep;
      notify = true;
    }
    if (e.reminder !== now.reminder && e.reminder !== undefined) {
      patch.reminders = e.reminder === null || e.reminder === '' ? { useDefault: true } : { useDefault: false, overrides: [{ method: 'popup', minutes: Number(e.reminder) }] };
    }
    patch.extendedProperties = { private: { agentMeta: metaOf(e) } };
  }
  if (e.myStatus !== now.myStatus) {
    if (e.myStatus === 'declined') decline(base, target);
    else patch.attendees = (patch.attendees || base.attendees || []).map(a => a.self ? Object.assign({}, a, { responseStatus: 'accepted' }) : a);
  }
  let opts = { sendUpdates: notify && others ? 'all' : 'none' };
  if (owner && e.meet && !cur.hangoutLink) {
    patch.conferenceData = { createRequest: { requestId: Utilities.getUuid(), conferenceSolutionKey: { type: 'hangoutsMeet' } } };
    opts.conferenceDataVersion = 1;
  }
  let res = null;
  if (Object.keys(patch).length) res = Calendar.Events.patch(patch, CUR, target, opts);
  return { id: op.id, newId: op.id, series: !!seriesId, meetLink: res && res.hangoutLink || '' };
}

function decline(cur, id) {
  const attendees = (cur.attendees || []).map(a => a.self ? Object.assign({}, a, { responseStatus: 'declined' }) : a);
  Calendar.Events.patch({ attendees: attendees }, CUR, id, { sendUpdates: 'all' });
}

// ───────────── Moving a calendar between accounts ─────────────

const EXPORT_FIELDS = 'nextPageToken,items(id,status,eventType,summary,description,location,start,end,recurrence,recurringEventId,originalStartTime,attendees(email,self,responseStatus,resource),organizer(self,email),extendedProperties,hangoutLink,reminders,colorId,transparency,visibility)';

/** Everything in a calendar that still has an occurrence after `from`: series (with their first occurrence after it), singles and exceptions. */
function exportCal(req) {
  const calId = req.calendarId || CAL;
  const items = [];
  let pageToken;
  do {
    const res = Calendar.Events.list(calId, { timeMin: rfc(req.from), timeMax: rfc(req.to), singleEvents: false, showDeleted: true, maxResults: 2500, pageToken: pageToken, fields: EXPORT_FIELDS });
    (res.items || []).forEach(e => items.push(e));
    pageToken = res.nextPageToken;
  } while (pageToken && items.length < 5000);
  const outItems = [];
  items.forEach(e => {
    if (e.eventType === 'workingLocation' || e.eventType === 'birthday') return;
    if (e.recurrence && e.status !== 'cancelled') {
      const first = Calendar.Events.instances(calId, e.id, { timeMin: rfc(req.from), maxResults: 1, fields: 'items(start,end)' });
      if (!first.items || !first.items.length) return;
      e.firstStart = first.items[0].start;
      e.firstEnd = first.items[0].end;
      if (e.recurrence.some(r => /COUNT=/.test(r))) {
        let n = 0, tok;
        do {
          const ins = Calendar.Events.instances(calId, e.id, { timeMin: rfc(req.from), maxResults: 2500, pageToken: tok, fields: 'nextPageToken,items(id)' });
          n += (ins.items || []).length;
          tok = ins.nextPageToken;
        } while (tok && n < 5000);
        e.remaining = n;
      }
    }
    outItems.push(e);
  });
  return { timeZone: tz(), calendarId: calId, items: outItems };
}

/** Inserts a ready-made event into the primary calendar without emailing anyone. */
function importOne(it) {
  try {
    const made = Calendar.Events.insert(it.resource, CAL, { sendUpdates: 'none' });
    return { key: it.key, id: made.id };
  } catch (err) {
    return { key: it.key, error: String(err && err.message || err) };
  }
}

/** Ends a series just before `until` (local time); a series that starts after it is deleted. */
function truncateOne(calId, it) {
  try {
    const cur = Calendar.Events.get(calId || CAL, it.id);
    if (!cur || cur.status === 'cancelled') return { id: it.id, gone: true };
    const cutoff = parse(it.until);
    const start = new Date(cur.start.dateTime || cur.start.date + 'T00:00:00');
    if (start >= cutoff) { Calendar.Events.remove(calId || CAL, it.id, { sendUpdates: 'none' }); return { id: it.id, deleted: true }; }
    const untilUtc = Utilities.formatDate(new Date(cutoff.getTime() - 1000), 'UTC', "yyyyMMdd'T'HHmmss'Z'");
    const rec = (cur.recurrence || []).map(r => /^RRULE:/.test(r) ? r.replace(/;(UNTIL|COUNT)=[^;]*/g, '') + ';UNTIL=' + untilUtc : r);
    Calendar.Events.patch({ recurrence: rec }, calId || CAL, it.id, { sendUpdates: 'none' });
    return { id: it.id, truncated: true };
  } catch (err) {
    return { id: it.id, error: String(err && err.message || err) };
  }
}

// ───────────── Email (to you only) ─────────────

function email(req) {
  const to = Session.getEffectiveUser().getEmail();
  MailApp.sendEmail({ to: to, subject: String(req.subject || 'Donna').slice(0, 200), htmlBody: String(req.html || ''), name: String(req.from || 'Donna') });
  return { ok: true, to: to, remaining: MailApp.getRemainingDailyQuota() };
}

/** Run once from the editor to grant permission and check speed. */
function test() {
  const t = Date.now();
  const n = list(fmt(new Date()), fmt(new Date(Date.now() + 7 * 864e5)), true).length;
  Logger.log('Bridge v' + VERSION + (fast() ? ' (Calendar API ok)' : ' — ADD THE GOOGLE CALENDAR API SERVICE') + ' · ' + n + ' events this week across ' + calendars().length + ' calendars · ' + (Date.now() - t) + ' ms · ' + tz());
}
