// Learning loop: "ACT-###: Good/Bad" feedback → approved patterns, lessons and rules;
// calendar history → habits profile.
import * as T from './time.js';
import * as cal from './calendar.js';
import { load, save, settings, saveSettings } from './store.js';
import { findAction, setAction, revertAction, addRule, addActivityWindow, isAgentBlock, isTimed } from './engine.js';
import { complete } from './llm.js';
import { rulePrompt } from './prompt.js';

const FEEDBACK_RE = /^\s*(ACT-\d+)\s*[:\-–—]?\s*(good|bad|undo|revert)\b\s*[-–—:,.]?\s*(.*)$/i;

/** Splits a message into feedback lines (handled in code) and the rest (for the agent). */
export async function handleFeedback(message) {
  const replies = [], rest = [];
  for (const line of String(message).split('\n')) {
    const m = line.match(FEEDBACK_RE);
    if (!m) { rest.push(line); continue; }
    replies.push(await applyFeedback(m[1].toUpperCase(), m[2].toLowerCase(), m[3].trim()));
  }
  return { replies, rest: rest.join('\n').trim() };
}

export async function applyFeedback(id, verdict, reason) {
  const a = findAction(id);
  if (!a) return `I couldn't find ${id}.`;
  const mem = load('memory');
  if (verdict === 'good') {
    setAction(a, { feedback: 'good' + (reason ? `: ${reason}` : '') });
    mem.approved.push(`${a.summary} — because ${a.rationale || 'n/a'}${reason ? ` (user: ${reason})` : ''}`);
    mem.approved = mem.approved.slice(-50);
    save('memory');
    return `👍 ${id} noted — I'll keep doing this.`;
  }
  // A plain Undo (Today screen): revert it, without turning it into a lesson.
  if (verdict === 'undo') return `↩️ ${a.status === 'reverted' ? `${id} was already undone.` : revertAction(id, 'undone from Today')}`;
  const undo = a.status === 'reverted' ? `${id} was already undone.` : revertAction(id, reason || 'marked bad');
  setAction(a, { feedback: 'bad' + (reason ? `: ${reason}` : '') });
  let rule = '';
  if (reason) {
    rule = await ruleFromFeedback(a, reason);
    addRule(rule, 'feedback ' + id);
  }
  mem.lessons.push({ time: T.nowStr(), actionId: id, did: a.summary, reason: reason || '(no reason given)', rule });
  mem.lessons = mem.lessons.slice(-50);
  save('memory');
  return `↩️ ${undo}${rule ? `\n📘 New rule: ${rule}` : ''}`;
}

async function ruleFromFeedback(action, reason) {
  try {
    const text = await complete('You convert user feedback into precise, reusable calendar rules.', rulePrompt(action, reason), 200);
    const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
    const rule = (lines[0] || '').replace(/^["'\-•\s]+|["'\s]+$/g, '');
    // Rules about WHEN things happen become settings the code enforces, not just text the model may forget.
    for (const l of lines.slice(1)) {
      const t = /^TIMES:\s*(.+?)\s*\|\s*(.+)$/i.exec(l);
      if (t) addActivityWindow(t[1], t[2]);
      const w = /^WAKE:\s*(\d{1,2}:\d{2})/i.exec(l);
      if (w && T.isHM(w[1]) && T.hm(w[1]) < T.hm(settings().dayEnd)) saveSettings({ dayStart: w[1].padStart(5, '0') });
    }
    return rule && rule.length < 300 ? rule : reason;
  } catch {
    return reason;
  }
}

/** Learns habits from the last 60 days of (non-agent) calendar history. */
export function learnProfile() {
  const s = settings();
  const end = T.nowStr(), start = T.addDays(T.today(), -60) + 'T00:00';
  const evs = cal.list(start, end).filter(e => isTimed(e) && !isAgentBlock(e) && !e.agent);
  const meetings = evs.filter(e => (e.guests || []).length > 0 || e.kind === 'meeting');
  const median = arr => { if (!arr.length) return null; const x = [...arr].sort((a, b) => a - b); return x[Math.floor(x.length / 2)]; };

  // Busy rate per hour across waking hours → reliably quiet windows.
  const lo = Math.floor(T.hm(s.dayStart) / 60), hi = Math.ceil(T.hm(s.dayEnd) / 60);
  const busy = {};
  const perDay = [0, 0, 0, 0, 0, 0, 0], dayCount = [0, 0, 0, 0, 0, 0, 0];
  let days = 0;
  for (let d = T.day(start); d < T.today(); d = T.addDays(d, 1)) {
    days++;
    dayCount[T.dow(d)]++;
    const dayEvs = evs.filter(e => T.day(e.start) === d);
    perDay[T.dow(d)] += dayEvs.reduce((n, e) => n + T.diffMin(e.start, e.end), 0);
    for (let h = lo; h < hi; h++) {
      const slot = { start: T.at(d, h * 60), end: T.at(d, h * 60 + 60) };
      if (dayEvs.some(e => T.overlaps(e, slot))) busy[h] = (busy[h] || 0) + 1;
    }
  }
  const quiet = [];
  if (evs.length >= 10) {
    let run = null;
    for (let h = lo; h <= hi; h++) {
      const free = h < hi && (busy[h] || 0) / Math.max(1, days) < 0.25;
      if (free && !run) run = [h, h];
      else if (free) run[1] = h;
      if ((!free || h === hi) && run) { if (run[1] - run[0] >= 1) quiet.push(`${T.toHM(run[0] * 60)}–${T.toHM((run[1] + 1) * 60)}`); run = null; }
    }
  }
  const startCounts = {};
  evs.forEach(e => { const h = T.clock(e.start); startCounts[h] = (startCounts[h] || 0) + 1; });
  const avg = perDay.map((m, i) => dayCount[i] ? m / dayCount[i] : 0);
  const busiestDays = avg.map((m, i) => [i, m]).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, 2).map(x => T.DAY_NAMES[x[0]]);

  const mem = load('memory');
  mem.profile = {
    typicalMeetingMinutes: median(meetings.map(e => T.diffMin(e.start, e.end))),
    usualStarts: Object.keys(startCounts).sort((a, b) => startCounts[b] - startCounts[a]).slice(0, 4),
    busiestDays,
    quietWindows: quiet.slice(0, 4),
    scheduledHoursPerDay: days ? +(evs.reduce((n, e) => n + T.diffMin(e.start, e.end), 0) / 60 / days).toFixed(1) : null,
    meetingHoursPerWeek: days ? +(meetings.reduce((n, e) => n + T.diffMin(e.start, e.end), 0) / 60 / days * 7).toFixed(1) : null,
    basedOnEvents: evs.length,
    updated: T.nowStr(),
  };
  save('memory');
  return mem.profile;
}
