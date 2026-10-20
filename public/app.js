// Donna UI (no framework). Views: today, calendar, tasks, habits, insights, activity, memory, settings.
'use strict';
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CATS = { classes: 'Classes', study: 'Study', meetings: 'Meetings', personal: 'Personal', tasks: 'Task sessions', habits: 'Habits', focus: 'Focus', other: 'Other' };
const ICON = {
  clock: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  people: '<svg class="i" viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/></svg>',
  pin: '<svg class="i" viewBox="0 0 24 24"><path d="M12 21s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="9" r="2.5"/></svg>',
  video: '<svg class="i" viewBox="0 0 24 24"><rect x="3" y="6" width="13" height="12" rx="2.5"/><path d="M16 10.5l5-3v9l-5-3"/></svg>',
  note: '<svg class="i" viewBox="0 0 24 24"><path d="M5 4h14v16H5zM9 9h6M9 13h6M9 17h3"/></svg>',
  cal: '<svg class="i" viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="16" rx="3"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/></svg>',
  repeat: '<svg class="i" viewBox="0 0 24 24"><path d="M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3"/></svg>',
  plus: '<svg class="i" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  left: '<svg class="i" viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>',
  right: '<svg class="i" viewBox="0 0 24 24"><path d="M9 18l6-6-6-6"/></svg>',
  chat: '<svg class="i" viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-5.4A8 8 0 1 1 21 12z"/></svg>',
  check: '<svg class="i" viewBox="0 0 24 24" style="width:13px;height:13px"><path d="M5 12l5 5 9-10"/></svg>',
  warn: '<svg class="i" viewBox="0 0 24 24"><path d="M12 3l10 18H2L12 3zM12 10v4M12 17.5v.5"/></svg>',
  spark: '<svg class="i" viewBox="0 0 24 24"><path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/></svg>',
  play: '<svg class="i" viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z"/></svg>',
  copy: '<svg class="i" viewBox="0 0 24 24"><rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>',
};

// ─── Utilities ───
async function api(path, data, raw, { timeout = 30000 } = {}) {
  const opts = data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': raw ? 'text/calendar' : 'application/json' }, body: raw ? data : JSON.stringify(data) };
  // Never hang: a request that takes longer than this is given up with a clear message.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  let res;
  try { res = await fetch(path, { ...opts, signal: ctl.signal }); }
  catch (e) {
    throw new Error(e.name === 'AbortError' ? 'That took too long. Your connection or Google may be slow right now; try again in a moment.'
      : navigator.onLine === false ? "You're offline. Showing what was last loaded." : "Couldn't reach Donna. Check your connection.");
  } finally { clearTimeout(timer); }
  if (res.status === 401) { location.href = '/login.html'; throw new Error('Please sign in'); }
  let out = {};
  try { out = await res.json(); } catch { /* not json */ }
  if (!res.ok) throw new Error(out.error || res.statusText);
  return out;
}
function toast(text, { action, onAction, ms = 3200 } = {}) {
  const el = $('toast');
  el.innerHTML = `<span>${esc(text)}</span>${action ? `<button>${esc(action)}</button>` : ''}`;
  if (action) el.querySelector('button').onclick = () => { el.classList.remove('on'); onAction(); };
  el.classList.add('on');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('on'), action ? Math.max(ms, 6000) : ms);
}
const p2 = n => String(n).padStart(2, '0');
const ymd = x => `${x.getFullYear()}-${p2(x.getMonth() + 1)}-${p2(x.getDate())}`;
const addDays = (d, n) => { const x = new Date(d + 'T12:00'); x.setDate(x.getDate() + n); return ymd(x); };
const dow = d => new Date(d + 'T12:00').getDay();
const weekStart = d => addDays(d, dow(d) === 0 ? -6 : 1 - dow(d));
const mins = s => +s.slice(11, 13) * 60 + +s.slice(14, 16);
const hm = s => { const [h, m] = String(s || '0:0').split(':').map(Number); return h * 60 + (m || 0); };
const hhmm = m => `${p2(Math.floor(m / 60))}:${p2(m % 60)}`;
const clock = s => s.slice(11, 16);
const dayLabel = (d, long) => { const x = new Date(d + 'T12:00'); return `${(long ? DAYS_LONG : DAYS)[x.getDay()]} ${x.getDate()} ${MONTHS[x.getMonth()]}`; };
const diff = (a, b) => (new Date(b) - new Date(a)) / 60000;
const addMin = (s, n) => { const x = new Date(s); x.setMinutes(x.getMinutes() + n); return `${ymd(x)}T${p2(x.getHours())}:${p2(x.getMinutes())}`; };
const dur = m => m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ' ' + (m % 60) + 'm' : ''}` : `${m}m`;
const relDay = (d, today) => d === today ? 'Today' : d === addDays(today, 1) ? 'Tomorrow' : d === addDays(today, -1) ? 'Yesterday' : dayLabel(d);
const md = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">link</a>')
  .split(/\n{2,}/).map(par => {
    const lines = par.split('\n');
    if (lines.every(l => /^\s*[-•]\s/.test(l))) return `<ul>${lines.map(l => `<li>${l.replace(/^\s*[-•]\s/, '')}</li>`).join('')}</ul>`;
    return `<p>${lines.join('<br>')}</p>`;
  }).join('');
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const store = { get(k, d) { try { const v = localStorage.getItem('donna.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem('donna.' + k, JSON.stringify(v)); } catch { /* private mode */ } } };
// Last data seen per view: the app paints it at once on open, then swaps in fresh data.
const snap = {
  get(k) { return store.get('snap.' + k, null); },
  set(k, v) {
    const keys = store.get('snapKeys', []).filter(x => x !== k);
    keys.push(k);
    for (const old of keys.splice(0, Math.max(0, keys.length - 10))) { try { localStorage.removeItem('donna.snap.' + old); } catch { /* ignore */ } }
    store.set('snapKeys', keys);
    store.set('snap.' + k, v);
  },
};

// ─── App state ───
const S = {
  view: 'today', calView: store.get('calView', innerWidth < 980 ? 'day' : 'week'), anchor: null, data: null, settings: {},
  today: ymd(new Date()), miniMonth: null, activityFilter: 'all',
};

// ─── Navigation ───
const TITLES = { today: 'Today', calendar: 'Calendar', tasks: 'Tasks', habits: 'Habits', insights: 'Insights', activity: 'Activity', memory: 'Memory', settings: 'Settings', more: 'More' };
function setView(v, { push = true } = {}) {
  if (v === 'chat') { $('app').classList.add('mobile-chat'); setTab('chat'); $('input').focus(); return; }
  $('app').classList.remove('mobile-chat');
  S.view = v;
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  setTab(v);
  if (push) history.replaceState(null, '', '#' + v);
  document.title = `${TITLES[v] || 'Donna'} · ${S.settings.agentName || 'Donna'}`;
  render();
}
function setTab(v) { document.querySelectorAll('#tabbar button').forEach(b => b.classList.toggle('on', b.dataset.view === v || (v !== 'today' && v !== 'calendar' && v !== 'chat' && v !== 'tasks' && b.dataset.view === 'more'))); }
document.querySelectorAll('#nav button, #tabbar button').forEach(b => b.onclick = () => setView(b.dataset.view));
window.addEventListener('hashchange', () => { const v = location.hash.slice(1); if (TITLES[v] && v !== S.view) setView(v, { push: false }); });

function render() {
  const fn = { today: renderToday, calendar: renderCalendar, tasks: renderTasks, habits: renderHabits, insights: renderInsights, activity: renderActivity, memory: renderMemory, settings: renderSettings, more: renderMore }[S.view];
  closePop();
  fn().catch(e => {
    // Something is already on screen (the saved copy): keep it and say what went wrong.
    if ($('view').querySelector('.hero, #calBody, .card')) return toast('⚠️ ' + e.message, { ms: 6000 });
    $('view').innerHTML = `<div class="view pad"><div class="banner warn">${ICON.warn}<div>${esc(e.message)}</div></div></div>`; });
}
function topbar(html) { $('topbar').innerHTML = html + '<span class="syncpill" id="syncPill" title="When your calendar was last read from Google"></span>'; paintSync(); }

// ─── Google sync: views come from the saved copy instantly; this checks Google in the background ───
const SYNC = { at: null, busy: false, tried: 0, failed: false };
function paintSync() {
  const el = $('syncPill');
  if (!el) return;
  if (!S.settings.google) { el.textContent = ''; return; }
  const age = SYNC.at ? Math.max(0, Math.round((Date.now() - SYNC.at) / 60000)) : null;
  el.className = 'syncpill' + (SYNC.busy ? ' busy' : SYNC.failed ? ' bad' : '');
  el.innerHTML = SYNC.busy ? '<i></i><span class="hide-m">Syncing…</span>' : SYNC.failed ? `<i></i><span class="hide-m">Google slow · showing saved</span>`
    : age === null ? '' : `<i></i><span class="hide-m">${age < 1 ? 'Up to date' : `Updated ${age < 60 ? age + ' min' : Math.round(age / 60) + ' h'} ago`}</span>`;
}
function noteSync(sync) {
  if (!sync) return;
  SYNC.at = Date.parse(sync.at) || SYNC.at;
  paintSync();
  if (sync.ageSec > 45) syncNow();
}
async function syncNow(force = false) {
  if (SYNC.busy || (!force && Date.now() - SYNC.tried < 30000)) return;
  SYNC.busy = true; SYNC.tried = Date.now(); paintSync();
  try {
    const r = await api('/api/sync', {}, false, { timeout: 45000 });
    SYNC.at = Date.parse(r.sync.at); SYNC.failed = false;
    if (r.changed && !$('editor').open && !$('planner').open && !popEl && !pointerDown) render();
  } catch { SYNC.failed = true; }
  SYNC.busy = false; paintSync();
}
setInterval(paintSync, 30000);
let pointerDown = false;
addEventListener('pointerdown', () => { pointerDown = true; }, true);
addEventListener('pointerup', () => { pointerDown = false; }, true);

// ─── Status, sidebar ───
function setStatus(s) {
  S.settings = s;
  store.set('settings', s);
  $('agentName').textContent = s.agentName || 'Donna';
  $('chatName').textContent = s.agentName || 'Donna';
  $('chatAvatar').textContent = (s.agentName || 'S')[0].toUpperCase();
  const dot = $('dot');
  const aiOk = s.aiReady;
  dot.className = 'dot ' + (!aiOk ? 'bad' : s.autonomous ? 'ok' : 'warn');
  const where = s.google ? `Google Calendar${s.bridgeVersion && s.bridgeVersion < 3 ? ' (bridge v2)' : ''}` : 'Practice calendar';
  $('statusText').textContent = !aiOk ? 'No AI model set up' : `${s.autonomous ? 'Autonomous' : 'Paused'} · ${where}`;
  const live = (s.ai || []).filter(p => p.ready && !p.blocked);
  $('aiText').textContent = live.length ? `AI: ${live.map(p => p.id).join(' → ')}` : (s.ai || []).some(p => p.ready) ? 'AI: all models resting (quota)' : '';
  $('chatSub').textContent = s.autonomous ? 'Acts on its own · every change can be undone' : 'Paused · acts only when asked';
}
function renderMini() {
  const sel = S.anchor || S.today;
  const m = S.miniMonth || sel.slice(0, 7);
  const first = m + '-01';
  const start = weekStart(first);
  const ws = weekStart(sel);
  let html = `<div class="mini-head"><button data-m="-1" aria-label="Previous month">‹</button><span>${MONTHS[+m.slice(5) - 1]} ${m.slice(0, 4)}</span><button data-m="1" aria-label="Next month">›</button></div><div class="mini-grid">`;
  html += ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(d => `<span>${d}</span>`).join('');
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    const cls = [d.slice(0, 7) !== m && 'out', d === S.today && 'today', d === sel && S.view === 'calendar' && 'sel',
      S.view === 'calendar' && S.calView === 'week' && d >= ws && d < addDays(ws, 7) && 'inweek'].filter(Boolean).join(' ');
    html += `<button data-d="${d}" class="${cls}">${+d.slice(8)}</button>`;
  }
  $('mini').innerHTML = html + '</div>';
}
$('mini').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.m) { const m = S.miniMonth || (S.anchor || S.today).slice(0, 7); const x = new Date(m + '-15T12:00'); x.setMonth(x.getMonth() + +b.dataset.m); S.miniMonth = ymd(x).slice(0, 7); renderMini(); return; }
  S.anchor = b.dataset.d; S.miniMonth = null;
  setView('calendar');
});

// ─── Data ───
async function loadState(view, date) {
  const s = await api(`/api/state?view=${view}&date=${date}`);
  S.today = s.today;
  setStatus(s.settings);
  $('taskCount').textContent = s.tasks.length || '';
  return s;
}

// ─── Today ───
async function renderToday() {
  topbar(`<h1>Today</h1><span class="muted hide-m">${dayLabel(S.today, true)}</span><span class="spacer"></span>
    <button class="btn" id="imUp" title="Re-plan the rest of today from now">☀️<span class="hide-m">I'm up</span></button>
    <button class="btn" id="planDay" title="Build a plan for a day">${ICON.spark}<span class="hide-m">Plan my day</span></button>
    <button class="btn primary" id="newEv">${ICON.plus}<span class="hide-m">New event</span></button>`);
  $('imUp').onclick = () => ask('I woke up just now, replan my day');
  $('planDay').onclick = () => openPlanner();
  $('newEv').onclick = () => openEditor({ start: roundNow(), end: addMin(roundNow(), 30), kind: 'meeting' });
  // Paint what was last seen right away; fresh data replaces it a moment later.
  const last = snap.get('today');
  if (last && last.st.today === S.today && !$('view').querySelector('.hero')) { try { setStatus(last.st.settings); paintToday(last.st, last.tm, last.rd, last.decisions, last.autoPlan, last.ledger); } catch { /* old shape */ } }
  else if (!last) $('view').innerHTML = '<div class="view pad"><div class="wrap"><div class="skeleton"></div><div class="skeleton"></div></div></div>';
  const { st, tm, rd, decisions, autoPlan, ledger } = await api('/api/home');
  S.today = st.today;
  setStatus(st.settings);
  $('taskCount').textContent = st.tasks.length || '';
  snap.set('today', { st, tm, rd, decisions, autoPlan, ledger });
  if (S.view !== 'today') return;
  paintToday(st, tm, rd, decisions, autoPlan, ledger);
  noteSync(st.sync);
  if (autoPlan && autoPlan.on && autoPlan.target && !autoPlan.done) planAhead(autoPlan.target);
}

// ─── Evening autopilot: opening the app after 18:00 gets the next day ready, once per day ───
let planningAhead = false;
async function planAhead(target) {
  if (planningAhead || store.get('autoPlanned', '') === target) return;
  planningAhead = true;
  const box = $('decisions');
  if (box) box.insertAdjacentHTML('afterbegin', '<div class="issue" id="planningNow"><span class="typing"><i></i><i></i><i></i></span><span>Getting tomorrow ready…</span></div>');
  try {
    const r = await api('/api/autoplan', {}, false, { timeout: 70000 });
    store.set('autoPlanned', target);
    if (!r.skipped) toast(r.changes ? `Tomorrow is ready: ${r.changes} change${r.changes === 1 ? '' : 's'}. See “${S.settings.agentName || 'Donna'} decided”.` : 'Tomorrow already fits. Nothing needed changing.', { ms: 6000 });
    loadChat().catch(() => {});
  } catch (err) { toast('⚠️ Could not plan tomorrow: ' + err.message); }
  planningAhead = false;
  if (S.view === 'today') render();
}
// Your alertness through the day (same curve the planner uses, src/smart.js), from your own wake-up / wind-down.
function energyAt(m, wake, sleep) {
  if (sleep <= wake) sleep = 1440;
  if (m < wake || m >= sleep) return 0.15;
  const since = m - wake, dip = Math.max(13 * 60 + 30, wake + 5 * 60);
  if (since < 45) return 0.45 + 0.35 * since / 45;
  if (m >= dip && m < dip + 105) return 0.55;
  if (sleep - m <= 60) return 0.35;
  if (sleep - m <= 150) return 0.62;
  if (since < 4 * 60 + 15) return 1;
  return m < dip ? 0.85 : 0.88;
}
const energyWord = (e, m, wake) => m < wake ? 'before your day' : e >= 0.95 ? 'peak focus' : e >= 0.8 ? 'good focus' : e >= 0.5 ? 'lighter energy' : 'winding down';
const OWNER = {
  you: () => '',
  asked: () => '<span class="own asked" title="Donna booked this because you asked">you asked</span>',
  auto: e => `<span class="own auto" title="Donna placed this on its own">${esc(S.settings.agentName || 'Donna')}</span>`,
};
const inMin = (from, to) => { const m = Math.round(diff(from, to)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${m % 60 ? ' ' + (m % 60) + 'm' : ''}`; };

/** Your waking day as one strip: energy shading behind, your blocks on top, a marker for now. */
function dayStrip(st, s) {
  const wake = hm(s.dayStart || '07:00'), sleep = hm(s.dayEnd || '23:00') || 1440;
  const span = Math.max(60, sleep - wake), pct = m => Math.max(0, Math.min(100, (m - wake) / span * 100));
  let shade = '';
  for (let m = wake; m < sleep; m += 30) shade += `<i style="left:${pct(m)}%;width:${30 / span * 100}%;opacity:${(energyAt(m + 15, wake, sleep) * .9).toFixed(2)}"></i>`;
  const blocks = st.events.filter(e => !e.allDay && e.kind !== 'buffer' && e.myStatus !== 'declined').map(e => {
    const a = e.start.slice(0, 10) < S.today ? wake : mins(e.start), b = e.end.slice(0, 10) > S.today ? sleep : mins(e.end);
    if (b <= wake || a >= sleep) return '';
    return `<b class="k-${e.readOnly ? 'busy' : e.category} ${e.origin === 'auto' ? 'by-auto' : ''}" style="left:${pct(a)}%;width:${Math.max(.6, pct(b) - pct(a))}%" title="${esc(clock(e.start) + ' ' + e.title)}"></b>`;
  }).join('');
  const now = mins(st.now);
  const peakFrom = wake + 45, peakTo = Math.min(wake + 255, Math.max(13 * 60 + 30, wake + 300));
  const ticks = [wake, ...[9, 12, 15, 18, 21].map(x => x * 60).filter(x => x > wake + 90 && x < sleep - 90), sleep];
  return `<div class="strip" aria-label="Your day from ${s.dayStart} to ${s.dayEnd}">
    <div class="strip-bar"><div class="shade">${shade}</div>${blocks}${now > wake && now < sleep ? `<span class="strip-now" style="left:${pct(now)}%"></span>` : ''}</div>
    <div class="strip-ticks">${ticks.map(t => `<span style="left:${pct(t)}%">${hhmm(Math.min(t, 1439))}</span>`).join('')}</div>
    <div class="strip-legend"><span><i class="sw energy"></i>your energy (peak ${hhmm(peakFrom)}–${hhmm(peakTo)}, from your ${esc(s.dayStart)} wake-up)</span><span><i class="sw auto"></i>placed by ${esc(s.agentName || 'Donna')}</span></div>
  </div>`;
}

function trustCard(list, autoPlan, led) {
  const name = esc(S.settings.agentName || 'Donna');
  const on = !!S.settings.autonomous;
  const open = (list || []).filter(d => d.summary && !d.undone && !d.kept);
  const settled = (list || []).filter(d => d.summary && (d.undone || d.kept));
  const row = d => `<div class="issue decision ${d.undone ? 'undone' : ''}">
      <span class="muted mono" style="font-size:12px;min-width:44px">${esc(clock(d.time))}</span>
      <span style="flex:1;min-width:0">${esc(d.summary)}${d.why ? `<div class="hint">Why: ${esc(d.why)}</div>` : ''}
      ${d.undone ? '<span class="pill">undone</span>' : d.kept ? '<span class="pill ok">kept</span>' : `<span class="dec-btns"><button class="btn sm" data-keep="${esc(d.id)}" title="Good call: keep it and do more like this">👍 Keep</button><button class="btn sm ghost" data-undo="${esc(d.id)}">↩ Undo</button></span>`}</span></div>`;
  const plan = !on ? '' : autoPlan && autoPlan.done ? `Tomorrow planned at ${esc(clock(autoPlan.at || ''))}.` : new Date().getHours() >= 18 ? 'Planning tomorrow…' : 'Plans tomorrow when you open the app after 6 pm.';
  return `<div class="card trust"><h2>🤝 Your call<span class="hint">${open.length ? `${open.length} to review` : 'all reviewed'}</span></h2>
    <div class="autopilot ${on ? 'on' : ''}">
      <div style="flex:1"><b>Autopilot ${on ? 'on' : 'off'}</b><div class="hint">${on ? `${name} keeps tasks, habits and buffers in place and fixes clashes. ${plan}` : `${name} only acts when you ask.`}</div></div>
      <button class="btn sm ${on ? '' : 'primary'}" id="autopilot">${on ? 'Pause' : 'Turn on'}</button></div>
    <div id="decisions">${open.map(row).join('') || `<div class="hint" style="padding:8px 0">Nothing new from ${name}. Every change it makes shows up here first, with the reason, for you to keep or undo.</div>`}</div>
    ${open.length > 1 ? `<div class="row" style="margin-top:8px"><button class="btn sm" id="keepAll">Keep all ${open.length}</button></div>` : ''}
    ${settled.length ? `<details class="settled"><summary class="hint">${settled.length} already reviewed</summary>${settled.slice(0, 6).map(row).join('')}</details>` : ''}
    ${led && led.changes ? `<div class="ledger">This week ${name} made <b>${led.changes}</b> change${led.changes === 1 ? '' : 's'} on its own · you kept <b>${led.kept}</b> · undid <b>${led.undone}</b></div>` : ''}
  </div>`;
}

function paintToday(st, tm, rd, decisions = [], autoPlan = null, led = null) {
  S.data = st;
  const s = st.settings;
  const name = (s.userName || '').split(' ')[0];
  const h = new Date().getHours();
  const wake = hm(s.dayStart || '07:00'), sleep = hm(s.dayEnd || '23:00') || 1440;
  const timed = st.events.filter(e => !e.allDay && e.kind !== 'buffer' && e.myStatus !== 'declined');
  const left = timed.filter(e => e.end > st.now);
  const free = freeMinutes(st.events, S.today, s, st.now);
  const next = left.find(e => e.start > st.now);
  const nowEv = left.find(e => e.start <= st.now);
  const focusMin = timed.filter(e => ['study', 'tasks', 'focus'].includes(e.category) || e.kind === 'focus').reduce((n, e) => n + diff(e.start, e.end), 0);
  const tasksOk = st.tasks.filter(t => !t.atRisk).length;
  const goals = ((rd && rd.goals) || []).filter(g => g.active);
  const goalDone = goals.reduce((n, g) => n + g.done, 0), goalTarget = goals.reduce((n, g) => n + g.target, 0);

  const ag = row => {
    const past = row.end <= st.now, cur = row.start <= st.now && row.end > st.now;
    const e = energyAt(mins(row.start) + 15, wake, sleep);
    const tags = [row.meetLink && `<a class="pill acc" href="${esc(row.meetLink)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${ICON.video} Join</a>`,
      row.readOnly && `<span class="pill">${esc(row.calendarName || 'other calendar')}</span>`].filter(Boolean).join(' ');
    const why = row.origin === 'auto' || row.origin === 'asked' ? (row.why ? `Why here: ${row.why}` : '') : '';
    return `<div class="ag ${past ? 'past' : ''} ${cur ? 'now' : ''} ${row.origin === 'auto' ? 'is-auto' : ''} k-${row.readOnly ? 'busy' : row.category}" data-id="${esc(row.id)}">
      <div class="t">${clock(row.start)} – ${clock(row.end)}<div class="en" title="Your energy at this time">${energyWord(e, mins(row.start), wake)}</div></div><div class="bar" style="background:var(--cc)"></div>
      <div style="min-width:0"><div class="title">${esc(row.title)} ${OWNER[row.origin || 'you'](row)}</div><div class="sub">${esc([dur(diff(row.start, row.end)), row.location, row.guests && row.guests.length ? row.guests.length + ' guest' + (row.guests.length > 1 ? 's' : '') : ''].filter(Boolean).join(' · '))}</div>
        ${why && !past ? `<div class="why">${esc(why)}</div>` : ''}</div>
      <div class="act-col">${tags}</div></div>`;
  };
  let agenda = '', marked = false;
  for (const e of timed) {
    if (!marked && e.start > st.now) { agenda += `<div class="nowmark">Now · ${clock(st.now)}</div>`; marked = true; }
    agenda += ag(e);
  }
  if (!marked && timed.length) agenda += `<div class="nowmark">Now · ${clock(st.now)}</div>`;
  const allDay = st.events.filter(e => e.allDay);
  const tomorrow = tm.events.filter(e => !e.allDay && e.kind !== 'buffer' && e.myStatus !== 'declined');
  const issues = st.issues.filter(i => !/^No room for habit/.test(i)).slice(0, 6);
  const lead = nowEv ? `Right now: <b>${esc(nowEv.title)}</b> until ${clock(nowEv.end)}.` : next ? `Next for you: <b>${esc(next.title)}</b> in ${inMin(st.now, next.start)} (${clock(next.start)}).` : 'Nothing else on your plate today.';
  $('view').className = 'view pad';
  $('view').innerHTML = `<div class="wrap">
    <div class="hero">
      <div class="hero-top">
        <div style="min-width:0"><h2>${h < 4 ? 'Still up' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'}${name ? ', ' + esc(name) : ''}</h2>
          <p>${lead} ${left.length ? `${left.length} thing${left.length === 1 ? '' : 's'} left today.` : ''}</p>
          ${name ? '' : '<p class="hint"><a href="#settings">Tell Donna your name</a> so this feels like yours.</p>'}</div>
        <div class="chips">${["What's next?", 'Plan tomorrow for max productivity', 'Fix my conflicts this week'].map(x => `<button class="chip" data-ask="${esc(x)}">${esc(x)}</button>`).join('')}</div>
      </div>
      ${dayStrip(st, s)}
    </div>
    ${isIOS && !isStandalone() && !store.get('a2hsDismissed', false) ? `<div class="banner info" id="a2hs">📱<div style="flex:1">Put ${esc(s.agentName || 'Donna')} on your Home Screen: tap <b>Share</b> (□↑) → <b>Add to Home Screen</b>. It opens like an app, stays signed in and can notify you.</div><button class="btn sm ghost" id="a2hsX">✕</button></div>` : ''}
    <div class="stats">
      <div class="stat"><div class="k">Your free time left</div><div class="v">${dur(free.free)}</div><div class="hint">longest stretch ${dur(free.longest)}</div></div>
      <div class="stat"><div class="k">Focus time today</div><div class="v">${dur(focusMin)}</div><div class="hint">study & task blocks</div></div>
      <div class="stat"><div class="k">Your tasks on track</div><div class="v">${st.tasks.length ? `${tasksOk}/${st.tasks.length}` : '—'}</div><div class="hint">${st.tasks.length - tasksOk ? `<span class="bad-t">${st.tasks.length - tasksOk} at risk</span>` : st.tasks.length ? 'all fit before due' : 'none open'}</div></div>
      <div class="stat"><div class="k">Your weekly goals</div><div class="v">${goals.length ? `${hrs(goalDone)}<small> / ${hrs(goalTarget)}</small>` : '—'}</div><div class="hint">${goals.length ? goals.map(g => esc(g.title)).join(', ') : '<a href="#tasks">set one</a>'}</div></div>
    </div>
    <div class="cards today-grid">
      <div class="card"><h2>${ICON.cal} Your day<span class="hint">${dayLabel(S.today, true)}</span></h2>
        ${allDay.length ? `<div class="row" style="margin-bottom:8px">${allDay.map(e => `<span class="pill acc">${esc(e.title)}</span>`).join('')}</div>` : ''}
        <div class="agenda" id="agenda">${agenda || '<div class="empty"><b>A clear day</b>It\'s yours. Ask Donna to plan something, or enjoy it.</div>'}</div></div>
      <div>
        ${trustCard(decisions, autoPlan, led)}
        ${issues.length ? `<div class="card"><h2>${ICON.warn} Needs you</h2>${issues.map(i => `<div class="issue"><span class="dot warn" style="margin-top:6px"></span><span>${esc(i)}</span></div>`).join('')}
          <div class="row" style="margin-top:10px"><button class="btn sm" data-ask="Fix my conflicts this week">Let Donna fix it</button></div></div>` : ''}
        <div class="card"><h2>${ICON.check} Your tasks<span class="hint"><a href="#tasks">All</a></span></h2>
          ${st.tasks.length ? st.tasks.slice(0, 5).map(t => taskRow(t, true)).join('') : '<div class="hint">No open tasks. Try: “OS assignment due Friday, about 3 hours”.</div>'}</div>
        ${radarCards(rd)}
        <div class="card"><h2>${ICON.cal} Tomorrow<span class="hint">${dayLabel(addDays(S.today, 1))}</span></h2>
          ${tomorrow.length ? tomorrow.slice(0, 8).map(e => `<div class="issue" style="cursor:pointer" data-id="${esc(e.id)}"><span class="muted mono" style="font-size:12px;min-width:44px">${clock(e.start)}</span><span style="flex:1">${esc(e.title)}</span>${OWNER[e.origin || 'you'](e)}</div>`).join('') + (tomorrow.length > 8 ? `<div class="hint">+${tomorrow.length - 8} more</div>` : '') : '<div class="hint">Nothing yet.</div>'}</div>
      </div>
    </div></div>`;
  const all = [...st.events, ...tm.events];
  $('view').querySelectorAll('[data-id]').forEach(el => el.onclick = ev => { const e = all.find(x => x.id === el.dataset.id); if (e) openPop(e, el); });
  bindTaskRows($('view'));
  const verdict = async (id, v) => {
    try { const r = await api('/api/feedback', { id, verdict: v, reason: '' }); toast(r.text.split('\n')[0]); } catch (err) { toast('⚠️ ' + err.message); }
  };
  $('view').querySelectorAll('[data-undo]').forEach(b => b.onclick = async () => { b.disabled = true; await verdict(b.dataset.undo, 'undo'); loadChat().catch(() => {}); render(); });
  $('view').querySelectorAll('[data-keep]').forEach(b => b.onclick = async () => { b.disabled = true; await verdict(b.dataset.keep, 'good'); render(); });
  $('keepAll')?.addEventListener('click', async e => {
    e.target.disabled = true;
    for (const b of $('view').querySelectorAll('[data-keep]')) await api('/api/feedback', { id: b.dataset.keep, verdict: 'good', reason: '' }).catch(() => {});
    toast('Kept. Donna will do more like this.'); render();
  });
  $('autopilot')?.addEventListener('click', async () => {
    const on = !S.settings.autonomous;
    if (!on && !confirm('Pause autopilot? Donna will only change things when you ask.')) return;
    try { setStatus(await api('/api/settings', { autonomous: on })); toast(on ? 'Autopilot on. Every change it makes shows up here for you to keep or undo.' : 'Autopilot paused.'); } catch (err) { toast('⚠️ ' + err.message); }
    render();
  });
  $('a2hsX')?.addEventListener('click', () => { store.set('a2hsDismissed', true); $('a2hs').remove(); });
}
// ─── Radar & goals (Today) ───
const RADAR_ICON = { exam: '📝', presentation: '🎤', deadline: '⏰', travel: '✈️', task: '✅' };
const hrs = m => (Math.round(m / 6) / 10).toString().replace(/\.0$/, '') + 'h';
function radarCards(rd) {
  if (!rd) return '';
  const items = (rd.items || []).slice(0, 8);
  const away = rd.away || [];
  const goals = (rd.goals || []).filter(g => g.active);
  const coming = items.length || away.length ? `<div class="card"><h2>📌 Coming up<span class="hint">next 3 weeks</span></h2>
    ${away.map(a => `<div class="banner warn" style="margin-bottom:8px">${ICON.warn}<div style="flex:1">${esc(a.text)}</div><button class="btn sm" data-ask="${esc(`I'm travelling: ${a.trip}. Cancel my in-person classes from ${a.from.replace('T', ' ')} until ${a.until.replace('T', ' ')}`)}">Handle classes</button></div>`).join('')}
    ${items.map(x => `<div class="issue"><span style="min-width:22px">${RADAR_ICON[x.kind] || '•'}</span><span style="flex:1">${esc(x.title)}${x.atRisk ? ' <span class="pill bad">at risk</span>' : ''}</span><span class="hint" style="white-space:nowrap">${esc(x.when)}${x.time ? ' ' + esc(x.time) : ''}</span></div>`).join('')}
    ${items.some(x => x.kind === 'exam') ? `<div class="row" style="margin-top:8px"><button class="btn sm" data-ask="Plan revision for my upcoming exams and evaluations, starting this week">Plan revision</button></div>` : ''}</div>` : '';
  const goalCard = goals.length ? `<div class="card"><h2>🎯 This week<span class="hint"><a href="#tasks">Goals</a></span></h2>
    ${goals.map(g => `<div style="margin:6px 0"><div class="row"><b style="font-weight:550">${esc(g.title)}</b><span class="spacer"></span><span class="hint">${hrs(g.done)} done · ${hrs(g.planned)} planned of ${hrs(g.target)}</span></div>
      <div class="progress"><i style="width:${Math.min(100, Math.round(g.done / g.target * 100))}%"></i></div></div>`).join('')}</div>` : '';
  return coming + goalCard;
}

// ─── Plan my day (dialog → one chat request) ───
function openPlanner(day) {
  const f = $('plannerForm');
  const tomorrow = addDays(S.today, 1);
  const late = new Date().getHours() < 4;
  f.day.value = day || (new Date().getHours() >= 20 ? tomorrow : S.today);
  if (late) f.day.value = S.today;
  f.from.value = '';
  f.items.value = store.get('planItems', '');
  $('planner').showModal();
  setTimeout(() => f.items.focus(), 30);
}
$('planner').addEventListener('click', e => { if (e.target.closest('[data-close]') || e.target === $('planner')) $('planner').close(); });
$('plannerForm').onsubmit = e => {
  e.preventDefault();
  const f = e.target;
  const list = f.items.value.split('\n').map(x => x.trim()).filter(Boolean);
  store.set('planItems', f.items.value);
  const d = f.day.value;
  const when = d === S.today ? 'today' : d === addDays(S.today, 1) ? 'tomorrow' : dayLabel(d, true);
  const parts = [`Plan my day for ${when}${f.from.value ? ` starting at ${f.from.value}` : ''}.`];
  if (list.length) parts.push('Things to do:\n' + list.map(x => '- ' + x).join('\n'));
  if (f.reflow.checked) parts.push('Also re-arrange my own study blocks already on that day if it helps (keep classes fixed).');
  if (f.fill.checked) parts.push('Maximum productivity: fill the free gaps.');
  if (!f.meals.checked) parts.push('No lunch or dinner breaks needed.');
  $('planner').close();
  ask(parts.join('\n'));
};

function freeMinutes(events, d, s, now) {
  const lo = `${d}T${s.dayStart || '07:00'}`, hi = `${d}T${s.dayEnd || '23:00'}`;
  let t = now > lo ? roundTo15(now) : lo;
  const busy = events.filter(e => !e.allDay && e.myStatus !== 'declined' && !(e.agent && ['focus', 'habit', 'task', 'buffer'].includes(e.kind)));
  let free = 0, longest = 0, run = 0;
  for (; t < hi; t = addMin(t, 15)) {
    const end = addMin(t, 15);
    if (busy.some(e => e.start < end && e.end > t)) { run = 0; continue; }
    free += 15; run += 15; longest = Math.max(longest, run);
  }
  return { free, longest };
}
const roundTo15 = s => { const m = mins(s); const r = Math.ceil(m / 15) * 15; return r >= 1440 ? s.slice(0, 11) + '23:45' : s.slice(0, 11) + hhmm(r); };
function roundNow() { const n = new Date(); return roundTo15(`${ymd(n)}T${p2(n.getHours())}:${p2(n.getMinutes())}`); }

async function runNow() {
  toast('Checking your plan…', { ms: 60000 });
  try {
    const r = await api('/api/run', {});
    const n = r && r.actions ? r.actions.length : 0;
    toast(n ? `${n} change${n === 1 ? '' : 's'}${r.text ? ': ' + r.text.slice(0, 120) : ''}` : 'All good. Nothing needed changing.', { ms: 5000 });
  } catch (err) { toast('⚠️ ' + err.message); }
  loadChat(); render();
}

// ─── Calendar ───
const START_H = 0, END_H = 24;
async function renderCalendar() {
  const anchor = S.anchor || S.today;
  const isWeek = S.calView === 'week';
  const from = isWeek ? weekStart(anchor) : anchor;
  const to = addDays(from, 6);
  const label = isWeek ? (from.slice(5, 7) === to.slice(5, 7) ? `${+from.slice(8)} – ${+to.slice(8)} ${MONTHS[+to.slice(5, 7) - 1]} ${to.slice(0, 4)}` : `${+from.slice(8)} ${MONTHS[+from.slice(5, 7) - 1]} – ${+to.slice(8)} ${MONTHS[+to.slice(5, 7) - 1]}`) : dayLabel(from, true);
  topbar(`<h1 class="hide-m">Calendar</h1>
    <button class="btn" id="todayBtn">Today</button>
    <button class="btn icon ghost" id="prev" aria-label="Previous">${ICON.left}</button><button class="btn icon ghost" id="next" aria-label="Next">${ICON.right}</button>
    <b style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${label}</b>
    <span class="spacer"></span>
    <span class="legend wide">${['classes', 'study', 'meetings', 'personal', 'tasks', 'habits'].map(c => `<span class="k-${c}"><i></i>${CATS[c]}</span>`).join('')}</span>
    <div class="seg"><button data-cv="day" class="${!isWeek ? 'on' : ''}">Day</button><button data-cv="week" class="${isWeek ? 'on' : ''}">Week</button></div>
    <button class="btn primary icon" id="newEv" title="New event (N)">${ICON.plus}</button>`);
  $('todayBtn').onclick = () => { S.anchor = S.today; renderCalendar(); };
  $('prev').onclick = () => { S.anchor = addDays(anchor, isWeek ? -7 : -1); renderCalendar(); };
  $('next').onclick = () => { S.anchor = addDays(anchor, isWeek ? 7 : 1); renderCalendar(); };
  document.querySelectorAll('[data-cv]').forEach(b => b.onclick = () => { S.calView = b.dataset.cv; store.set('calView', S.calView); renderCalendar(); });
  $('newEv').onclick = () => openEditor({ start: `${anchor}T${hhmm(Math.max(hm(S.settings.workStart || '09:00'), 0))}`, end: `${anchor}T${hhmm(hm(S.settings.workStart || '09:00') + 30)}`, kind: 'meeting' });
  const key = `cal:${isWeek ? 'week' : 'day'}:${from}`;
  const last = snap.get(key);
  if (last && last.events) { S.data = last; renderMini(); drawGrid(); }
  const fresh = await loadState(isWeek ? 'week' : 'day', from);
  snap.set(key, fresh);
  if (S.view !== 'calendar' || (S.anchor || S.today) !== anchor || S.calView !== (isWeek ? 'week' : 'day')) return; // user moved on
  S.data = fresh;
  renderMini();
  drawGrid();
  noteSync(fresh.sync);
}

function layoutDay(evs) {
  const sorted = evs.slice().sort((a, b) => a.start.localeCompare(b.start) || b.end.localeCompare(a.end));
  const out = [];
  let cluster = [], clusterEnd = '';
  const flush = () => {
    const cols = [];
    for (const e of cluster) {
      let c = 0;
      while (cols[c] && cols[c] > e.start) c++;
      cols[c] = e.end;
      out.push({ e, c });
    }
    const n = cols.length;
    out.slice(-cluster.length).forEach(x => { x.n = n; });
    cluster = [];
  };
  for (const e of sorted) {
    if (cluster.length && e.start >= clusterEnd) flush();
    cluster.push(e);
    clusterEnd = cluster.length === 1 ? e.end : (e.end > clusterEnd ? e.end : clusterEnd);
  }
  if (cluster.length) flush();
  return out;
}
function conflictIds(events) {
  const real = events.filter(e => !e.allDay && e.myStatus !== 'declined' && !(e.agent && ['focus', 'buffer', 'habit', 'task'].includes(e.kind)));
  const ids = new Set();
  for (let i = 0; i < real.length; i++) for (let j = i + 1; j < real.length; j++) {
    const a = real[i], b = real[j];
    if (a.start < b.end && a.end > b.start && !(a.readOnly && b.readOnly)) { ids.add(a.id); ids.add(b.id); }
  }
  return ids;
}
const hourPx = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hour')) || 48;

function drawGrid() {
  const st = S.data, s = st.settings;
  const days = [...Array(st.days)].map((_, i) => addDays(st.from, i));
  const ws = hm(s.workStart), we = hm(s.workEnd);
  const px = hourPx() / 60;
  const cols = `56px repeat(${days.length}, minmax(${days.length > 1 ? 92 : 200}px, 1fr))`;
  const clashes = conflictIds(st.events);
  let head = `<div class="cal-head" style="grid-template-columns:${cols}"><div></div>`;
  head += days.map(d => `<div class="dh ${d === st.today ? 'today' : ''} ${(s.workDays || []).includes(dow(d)) ? '' : 'off'}">${DAYS[dow(d)]}<b>${+d.slice(8)}</b></div>`).join('');
  const allDay = days.map(d => st.events.filter(e => e.allDay && e.start.slice(0, 10) <= d && e.end.slice(0, 10) > d));
  if (allDay.some(x => x.length)) head += `<div class="allday" style="grid-template-columns:${cols}"><div class="hint" style="font-size:10px;padding:3px 6px;text-align:right">all-day</div>${allDay.map(list => `<div class="cell">${list.map(e => `<div class="ad k-${e.category}" data-id="${esc(e.id)}" title="${esc(e.title)}">${esc(e.title)}</div>`).join('')}</div>`).join('')}</div>`;
  head += '</div>';
  let body = `<div class="cal-body" id="calBody"><div class="cal-grid" style="grid-template-columns:${cols}"><div class="hours">${[...Array(END_H - START_H)].map((_, i) => `<div>${i ? p2(START_H + i) + ':00' : ''}</div>`).join('')}</div>`;
  body += days.map(d => {
    const isWork = (s.workDays || []).includes(dow(d));
    const evs = st.events.filter(e => !e.allDay && e.start.slice(0, 10) <= d && e.end > d + 'T00:00');
    const placed = layoutDay(evs.map(e => ({ ...e, start: e.start < d + 'T00:00' ? d + 'T00:00' : e.start, end: e.end.slice(0, 10) > d ? d + 'T23:59' : e.end, _orig: e })));
    const evHtml = placed.map(({ e, c, n }) => {
      const o = e._orig;
      const top = mins(e.start) * px, h = Math.max(14, (mins(e.end) || 1440) * px - top - 1);
      const kind = o.kind === 'buffer' ? 'buffer' : o.readOnly ? 'busy' : '';
      const cls = ['ev', `k-${o.readOnly ? 'busy' : o.category}`, kind, o.agent && ['focus', 'habit', 'task'].includes(o.kind) && 'agent', o.myStatus === 'declined' && 'declined',
        clashes.has(o.id) && 'conflict', o.end <= st.now && 'past'].filter(Boolean).join(' ');
      const width = n > 1 ? `left:calc(${(c / n) * 100}% + 2px);width:calc(${100 / n}% - 4px);right:auto;` : '';
      const movable = !o.readOnly && o.kind !== 'buffer';
      const icons = [o.recurringId || o.groupId ? '↻' : '', o.meetLink ? '▶' : '', o.highStakes || o.view.highStakes ? '★' : '', o.organizer === false && !o.readOnly ? '✉' : ''].filter(Boolean).join(' ');
      return `<div class="${cls}" style="top:${top}px;height:${h}px;${width}" data-id="${esc(o.id)}" ${movable ? 'data-move="1"' : ''} title="${esc(o.title)} · ${clock(o.start)}–${clock(o.end)}">
        ${o.kind === 'buffer' ? '' : `<b>${esc(o.title)}</b>${h > 30 ? `<span class="tm">${clock(o.start)}–${clock(o.end)} ${icons}</span>` : ''}`}${movable && h > 20 ? '<span class="rs"></span>' : ''}</div>`;
    }).join('');
    const now = d === st.today ? `<div class="nowline" style="top:${mins(st.now) * px}px"></div>` : '';
    const band = isWork ? `<div class="work" style="top:${ws * px}px;height:${(we - ws) * px}px"></div>` : '';
    return `<div class="col ${isWork ? '' : 'off'}" data-day="${d}" style="height:${24 * hourPx()}px">${band}${evHtml}${now}</div>`;
  }).join('');
  body += '</div></div>';
  $('view').className = 'view';
  $('view').innerHTML = `<div class="cal">${head}${body}</div>`;
  const cb = $('calBody');
  const scrollTo = days.includes(st.today) ? Math.max(0, mins(st.now) - 120) : Math.max(0, Math.min(ws, hm(s.dayStart || '07:00')) - 30);
  cb.scrollTop = scrollTo * px;
  bindGrid();
}

function bindGrid() {
  const view = $('view');
  view.querySelectorAll('.ad').forEach(el => el.onclick = () => openPop(S.data.events.find(e => e.id === el.dataset.id), el));
  const body = $('calBody');
  let drag = null;
  const px = hourPx() / 60;
  const colAt = (x, y) => { const el = document.elementFromPoint(x, y); return el && el.closest('.col'); };
  const snap = m => Math.round(m / 15) * 15;
  body.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const evEl = e.target.closest('.ev');
    const col = e.target.closest('.col');
    if (!col) return;
    const rect = col.getBoundingClientRect();
    const y = e.clientY - rect.top;
    if (evEl) {
      const ev = S.data.events.find(x => x.id === evEl.dataset.id);
      drag = { type: e.target.classList.contains('rs') ? 'resize' : 'move', el: evEl, ev, x0: e.clientX, y0: e.clientY, started: false, can: !!evEl.dataset.move, pid: e.pointerId };
    } else {
      if (e.pointerType === 'touch') { drag = { type: 'tap', col, y, x0: e.clientX, y0: e.clientY }; return; }
      const m = snap(Math.floor(y / px / 15) * 15);
      drag = { type: 'create', col, m0: Math.floor(y / px / 15) * 15, m1: m + 30, started: false, x0: e.clientX, y0: e.clientY, pid: e.pointerId };
    }
  });
  body.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
    if (!drag.started && Math.hypot(dx, dy) < 5) return;
    if (drag.type === 'tap') { drag = null; return; }
    if ((drag.type === 'move' || drag.type === 'resize') && !drag.can) return;
    if (!drag.started) { drag.started = true; try { body.setPointerCapture(drag.pid); } catch { /* ok */ } if (drag.el) drag.el.classList.add('dragging'); closePop(); }
    if (drag.type === 'create') {
      const rect = drag.col.getBoundingClientRect();
      const m = Math.max(0, Math.min(1440, snap((e.clientY - rect.top) / px)));
      const a = Math.min(drag.m0, m), b = Math.max(drag.m0 + 15, m);
      drag.a = a; drag.b = b;
      let g = drag.col.querySelector('.ghost');
      if (!g) { g = document.createElement('div'); g.className = 'ghost'; drag.col.appendChild(g); }
      g.style.top = a * px + 'px'; g.style.height = (b - a) * px + 'px'; g.textContent = `${hhmm(a)} – ${hhmm(b)}`;
    } else if (drag.type === 'move') {
      const delta = snap(dy / px);
      const col = colAt(e.clientX, e.clientY);
      const d0 = drag.ev.start.slice(0, 10);
      const d1 = col ? col.dataset.day : d0;
      const len = diff(drag.ev.start, drag.ev.end);
      let start = addMin(d1 + drag.ev.start.slice(10), delta);
      drag.newStart = start; drag.newEnd = addMin(start, len);
      if (col && drag.el.parentElement !== col) col.appendChild(drag.el);
      drag.el.style.top = mins(start) * px + 'px';
      drag.el.querySelector('.tm') && (drag.el.querySelector('.tm').textContent = `${clock(start)}–${clock(drag.newEnd)}`);
    } else if (drag.type === 'resize') {
      const len = Math.max(15, snap(diff(drag.ev.start, drag.ev.end) + dy / px));
      drag.newStart = drag.ev.start; drag.newEnd = addMin(drag.ev.start, len);
      drag.el.style.height = len * px - 1 + 'px';
      drag.el.querySelector('.tm') && (drag.el.querySelector('.tm').textContent = `${clock(drag.ev.start)}–${clock(drag.newEnd)}`);
    }
  });
  const end = async e => {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.type === 'tap') {
      const m = Math.floor(d.y / px / 30) * 30;
      openEditor({ start: `${d.col.dataset.day}T${hhmm(m)}`, end: `${d.col.dataset.day}T${hhmm(Math.min(m + 30, 1439))}`, kind: 'meeting' });
      return;
    }
    if (!d.started) {
      if (d.type === 'create') {
        const m = d.m0;
        openEditor({ start: `${d.col.dataset.day}T${hhmm(m)}`, end: `${d.col.dataset.day}T${hhmm(Math.min(m + 30, 1439))}`, kind: 'meeting' });
      } else if (d.ev) openPop(d.ev, d.el);
      return;
    }
    if (d.type === 'create') {
      d.col.querySelector('.ghost')?.remove();
      openEditor({ start: `${d.col.dataset.day}T${hhmm(d.a)}`, end: `${d.col.dataset.day}T${hhmm(Math.min(d.b, 1439))}`, kind: 'meeting' });
      return;
    }
    if (!d.newStart || (d.newStart === d.ev.start && d.newEnd === d.ev.end)) { drawGrid(); return; }
    const before = { start: d.ev.start, end: d.ev.end };
    try {
      const r = await api('/api/events/update', { id: d.ev.id, origStart: d.ev.start, start: d.newStart, end: d.newEnd });
      problems(r.problems);
      toast(`Moved "${d.ev.title}" to ${dayLabel(d.newStart.slice(0, 10))} ${clock(d.newStart)}`, { action: 'Undo', onAction: async () => {
        await api('/api/events/update', { id: r.event ? r.event.id : d.ev.id, origStart: d.newStart, ...before }); renderCalendar();
      } });
    } catch (err) { toast('⚠️ ' + err.message); }
    renderCalendar();
  };
  body.addEventListener('pointerup', end);
  body.addEventListener('pointercancel', () => { if (drag && drag.started) drawGrid(); drag = null; });
}
function problems(list) { if (list && list.length) toast('⚠️ Google: ' + list.join('; ')); }

// ─── Event popover ───
let popEl = null;
function closePop() { if (popEl) { popEl.remove(); popEl = null; } }
document.addEventListener('pointerdown', e => { if (popEl && !popEl.contains(e.target) && !e.target.closest('.ev, .ag, [data-id]')) closePop(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closePop(); });
function openPop(ev, anchor) {
  if (!ev) return;
  closePop();
  const p = document.createElement('div');
  p.className = `pop k-${ev.readOnly ? 'busy' : ev.category}`;
  const len = diff(ev.start, ev.end);
  const when = ev.allDay ? `${dayLabel(ev.start.slice(0, 10), true)} · all day` : `${dayLabel(ev.start.slice(0, 10), true)} · ${clock(ev.start)} – ${clock(ev.end)} (${dur(len)})`;
  const tags = [ev.agent && ['focus', 'habit', 'task'].includes(ev.kind) ? `<span class="pill acc">${ev.taskId ? 'Task session' : ev.habitId ? 'Habit' : 'Focus'} · placed by ${esc(S.settings.agentName || 'Donna')}</span>` : ev.agent ? `<span class="pill acc">Made by ${esc(S.settings.agentName || 'Donna')}</span>` : '',
    ev.view.highStakes ? '<span class="pill warn">High-stakes</span>' : '', ev.view.protected ? '<span class="pill">Protected</span>' : '', ev.view.flexible ? '<span class="pill">Flexible</span>' : '',
    ev.organizer === false && !ev.readOnly ? '<span class="pill">Invitation</span>' : '', ev.recurringId || ev.groupId ? `<span class="pill">${ICON.repeat} Repeats</span>` : '',
    ev.myStatus === 'declined' ? '<span class="pill bad">Declined</span>' : ''].filter(Boolean).join('');
  p.innerHTML = `<h3><span class="sw"></span><span>${esc(ev.title)}</span></h3><div class="when">${when}</div>
    ${tags ? `<div class="tags">${tags}</div>` : ''}
    <div class="meta">
      ${ev.meetLink ? `<div>${ICON.video}<a href="${esc(ev.meetLink)}" target="_blank" rel="noopener">Join Google Meet</a></div>` : ''}
      ${ev.location ? `<div>${ICON.pin}<span>${esc(ev.location)}</span></div>` : ''}
      ${ev.guests && ev.guests.length ? `<div>${ICON.people}<span>${ev.guests.map(esc).join(', ')}</span></div>` : ''}
      ${ev.readOnly ? `<div>${ICON.cal}<span>${esc(ev.calendarName || 'Another calendar')} (read-only)</span></div>` : ''}
      ${ev.description ? `<div>${ICON.note}<span style="white-space:pre-wrap">${esc(ev.description.slice(0, 600))}</span></div>` : ''}
    </div>
    <div class="row">
      ${!ev.readOnly && ev.kind !== 'buffer' ? '<button class="btn sm" data-a="edit">Edit</button><button class="btn sm danger" data-a="del">Delete</button>' : ''}
      <span class="spacer"></span><button class="btn sm" data-a="ask">${ICON.chat} Ask ${esc(S.settings.agentName || 'Donna')}</button>
    </div>`;
  document.body.appendChild(p);
  const r = anchor.getBoundingClientRect();
  const pw = p.offsetWidth, ph = p.offsetHeight;
  let left = r.right + 8; if (left + pw > innerWidth - 8) left = Math.max(8, r.left - pw - 8);
  let top = Math.min(Math.max(8, r.top), innerHeight - ph - 8);
  if (innerWidth < 600) { left = 12; top = Math.max(12, innerHeight - ph - 80); }
  p.style.left = left + 'px'; p.style.top = top + 'px';
  popEl = p;
  p.querySelector('[data-a="edit"]')?.addEventListener('click', () => { closePop(); openEditor(ev); });
  p.querySelector('[data-a="del"]')?.addEventListener('click', async () => {
    closePop();
    let scope = 'this';
    if (ev.recurringId || ev.groupId) scope = confirm(`"${ev.title}" repeats.\n\nOK = delete the whole series\nCancel = delete only this one`) ? 'series' : 'this';
    else if (!confirm(`Delete "${ev.title}"?`)) return;
    try { const r = await api('/api/events/delete', { id: ev.id, origStart: ev.start, scope }); problems(r.problems); toast('Deleted'); } catch (err) { toast('⚠️ ' + err.message); }
    render();
  });
  p.querySelector('[data-a="ask"]').addEventListener('click', () => {
    closePop();
    ask(`About "${ev.title}" on ${dayLabel(ev.start.slice(0, 10))} at ${clock(ev.start)}: `, false);
  });
}

// ─── Event editor ───
let editing = null;
function openEditor(ev) {
  editing = ev;
  const f = $('editorForm');
  $('editorTitle').textContent = ev.id ? 'Edit event' : 'New event';
  f.title.value = ev.title || '';
  f.start.value = ev.start; f.end.value = ev.end;
  f.kind.value = ['meeting', 'task', 'focus', 'personal'].includes(ev.kind) ? ev.kind : 'meeting';
  f.guests.value = (ev.guests || []).join(', ');
  f.location.value = ev.location || '';
  f.description.value = ev.description || '';
  f.meet.checked = !!(ev.meet || ev.meetLink);
  f.flexible.checked = !!ev.flexible; f.highStakes.checked = !!ev.highStakes; f.protected.checked = !!ev.protected;
  $('scopeRow').classList.toggle('hidden', !(ev.recurringId && S.settings.bridgeVersion >= 3));
  f.querySelector('input[name=scope][value=this]').checked = true;
  $('deleteBtn').style.display = ev.id ? '' : 'none';
  $('editor').showModal();
  setTimeout(() => f.title.focus(), 30);
}
$('editor').addEventListener('click', e => { if (e.target.closest('[data-close]') || e.target === $('editor')) $('editor').close(); });
$('deleteBtn').onclick = async () => {
  const scope = $('editorForm').querySelector('input[name=scope]:checked').value;
  try { const r = await api('/api/events/delete', { id: editing.id, origStart: editing.start, scope }); problems(r.problems); } catch (err) { return toast('⚠️ ' + err.message); }
  $('editor').close(); toast('Deleted'); render();
};
$('editorForm').onsubmit = async e => {
  e.preventDefault();
  const f = e.target;
  if (f.end.value <= f.start.value) return toast('The end must be after the start');
  const data = {
    title: f.title.value.trim(), start: f.start.value.slice(0, 16), end: f.end.value.slice(0, 16), kind: f.kind.value,
    guests: f.guests.value.split(/[,;\s]+/).map(x => x.trim()).filter(x => /@/.test(x)), description: f.description.value, location: f.location.value,
    meet: f.meet.checked, flexible: f.flexible.checked, highStakes: f.highStakes.checked, protected: f.protected.checked,
  };
  try {
    const r = editing.id ? await api('/api/events/update', { id: editing.id, origStart: editing.start, scope: f.querySelector('input[name=scope]:checked').value, ...data }) : await api('/api/events', data);
    problems(r.problems);
    $('editor').close(); toast(editing.id ? 'Saved' : 'Added'); render();
  } catch (err) { toast('⚠️ ' + err.message); }
};

// ─── Tasks ───
function taskRow(t, compact) {
  const pct = Math.min(100, Math.round((t.spent || 0) / t.minutes * 100));
  const due = t.due.length === 10 ? t.due + 'T23:59' : t.due;
  const overdue = due < (S.data ? S.data.now : '');
  return `<div class="li ${t.status === 'done' ? 'done' : ''}" data-task="${esc(t.id)}">
    <button class="circle ${t.status === 'done' ? 'on' : ''}" data-done="${esc(t.id)}" title="${t.status === 'done' ? 'Reopen' : 'Mark done'}">${t.status === 'done' ? ICON.check : ''}</button>
    <div class="body"><div class="ttl">${esc(t.title)} ${t.priority === 'high' ? '<span class="pill warn">High</span>' : ''} ${t.atRisk ? '<span class="pill bad">At risk</span>' : ''}</div>
      <div class="sub">Due ${esc(relDay(due.slice(0, 10), S.today))}${t.due.length > 10 ? ' ' + clock(t.due) : ''}${overdue ? ' · overdue' : ''} · ${dur(t.spent || 0)} of ${dur(t.minutes)} done${!compact && t.sessions && t.sessions.length ? ` · next: ${esc(t.sessions[0])}` : ''}</div>
      <div class="progress"><i style="width:${pct}%"></i></div></div>
    ${compact ? '' : `<button class="btn sm ghost" data-deltask="${esc(t.id)}" title="Delete">✕</button>`}</div>`;
}
function bindTaskRows(root) {
  root.querySelectorAll('[data-done]').forEach(b => b.onclick = async () => {
    const done = !b.classList.contains('on');
    try { await api('/api/tasks', { id: b.dataset.done, status: done ? 'done' : 'open' }); toast(done ? 'Nice — task done. Freed its future sessions.' : 'Reopened'); } catch (err) { toast('⚠️ ' + err.message); }
    render();
  });
  root.querySelectorAll('[data-deltask]').forEach(b => b.onclick = async () => {
    if (!confirm('Delete this task and its planned sessions?')) return;
    await api('/api/tasks', { id: b.dataset.deltask, status: 'deleted' }); render();
  });
}
async function renderTasks() {
  topbar(`<h1>Tasks</h1><span class="muted hide-m">Donna books work sessions before each due date and re-plans when your day changes.</span><span class="spacer"></span>`);
  const [tasks, rd] = await Promise.all([api('/api/tasks'), api('/api/radar').catch(() => ({ goals: [] }))]);
  const goals = rd.goals || [];
  if (!S.data) S.data = { now: new Date().toISOString().slice(0, 16) };
  const open = tasks.filter(t => t.status === 'open').sort((a, b) => a.due.localeCompare(b.due));
  const done = tasks.filter(t => t.status === 'done').slice(-10).reverse();
  $('taskCount').textContent = open.length || '';
  const tomorrow = addDays(S.today, 1);
  $('view').className = 'view pad';
  $('view').innerHTML = `<div class="wrap">
    <form class="card" id="taskForm"><h2>${ICON.plus} New task</h2>
      <div class="grid2" style="grid-template-columns:2fr 1fr 1fr 1fr">
        <label class="f">What needs doing<input name="title" required placeholder="OS assignment, CFA chapter 4, pitch deck…" autocomplete="off"></label>
        <label class="f">Time needed (hours)<input name="hours" type="number" min="0.25" max="40" step="0.25" value="2" required></label>
        <label class="f">Due<input name="due" type="date" value="${addDays(S.today, 3)}" min="${S.today}" required></label>
        <label class="f">Priority<select name="priority"><option value="normal">Normal</option><option value="high">High</option><option value="low">Low</option></select></label>
      </div>
      <div class="row" style="margin-top:12px"><span class="hint">Or just tell ${esc(S.settings.agentName || 'Donna')}: “DBMS project due ${dayLabel(tomorrow)}, about 5 hours”.</span><span class="spacer"></span><button class="btn primary">Add &amp; plan</button></div>
    </form>
    <div class="card"><h2>Open<span class="hint">${open.length}</span></h2><div class="list">${open.map(t => taskRow(t)).join('') || '<div class="empty"><b>Nothing open</b>Add a task above and it gets time on your calendar automatically.</div>'}</div></div>
    <div class="card"><h2>🎯 Weekly goals<span class="hint">your own blocks count; only the shortfall gets booked</span></h2>
      <div class="list">${goals.map(g => `<div class="li"><div class="body"><div class="ttl">${esc(g.title)} · ${hrs(g.target)}/week ${g.atRisk ? '<span class="pill bad">behind</span>' : ''}</div>
        <div class="sub">${hrs(g.done)} done · ${hrs(g.planned)} planned this week${g.match && g.match !== g.title.toLowerCase() ? ` · counts “${esc(g.match)}”` : ''}</div><div class="progress"><i style="width:${Math.min(100, Math.round(g.planned / g.target * 100))}%"></i></div></div>
        <button class="btn sm ghost" data-delgoal="${esc(g.id)}" title="Remove">✕</button></div>`).join('') || '<div class="hint">No goals yet. Say “10 hours of CFA a week”, or add one here.</div>'}</div>
      <form class="row" id="goalForm" style="margin-top:10px"><input name="title" placeholder="CFA, DSA, Gym…" required style="flex:1;min-width:140px"><input name="hours" type="number" min="0.5" max="70" step="0.5" value="6" style="width:90px" title="hours per week"><span class="hint">h/week</span><button class="btn">Add goal</button></form></div>
    ${done.length ? `<div class="card"><h2>Recently done</h2><div class="list">${done.map(t => taskRow(t)).join('')}</div></div>` : ''}
  </div>`;
  bindTaskRows($('view'));
  $('goalForm').onsubmit = async e => {
    e.preventDefault();
    try { const r = await api('/api/goals', { title: e.target.title.value.trim(), hours: +e.target.hours.value }); problems(r.problems); toast(`Goal set. ${hrs(r.goal.planned)} of ${hrs(r.goal.target)} planned this week.`); } catch (err) { toast('⚠️ ' + err.message); }
    renderTasks();
  };
  $('view').querySelectorAll('[data-delgoal]').forEach(b => b.onclick = async () => { if (!confirm('Remove this goal? Its future sessions are freed.')) return; await api('/api/goals', { id: b.dataset.delgoal, remove: true }); renderTasks(); });
  $('taskForm').onsubmit = async e => {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('button.primary'); btn.disabled = true;
    try {
      const r = await api('/api/tasks', { title: f.title.value.trim(), minutes: Math.round(+f.hours.value * 60), due: f.due.value, priority: f.priority.value });
      problems(r.problems);
      toast(r.task.atRisk ? `Added, but only part fits before it's due — free up some time.` : `Added. Booked ${r.task.sessions.length} session${r.task.sessions.length === 1 ? '' : 's'}.`, { ms: 5000 });
    } catch (err) { toast('⚠️ ' + err.message); }
    renderTasks();
  };
}

// ─── Habits ───
const HABIT_PRESETS = [
  { title: '🏋️ Gym', minutes: 60, days: 'MO,TU,WE,TH,FR', windowStart: '17:00', windowEnd: '21:00', idealTime: '18:00', kind: 'personal' },
  { title: '🍽️ Lunch', minutes: 45, days: 'daily', windowStart: '12:30', windowEnd: '14:30', idealTime: '13:00', kind: 'personal' },
  { title: '🎯 Deep work', minutes: 90, days: 'MO,TU,WE,TH,FR', windowStart: '09:00', windowEnd: '13:00', idealTime: '09:30', kind: 'focus' },
  { title: '📖 Reading', minutes: 30, days: 'daily', windowStart: '21:00', windowEnd: '23:00', idealTime: '22:00', kind: 'personal' },
];
async function renderHabits() {
  topbar(`<h1>Habits</h1><span class="muted hide-m">Flexible routines placed in the best free slot of their window each day.</span>`);
  const habits = await api('/api/habits');
  const dayBoxes = (name, val) => `<div class="daypick">${['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'].map(c => `<label><input type="checkbox" name="${name}" value="${c}" ${val.includes(c) ? 'checked' : ''}><span>${c[0] + c[1].toLowerCase()}</span></label>`).join('')}</div>`;
  $('view').className = 'view pad';
  $('view').innerHTML = `<div class="wrap">
    <div class="card"><h2>Your habits<span class="hint">${habits.length}</span></h2><div class="list">
      ${habits.map(h => `<div class="li"><div class="body"><div class="ttl">${esc(h.title)} ${h.active === false ? '<span class="pill">Paused</span>' : ''}</div>
        <div class="sub">${dur(h.minutes)} · ${esc(String(h.days).replace(/,/g, ' '))} · between ${h.windowStart} and ${h.windowEnd}${h.idealTime ? ' · ideally ' + h.idealTime : ''}</div></div>
        <button class="btn sm" data-toggle="${esc(h.id)}" data-on="${h.active !== false}">${h.active === false ? 'Resume' : 'Pause'}</button>
        <button class="btn sm ghost" data-rm="${esc(h.id)}" title="Remove">✕</button></div>`).join('') || '<div class="empty"><b>No habits yet</b>Pick a preset below or describe one to Donna.</div>'}
    </div></div>
    <form class="card" id="habitForm"><h2>${ICON.plus} New habit</h2>
      <div class="chips" style="margin-bottom:12px">${HABIT_PRESETS.map((p, i) => `<button type="button" class="chip" data-preset="${i}">${esc(p.title)}</button>`).join('')}</div>
      <div class="grid2">
        <label class="f">Name<input name="title" required placeholder="Gym, revision, walk…" autocomplete="off"></label>
        <label class="f">Minutes<input name="minutes" type="number" min="5" max="480" step="5" value="60" required></label>
        <label class="f">Earliest start<input name="windowStart" type="time" value="17:00" required></label>
        <label class="f">Latest end<input name="windowEnd" type="time" value="21:00" required></label>
        <label class="f">Ideal start (optional)<input name="idealTime" type="time"></label>
        <label class="f">Type<select name="kind"><option value="personal">Personal</option><option value="focus">Focus / deep work</option><option value="task">Study / work</option></select></label>
      </div>
      <label class="f" style="margin-top:12px">Days${dayBoxes('days', ['MO', 'TU', 'WE', 'TH', 'FR'])}</label>
      <div class="row end" style="margin-top:12px"><button class="btn primary">Add habit</button></div>
    </form></div>`;
  const f = $('habitForm');
  f.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => {
    const p = HABIT_PRESETS[+b.dataset.preset];
    f.title.value = p.title; f.minutes.value = p.minutes; f.windowStart.value = p.windowStart; f.windowEnd.value = p.windowEnd; f.idealTime.value = p.idealTime; f.kind.value = p.kind;
    const days = p.days === 'daily' ? ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] : p.days.split(',');
    f.querySelectorAll('input[name=days]').forEach(x => { x.checked = days.includes(x.value); });
  });
  f.onsubmit = async e => {
    e.preventDefault();
    const days = [...f.querySelectorAll('input[name=days]:checked')].map(x => x.value);
    if (!days.length) return toast('Pick at least one day');
    try {
      const r = await api('/api/habits', { title: f.title.value.trim(), minutes: +f.minutes.value, windowStart: f.windowStart.value, windowEnd: f.windowEnd.value, idealTime: f.idealTime.value, kind: f.kind.value, days: days.length === 7 ? 'daily' : days.join(',') });
      problems(r.problems);
      toast(`Added. Placed ${r.placed ? r.placed.length : 0} block(s) in the next days.`);
    } catch (err) { toast('⚠️ ' + err.message); }
    renderHabits();
  };
  $('view').querySelectorAll('[data-rm]').forEach(b => b.onclick = async () => { if (!confirm('Remove this habit and its upcoming blocks?')) return; await api('/api/habits', { id: b.dataset.rm, remove: true }); renderHabits(); });
  $('view').querySelectorAll('[data-toggle]').forEach(b => b.onclick = async () => { await api('/api/habits', { id: b.dataset.toggle, active: b.dataset.on !== 'true' }); renderHabits(); });
}

// ─── Insights ───
async function renderInsights() {
  const week = weekStart(S.anchor || S.today);
  topbar(`<h1>Insights</h1><button class="btn icon ghost" id="prev">${ICON.left}</button><button class="btn icon ghost" id="next">${ICON.right}</button><b>${dayLabel(week)} – ${dayLabel(addDays(week, 6))}</b>`);
  $('prev').onclick = () => { S.anchor = addDays(week, -7); renderInsights(); };
  $('next').onclick = () => { S.anchor = addDays(week, 7); renderInsights(); };
  const r = await api('/api/insights?week=' + week);
  const cats = Object.keys(CATS).filter(c => r.byCategory[c]);
  const max = Math.max(60, ...r.days.map(d => Object.values(d.by).reduce((a, b) => a + b, 0)));
  const total = r.totalMinutes || 1;
  $('view').className = 'view pad';
  $('view').innerHTML = `<div class="wrap">
    <div class="stats">
      <div class="stat"><div class="k">Scheduled this week</div><div class="v">${dur(r.totalMinutes)}</div></div>
      <div class="stat"><div class="k">In classes &amp; study</div><div class="v">${dur((r.byCategory.classes || 0) + (r.byCategory.study || 0) + (r.byCategory.tasks || 0))}</div></div>
      <div class="stat"><div class="k">In meetings</div><div class="v">${dur(r.byCategory.meetings || 0)}</div></div>
      <div class="stat"><div class="k">Tasks done / open</div><div class="v">${r.tasks.done} / ${r.tasks.open}</div></div>
    </div>
    <div class="card"><h2>Where your time goes</h2>
      <div class="split-bar">${cats.map(c => `<i class="k-${c}" style="width:${r.byCategory[c] / total * 100}%" title="${CATS[c]} ${dur(r.byCategory[c])}"></i>`).join('')}</div>
      <div class="legend">${cats.map(c => `<span class="k-${c}"><i></i>${CATS[c]} · ${dur(r.byCategory[c])} (${Math.round(r.byCategory[c] / total * 100)}%)</span>`).join('') || '<span>No events this week.</span>'}</div></div>
    <div class="card"><h2>Day by day</h2>
      <div class="bars">${r.days.map(d => `<div style="display:flex;flex-direction:column;height:100%"><div class="b" title="${dur(Object.values(d.by).reduce((a, b) => a + b, 0))}">${Object.keys(CATS).filter(c => d.by[c]).map(c => `<i class="k-${c}" style="height:${d.by[c] / max * 100}%"></i>`).join('')}</div><div class="lab">${DAYS[dow(d.date)]} ${+d.date.slice(8)}</div></div>`).join('')}</div></div>
    <div class="card"><h2>${ICON.spark} Agent</h2><div class="hint">${r.agentActions} change${r.agentActions === 1 ? '' : 's'} made by ${esc(S.settings.agentName || 'Donna')} this week. ${r.tasks.atRisk ? `<b>${r.tasks.atRisk} task(s) at risk</b> of missing their deadline.` : 'No tasks at risk.'}</div></div>
  </div>`;
}

// ─── Activity ───
async function renderActivity() {
  topbar(`<h1>Activity</h1><span class="muted hide-m">Every change has an id. 👍 teaches, 👎 undoes and learns a rule.</span><span class="spacer"></span><button class="btn" id="runNow">${ICON.spark}<span class="hide-m">Check my plan</span></button>`);
  $('runNow').onclick = runNow;
  const rows = await api('/api/activity');
  const f = S.activityFilter;
  const shown = rows.filter(a => f === 'all' || (f === 'mine' ? !a.auto : a.auto));
  $('view').className = 'view pad';
  $('view').innerHTML = `<div class="wrap"><div class="filters">${[['all', 'All'], ['mine', 'From your requests'], ['auto', 'Automatic']].map(([k, l]) => `<button class="chip" style="${f === k ? 'border-color:var(--accent);color:var(--accent)' : ''}" data-f="${k}">${l}</button>`).join('')}</div>
    <div class="card"><div class="list">${shown.slice(0, 200).map(a => {
      const undone = a.status === 'reverted';
      const canRate = !undone && a.type !== 'revert' && !a.feedback;
      return `<div class="li ${undone ? 'done' : ''}"><div class="body"><div class="ttl"><span class="mono" style="color:var(--accent);font-size:12px">${esc(a.id)}</span> ${esc(a.summary)}</div>
        <div class="sub">${esc(a.rationale)} · ${esc(relDay(a.time.slice(0, 10), S.today))} ${clock(a.time)} · ${a.auto ? 'automatic' : a.source === 'booking' ? 'booking page' : 'your request'}</div></div>
        ${canRate ? `<span class="fb"><button data-id="${esc(a.id)}" data-v="Good" title="Good">👍</button><button data-id="${esc(a.id)}" data-v="Bad" title="Bad: undo and learn">👎</button></span>` : `<span class="pill">${esc(undone ? 'undone' : (a.feedback || '').split(':')[0])}</span>`}</div>`;
    }).join('') || '<div class="empty"><b>No activity yet</b>Changes Donna makes show up here.</div>'}</div></div></div>`;
  $('view').querySelectorAll('[data-f]').forEach(b => b.onclick = () => { S.activityFilter = b.dataset.f; renderActivity(); });
  $('view').querySelectorAll('.fb button').forEach(b => b.onclick = () => feedback(b.dataset.id, b.dataset.v));
}

// ─── Memory ───
async function renderMemory() {
  topbar(`<h1>Memory</h1><span class="muted hide-m">What ${esc(S.settings.agentName || 'Donna')} has learned. It follows these on every request.</span>`);
  const m = await api('/api/memory');
  const p = m.profile || {};
  const prof = [['Usually free', (p.quietWindows || []).join(', ')], ['Things usually start at', (p.usualStarts || []).join(', ')], ['Busiest days', (p.busiestDays || []).join(', ')],
    ['Typical meeting', p.typicalMeetingMinutes && p.typicalMeetingMinutes + ' min'], ['Scheduled per day', p.scheduledHoursPerDay && p.scheduledHoursPerDay + ' h'], ['Meetings per week', p.meetingHoursPerWeek && p.meetingHoursPerWeek + ' h'],
    ['Based on', p.basedOnEvents != null && p.basedOnEvents + ' past events']].filter(x => x[1]);
  $('view').className = 'view pad';
  $('view').innerHTML = `<div class="wrap">
    <div class="card"><h2>Rules<span class="hint">from your words, 👎 feedback, or added here</span></h2><div class="list" id="rules">
      ${m.rules.map(r => `<div class="li"><input type="checkbox" class="check" data-rule="${esc(r.id)}" ${r.active ? 'checked' : ''} title="Active" style="margin-top:3px;width:16px;height:16px;accent-color:var(--accent)"><div class="body"><div class="ttl" style="font-weight:450">${esc(r.text)}</div><div class="sub">from ${esc(r.source)} · ${esc(r.time.slice(0, 10))}</div></div><button class="btn sm ghost" data-delrule="${esc(r.id)}">✕</button></div>`).join('') || '<div class="hint">No rules yet. Say things like “never book anything before 10 on weekends”.</div>'}
    </div><form class="row" id="ruleForm" style="margin-top:10px"><input id="ruleInput" placeholder="e.g. Keep Sunday evenings free" style="flex:1;min-width:200px"><button class="btn primary">Add rule</button></form></div>
    <div class="card"><h2>People<span class="hint">names → emails for invites</span></h2><div class="list">
      ${m.people.map(x => `<div class="li"><div class="body"><div class="ttl">${esc(x.name)}</div><div class="sub">${esc(x.email || 'no email')}${x.note ? ' · ' + esc(x.note) : ''}</div></div><button class="btn sm ghost" data-delperson="${esc(x.id)}">✕</button></div>`).join('') || '<div class="hint">Nobody yet. Say “Riya’s email is riya@college.edu”.</div>'}
    </div><form class="row" id="personForm" style="margin-top:10px"><input name="name" placeholder="Name" style="flex:1;min-width:120px" required><input name="email" type="email" placeholder="email@example.com" style="flex:1.4;min-width:160px"><button class="btn">Add</button></form></div>
    <div class="cards">
      <div class="card"><h2>Lessons from 👎</h2>${m.lessons.slice().reverse().slice(0, 12).map(l => `<div class="issue"><span>${esc(l.did)}<div class="hint">You said “${esc(l.reason)}”${l.rule ? ` → ${esc(l.rule)}` : ''}</div></span></div>`).join('') || '<div class="hint">None yet.</div>'}</div>
      <div class="card"><h2>Habits from your calendar<span class="hint"><button class="btn sm" id="relearn">Re-analyse</button></span></h2>${prof.map(([k, v]) => `<div class="issue"><b style="min-width:150px;font-weight:550">${k}</b><span>${esc(v)}</span></div>`).join('') || '<div class="hint">Not enough history yet.</div>'}
        ${(m.adjustments || []).length ? `<div class="hint" style="margin-top:10px"><b>Observed from your edits</b><br>${m.adjustments.slice(-6).reverse().map(esc).join('<br>')}</div>` : ''}</div>
    </div></div>`;
  const v = $('view');
  v.querySelectorAll('[data-rule]').forEach(x => x.onchange = async () => { await api('/api/rules', { id: x.dataset.rule, active: x.checked }); });
  v.querySelectorAll('[data-delrule]').forEach(x => x.onclick = async () => { if (confirm('Delete this rule?')) { await api('/api/rules', { id: x.dataset.delrule, remove: true }); renderMemory(); } });
  v.querySelectorAll('[data-delperson]').forEach(x => x.onclick = async () => { await api('/api/people', { id: x.dataset.delperson, remove: true }); renderMemory(); });
  $('ruleForm').onsubmit = async e => { e.preventDefault(); const t = $('ruleInput').value.trim(); if (!t) return; await api('/api/rules', { text: t }); renderMemory(); };
  $('personForm').onsubmit = async e => { e.preventDefault(); try { await api('/api/people', { name: e.target.name.value, email: e.target.email.value }); renderMemory(); } catch (err) { toast('⚠️ ' + err.message); } };
  $('relearn').onclick = async () => { await api('/api/relearn', {}); toast('Re-analysed your calendar'); renderMemory(); };
}

// ─── Settings ───
const PROVIDER_INFO = {
  'workers-ai': { name: 'Cloudflare Workers AI', note: 'Built in on the hosted app. Free daily allowance, no key.', key: null },
  gemini: { name: 'Google Gemini', note: 'Free key, ~1,000 requests/day on Flash-Lite.', key: 'geminiApiKey', model: 'geminiModel', url: 'https://aistudio.google.com/apikey' },
  groq: { name: 'Groq', note: 'Free key, very fast, generous daily limits.', key: 'groqApiKey', model: 'groqModel', url: 'https://console.groq.com/keys' },
  cerebras: { name: 'Cerebras', note: 'Free key, ~1M tokens/day.', key: 'cerebrasApiKey', model: 'cerebrasModel', url: 'https://cloud.cerebras.ai/' },
  openrouter: { name: 'OpenRouter', note: 'Free key; “:free” models.', key: 'openrouterApiKey', model: 'openrouterModel', url: 'https://openrouter.ai/keys' },
  mistral: { name: 'Mistral', note: 'Free “Experiment” plan key.', key: 'mistralApiKey', model: 'mistralModel', url: 'https://console.mistral.ai/api-keys' },
};
async function renderSettings() {
  topbar(`<h1>Settings</h1><span class="spacer"></span><button class="btn primary" id="saveTop">Save</button>`);
  const s = await api('/api/settings');
  setStatus(s);
  const b = s.booking || {};
  const bookUrl = `${location.origin}/book/${b.slug || ''}`;
  const dayBoxes = (name, val) => `<div class="daypick">${[1, 2, 3, 4, 5, 6, 0].map(d => `<label><input type="checkbox" name="${name}" value="${d}" ${(val || []).includes(d) ? 'checked' : ''}><span>${DAYS[d]}</span></label>`).join('')}</div>`;
  const v3 = s.google && s.bridgeVersion >= 3;
  $('view').className = 'view pad';
  $('view').innerHTML = `<form class="wrap settings" id="settingsForm" autocomplete="off">
    ${s.authEnabled ? `<section class="card" id="security"><h2>🔐 Security</h2><p class="hint">Sign in with your fingerprint or face (Windows Hello, Touch ID, Face ID) instead of the password. The key never leaves your device.</p><div id="securityBody" class="hint">Loading…</div></section>` : ''}
    <section class="card" id="iphone"><h2>📱 iPhone</h2><p class="hint">Use ${esc(s.agentName)} like a real app: on your Home Screen, with notifications and Siri.</p><div id="iphoneBody"></div></section>

    <section class="card"><h2>You</h2><p class="hint">${esc(s.agentName)} plans around how you actually live. It also learns these from what you say (“I wake up at 9:30”, “I only run in the evening”).</p>
      <div class="grid2"><label class="f">Your name<input name="userName" value="${esc(s.userName)}"></label><label class="f">Agent name<input name="agentName" value="${esc(s.agentName)}"></label>
        <label class="f">Wake-up (nothing auto-placed before)<input name="dayStart" type="time" value="${esc(s.dayStart)}"></label><label class="f">Wind-down (nothing auto-placed after)<input name="dayEnd" type="time" value="${esc(s.dayEnd)}"></label>
        <label class="f">Longest focus block (min)<input name="focusSpan" type="number" min="25" max="240" step="5" value="${s.focusSpan}"></label><label class="f">Break between blocks (min)<input name="breakMinutes" type="number" min="0" max="60" step="5" value="${s.breakMinutes}"></label>
        <label class="f">Night owl: “tomorrow” said before (empty = off)<input name="nightOwl" type="time" value="${esc(s.nightOwl)}"></label><label class="f">Home city (+ aliases, for trips)<input name="homeCity" value="${esc(s.homeCity)}" placeholder="Boston, Cambridge, BOS"></label>
        <label class="f">Theme<select id="themeSel"><option value="">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label></div>
      <label class="f" style="margin-top:12px">When activities happen (one per line: <code>words: times</code>) — enforced whenever ${esc(s.agentName)} picks a time
        <textarea name="activityWindows" rows="3" placeholder="run, jog: 06:00-08:00, 17:00-21:00&#10;gym: 18:00-22:00">${esc((s.activityWindows || []).map(a => `${a.match}: ${a.windows}`).join('\n'))}</textarea></label></section>

    <section class="card" id="cal-conn"><h2>Calendar</h2><p class="hint">Connect your Google Calendar through your own free Apps Script bridge. Nothing else gets access.</p>
      <div class="grid2"><label class="f">Calendar<select name="calendarMode" id="calendarMode"><option value="google" ${s.calendarMode === 'google' ? 'selected' : ''}>My Google Calendar</option><option value="local" ${s.calendarMode !== 'google' ? 'selected' : ''}>Practice calendar (inside this app)</option></select></label></div>
      <div id="googleFields" style="margin-top:12px">
        ${s.google && !v3 ? `<div class="banner warn" id="upgradeBanner">${ICON.warn}<div><b>Update your bridge to the latest version</b> to unlock recurring-series edits, all your calendars, Meet links, long-range search and email briefings. Two minutes, the URL stays the same:
          <ol><li>Open <a href="https://script.google.com/home" target="_blank" rel="noopener">script.google.com</a> → your bridge project.</li>
          <li>Replace <b>Code.gs</b> with <button type="button" class="btn sm" data-copy="code">${ICON.copy} Copy Code.gs</button></li>
          <li>Project Settings ⚙ → tick “Show appsscript.json” → replace it with <button type="button" class="btn sm" data-copy="manifest">${ICON.copy} Copy appsscript.json</button></li>
          <li>Run the <b>test</b> function once → Allow.</li>
          <li><b>Deploy → Manage deployments → ✏️ → Version: New version → Deploy.</b> Then press <i>Test connection</i> below.</li></ol></div></div>` : ''}
        ${v3 ? `<div class="banner info">${ICON.check}<div>Bridge connected${s.userEmail ? ' as <b>' + esc(s.userEmail) + '</b>' : ''}. All features on.</div></div>` : ''}
        <div class="grid2"><label class="f">Bridge URL (ends in /exec)<input name="bridgeUrl" value="${esc(s.bridgeUrl)}" placeholder="https://script.google.com/macros/s/…/exec"></label>
        <label class="f">Bridge token<input name="bridgeToken" type="password" value="${esc(s.bridgeToken)}" placeholder="TOKEN from Code.gs"></label></div>
        <div class="row" style="margin-top:10px"><button class="btn" type="button" id="testBridge">Test connection</button><span class="hint" id="bridgeState"></span></div>
      </div>
      <div id="moveCard" style="margin-top:14px"></div>
      <div id="localData" style="margin-top:12px"><p class="hint">Practice with sample data, or import a Google Calendar export (.ics).</p>
        <div class="row"><label class="btn">Import .ics…<input type="file" id="icsFile" accept=".ics,text/calendar" hidden></label><label class="check"><input type="checkbox" id="icsReplace"> replace current events</label><button class="btn" type="button" id="demoBtn">Load a demo fortnight</button></div></div>
    </section>

    <section class="card"><h2>AI models</h2><p class="hint">${esc(s.agentName)} tries these in order and skips any that are out of free quota, so it keeps working. Add a second free key for extra headroom.</p>
      <div>${(s.ai || []).map(p => { const info = PROVIDER_INFO[p.id]; return `<div class="provider"><span class="dot ${p.ready ? (p.blocked ? 'warn' : 'ok') : ''}"></span>
        <div><b>${info.name}</b> <span class="hint">· ${esc(p.model || '')}${p.callsToday ? ` · ${p.callsToday} call${p.callsToday === 1 ? '' : 's'} today` : ''}</span><div class="hint">${p.blocked ? `Resting until ${new Date(p.blocked.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}: ${esc(p.blocked.why)}` : esc(info.note)}${info.url ? ` <a href="${info.url}" target="_blank" rel="noopener">Get a key</a>` : ''}</div>
        ${info.key ? `<div class="grid2" style="margin-top:6px"><input name="${info.key}" type="password" value="${esc(s[info.key])}" placeholder="API key"><input name="${info.model}" value="${esc(s[info.model])}" placeholder="model"></div>` : `<div class="grid2" style="margin-top:6px"><input name="workersAiModel" value="${esc(s.workersAiModel)}"></div>`}</div>
        <span class="pill ${p.ready ? (p.blocked ? 'warn' : 'good') : ''}">${p.ready ? (p.blocked ? 'resting' : 'ready') : 'off'}</span></div>`; }).join('')}</div>
      <div class="grid2" style="margin-top:10px"><label class="f">Order (first = preferred)<input name="aiOrder" value="${esc((s.aiOrder || []).join(', '))}"></label></div>
      <div class="row" style="margin-top:10px"><button type="button" class="btn sm" id="aiReset">Retry resting models now</button></div>
    </section>

    <section class="card"><h2>Schedule</h2><p class="hint">Meetings are placed automatically only within meeting hours. Tasks, habits and personal plans may use your waking hours. A time you name yourself always wins.</p>
      <div class="grid2">
        <label class="f">Meetings from<input name="workStart" type="time" value="${esc(s.workStart)}"></label><label class="f">Meetings until<input name="workEnd" type="time" value="${esc(s.workEnd)}"></label>
      </div>
      <label class="f" style="margin-top:12px">Meeting days${dayBoxes('workDays', s.workDays)}</label>
      <div class="grid2" style="margin-top:12px">
        <label class="f">Buffer around high-stakes events (min)<input name="bufferMinutes" type="number" min="0" max="120" value="${s.bufferMinutes}"></label>
        <label class="f">Plan habits &amp; buffers this many days ahead<input name="planDaysAhead" type="number" min="1" max="14" value="${s.planDaysAhead}"></label>
        <label class="f">Default reminder (min)<input name="defaultReminder" type="number" min="0" max="1440" value="${s.defaultReminder}"></label>
      </div>
      <label class="f" style="margin-top:12px">High-stakes keywords (get buffers, never bumped)<input name="highStakesKeywords" value="${esc(s.highStakesKeywords)}"></label>
      <label class="f" style="margin-top:12px">Protected keywords (never moved unless you name them)<input name="protectedKeywords" value="${esc(s.protectedKeywords)}"></label>
      <label class="check" style="margin-top:12px"><input type="checkbox" name="meetDefault" ${s.meetDefault ? 'checked' : ''}> Add a Google Meet link to meetings with invited guests</label>
    </section>

    <section class="card"><h2>Autonomy &amp; briefings</h2>
      <label class="check"><input type="checkbox" name="autonomous" ${s.autonomous ? 'checked' : ''}> Act on my own: every 15 minutes, keep habits, task sessions and buffers in place and fix conflicts</label>
      <div class="grid2" style="margin-top:12px"><label class="f">Morning briefing at (empty = off)<input name="morningBriefing" type="time" value="${esc(s.morningBriefing)}"></label>
        <label class="f">Evening review at (empty = off)<input name="eveningReview" type="time" value="${esc(s.eveningReview)}"></label></div>
      <label class="check" style="margin-top:12px"><input type="checkbox" name="emailBriefing" ${s.emailBriefing ? 'checked' : ''} ${v3 ? '' : 'disabled'}> Also email the briefings to me${v3 ? '' : ' (needs bridge v3)'}</label>
      ${v3 ? '<div class="row" style="margin-top:8px"><button type="button" class="btn sm" id="testEmail">Send me a test briefing</button></div>' : ''}
    </section>

    <section class="card"><h2>Booking page</h2><p class="hint">A public link where others pick a free slot. ${esc(s.agentName)} books it with a Meet link and invites them. Only free times inside these hours are shown.</p>
      <label class="check"><input type="checkbox" name="booking.enabled" ${b.enabled ? 'checked' : ''}> Turn on my booking page</label>
      <div class="grid2" style="margin-top:12px">
        <label class="f">Link name<input name="booking.slug" value="${esc(b.slug)}" placeholder="your-name" pattern="[a-z0-9-]+"></label>
        <label class="f">Page title<input name="booking.title" value="${esc(b.title)}" placeholder="Meet with ${esc(s.userName || 'me')}"></label>
        <label class="f">Lengths offered (min)<input name="booking.durations" value="${esc((b.durations || []).join(', '))}"></label>
        <label class="f">From<input name="booking.start" type="time" value="${esc(b.start)}"></label><label class="f">Until<input name="booking.end" type="time" value="${esc(b.end)}"></label>
        <label class="f">Days ahead<input name="booking.daysAhead" type="number" min="1" max="60" value="${b.daysAhead}"></label>
        <label class="f">Minimum notice (hours)<input name="booking.minNoticeHours" type="number" min="0" max="168" value="${b.minNoticeHours}"></label>
        <label class="f">Max bookings per day<input name="booking.maxPerDay" type="number" min="1" max="20" value="${b.maxPerDay}"></label>
        <label class="f">Gap around bookings (min)<input name="booking.bufferMinutes" type="number" min="0" max="60" value="${b.bufferMinutes}"></label>
      </div>
      <label class="f" style="margin-top:12px">Days${dayBoxes('booking.days', b.days)}</label>
      <label class="f" style="margin-top:12px">Intro text<textarea name="booking.intro" rows="2" placeholder="Pick a time that works for you.">${esc(b.intro)}</textarea></label>
      ${b.enabled && b.slug ? `<div class="row" style="margin-top:12px"><code>${esc(bookUrl)}</code><button type="button" class="btn sm" id="copyBook">${ICON.copy} Copy link</button><a class="btn sm" href="${esc(bookUrl)}" target="_blank" rel="noopener">Open</a></div>` : ''}
    </section>

    <section class="card"><h2>Shortcuts</h2><div class="hint" style="line-height:2">
      <span class="kbd">Ctrl</span>+<span class="kbd">K</span> talk to ${esc(s.agentName)} · <span class="kbd">Ctrl</span>+<span class="kbd">J</span> show/hide chat · <span class="kbd">N</span> new event · <span class="kbd">T</span> today · <span class="kbd">←</span> <span class="kbd">→</span> previous/next · <span class="kbd">D</span>/<span class="kbd">W</span> day/week</div>
      <p class="hint">Install on your phone: open this site in Chrome/Safari → Share/⋮ → <b>Add to Home screen</b>.</p></section>

    <div class="row" style="margin-top:16px"><button class="btn primary">Save settings</button><span class="hint">Time zone: ${esc(s.timeZone)}</span><span class="spacer"></span>${s.authEnabled ? '<button class="btn danger" type="button" id="logoutBtn">Sign out</button>' : ''}</div>
  </form>`;
  const f = $('settingsForm');
  $('themeSel').value = store.get('theme', '');
  $('themeSel').onchange = e => { store.set('theme', e.target.value); applyTheme(); };
  const syncMode = () => { const g = $('calendarMode').value === 'google'; $('googleFields').classList.toggle('hidden', !g); $('localData').classList.toggle('hidden', g); };
  $('calendarMode').onchange = syncMode; syncMode();
  const collect = () => {
    const data = { booking: {} };
    const days = {};
    for (const el of f.elements) {
      if (!el.name || el.name === 'scope') continue;
      const [a, b2] = el.name.split('.');
      if (a === 'notify') { (data.notify = data.notify || {})[b2] = el.checked; continue; }
      const target = b2 ? data.booking : data;
      const key = b2 || a;
      if (el.type === 'checkbox' && (key === 'workDays' || key === 'days')) { (days[el.name] = days[el.name] || []); if (el.checked) days[el.name].push(+el.value); continue; }
      target[key] = el.type === 'checkbox' ? el.checked : el.value;
    }
    data.workDays = days.workDays || [];
    data.booking.days = days['booking.days'] || [];
    return data;
  };
  const save = async () => {
    try { const r = await api('/api/settings', collect()); setStatus(r); toast('Saved'); renderSettings(); } catch (err) { toast('⚠️ ' + err.message); }
  };
  f.onsubmit = e => { e.preventDefault(); save(); };
  $('saveTop').onclick = save;
  $('testBridge').onclick = async () => {
    $('bridgeState').textContent = 'Testing…';
    try {
      const r = await api('/api/bridge/test', { bridgeUrl: f.bridgeUrl.value, bridgeToken: f.bridgeToken.value, calendarMode: 'google' });
      $('bridgeState').innerHTML = `✅ ${esc(r.email || 'Connected')} · ${esc(r.timeZone)} · bridge v${r.version}${r.calendars && r.calendars.length ? ` · ${r.calendars.length} calendars` : ''} · ${r.ms} ms`;
      setTimeout(renderSettings, 1500);
    } catch (err) { $('bridgeState').textContent = '❌ ' + err.message; }
  };
  f.querySelectorAll('[data-copy]').forEach(btn => btn.onclick = async () => {
    try { const r = await api('/api/bridge/code'); await navigator.clipboard.writeText(btn.dataset.copy === 'code' ? r.code : r.manifest); toast('Copied. Paste it into the Apps Script editor.'); }
    catch (err) { toast('⚠️ ' + err.message); }
  });
  $('aiReset').onclick = async () => { await api('/api/ai/reset', {}); toast('Will retry every model on the next request'); renderSettings(); };
  $('testEmail')?.addEventListener('click', async () => { try { const r = await api('/api/briefing/send', { kind: 'morning' }); toast(r.ok ? `Sent to ${r.to}` : r.reason); } catch (err) { toast('⚠️ ' + err.message); } });
  $('copyBook')?.addEventListener('click', async () => { await navigator.clipboard.writeText(bookUrl); toast('Booking link copied'); });
  $('logoutBtn')?.addEventListener('click', async () => { await fetch('/api/logout', { method: 'POST' }); location.href = '/login.html'; });
  renderIphone(s);
  renderSecurity();
  if (s.google) renderMove();
  $('icsFile').onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    try { const r = await api('/api/import' + ($('icsReplace').checked ? '?replace=1' : ''), await file.text(), true); toast(`Imported ${r.imported} events`); } catch (err) { toast('⚠️ ' + err.message); }
    e.target.value = '';
  };
  $('demoBtn').onclick = async () => {
    if (!confirm('Replace the practice calendar with a demo fortnight? (Rules and settings stay.)')) return;
    try { const r = await api('/api/demo', {}); toast(`Loaded ${r.events} demo events`); loadChat(); } catch (err) { toast('⚠️ ' + err.message); }
  };
}

// ─── iPhone: home screen, notifications, Siri ───
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const b64uToBytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
// ─── Passkeys (Settings → Security) ───
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => { const t = s.replace(/-/g, '+').replace(/_/g, '/'); return Uint8Array.from(atob(t + '='.repeat((4 - t.length % 4) % 4)), c => c.charCodeAt(0)); };
const deviceName = () => /iPhone/.test(navigator.userAgent) ? 'iPhone' : /iPad/.test(navigator.userAgent) ? 'iPad' : /Android/.test(navigator.userAgent) ? 'Android phone'
  : /Windows/.test(navigator.userAgent) ? 'Windows laptop' : /Macintosh/.test(navigator.userAgent) ? 'Mac' : 'This device';
async function renderSecurity() {
  const box = $('securityBody');
  if (!box) return;
  let r;
  try { r = await api('/api/passkey/list'); } catch (e) { box.textContent = e.message; return; }
  const can = !!window.PublicKeyCredential;
  box.innerHTML = `<div class="list">${r.keys.map(k => `<div class="li"><div class="body"><div class="ttl">🔑 ${esc(k.name)}</div><div class="hint">Added ${esc(k.created.slice(0, 10))}${k.lastUsed ? ` · last used ${esc(k.lastUsed.slice(0, 10))}` : ''}</div></div><button class="btn sm ghost" type="button" data-pkdel="${esc(k.id)}">Remove</button></div>`).join('') || '<div class="hint">No passkeys yet.</div>'}</div>
    <div class="row" style="margin-top:10px">${can ? `<button class="btn primary" type="button" id="pkAdd">Add this device (${esc(deviceName())})</button>` : '<span class="hint">This browser does not support passkeys.</span>'}
    <button class="btn" type="button" id="revokeAll" title="Every other phone or laptop has to sign in again">Sign out all other devices</button></div>`;
  $('pkAdd')?.addEventListener('click', async e => {
    e.target.disabled = true;
    try {
      const fresh = await api('/api/passkey/list');
      const cred = await navigator.credentials.create({ publicKey: {
        challenge: unb64u(fresh.challenge), rp: { name: S.settings.agentName || 'Donna', id: fresh.rpId },
        user: { id: new TextEncoder().encode('donna-owner'), name: S.settings.userEmail || 'me', displayName: S.settings.userName || 'Me' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }, { type: 'public-key', alg: -8 }],
        authenticatorSelection: { userVerification: 'required', residentKey: 'required' },
        excludeCredentials: fresh.keys.map(k => ({ type: 'public-key', id: unb64u(k.id) })), timeout: 60000, attestation: 'none' } });
      const res = cred.response;
      if (!res.getPublicKey || !res.getPublicKey()) throw new Error('Please update this browser to add a passkey.');
      await api('/api/passkey/register', { id: cred.id, clientDataJSON: b64u(res.clientDataJSON), authenticatorData: b64u(res.getAuthenticatorData()),
        publicKey: b64u(res.getPublicKey()), alg: res.getPublicKeyAlgorithm(), name: deviceName() });
      store.set('passkey', true);
      toast(`Done. Next time, sign in on this ${deviceName()} with your fingerprint or face.`, { ms: 6000 });
    } catch (err) { toast('⚠️ ' + (err.name === 'InvalidStateError' ? 'This device already has a passkey.' : err.name === 'NotAllowedError' ? 'Cancelled.' : err.message)); }
    renderSecurity();
  });
  box.querySelectorAll('[data-pkdel]').forEach(b => b.onclick = async () => { if (!confirm('Remove this passkey? That device will need the password next time.')) return; await api('/api/passkey/remove', { id: b.dataset.pkdel }); renderSecurity(); });
  $('revokeAll')?.addEventListener('click', async () => {
    if (!confirm('Sign out every other phone and laptop? This one stays signed in.')) return;
    try { await api('/api/sessions/revoke', {}); toast('All other devices are signed out.'); } catch (err) { toast('⚠️ ' + err.message); }
  });
}

async function renderIphone(s) {
  const box = $('iphoneBody');
  if (!box) return;
  const origin = location.origin;
  const pushOk = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  let subscribed = false;
  try { const reg = await navigator.serviceWorker.getRegistration(); subscribed = !!(reg && await reg.pushManager.getSubscription()); } catch { /* unsupported */ }
  const n = s.notify || {};
  box.innerHTML = `
    <h3 style="font-size:13.5px;margin:6px 0 4px">1 · Home Screen app</h3>
    ${isStandalone() ? '<div class="hint">✅ You are using the Home Screen app.</div>' : `<div class="hint">In <b>Safari</b> on your iPhone open <code>${esc(origin)}</code>, tap <b>Share</b> (□↑) → <b>Add to Home Screen</b> → Add. Open ${esc(s.agentName)} from the new icon and sign in once; it stays signed in for a year.</div>`}
    <h3 style="font-size:13.5px;margin:16px 0 4px">2 · Notifications</h3>
    <div class="hint">Morning plan, evening review, changes ${esc(s.agentName)} makes on its own, and new bookings.${isIOS && !isStandalone() ? ' <b>On iPhone, turn them on from the Home Screen app</b> (iOS 16.4 or newer).' : ''}</div>
    <div class="row" style="margin-top:8px">
      ${pushOk ? `<button type="button" class="btn ${subscribed ? '' : 'primary'}" id="pushOn">${subscribed ? '✅ On for this device' : 'Turn on for this device'}</button>` : '<span class="hint">This browser can\'t receive notifications here.</span>'}
      ${subscribed ? '<button type="button" class="btn" id="pushTest">Send a test</button>' : ''}
    </div>
    <div class="row" style="margin-top:8px">
      <label class="check"><input type="checkbox" name="notify.briefings" ${n.briefings !== false ? 'checked' : ''}> Briefings</label>
      <label class="check"><input type="checkbox" name="notify.changes" ${n.changes !== false ? 'checked' : ''}> Changes made on its own</label>
      <label class="check"><input type="checkbox" name="notify.bookings" ${n.bookings !== false ? 'checked' : ''}> New bookings</label>
    </div>
    <h3 style="font-size:13.5px;margin:16px 0 4px">3 · “Hey Siri, Ask Donna”</h3>
    <div id="siriBox"><div class="hint">Talk to ${esc(s.agentName)} hands-free. One-time setup in the Shortcuts app, about a minute.</div>
      <div class="row" style="margin-top:8px"><button type="button" class="btn" id="siriKey">${s.siriKey ? 'Show setup again (makes a new link)' : 'Set up Siri'}</button></div></div>`;
  $('pushOn')?.addEventListener('click', enablePush);
  $('pushTest')?.addEventListener('click', async () => { const r = await api('/api/push/test', {}); toast(r.sent ? 'Sent — check your notifications' : 'No device received it. Turn notifications on again.'); });
  $('siriKey').onclick = async () => {
    if (s.siriKey && !confirm('This makes a new Siri link; the old one stops working. Continue?')) return;
    const r = await api('/api/siri/key', {});
    const link = `${origin}/api/siri?key=${r.key}`;
    $('siriBox').innerHTML = `<div class="banner info"><div style="width:100%">Your private Siri link (treat it like a password):
      <div class="row" style="margin:8px 0"><code style="word-break:break-all;flex:1">${esc(link)}</code><button type="button" class="btn sm" id="copySiri">${ICON.copy} Copy</button></div>
      <ol>
        <li>On your iPhone open <b>Shortcuts</b> → <b>+</b> → name it <b>Ask Donna</b>.</li>
        <li>Add the action <b>Dictate Text</b>.</li>
        <li>Add <b>Get Contents of URL</b> → paste the link → tap <b>›</b> → Method <b>POST</b> → Request Body <b>JSON</b> → <b>Add new field</b> → Text → key <code>message</code>, value <b>Dictated Text</b>.</li>
        <li>Add <b>Speak Text</b> (it speaks the Contents of URL).</li>
        <li>Done. Say <b>“Hey Siri, Ask Donna”</b>, then e.g. “move my DSA study to 9 pm”.</li>
      </ol></div></div>`;
    $('copySiri').onclick = async () => { await navigator.clipboard.writeText(link); toast('Copied. Paste it into Get Contents of URL.'); };
  };
}
async function enablePush() {
  try {
    if (isIOS && !isStandalone()) return toast('Open the app from your Home Screen first, then turn notifications on there.', { ms: 6000 });
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return toast('Notifications were not allowed. You can allow them in iPhone Settings → Notifications.', { ms: 6000 });
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    const { publicKey } = await api('/api/push/key');
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(publicKey) });
    const device = isIOS ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android' : 'Computer';
    await api('/api/push/subscribe', { subscription: sub.toJSON(), device });
    toast('Notifications are on for this device');
    await api('/api/push/test', {});
    renderSettings();
  } catch (err) { toast('⚠️ ' + err.message); }
}

// ─── Move to another Google account ───
async function renderMove() {
  const box = $('moveCard');
  if (!box) return;
  const m = await api('/api/move');
  const name = esc(S.settings.agentName || 'Donna');
  const step = (title, body) => `<div class="banner info" style="display:block"><b>${title}</b><div style="margin-top:6px">${body}</div></div>`;
  let html = '';
  if (m.stage === 'idle' || !m.stage) {
    html = `<div class="row"><div class="hint" style="flex:1">Want your calendar in a different Google account (for example the one your iPhone uses)? ${name} can copy everything over and switch to it.</div>
      <button type="button" class="btn" id="mvStart">Move to another Google account</button></div>`;
  } else if (m.stage === 'setup') {
    html = step('Step 1 of 3 · Make a bridge in the new account', `On a computer, open a <b>private/incognito window</b> and sign in to Google as the <b>new</b> account only (so nothing gets created in the old one).
      <ol><li>Go to <a href="https://script.google.com/home" target="_blank" rel="noopener">script.google.com</a> → <b>New project</b>.</li>
      <li>Delete what's there and paste <button type="button" class="btn sm" data-mvcopy="code">${ICON.copy} Copy Code.gs</button> (it already has a fresh secret token).</li>
      <li>⚙ Project Settings → tick <b>Show "appsscript.json"</b> → open it and replace everything with <button type="button" class="btn sm" data-mvcopy="manifest">${ICON.copy} Copy appsscript.json</button></li>
      <li>Back in the editor pick the function <b>test</b> → <b>Run</b> → <b>Review permissions</b> → choose the new account → Advanced → Go to project → <b>Allow</b>.</li>
      <li><b>Deploy → New deployment</b> → ⚙ <b>Web app</b> → Execute as <b>Me</b>, Who has access <b>Anyone</b> → Deploy → copy the <b>Web app URL</b>.</li></ol>
      <div class="row" style="margin-top:8px"><input id="mvUrl" placeholder="https://script.google.com/macros/s/…/exec" style="flex:1;min-width:220px"><button type="button" class="btn primary" id="mvConnect">Connect</button></div>`) +
      '<div class="row" style="margin-top:6px"><button type="button" class="btn sm ghost" id="mvCancel">Cancel the move</button></div>';
  } else if (m.stage === 'connected' || m.stage === 'exported' || m.stage === 'importing') {
    const accessText = { owner: 'can edit', writer: 'can edit', reader: 'can see (not edit)', '': 'cannot see' }[m.access] || m.access;
    html = step('Step 2 of 3 · Copy your calendar', `Connected to <b>${esc(m.email)}</b>. That account ${accessText} <b>${esc(m.oldEmail)}</b>'s calendar.` +
      (m.needsOldUpdate ? `<div class="banner warn" style="margin-top:8px;display:block"><b>One more thing:</b> to ${m.sourceVia === 'old' ? 'read and ' : ''}tidy up the old calendar, update the bridge in <b>${esc(m.oldEmail)}</b> (the one ${name} uses now): open it at script.google.com → replace Code.gs with <button type="button" class="btn sm" data-copy="code">${ICON.copy} Copy Code.gs</button> → replace appsscript.json with <button type="button" class="btn sm" data-copy="manifest">${ICON.copy} Copy appsscript.json</button> → Run <b>test</b> → Allow → Deploy → Manage deployments → ✏️ → New version → Deploy.
        <div class="row" style="margin-top:8px"><button type="button" class="btn" id="mvRecheck">I've updated it</button></div></div>` :
      `<p>${name} copies everything from <b>20 days ago onward</b> into ${esc(m.email)}: repeating events stay repeating, edited or skipped occurrences are kept, guests and Meet links are kept as notes, and <b>nobody gets an email</b>. Nothing is deleted in this step.</p>
        <div class="row"><button type="button" class="btn primary" id="mvCopy">${m.total ? 'Continue copying' : 'Copy my calendar'}</button><span class="hint" id="mvProg">${m.total ? `${m.imported} of ${m.total} copied` : ''}</span></div>`)) +
      '<div class="row" style="margin-top:6px"><button type="button" class="btn sm ghost" id="mvCancel">Cancel the move</button></div>';
  } else if (m.stage === 'imported') {
    html = step('Step 3 of 3 · Switch and tidy up', `Copied <b>${m.imported}</b> items to ${esc(m.email)} (${m.summary ? `${m.summary.series} repeating series, ${m.summary.singles} single events` : ''})${m.failed ? `, <b>${m.failed} failed</b>: ${m.errors.map(esc).join('; ')}` : ''}. Check them in Google Calendar on your iPhone if you like.
      <p>Finishing switches ${name} to <b>${esc(m.email)}</b>, then removes the copied events from <b>${esc(m.oldEmail)}</b> (only ones copied successfully${m.skippedInvites ? `; ${m.skippedInvites} invitation(s) from other people stay there, since removing them would notify the organisers` : ''}). Events before ${esc(m.cutoff.slice(0, 10))} stay in the old account as history. A full backup was saved first.</p>
      <div class="row"><button type="button" class="btn primary" id="mvFinish">Switch to ${esc(m.email)} and remove the old copies</button><span class="hint" id="mvProg"></span></div>`);
  } else if (m.stage === 'switched' || m.stage === 'cleaning') {
    html = step('Finishing', `${name} now runs on <b>${esc(m.email)}</b>. Removing copies from ${esc(m.oldEmail)}: ${m.cleaned} of ${m.cleanable} done.` +
      (m.needsOldUpdate ? '<div class="hint" style="margin-top:6px">Update the old bridge first (see above), then continue.</div>' : '') +
      '<div class="row" style="margin-top:8px"><button type="button" class="btn primary" id="mvClean">Continue</button><span class="hint" id="mvProg"></span></div>');
  } else if (m.stage === 'done') {
    html = `<div class="banner info" style="display:block">✅ <b>Moved to ${esc(m.email)}.</b> ${m.cleaned} copied items were removed from ${esc(m.oldEmail)}.${m.skippedInvites ? ` ${m.skippedInvites} invitation(s) from other people were left there.` : ''}
      <div style="margin-top:6px">To be sure nothing shows twice on your iPhone: <b>Settings → Calendar → Accounts</b> → if ${esc(m.oldEmail)} is listed, turn its <b>Calendars</b> off. If you had subscribed to the old calendar inside ${esc(m.email)}, untick it in the Calendar app → Calendars.</div></div>`;
  }
  box.innerHTML = html;
  // While moving accounts, the old bridge's upgrade banner only confuses (the move step says if it is needed).
  $('upgradeBanner')?.classList.toggle('hidden', !['idle', 'done', undefined].includes(m.stage));
  const run = async (btn, fn) => { btn.disabled = true; try { await fn(); } catch (err) { toast('⚠️ ' + err.message, { ms: 7000 }); } btn.disabled = false; renderMove(); };
  const prog = t => { const p = $('mvProg'); if (p) p.textContent = t; };
  $('mvStart')?.addEventListener('click', e => run(e.target, () => api('/api/move/start', {})));
  $('mvCancel')?.addEventListener('click', e => { if (confirm('Cancel the move? Nothing has been deleted.')) run(e.target, () => api('/api/move/cancel', {})); });
  box.querySelectorAll('[data-mvcopy]').forEach(b => b.onclick = async () => { const r = await api('/api/move/code'); await navigator.clipboard.writeText(b.dataset.mvcopy === 'code' ? r.code : r.manifest); toast('Copied. Paste it in the new account\'s Apps Script editor.'); });
  box.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => { const r = await api('/api/bridge/code'); await navigator.clipboard.writeText(b.dataset.copy === 'code' ? r.code : r.manifest); toast('Copied. Paste it in the old account\'s bridge project.'); });
  $('mvConnect')?.addEventListener('click', e => run(e.target, () => api('/api/move/connect', { url: $('mvUrl').value })));
  $('mvRecheck')?.addEventListener('click', e => run(e.target, () => api('/api/move/recheck', {})));
  $('mvCopy')?.addEventListener('click', e => run(e.target, async () => {
    let st = await api('/api/move');
    if (st.stage === 'connected') { prog('Reading your calendar… (can take a minute)'); st = await api('/api/move/export', {}); }
    while (st.stage === 'exported' || st.stage === 'importing') { prog(`Copying… ${st.imported} of ${st.total}`); st = await api('/api/move/import', {}); }
    toast(`Copied ${st.imported} of ${st.total}`);
  }));
  $('mvFinish')?.addEventListener('click', e => {
    if (!confirm(`Switch ${S.settings.agentName || 'Donna'} to ${m.email} and remove the copied events from ${m.oldEmail}?`)) return;
    run(e.target, async () => {
      let st = await api('/api/move/switch', {});
      while (st.stage === 'switched' || st.stage === 'cleaning') { prog(`Tidying the old calendar… ${st.cleaned} of ${st.cleanable}`); const before = st.cleaned; st = await api('/api/move/cleanup', {}); if (st.stage === 'cleaning' && st.cleaned === before) break; }
      toast(st.stage === 'done' ? 'All done — your calendar now lives in ' + st.email : 'Some old copies could not be removed; press Continue to retry.', { ms: 7000 });
    });
  });
  $('mvClean')?.addEventListener('click', e => run(e.target, async () => {
    let st = await api('/api/move');
    while (st.stage === 'switched' || st.stage === 'cleaning') { prog(`${st.cleaned} of ${st.cleanable}`); const before = st.cleaned; st = await api('/api/move/cleanup', {}); if (st.stage === 'cleaning' && st.cleaned === before) break; }
  }));
}

// ─── More (mobile) ───
async function renderMore() {
  topbar('<h1>More</h1>');
  $('view').className = 'view pad';
  $('view').innerHTML = `<div class="wrap"><div class="card"><div class="list">${['habits', 'insights', 'activity', 'memory', 'settings'].map(v => `<div class="li" style="cursor:pointer" data-go="${v}"><div class="body"><div class="ttl">${TITLES[v]}</div></div>${ICON.right}</div>`).join('')}</div></div>
    <div class="hint" style="text-align:center;margin-top:12px">${esc($('statusText').textContent)}</div></div>`;
  $('view').querySelectorAll('[data-go]').forEach(x => x.onclick = () => setView(x.dataset.go));
}

// ─── Chat ───
const PENDING = ['Thinking…', 'Finding the best times…', 'Making the changes…', 'Double-checking…', 'Almost there…'];
let feedbackState = {};
function actionRows(actions) {
  const mine = actions.filter(a => !a.auto), auto = actions.filter(a => a.auto);
  const row = a => {
    const st = feedbackState[a.id];
    return `<div class="act ${st ? 'done' : ''} ${a.auto ? 'auto' : ''}" data-id="${esc(a.id)}"><span class="id">${esc(a.id)}</span><span class="sum">${esc(a.summary)}</span>
      ${/\(undo of/.test(a.summary) ? '' : `<span class="fb">${st ? `<span class="hint">${esc(st)}</span>` : '<button title="Good — keep doing this" data-v="Good">👍</button><button title="Bad — undo and learn" data-v="Bad">👎</button>'}</span>`}</div>`;
  };
  if (!actions.length) return '';
  const list = mine.length ? mine : auto;
  const rest = mine.length ? auto : [];
  const shown = list.slice(0, 6), hidden = [...list.slice(6), ...rest];
  return `<div class="acts">${shown.map(row).join('')}${hidden.length ? `<button class="more-acts" data-more>+ ${hidden.length} more change${hidden.length === 1 ? '' : 's'}${rest.length && !list.slice(6).length ? ' (automatic)' : ''}</button><div class="hidden">${hidden.map(row).join('')}</div>` : ''}</div>`;
}
function addMsg(m) {
  const d = document.createElement('div');
  d.className = 'msg ' + (m.role === 'user' ? 'user' : 'assistant') + (m.briefing ? ' briefing' : '');
  d.innerHTML = (m.role === 'user' ? `<p>${esc(m.text)}</p>` : md(m.text)) + actionRows(m.actions || []) +
    (m.time ? `<span class="time">${esc(relDay(m.time.slice(0, 10), S.today))} ${clock(m.time)}${m.model ? ' · ' + esc(m.model.split('/').pop()) : ''}</span>` : '');
  $('messages').appendChild(d);
  return d;
}
async function loadChat() {
  const [msgs, acts] = await Promise.all([api('/api/chat'), api('/api/activity')]);
  snap.set('chat', { msgs: msgs.slice(-40), acts: acts.slice(0, 120) });
  paintChat(msgs, acts);
}
function paintChat(msgs, acts) {
  feedbackState = {};
  acts.forEach(a => { if (a.status === 'reverted') feedbackState[a.id] = 'undone'; else if (a.feedback) feedbackState[a.id] = a.feedback.split(':')[0]; });
  $('messages').innerHTML = '';
  if (!msgs.length) addMsg({ role: 'assistant', text: `Hi! I'm ${S.settings.agentName || 'Donna'}. I run your calendar on my own — booking, moving, clearing, recurring plans, study sessions for deadlines, habits — and every change can be undone.\n\nJust tell me what you need, in plain words or Hinglish.` });
  msgs.forEach(addMsg);
  $('messages').scrollTop = $('messages').scrollHeight;
  renderSuggestions();
}
function renderSuggestions() {
  const list = ['Plan my day…', 'I just woke up', "What's next?", "What's tomorrow?", '10 hours of CFA a week', 'OS assignment due Friday, 3 hours', 'Undo that'];
  $('suggest').innerHTML = list.map(x => `<button class="chip" type="button">${esc(x)}</button>`).join('');
}
$('suggest').addEventListener('click', e => { if (!e.target.classList.contains('chip')) return; if (e.target.textContent === 'Plan my day…') openPlanner(); else ask(e.target.textContent); });
document.addEventListener('click', e => {
  const a = e.target.closest('[data-ask]');
  if (a) ask(a.dataset.ask);
});
$('messages').addEventListener('click', async e => {
  if (e.target.closest('[data-more]')) { const b = e.target.closest('[data-more]'); b.nextElementSibling.classList.remove('hidden'); b.remove(); return; }
  const btn = e.target.closest('.fb button');
  if (!btn) return;
  await feedback(btn.closest('.act').dataset.id, btn.dataset.v);
});
async function feedback(id, verdict) {
  let reason = '';
  if (verdict === 'Bad') {
    reason = prompt(`What was wrong with ${id}? I'll undo it and turn your reason into a rule.\n(Optional, but it makes me smarter.)`, '');
    if (reason === null) return;
  }
  try { const r = await api('/api/feedback', { id, verdict, reason }); toast(r.text.split('\n')[0]); } catch (err) { toast('⚠️ ' + err.message); }
  await loadChat();
  render();
}
function ask(text, send = true) {
  if (innerWidth < 980) setView('chat');
  else if ($('app').classList.contains('chat-closed')) toggleChat(true);
  $('input').value = text; autosize();
  if (send) $('composer').requestSubmit(); else { $('input').focus(); $('input').setSelectionRange(text.length, text.length); }
}
let sending = false;
$('composer').onsubmit = async e => {
  e.preventDefault();
  const text = $('input').value.trim();
  if (!text || sending) return;
  sending = true;
  $('input').value = ''; autosize();
  addMsg({ role: 'user', text });
  const pending = document.createElement('div');
  pending.className = 'msg assistant pending';
  pending.innerHTML = '<span class="typing"><i></i><i></i><i></i></span><span class="pl">' + PENDING[0] + '</span>';
  $('messages').appendChild(pending);
  $('messages').scrollTop = $('messages').scrollHeight;
  let i = 0;
  const tick = setInterval(() => { i = Math.min(i + 1, PENDING.length - 1); pending.querySelector('.pl').textContent = PENDING[i]; }, 3500);
  $('sendBtn').disabled = true;
  try {
    // The server answers within ~45 s whatever happens; past that something is really wrong.
    await api('/api/chat', { message: text }, false, { timeout: 70000 });
    await loadChat();
    if (S.view !== 'settings') render();
  } catch (err) {
    pending.classList.remove('pending');
    pending.innerHTML = `<p>⚠️ ${esc(err.message)}</p>`;
    // It may still have finished on the server: pick up the reply if it lands.
    setTimeout(() => loadChat().then(() => render()).catch(() => {}), 8000);
  }
  clearInterval(tick);
  $('sendBtn').disabled = false; sending = false;
  if (innerWidth >= 980) $('input').focus();
};
function autosize() { const t = $('input'); t.style.height = 'auto'; t.style.height = Math.min(160, t.scrollHeight) + 'px'; }
$('input').addEventListener('input', autosize);
$('input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('composer').requestSubmit(); } });
$('clearChat').onclick = async () => { if (!confirm('Clear the conversation? (Changes and the activity log stay.)')) return; await api('/api/chat/clear', {}); loadChat(); };
function toggleChat(open) {
  const app = $('app');
  const closed = open === undefined ? !app.classList.contains('chat-closed') : !open;
  app.classList.toggle('chat-closed', closed);
  store.set('chatClosed', closed);
  if (!closed) $('input').focus();
  if (S.view === 'calendar') setTimeout(drawGrid, 10);
}
$('closeChat').onclick = () => toggleChat(false);

// Voice input (Chrome / Edge / Safari): speak a request.
(() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { $('mic').style.display = 'none'; return; }
  let rec = null;
  $('mic').onclick = () => {
    if (rec) { rec.stop(); return; }
    rec = new SR();
    rec.lang = navigator.language || 'en-IN';
    rec.interimResults = true;
    rec.onresult = e => { $('input').value = [...e.results].map(r => r[0].transcript).join(''); autosize(); };
    rec.onend = () => { $('mic').classList.remove('on'); const t = $('input').value.trim(); rec = null; if (t) $('composer').requestSubmit(); };
    rec.onerror = () => { $('mic').classList.remove('on'); rec = null; };
    $('mic').classList.add('on');
    rec.start();
  };
})();

// ─── Keyboard ───
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); ask('', false); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j') { e.preventDefault(); toggleChat(); return; }
  if (e.target.closest('input, textarea, select, dialog') || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'n') openEditor({ start: roundNow(), end: addMin(roundNow(), 30), kind: 'meeting' });
  else if (k === 't') { S.anchor = S.today; S.view === 'calendar' ? renderCalendar() : setView('today'); }
  else if (S.view === 'calendar' && (k === 'arrowleft' || k === 'arrowright')) $(k === 'arrowleft' ? 'prev' : 'next').click();
  else if (S.view === 'calendar' && (k === 'd' || k === 'w')) { S.calView = k === 'd' ? 'day' : 'week'; store.set('calView', S.calView); renderCalendar(); }
  else if (k === 'c') setView('calendar');
});

// ─── Theme ───
function applyTheme() { const t = store.get('theme', ''); if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; }
applyTheme();

// ─── Boot ───
(() => {
  if (store.get('chatClosed', false) && innerWidth >= 980) $('app').classList.add('chat-closed');
  const v = location.hash.slice(1);
  // Nothing waits on the network to show up: last-known settings, view and chat paint first.
  const known = store.get('settings', null);
  if (known) setStatus(known);
  setView(TITLES[v] ? v : 'today', { push: false });
  renderMini();
  const chatSnap = snap.get('chat');
  if (chatSnap) paintChat(chatSnap.msgs, chatSnap.acts);
  loadChat().catch(() => {});
  api('/api/settings').then(setStatus).catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
// Keep the view fresh: the agent works in the background. Coming back to the app re-checks Google.
let lastRender = Date.now();
const refresh = () => {
  if (document.visibilityState !== 'visible' || $('editor').open || $('planner').open || popEl || sending || pointerDown) return;
  lastRender = Date.now();
  if (S.view === 'today' || S.view === 'calendar') render();
};
setInterval(refresh, 90000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - lastRender > 30000) { refresh(); syncNow(); } });
window.addEventListener('resize', debounce(() => { if (S.view === 'calendar') drawGrid(); }, 200));
