// Day planner (no AI): "plan my day", "maximise productivity", "I woke up late — re-plan from now".
// The model only lists what the user wants; code places it around fixed commitments, inside waking
// hours, the user's focus span, breaks and activity times (e.g. runs only early morning or evening),
// fills gaps when asked, pushes what doesn't fit to the next day — and never cancels anything.
import * as T from './time.js';
import * as cal from './calendar.js';
import { load, save, settings } from './store.js';
import { TOOLS, RUN, realId, isAgentBlock, isTimed, isPing, activityWindows, windowFor, logAction, markWrite, markCreate } from './engine.js';
import { ensureRange } from './sync.js';
import { demandOf, energy, scoreSlot, freeAround } from './smart.js';

const STEP = 5;
const MIN_BLOCK = 30;
// Things that happen at a set time with other people or places: a re-plan never moves them.
const FIXED = /\b(lecture|lab|class|tutorial|seminar|exam|mid-?term|end-?sem|viva|test|quiz|ica|assessment|evaluation|eval|presentation|submission|interview|flight|train|bus|concert|appointment|doctor|dentist|wedding|party|celebration|ceremony|function|busy|travel|match)(e?s)?\b/i;
// …unless the title says it is the user's own study / practice block ("Mid Term Prep", "CFA: Study Block and Quiz").
const OWN_WORK = /\b(study (?:block|session)|self[- ]study|practice|revision|revise|prep|preparation|block|session|leetcode|dsa|homework|deep dive)\b/i;
const PERSONAL = /\b(run|running|jog|jogging|walk|gym|workout|exercise|yoga|swim|meditat\w*|lunch|dinner|breakfast|nap|rest|shower|meal|cook\w*|marathon)\b/i;
const MEAL = /\b(lunch|dinner|meal|breakfast|brunch)\b/i;
const DEFAULT_MINUTES = [[/\b(run|jog|walk|gym|workout|exercise|yoga)\b/i, 60], [/\b(lunch|dinner|meal)\b/i, 30], [/\b(nap|rest|break)\b/i, 20], [/\b(review|reading|read)\b/i, 45]];

const GENERIC = new Set(['study', 'work', 'session', 'block', 'practice', 'time', 'task', 'hours', 'hour', 'h', 'min', 'mins', 'and', 'the', 'my', 'of', 'for', 'with', 'to', 'a', 'on', 'new']);
const wordsOf = t => String(t || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w && !/^\d+$/.test(w));
/** Does the user's item name an event already on the day? ("Run" ≈ "Marathon Run: 5k Long Run") */
export function sameThing(item, title) {
  const x = wordsOf(item), y = new Set(wordsOf(title));
  const key = x.filter(w => !GENERIC.has(w));
  return key.length > 0 && x.filter(w => !['and', 'the', 'my', 'of', 'for', 'with', 'to', 'a', 'on'].includes(w)).every(w => y.has(w) || y.has(w + 's') || y.has(w.replace(/s$/, '')));
}

/** Did the user's message give this item a length ("CFA for 2 hours", "run 1.5h")? */
export function statedLength(title, text) {
  const t = String(text || '').toLowerCase();
  const key = wordsOf(title).filter(w => !GENERIC.has(w) && w.length > 2);
  for (const w of key) {
    const i = t.indexOf(w);
    if (i < 0) continue;
    const near = t.slice(Math.max(0, i - 12), i + w.length + 45).split(/[,;\n]| and /).find(p => p.includes(w)) || '';
    if (/\d+(?:\.\d+)?\s*(?:h\b|hrs?|hours?|mins?|minutes?|ghant)|\b(?:an|one|half an?|two|three) hours?\b/.test(near)) return true;
  }
  return false;
}

/** Can a re-plan move this event? The user's own solo blocks yes; classes, labs, meetings, travel no. */
export function isMovableSolo(e) {
  if (!isTimed(e) || e.readOnly || e.organizer === false || (e.guests || []).length || e.kind === 'buffer' || isPing(e)) return false;
  if (isAgentBlock(e)) return true;
  if (e.highStakes || (e.protected && !e.agent)) return false;
  if ((FIXED.test(e.title) || FIXED.test(e.description || '')) && !OWN_WORK.test(e.title)) return false;
  return true;
}

const round = m => Math.ceil(m / STEP) * STEP;
const hmOf = (x, fallback) => (T.isHM(x) ? T.hm(x) : x === '24:00' ? 1440 : fallback);
/** Intersects two sorted lists of [a, b) minute ranges. */
function intersect(xs, ys) {
  const out = [];
  for (const [a, b] of xs) for (const [c, e] of ys) { const lo = Math.max(a, c), hi = Math.min(b, e); if (hi > lo) out.push([lo, hi]); }
  return out.sort((p, q) => p[0] - q[0]);
}
const fmt = m => T.toHM(Math.min(m, 1439));
const dur = m => m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ' ' + (m % 60) + 'm' : ''}` : `${m}m`;

/** Minutes of day d an event covers, clipped to the day. */
function span(e, d) {
  const a = T.day(e.start) < d ? 0 : T.mins(e.start);
  const b = T.day(e.end) > d ? 1440 : (T.mins(e.end) || 1440);
  return [a, b];
}

/**
 * Places items on one day. Pure: works on minute ranges and returns the placements.
 * @returns {{placed: object[], unplaced: object[]}}
 */
function place({ items, obstacles, S, E, brk, focus, compress, fill, fillers, meals, d, s, wake = S, sleep = E, today = false, variant = {} }) {
  const busy = obstacles.map(o => [o.a, o.b]);
  const placed = [], unplaced = [];
  const fits = (t, len, gap = brk) => busy.every(([a, b]) => b + gap <= t || a >= t + len + gap);
  const put = (it, t, len, part) => { placed.push({ it, a: t, b: t + len, part }); busy.push([t, t + len]); };
  const earliest = (ws, len, from) => {
    for (const [lo, hi] of ws) {
      for (let t = round(Math.max(lo, from)); t + len <= hi; t += STEP) if (fits(t, len)) return t;
    }
    return null;
  };
  // The best start, not the first: energy for the kind of work, no wasted scraps, parts spread out.
  const best = (ws, len, it, from) => {
    const same = placed.filter(p => p.it === it);
    const neighbors = [...obstacles.map(o => ({ a: o.a, b: o.b, demand: o.demand })), ...placed.map(p => ({ a: p.a, b: p.b, demand: p.it.demand }))];
    let top = null;
    for (const [lo, hi] of ws) {
      for (let t = round(Math.max(lo, from)); t + len <= hi; t += STEP) {
        if (!fits(t, len)) continue;
        const sc = scoreSlot(t, len, { demand: it.demand, wake, sleep, from: S, earlyWeight: today ? 0.08 : 0.04, ideal: it.ideal ?? null, idealWeight: it.meal ? 0.4 : 1.4,
          free: freeAround(t, len, busy, brk, S, E), neighbors, same, brk });
        if (!top || sc > top.sc + 1e-9) top = { t, sc };
      }
    }
    return top;
  };
  const windows = it => {
    if (it.at != null) return [[it.at, it.at + it.len]];
    let ws = [[S, E]];
    if (it.after != null) ws = intersect(ws, [[it.after, 1440]]);
    if (it.before != null) ws = intersect(ws, [[0, it.before]]);
    const act = activityWindows(it.title, s);
    if (act) { ws = intersect(ws, act.windows); it.actLabel = act.label; }
    if (it.kind === 'meeting') { const w = windowFor(d, 'meeting', s); ws = w ? intersect(ws, [w]) : []; }
    return ws;
  };
  const shrink = m => compress ? Math.max(MIN_BLOCK, round(m * 0.8) - (round(m * 0.8) % STEP)) : m;
  const chunks = it => {
    const total = shrink(it.minutes);
    if (it.ev || !it.split || it.kind === 'personal' || total <= focus) return [total];
    const n = Math.ceil(total / focus);
    const each = Math.max(MIN_BLOCK, Math.round(total / n / STEP) * STEP);
    return Array.from({ length: n }, (_, i) => (i < n - 1 ? each : Math.max(MIN_BLOCK, total - each * (n - 1))));
  };

  // 1. Times the user fixed.
  for (const it of items.filter(x => x.at != null)) {
    it.len = shrink(it.minutes);
    if (it.at < S || it.at + it.len > 1440) { unplaced.push({ it, minutes: it.len, why: `${fmt(it.at)} is outside ${fmt(S)}–${fmt(E)}` }); continue; }
    const clash = busy.find(([a, b]) => a < it.at + it.len && b > it.at);
    put(it, it.at, it.len, 0);
    if (clash) placed[placed.length - 1].clash = true;
  }
  // 2. Re-flowed events keep their order and their time when it still works; displaced ones ripple later.
  for (const it of items.filter(x => x.reflow && x.at == null).sort((x, y) => x.orig - y.orig)) {
    it.len = shrink(it.minutes);
    const ws = windows(it);
    // Still free where it is (back-to-back is fine for what was already planned)? Then it stays.
    const inWin = ws.some(([lo, hi]) => it.orig >= lo && it.orig + it.len <= hi);
    const t = it.orig >= S && inWin && fits(it.orig, it.len, 0) ? it.orig : earliest(ws, it.len, Math.max(it.orig, S));
    if (t !== null) put(it, t, it.len, 0);
    else {
      const t2 = earliest(ws, it.len, S); // it may still fit earlier than its old time
      if (t2 !== null) put(it, t2, it.len, 0); else unplaced.push({ it, minutes: it.len, why: 'no room left today' });
    }
  }
  // 3. Meals, items with their own time limits (narrowest first), then the rest — in the variant's order.
  const fresh = items.filter(x => !x.reflow && x.at == null);
  const mealItems = meals.map((m, i) => ({ title: m.title, minutes: 30, kind: 'personal', after: m.from, before: m.to, ideal: m.from + 45, meal: true, demand: 'meal', order: -10 + i, split: false }));
  const constrained = it => it.after != null || it.before != null || !!activityWindows(it.title, s);
  // What matters most first; deep work before light (it needs the peak hours) unless the variant keeps the user's order.
  const weight = { deep: 0, physical: 1, social: 1, neutral: 2, light: 3, meal: 4 };
  const rest = fresh.filter(x => !constrained(x)).sort((x, y) => (x.rank - y.rank) || (variant.deepFirst ? weight[x.demand] - weight[y.demand] : 0)
    || (variant.longFirst ? y.minutes - x.minutes : 0) || (x.order - y.order));
  const narrow = fresh.filter(constrained).sort((x, y) => windows(x).reduce((n, [a, b]) => n + b - a, 0) - windows(y).reduce((n, [a, b]) => n + b - a, 0));
  const ordered = variant.mealsFirst === false ? [...narrow, ...rest, ...mealItems] : [...mealItems, ...narrow, ...rest];
  let mealsMissed = 0;
  for (const it of ordered) {
    const ws = windows(it);
    let left = 0;
    const parts = chunks(it);
    parts.forEach(len => {
      let got = best(ws, len, it, S);
      let use = len;
      // Doesn't fit whole: the longest piece that still fits (never a scrap under MIN_BLOCK).
      for (let n = len - 15; !got && n >= MIN_BLOCK && !it.meal && it.split; n -= 15) { got = best(ws, n, it, S); use = n; }
      if (!got) { left += len; return; }
      put(it, got.t, use, parts.length > 1 ? 1 : 0);
      Object.assign(placed[placed.length - 1], { of: parts.length, sc: got.sc });
      left += len - use;
    });
    // Parts are numbered in the order they happen.
    placed.filter(p => p.it === it && p.part).sort((x, y) => x.a - y.a).forEach((p, i) => { p.part = i + 1; });
    if (it.meal && left) mealsMissed++;
    if (left >= MIN_BLOCK / 2 && !it.meal) unplaced.push({ it, minutes: left, partial: left < it.minutes, why: ws.length ? 'no room left today' : `only done at ${it.actLabel || 'other times'}` });
  }
  // 3b. Something didn't fit: slide the new blocks up against what comes before them, so the scattered
  //     scraps of free time join into usable stretches, then try the leftovers again.
  if (unplaced.some(u => u.why === 'no room left today')) {
    for (const p of placed.filter(p => !p.it.ev && p.it.at == null).sort((x, y) => x.a - y.a)) {
      const i = busy.findIndex(([a, b]) => a === p.a && b === p.b);
      if (i < 0) continue;
      busy.splice(i, 1);
      const len = p.b - p.a;
      const t = earliest(windows(p.it).filter(([lo, hi]) => lo <= p.a && hi >= p.a + len).map(([lo]) => [lo, p.a + len]), len, S);
      if (t !== null && t < p.a) { p.a = t; p.b = t + len; }
      busy.push([p.a, p.b]);
    }
    for (const u of unplaced.filter(x => x.why === 'no room left today').sort((x, y) => x.it.rank - y.it.rank)) {
      const ws = windows(u.it);
      for (let n = u.minutes; n >= MIN_BLOCK && u.minutes >= MIN_BLOCK / 2; n -= 15) {
        const got = best(ws, Math.min(n, focus), u.it, S);
        if (!got) continue;
        const use = Math.min(n, focus);
        put(u.it, got.t, use, 0);
        Object.assign(placed[placed.length - 1], { sc: got.sc, extra: true });
        u.minutes -= use;
        n = u.minutes + 15;
      }
    }
    for (let i = unplaced.length - 1; i >= 0; i--) if (unplaced[i].minutes < 20) unplaced.splice(i, 1);
  }
  // 4. Fill the gaps that are left (maximum productivity), round-robin over the fillers.
  if (fill && fillers.length) {
    let k = 0;
    for (let guard = 0; guard < 40; guard++) {
      const gap = gaps(busy, S, E, brk).find(([a, b]) => b - a >= MIN_BLOCK);
      if (!gap) break;
      let done = false;
      // Round-robin for variety, but deep work gets the high-energy gaps and light work the dips.
      const sharp = energy(gap[0] + 30, wake, sleep) >= 0.8;
      const turn = fillers.map((_, i) => fillers[(k + i) % fillers.length]);
      const order = [...turn.filter(f => (f.demand === 'deep') === sharp), ...turn.filter(f => (f.demand === 'deep') !== sharp)];
      for (let tries = 0; tries < order.length && !done; tries++) {
        const it = order[tries];
        const ws = intersect(windows({ ...it, at: null }), [gap]);
        const room = ws.length ? ws[0][1] - ws[0][0] : 0;
        if (room < MIN_BLOCK) continue;
        const len = Math.min(focus, room - (room % STEP));
        put(it, ws[0][0], len, 0);
        placed[placed.length - 1].filler = true;
        const owed = unplaced.find(u => u.it === it);
        if (owed) { owed.minutes -= len; if (owed.minutes < 15) unplaced.splice(unplaced.indexOf(owed), 1); }
        k = (fillers.indexOf(it) + 1) % fillers.length;
        done = true;
      }
      if (!done) busy.push(gap); // nothing fits there; leave it free
    }
  }
  return { placed, unplaced, busy, mealsMissed };
}

const VARIANTS = [
  { mealsFirst: true, deepFirst: true }, { mealsFirst: true, deepFirst: false },
  { mealsFirst: false, deepFirst: true }, { mealsFirst: false, deepFirst: false },
  { mealsFirst: true, deepFirst: true, longFirst: true }, { mealsFirst: false, deepFirst: true, longFirst: true },
];
/** How good a whole day is: well-placed hours count, unplaced work and wasted scraps cost. */
function quality(res, { S, E, brk }) {
  let q = 0;
  for (const p of res.placed) q += (p.sc || 0) * (p.b - p.a) / 60;
  for (const u of res.unplaced) q -= (u.it.rank === 0 ? 6 : 3.5) * u.minutes / 60;
  q -= 10 * res.mealsMissed; // skipping a meal the user kept is never worth it
  for (const p of res.placed) if (!p.filler && p.it.demand === 'deep' && p.b - p.a < 45 && p.it.minutes >= 45) q -= 0.6;
  for (const [a, b] of gaps(res.busy, S, E, brk)) if (b - a >= 5 && b - a < 30) q -= 0.25;
  return q;
}
function bestPlan(args) {
  let top = null;
  for (const v of VARIANTS) {
    for (const it of args.items) delete it.len;
    const res = place({ ...args, variant: v });
    const q = quality(res, args);
    if (!top || q > top.q + 1e-9) top = { q, res };
  }
  return top.res;
}

/** Free [a, b) ranges inside [S, E] once breaks around busy blocks are kept. */
function gaps(busy, S, E, brk) {
  const xs = busy.filter(([a, b]) => b > S && a < E).sort((p, q) => p[0] - q[0]);
  const out = [];
  let t = S;
  for (const [a, b] of xs) {
    const end = a - brk;
    if (end - t >= STEP) out.push([t, end]);
    t = Math.max(t, b + brk);
  }
  if (E - t >= STEP) out.push([t, E]);
  return out.filter(([a, b]) => b > a);
}

Object.assign(TOOLS, {
  async plan_day(a) {
    const s = settings();
    const d = T.day(T.norm(a.date || T.today()));
    if (d < T.today()) throw new Error('That day is over; plan today or a later day.');
    await ensureRange(d, T.addDays(d, 1));
    const today = d === T.today();
    const nowM = today ? round(T.mins(T.nowStr()) + 5) : 0;
    const wake = T.hm(s.dayStart), sleep = T.hm(s.dayEnd) || 1440;
    let S = a.start === 'now' ? nowM : hmOf(a.start, Math.max(wake, nowM));
    S = Math.max(round(S), nowM);
    const E = Math.min(1440, hmOf(a.end, sleep > S ? sleep : 1440));
    if (E - S < MIN_BLOCK) throw new Error(`Only ${Math.max(0, E - S)} minutes are left on ${d} (${fmt(S)}–${fmt(E)}). Plan the next day instead.`);
    const brk = a.break_minutes !== undefined ? Math.max(0, Math.min(60, Number(a.break_minutes) || 0)) : (a.compress ? Math.min(5, s.breakMinutes) : s.breakMinutes);
    const focus = Math.max(25, Number(s.focusSpan) || 90);
    const cutoff = s.nightOwl ? T.hm(s.nightOwl) : 0;
    const dayEvs = cal.list(T.at(d, 0), T.addDays(d, 1) + 'T00:00').filter(isTimed);

    // What to place: the user's list, plus (re-flow) the movable events already on the day.
    const named = new Set();
    const already = [];
    const items = (Array.isArray(a.items) ? a.items : []).map((x, i) => {
      let ev = x.event_id ? cal.get(realId(x.event_id)) : null;
      // "Run" when a run is already on the day means that run, not a second one.
      if (!ev && x.title && x.at === undefined) {
        const same = dayEvs.find(e => !named.has(e.id) && e.organizer !== false && !e.readOnly && !isPing(e) && T.day(e.start) === d && sameThing(x.title, e.title));
        if (same && !isMovableSolo(same)) { already.push(same.title); return null; }
        if (same) ev = same;
      }
      if (x.event_id && !ev) throw new Error(`No event "${x.event_id}". Use an id from <context> or list_events.`);
      if (ev && (ev.readOnly || ev.organizer === false)) throw new Error(`"${ev.title}" belongs to someone else's calendar or invite; it cannot be re-planned.`);
      if (ev) named.add(ev.id);
      const title = String(x.title || (ev && ev.title) || '').trim().slice(0, 200);
      if (!title) throw new Error('Every item needs a title.');
      const guess = (DEFAULT_MINUTES.find(([re]) => re.test(title)) || [0, 90])[1];
      // An existing event keeps its own length unless the model targeted it by id with a new one.
      const minutes = Math.max(10, Math.min(12 * 60, Math.round((ev && !(x.event_id && Number(x.minutes)) ? T.diffMin(ev.start, ev.end) : Number(x.minutes)) || guess)));
      const kind = ['task', 'focus', 'personal', 'meeting'].includes(x.kind) ? x.kind : (ev ? (ev.kind === 'meeting' ? 'task' : ev.kind) : (PERSONAL.test(title) ? 'personal' : 'task'));
      return { title, minutes, kind, ev, at: T.isHM(x.at) ? T.hm(x.at) : null, after: T.isHM(x.after) ? T.hm(x.after) : null, before: T.isHM(x.before) ? T.hm(x.before) : null,
        ideal: T.isHM(x.around) ? T.hm(x.around) : null, demand: demandOf(title, kind),
        rank: { high: 0, normal: 1, low: 2 }[x.priority] ?? 1, split: x.split !== false, fill: !!x.fill, notes: String(x.notes || ''), order: i };
    }).filter(Boolean);
    const reflowed = a.reflow ? dayEvs.filter(e => !named.has(e.id) && isMovableSolo(e) && T.day(e.start) === d && T.mins(e.start) >= cutoff
      && (a.include_missed || T.mins(e.end) > S || T.day(e.end) > d) && !(isAgentBlock(e) && s.autonomous && !e.taskId)) : [];
    for (const e of reflowed) items.push({ title: e.title, minutes: T.diffMin(e.start, e.end), kind: e.kind, ev: e, reflow: true, orig: T.mins(e.start), rank: 1, split: false, order: 100 + T.mins(e.start), demand: demandOf(e.title, e.kind) });
    // Existing events the user named keep their time when it still works (minimal change); displaced ones ripple later.
    for (const it of items) if (it.ev && !it.reflow && it.at == null && T.day(it.ev.start) === d) { it.reflow = true; it.orig = T.mins(it.ev.start); }
    if (!items.length && !a.fill_gaps) throw new Error('Nothing to plan: pass items (what the user wants to do), or reflow:true to re-place what is already on the day.');

    // Fixed: everything else that takes real time. Agent blocks yield when the planner will re-place them.
    const moving = new Set(items.filter(x => x.ev).map(x => x.ev.id));
    const yieldable = e => isAgentBlock(e) && s.autonomous;
    const obstacles = dayEvs.filter(e => !moving.has(e.id) && !isPing(e) && !yieldable(e)).map(e => ({ e, demand: demandOf(e.title, e.kind), ...(([x, y]) => ({ a: x, b: y }))(span(e, d)) })).filter(o => o.b > o.a);

    const meals = [];
    if (a.fill_gaps && a.meals !== false) {
      const has = re => dayEvs.some(e => re.test(e.title)) || items.some(x => re.test(x.title));
      if (!has(/\blunch\b/i) && S < 14 * 60 + 30 && E > 12 * 60 + 30) meals.push({ title: '🍽 Lunch', from: 12 * 60 + 30, to: 14 * 60 + 30 });
      if (!has(/\bdinner\b/i) && S < 21 * 60 + 30 && E > 19 * 60 + 30) meals.push({ title: '🍽 Dinner', from: 19 * 60 + 30, to: 21 * 60 + 30 });
    }
    // Fillers for empty time: what the user marked, else their open tasks, else the work items they listed.
    let fillers = items.filter(x => x.fill && !x.reflow);
    if (a.fill_gaps && !fillers.length) {
      fillers = load('tasks').items.filter(t => t.status === 'open' && T.day(t.due) >= d)
        .sort((x, y) => x.due.localeCompare(y.due)).slice(0, 3).map(t => ({ title: `📝 ${t.title}`, kind: 'task', task: t, minutes: focus, split: false, demand: demandOf(t.title, 'task') }));
      // Grow what the user left open-ended ("my project"), not what they sized ("CFA for 2 hours").
      const work = items.filter(x => !x.ev && x.kind !== 'personal');
      if (!fillers.length) fillers = work.filter(x => !statedLength(x.title, RUN.userText));
      if (!fillers.length) fillers = work;
    }

    const args = { items, obstacles, S, E, brk, focus, compress: false, fill: !!a.fill_gaps, fillers, meals, d, s, wake, sleep, today };
    // Several arrangements are tried and the best whole day wins (one greedy pass can paint itself into a corner).
    let res = bestPlan(args);
    if (res.unplaced.length && a.compress) {
      const tight = bestPlan({ ...args, brk: Math.min(brk, 5), compress: true });
      if (tight.unplaced.reduce((n, u) => n + u.minutes, 0) < res.unplaced.reduce((n, u) => n + u.minutes, 0)) res = tight;
    }

    // What still didn't fit moves to the next day's best slot (inside waking hours and its activity times).
    const next = T.addDays(d, 1);
    const tomorrow = [];
    if (res.unplaced.length && a.overflow !== false) {
      const nextEvs = cal.list(T.at(next, 0), T.addDays(next, 1) + 'T00:00').filter(e => isTimed(e) && !isPing(e) && !yieldable(e) && !moving.has(e.id));
      const busy = nextEvs.map(e => span(e, next));
      for (const u of res.unplaced.filter(x => !x.partial)) {
        const len = u.it.ev ? T.diffMin(u.it.ev.start, u.it.ev.end) : u.minutes;
        let ws = [[wake, sleep]];
        const act = activityWindows(u.it.title, s);
        if (act) ws = intersect(ws, act.windows);
        let t = null;
        for (const [lo, hi] of ws) { for (let m = round(lo); m + len <= hi && t === null; m += STEP) if (busy.every(([x, y]) => y + brk <= m || x >= m + len + brk)) t = m; if (t !== null) break; }
        if (t === null) continue;
        busy.push([t, t + len]);
        tomorrow.push({ it: u.it, a: t, b: t + len });
        u.moved = true;
      }
    }

    // Apply: move existing events, create new blocks, log everything (one request = one undo).
    for (const p of [...res.placed, ...tomorrow]) {
      const day = tomorrow.includes(p) ? next : d;
      const start = T.at(day, p.a), end = p.b >= 1440 ? T.addDays(day, 1) + 'T00:00' : T.at(day, p.b);
      if (s.autonomous) for (const e of cal.list(start, end)) {
        if (!isAgentBlock(e) || moving.has(e.id) || e.kind === 'buffer') continue;
        cal.remove(e.id); markCreate(e.id, 'yielded'); logAction('delete', e, null, `Made room for "${p.it.title}"`, { auto: true }); RUN.planNeeded = true;
      }
      if (p.it.ev && !p.it.usedEv) {
        p.it.usedEv = true;
        const ev = p.it.ev;
        p.status = ev.start === start && ev.end === end ? 'kept' : day === next ? 'moved to tomorrow' : ev.start === start ? `now ${dur(p.b - p.a)}` : `moved from ${T.clock(ev.start)}`;
        if (p.status === 'kept') continue;
        markWrite();
        const after = cal.update(ev.id, { start, end });
        logAction('move', ev, after, a.rationale || 'Day plan');
        continue;
      }
      markWrite();
      const t = p.it.task;
      const ev = cal.create({ title: p.it.title, start, end, kind: p.it.kind === 'personal' ? 'personal' : p.it.kind === 'focus' ? 'focus' : 'task', agent: true,
        description: [p.it.notes, p.part ? `Part ${p.part} of a ${dur(p.it.minutes)} block.` : '', t ? `Work session for task ${t.id}.` : ''].filter(Boolean).join('\n'),
        ...(t ? { taskId: t.id } : {}) });
      if (t) { t.sessions = t.sessions || []; t.sessions.push({ eventId: ev.id, start, end }); save('tasks'); }
      logAction('create', null, ev, a.rationale || 'Day plan');
      p.status = day === next ? 'new, tomorrow' : p.filler ? 'new, fills a gap' : 'new';
    }

    const line = (a1, b1, title, tag) => `${fmt(a1)}–${b1 >= 1440 ? '24:00' : fmt(b1)} ${title}${tag ? ` (${tag})` : ''}`;
    const rows = [
      ...obstacles.filter(o => o.b > S && o.a < E && !(o.e.agent && o.e.kind === 'buffer')).map(o => ({ a: o.a, b: o.b, text: line(o.a, o.b, o.e.title, 'already on calendar') })),
      ...res.placed.map(p => ({ a: p.a, b: p.b, text: line(p.a, p.b, (p.it.ev ? p.it.ev.title : p.it.title) + (p.part ? ` (${p.part}/${p.of})` : ''), p.clash ? `${p.status || 'new'}, overlaps` : p.status) })),
    ].sort((x, y) => x.a - y.a);
    const free = gaps(res.busy, S, E, brk).filter(([x, y]) => y - x >= 15).reduce((n, [x, y]) => n + y - x, 0);
    return {
      ok: true, date: d, planned_window: `${fmt(S)}–${fmt(E)}`, timeline: rows.map(r => r.text),
      moved_to_next_day: tomorrow.length ? tomorrow.map(p => line(p.a, p.b, p.it.title, next)) : undefined,
      not_placed: res.unplaced.some(u => !u.moved) ? res.unplaced.filter(u => !u.moved).map(u => `${u.it.title} (${dur(u.minutes)}): ${u.why}`) : undefined,
      free_time_left: dur(free),
      already_on_calendar: already.length ? already.map(t => `${t}: already planned today, left as is`) : undefined,
      note: 'Report the timeline to the user as their plan (one line per block). Mention anything moved to the next day or not placed.',
    };
  },
});
