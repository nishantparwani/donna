// Weekly goals (no AI): "10 hours of CFA a week", "DSA 6h every week".
// Each week a goal is checked against the calendar: time already planned for it (the user's own CFA
// blocks count) is subtracted, and only the shortfall becomes a task the planner books before Sunday.
import * as T from './time.js';
import * as cal from './calendar.js';
import { load, save, settings } from './store.js';
import { TOOLS, RUN, isTimed, isPing } from './engine.js';

const GOAL_SUFFIX = ' (weekly goal)';
const words = s => String(s || '').toLowerCase().split(/[,;]/).map(x => x.trim()).filter(Boolean);
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const matches = (g, e) => {
  const t = ` ${e.title.toLowerCase()} `;
  return words(g.match || g.title).some(k => new RegExp(`(^|[^a-z0-9])${esc(k)}s?([^a-z0-9]|$)`).test(t));
};

/** Minutes this week already on the calendar for goal g, not counting the goal's own sessions. */
function weekMinutes(g, ws, ownTaskIds) {
  let planned = 0, done = 0;
  for (const e of cal.list(ws + 'T00:00', T.addDays(ws, 7) + 'T00:00')) {
    if (!isTimed(e) || isPing(e) || !matches(g, e)) continue;
    if (e.taskId && ownTaskIds.has(e.taskId)) continue;
    const m = T.diffMin(e.start, e.end);
    planned += m;
    if (e.end <= T.nowStr()) done += m;
  }
  return { planned, done };
}

/** Keeps one task per goal for the current week sized to the shortfall. Called by the planner. */
export function syncGoals() {
  const goals = load('goals').items.filter(g => g.active !== false);
  const tasks = load('tasks');
  const ws = T.weekStart(T.today());
  const s = settings();
  for (const t of tasks.items) if (t.goalId && t.week < ws && t.status === 'open') t.status = 'done'; // last week's are over
  for (const g of goals) {
    const mine = tasks.items.filter(t => t.goalId === g.id);
    let t = mine.find(x => x.week === ws);
    const { planned } = weekMinutes(g, ws, new Set(mine.map(x => x.id)));
    const need = Math.max(0, g.minutesPerWeek - planned);
    if (!t) {
      if (need < 30) continue;
      t = { id: 'T' + (++tasks.seq), title: g.title + GOAL_SUFFIX, goalId: g.id, week: ws, minutes: need, due: T.addDays(ws, 6) + 'T' + s.dayEnd,
        priority: 'normal', sessionMinutes: Math.min(Number(s.focusSpan) || 90, 120), notes: '', status: 'open', created: T.nowStr(), sessions: [], spent: 0 };
      tasks.items.push(t);
    } else if (t.status === 'open') {
      // The task covers only what the user's own blocks don't; booked sessions stay counted in it.
      t.minutes = Math.max(need, 15);
      if (need < 15) t.status = 'done';
    }
  }
  save('tasks');
}

/** Progress for the UI and the model. */
export function goalsView() {
  const ws = T.weekStart(T.today());
  const tasks = load('tasks').items;
  return load('goals').items.map(g => {
    const mine = tasks.filter(t => t.goalId === g.id);
    const own = weekMinutes(g, ws, new Set(mine.map(x => x.id)));
    const t = mine.find(x => x.week === ws);
    const sessions = t ? (t.sessions || []).reduce((n, x) => n + T.diffMin(x.start, x.end), 0) : 0;
    const sessionsDone = t ? (t.sessions || []).filter(x => x.end <= T.nowStr()).reduce((n, x) => n + T.diffMin(x.start, x.end), 0) : 0;
    return { id: g.id, title: g.title, match: g.match, active: g.active !== false, target: g.minutesPerWeek,
      planned: own.planned + sessions, done: own.done + sessionsDone, atRisk: !!(t && t.atRisk) };
  });
}

Object.assign(TOOLS, {
  async set_goal(a) {
    const title = String(a.title || '').trim().slice(0, 80);
    if (!title) throw new Error('title is empty.');
    const minutes = Math.round(Number(a.hours_per_week) * 60 || Number(a.minutes_per_week) || 0);
    if (!(minutes >= 30 && minutes <= 70 * 60)) throw new Error('hours_per_week must be between 0.5 and 70.');
    const store = load('goals');
    let g = store.items.find(x => x.title.toLowerCase() === title.toLowerCase());
    if (!g) { g = { id: 'G' + (++store.seq), title, created: T.nowStr() }; store.items.push(g); }
    Object.assign(g, { minutesPerWeek: minutes, match: String(a.counts || title).toLowerCase().slice(0, 120), active: true });
    save('goals');
    RUN.planNeeded = true;
    const { plan } = await import('./planner.js');
    await plan();
    return { ok: true, goal: goalsView().find(x => x.id === g.id) };
  },
  async remove_goal(a) {
    const store = load('goals');
    const g = store.items.find(x => x.id.toLowerCase() === String(a.goal_id || '').trim().toLowerCase() || x.title.toLowerCase() === String(a.goal_id || '').trim().toLowerCase());
    if (!g) throw new Error(`No goal "${a.goal_id}". Goals: ${store.items.map(x => `${x.id} ${x.title}`).join(', ') || 'none'}.`);
    store.items = store.items.filter(x => x !== g);
    save('goals');
    for (const t of load('tasks').items) if (t.goalId === g.id && t.status === 'open') t.status = 'deleted';
    save('tasks');
    const { plan } = await import('./planner.js');
    await plan();
    return { ok: true, removed: g.title };
  },
});
