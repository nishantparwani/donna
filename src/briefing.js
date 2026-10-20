// Briefings and insights, computed in code (no AI quota spent):
//   • morning briefing: today's plan, deadlines, risks, free time (chat + optional email)
//   • evening review: tomorrow at a glance
//   • insights: where the week's hours go
import * as T from './time.js';
import * as cal from './calendar.js';
import { load, settings } from './store.js';
import { isTimed, isAgentBlock, isProtected, isHighStakes } from './engine.js';
import { findConflicts } from './planner.js';
import { radar } from './radar.js';

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dayList = d => cal.list(T.at(d, 0), T.addDays(d, 1) + 'T00:00').filter(e => e.myStatus !== 'declined' && e.kind !== 'buffer');

/** Category used by insights and the UI legend. */
export function category(e) {
  if (e.agent && e.kind === 'focus') return 'focus';
  if (e.taskId || (e.agent && e.kind === 'task')) return 'tasks';
  if (e.habitId) return 'habits';
  const t = (e.title + ' ' + (e.description || '')).toLowerCase();
  if (/\b(lecture|lab|class|tutorial|seminar|course)s?\b/.test(t)) return 'classes';
  if (/\b(study|revision|revise|practice|leetcode|dsa|homework|assignment|read|reading)\b/.test(t) || e.kind === 'focus') return 'study';
  if (/\b(exam|quiz|viva|test)s?\b/.test(t)) return 'classes';
  if (e.kind === 'personal' || isProtected(e) && !(e.guests || []).length) return 'personal';
  if ((e.guests || []).length || e.kind === 'meeting') return 'meetings';
  return 'other';
}

function freeMinutes(d) {
  const s = settings();
  const lo = T.at(d, T.hm(s.dayStart)), hi = T.at(d, T.hm(s.dayEnd));
  let t = d === T.today() ? [lo, T.roundUp15(T.nowStr())].sort()[1] : lo;
  const evs = dayList(d).filter(e => isTimed(e) && !isAgentBlock(e));
  let free = 0, longest = 0, run = 0;
  for (; t < hi; t = T.addMin(t, 15)) {
    const slot = { start: t, end: T.addMin(t, 15) };
    if (evs.some(e => T.overlaps(e, slot))) { run = 0; continue; }
    free += 15; run += 15; longest = Math.max(longest, run);
  }
  return { free, longest };
}

const fmtMins = m => m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ' ' + (m % 60) + 'm' : ''}` : `${m}m`;

/** @returns {{title: string, text: string, html: string}} */
export function briefing(kind = 'morning') {
  const s = settings();
  const d = kind === 'morning' ? T.today() : T.addDays(T.today(), 1);
  const evs = dayList(d);
  const timed = evs.filter(e => !e.allDay);
  const tasks = load('tasks').items.filter(t => t.status === 'open');
  const dueSoon = tasks.filter(t => T.day(t.due) <= T.addDays(d, 2)).sort((a, b) => a.due.localeCompare(b.due));
  const risky = tasks.filter(t => t.atRisk);
  const conflicts = findConflicts(d).map(c => c.replace(/ E\d+ /g, ' ').replace(/^Conflict on \S+: /, ''));
  const { free, longest } = freeMinutes(d);
  const name = s.userName ? s.userName.split(' ')[0] : '';
  const head = kind === 'morning'
    ? `☀️ Good morning${name ? ', ' + name : ''}. ${T.DAY_NAMES[T.dow(d)]}: ${timed.length} event${timed.length === 1 ? '' : 's'}, ${fmtMins(free)} free${longest >= 60 ? ` (longest stretch ${fmtMins(longest)})` : ''}.`
    : `🌙 Tomorrow (${T.DAY_NAMES[T.dow(d)]} ${T.human(d + 'T00:00').slice(4, -6)}): ${timed.length} event${timed.length === 1 ? '' : 's'}${timed[0] ? `, first at ${T.clock(timed[0].start)}` : ''}.`;
  const lines = timed.map(e => `${T.clock(e.start)}–${T.clock(e.end)} ${e.title}${isHighStakes(e) ? ' ★' : ''}${e.meetLink ? ' (Meet)' : ''}`);
  const allDay = evs.filter(e => e.allDay).map(e => e.title);
  const notes = [];
  if (allDay.length) notes.push('All day: ' + allDay.join(', '));
  dueSoon.forEach(t => notes.push(`📝 ${t.title} due ${T.human(t.due.length === 10 ? t.due + 'T23:59' : t.due)} — ${fmtMins(Math.max(0, t.minutes - (t.spent || 0)))} left`));
  risky.filter(t => !dueSoon.includes(t)).forEach(t => notes.push(`⚠️ ${t.title} can't be fully scheduled before it's due — free up time or extend it.`));
  conflicts.forEach(c => notes.push('⚠️ Clash: ' + c));
  // What is coming that matters (exams, evaluations, trips), so nothing sneaks up.
  const r = radar(kind === 'morning' ? 10 : 7);
  r.items.filter(x => x.kind !== 'task' && x.date > d).slice(0, 4).forEach(x => notes.push(`📌 ${x.title} — ${x.when}${x.time ? ' ' + x.time : ''}`));
  r.away.slice(0, 1).forEach(a => notes.push('✈️ ' + a.text));
  const text = [head, lines.length ? lines.join('\n') : 'Nothing scheduled.', notes.length ? notes.join('\n') : ''].filter(Boolean).join('\n\n');
  const html = `<div style="font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#1b2130;max-width:560px">
<p style="font-size:17px;margin:0 0 12px"><b>${esc(head)}</b></p>
<table style="border-collapse:collapse;width:100%">${timed.map(e => `<tr><td style="padding:6px 10px 6px 0;color:#687087;white-space:nowrap;vertical-align:top">${T.clock(e.start)}–${T.clock(e.end)}</td><td style="padding:6px 0;border-bottom:1px solid #eef0f4">${esc(e.title)}${e.meetLink ? ` · <a href="${esc(e.meetLink)}">Join Meet</a>` : ''}${e.location && !e.meetLink ? `<br><span style="color:#687087;font-size:13px">${esc(e.location)}</span>` : ''}</td></tr>`).join('') || '<tr><td>Nothing scheduled.</td></tr>'}</table>
${notes.length ? `<ul style="padding-left:18px;margin:14px 0">${notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
<p style="color:#9aa1b1;font-size:12px;margin-top:18px">${esc(s.agentName)} · reply in the app to change anything</p></div>`;
  return { title: kind === 'morning' ? `Your ${T.DAY_NAMES[T.dow(d)]} plan` : `Tomorrow: ${timed.length} events`, text, html };
}

/** Hours per category for the week starting Monday `week`, plus this week vs last. */
export function insights(week = T.weekStart(T.today())) {
  const sum = from => {
    const by = {};
    let total = 0;
    for (const e of cal.list(from + 'T00:00', T.addDays(from, 7) + 'T00:00')) {
      if (!isTimed(e) || e.kind === 'buffer') continue;
      const m = T.diffMin(e.start, e.end);
      if (m > 12 * 60) continue;
      const c = category(e);
      by[c] = (by[c] || 0) + m;
      total += m;
    }
    return { by, total };
  };
  const cur = sum(week);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = T.addDays(week, i);
    const by = {};
    for (const e of cal.list(d + 'T00:00', T.addDays(d, 1) + 'T00:00')) {
      if (!isTimed(e) || e.kind === 'buffer' || T.day(e.start) !== d) continue;
      const c = category(e);
      by[c] = (by[c] || 0) + Math.min(T.diffMin(e.start, e.end), 720);
    }
    days.push({ date: d, by });
  }
  const tasks = load('tasks').items;
  return {
    week, totalMinutes: cur.total, byCategory: cur.by, days,
    tasks: { open: tasks.filter(t => t.status === 'open').length, atRisk: tasks.filter(t => t.status === 'open' && t.atRisk).length, done: tasks.filter(t => t.status === 'done').length },
    agentActions: load('actions').items.filter(a => a.time >= week && a.type !== 'revert').length,
  };
}
