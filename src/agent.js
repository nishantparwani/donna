// Agent loop + self-correction. After the model answers, code checks the answer and,
// if needed, sends it back with a precise correction:
//   1. it asked permission instead of acting      → "act now"
//   2. it claimed a change that no tool made      → "do it or correct the reply"
//   3. a change it made left an overlap behind    → "fix it"
// Simple messages (greetings, undo, 👍/👎 feedback) are handled in code with no model call.
import * as T from './time.js';
import * as cal from './calendar.js';
import { load, save, settings } from './store.js';
import { generate, OutOfTime } from './llm.js';
import { TOOL_DECLS, runTool, RUN, beginRun, findAction, TOOLS } from './engine.js';
import { plan, findConflicts } from './planner.js';
import { systemPrompt, wrapUserMessage, autonomousPrompt } from './prompt.js';
import { handleFeedback } from './learning.js';
import { ensureRange } from './sync.js';
import './dayplan.js';
import { quickAnswer, quickCreate } from './quick.js';

const MAX_STEPS = 8;
const MAX_CORRECTIONS = 2;
let CHAT_BUDGET_MS = 40000;     // a reply never takes longer than this; whatever was done by then is reported
/** Test hook. */
export function setChatBudget(ms) { CHAT_BUDGET_MS = ms; }
const CORRECTION_MIN_MS = 12000; // a self-check only runs if there is time left to act on it
const AUTO_LLM_PER_DAY = 8; // keep the free quota for chat
const ASKS_PERMISSION = /\b(should i|shall i|would you like(?: me)? to|do you want(?: me)? to|want me to|let me know if|would you prefer|please confirm|can you confirm|is that (?:ok|okay|alright|fine)|does that work|if you(?:'d| would) like)\b/i;
const DISAMBIGUATION = /\bwhich (?:one|of)\b/i;
const CLAIMS_ABSENT = /\b(not (?:scheduled|found|on your calendar|in your calendar)|no (?:upcoming|such|matching|scheduled)|(?:couldn't|could not|can't|cannot) find|don't see|do not see|isn't (?:on|in) your|there (?:is|are) no)\b/i;
const CLAIMS_FULL =/\b(fully (?:booked|occupied|packed)|no (?:free|open|available) (?:time|slot|slots|space)|no room|completely booked|is full|are full)\b/i;
const ASKS_FOR_CHANGE = /\b(book|schedule|set up|add|put|move|reschedule|push|pull|shift|bump|cancel|delete|drop|remove|clear|block|decline|undo|revert|make|create|plan|replan|re-plan|rename|retitle|timetable|prepone|postpone|kar do|rakh do|hata do|daal do)\b/i;
const EXPLAINS = /\b(can't|cannot|can not|unable|not possible|impossible|already|no free|no room|protected|in the past|isn't|is not|nothing|no such|couldn't|could not|won't|outside|read-only|another calendar|no event)\b/i;
const CLAIMS_CHANGE = /(^|[.!]\s+|\bI(?:'ve| have)?\s+)(booked|scheduled|moved|rescheduled|created|cancell?ed|deleted|declined|added|blocked|cleared|pushed|shifted|updated|set up|put|removed)\b/i;
const GREETING = /^\s*(hi|hii+|hello|hey|yo|hola|namaste|good (morning|afternoon|evening)|sup|hey there)( (donna|there|buddy))?\s*[!.]*\s*$/i;
const THANKS = /^\s*(thanks|thank you|thx|ty|ok|okay|cool|great|nice|perfect|awesome|👍|🙏|👌)+\s*[!.]*\s*$/i;
const UNDO = /^\s*(undo|undo that|undo it|revert( that)?|put it back|undo the last( one| change)?|undo last( change)?)\s*[.!]*\s*$/i;
const UNDO_N = /^\s*undo (?:the )?last (\d+|two|three|four|five)(?: changes?)?\s*[.!]*\s*$/i;
const WORDS = { two: 2, three: 3, four: 4, five: 5 };

/** Google mode: make sure the days a tool is about to touch are loaded. */
async function preload(a) {
  const days = [a.start_date, a.end_date, a.date, a.start, a.new_start, a.new_date].filter(Boolean).map(x => String(x).slice(0, 10)).filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x));
  if (days.length) await ensureRange(days.reduce((x, y) => x < y ? x : y), days.reduce((x, y) => x > y ? x : y));
}

async function toolLoop(messages, system, trace, meta) {
  for (let step = 0; step < MAX_STEPS; step++) {
    let out;
    try { out = await generate({ system, messages, tools: TOOL_DECLS, deadline: meta.deadline }); }
    catch (e) { if (e instanceof OutOfTime) return { text: '', finish: 'TIME' }; throw e; }
    meta.calls++; meta.provider = `${out.provider}/${out.model}`;
    messages.push({ role: 'assistant', content: out.text, calls: out.calls, ...(out.raw && out.raw.gemini ? { _gemini: out.raw.gemini } : {}) });
    if (!out.calls.length) return { text: out.text, finish: 'STOP' };
    let report = null, allOk = true;
    // Memory first: "Riya's email is … — book a call with Riya" must invite the address it just learned.
    const first = new Set(['remember_person', 'save_rule']);
    const ordered = [...out.calls.filter(c => first.has(c.name)), ...out.calls.filter(c => !first.has(c.name))];
    for (const c of ordered) {
      let result;
      if (c.name === 'finish') { report = String((c.args && c.args.report) || '').trim(); result = { ok: true }; }
      else {
        try { await preload(c.args || {}); result = await runTool(c.name, c.args || {}); }
        catch (e) { result = { ok: false, error: e.message }; }
        if (result && result.ok === false) allOk = false;
        trace.push({ tool: c.name, args: c.args, result });
      }
      messages.push({ role: 'tool', callId: c.id, name: c.name, content: result });
    }
    // One-round-trip finish: the model acted and reported in the same turn, and every action succeeded.
    if (report && allOk) return { text: report, finish: 'FINISH' };
    if (report && !allOk) messages.push({ role: 'user', content: '<system_check>Some calls failed, so your report was not shown. Fix the failures (or explain them), then call finish again with an accurate report.</system_check>' });
  }
  return { text: '', finish: 'STEP_LIMIT' };
}

/** Returns a correction for the model, or null if the answer passes. */
function critique(res, trace) {
  const text = res.text || '';
  const changed = RUN.actions.some(a => !a.auto);
  const failed = trace.some(t => t.result && t.result.ok === false);
  if (res.finish === 'STEP_LIMIT') return '<system_check>Too many steps. Stop calling tools that are not needed and call finish with an accurate report now.</system_check>';
  if (!text || text.length < 2 || /^<\/?[a-z_]+[^>]*>?$/i.test(text)) return '<system_check>Your reply was empty. Complete the request with the tools if anything is left, then call finish with a proper report (§7).</system_check>';
  if (!changed && ASKS_PERMISSION.test(text) && !DISAMBIGUATION.test(text)) {
    return `<system_check>AUTONOMY CHECK FAILED: you asked for permission or offered options and changed nothing. You hold standing authority (§1). Execute the request now with the tools, choosing the best option per §4–§6, then call finish. Only if two existing events genuinely match may you ask a single "which one" question.</system_check>`;
  }
  if (!changed && CLAIMS_CHANGE.test(text) && !trace.some(t => t.result && t.result.ok && (t.result.action_id || t.result.done || t.result.task || t.result.habit || t.result.undone || t.result.result))) {
    return `<system_check>CLAIM CHECK FAILED: your reply says the calendar changed, but no tool call changed anything. Either do it now with the tools, or rewrite the reply so it only states what is true.</system_check>`;
  }
  if (!changed && CLAIMS_ABSENT.test(text) && !trace.some(t => t.tool === 'search_events' || t.tool === 'list_events')) {
    return `<system_check>UNVERIFIED: you said it is not on the calendar, but <context> only covers 7 days. Call search_events (it covers six months), then answer.</system_check>`;
  }
  if (CLAIMS_FULL.test(text) && !trace.some(t => t.tool === 'find_free_slots')) {
    return `<system_check>UNVERIFIED: you said there is no room but never checked. Agent blocks count as free. Call find_free_slots for the day and window asked, act on the result, then call finish.</system_check>`;
  }
  if (!changed && ASKS_FOR_CHANGE.test(RUN.userText) && !/\?/.test(text) && !EXPLAINS.test(text) && !failed && !trace.some(t => t.result && t.result.ok && t.tool !== 'list_events' && t.tool !== 'search_events' && t.tool !== 'find_free_slots')) {
    return `<system_check>INCOMPLETE: the user asked for a change but nothing changed and your reply doesn't say why. Do it now with the tools and call finish. If it truly cannot be done within the rules, say why in one sentence.</system_check>`;
  }
  if (changed) {
    // Every clock time the report states must be one the changes (or the user) actually used.
    const actual = RUN.actions.filter(a => !a.auto).map(a => a.summary).join(' ') + ' ' + RUN.userText + ' ' + JSON.stringify(trace.map(t => t.result));
    const said = [...new Set((text.match(/\b([01]?\d|2[0-3]):[0-5]\d\b/g) || []).map(t => t.padStart(5, '0')))];
    const wrong = said.filter(t => !actual.includes(t));
    if (wrong.length && RUN.actions.some(a => !a.auto)) {
      return `<system_check>REPORT CHECK FAILED: your report mentions ${wrong.join(', ')}, but the changes actually made were:\n${RUN.actions.filter(a => !a.auto).map(a => '- ' + a.summary).join('\n')}\nIf that is what the user wanted, call finish again with a report that states exactly these times. If not, fix the calendar first.</system_check>`;
    }
    const touched = new Set(), days = new Set();
    for (const a of RUN.actions) {
      const rec = findAction(a.id);
      if (!rec || rec.auto || !['create', 'move'].includes(rec.type)) continue; // renames and notes can't cause a clash
      if (rec.eventId) touched.add(rec.eventId);
      for (const snap of [rec.before, rec.after]) if (snap && snap.start && !(rec.extra && rec.extra.count > 1)) days.add(T.day(snap.start));
    }
    const refs = [...touched].map(id => RUN.alias.get(id)).filter(Boolean);
    const problems = [...days].flatMap(findConflicts).filter(c => refs.some(r => c.includes(`${r} "`)));
    const forced = trace.some(t => t.args && t.args.allow_overlap);
    if (problems.length && !forced) {
      return `<system_check>VERIFY CHECK FAILED: events you touched still overlap:\n${problems.map(p => '- ' + p).join('\n')}\nFix these now (move the lower-priority event per §5), then call finish.</system_check>`;
    }
  }
  return null;
}

async function runAgent(userTurnText, history, budgetMs = CHAT_BUDGET_MS) {
  const system = systemPrompt();
  const messages = [...history, { role: 'user', content: userTurnText }];
  const trace = [];
  const meta = { calls: 0, provider: '', deadline: Date.now() + budgetMs };
  let res = await toolLoop(messages, system, trace, meta);
  for (let i = 0; i < MAX_CORRECTIONS && res.finish !== 'TIME' && meta.deadline - Date.now() > CORRECTION_MIN_MS; i++) {
    const fix = critique(res, trace);
    if (!fix) break;
    messages.push({ role: 'user', content: fix });
    const again = await toolLoop(messages, system, trace, meta);
    if (again.finish === 'TIME' && res.text) break; // keep the answer we had
    res = again;
  }
  let text = res.text;
  if (!text) {
    // Out of time or steps: say exactly what was done instead of failing silently.
    const done = RUN.actions.filter(a => !a.auto).map(a => '- ' + a.summary);
    text = done.length ? `Done so far:\n${done.join('\n')}` : (res.finish === 'TIME'
      ? 'The AI took too long to answer, so nothing was changed. Try again, or say it more simply (e.g. "CFA 2h tomorrow evening").'
      : 'I could not finish that. Please rephrase or try again.');
  }
  return { text, trace, meta };
}

// ─── Chat log ───
function saveChat(role, text, actions, extra = {}) {
  const c = load('chat');
  c.messages.push({ role, text, actions: actions || [], time: T.nowStr(), ...extra });
  save('chat');
}

/** Recent turns as neutral messages (starts with a user turn; same-role turns merged). */
function recentHistory(n = 8) {
  const out = [];
  for (const m of load('chat').messages.slice(-n)) {
    const role = m.role === 'user' ? 'user' : 'assistant';
    let text = m.text;
    if (m.actions && m.actions.length) text += '\n' + m.actions.filter(a => !a.auto).map(a => `${a.id}: ${a.summary}`).join('\n');
    if (!out.length && role !== 'user') continue;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += '\n\n' + text;
    else out.push({ role, content: text });
  }
  if (out.length && out[out.length - 1].role === 'user') out.pop(); // never end history on an unanswered user turn
  return out;
}

export function chatHistory() { return load('chat').messages.slice(-100); }

/** Removes internal references a model may echo: [E6; protected], E12, ACT lines, tool names. */
export function clean(text) {
  return String(text || '')
    .replace(/\s*\[E\d+[^\]]*\]/g, '')
    .replace(/\(\s*E\d+\s*\)/g, '')
    .replace(/\bE\d+\b(?=[\s,.)])/g, '')
    .replace(/^\s*ACT-\d+:.*$/gm, '')
    .replace(/\b(remember_person|create_events?|move_event|delete_events|find_free_slots|search_events|list_events|update_events?|rename_in_order|update_preferences|plan_day|set_goal|remove_goal|add_task|update_task|add_habit|remove_habit|save_rule)\b/g, m => ({ remember_person: 'tell me their email', add_task: 'add it as a task' })[m] || 'that')
    .replace(/[ \t]+\|[ \t]+(?=\d{2}:\d{2})/g, '\n')
    .replace(/\n{3,}/g, '\n\n').replace(/ {2,}/g, ' ').trim();
}

/** Code-only answers for messages that need no model. Returns null when the model is needed. */
async function fastPath(message) {
  const s = settings();
  if (GREETING.test(message)) {
    const h = T.hourNow();
    const next = cal.list(T.nowStr(), T.addDays(T.today(), 1) + 'T00:00').filter(e => !e.allDay && e.myStatus !== 'declined' && e.kind !== 'buffer' && e.start >= T.nowStr())[0];
    return `${h < 4 ? 'Still up' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'}${s.userName ? ', ' + s.userName.split(' ')[0] : ''}! ${next ? `Next up: ${next.title} at ${T.clock(next.start)}.` : 'Nothing else on your calendar today.'}`;
  }
  if (THANKS.test(message)) return '👍';
  const quick = await quickAnswer(message);
  if (quick !== null) return quick;
  const m = UNDO_N.exec(message);
  const n = UNDO.test(message) ? 1 : m ? (Number(m[1]) || WORDS[m[1].toLowerCase()]) : 0;
  if (n) {
    const r = await TOOLS.undo({ count: n, reason: 'Undo requested' });
    return r.undone ? r.undone.join('\n') : r.result;
  }
  return null;
}

// ─── Entry points ───

export async function chat(message) {
  message = String(message || '').trim().slice(0, 4000);
  if (!message) return { reply: '', actions: [] };
  beginRun('chat');
  const history = recentHistory();
  const { replies, rest } = await handleFeedback(message);
  RUN.userText = rest;
  // A short follow-up ("no, cancel it dude") refers to the previous request: what it named still counts as named.
  const prev = [...load('chat').messages].reverse().find(m => m.role === 'user');
  RUN.prevUserText = prev && rest.split(/\s+/).length <= 8 ? prev.text : '';
  const parts = [...replies];
  let meta = null, trace = [];
  if (rest) {
    try {
      const quick = await fastPath(rest);
      if (quick !== null) parts.push(quick);
      else {
        const res = await runAgent(wrapUserMessage(rest), history);
        parts.push(res.text);
        meta = res.meta; trace = res.trace;
      }
    } catch (e) {
      // No AI available: simple "X tomorrow at 7" requests are still handled in code.
      let saved = null;
      if (/AI model|quota|unavailable/i.test(e.message)) { try { saved = await quickCreate(rest); } catch (err) { saved = '⚠️ ' + err.message; } }
      parts.push(saved || '⚠️ ' + e.message);
    }
  }
  if ((RUN.actions.length || RUN.planNeeded) && settings().autonomous) {
    try { await plan(); } catch (e) { parts.push('⚠️ Planner: ' + e.message); }
  }
  const reply = clean(parts.join('\n\n'));
  const actions = RUN.actions.slice();
  saveChat('user', message);
  saveChat('assistant', reply, actions, meta ? { model: meta.provider } : {});
  return { reply, actions, model: meta && meta.provider, trace };
}

/** Unattended check: deterministic planning, then the AI only for conflicts that need judgement. */
export async function autoRun({ force = false, label = '' } = {}) {
  const s = settings();
  if (!s.autonomous && !force) return null;
  beginRun('auto');
  const issues = await plan();
  let text = '';
  const st = load('state');
  const needAi = issues.filter(i => /^Conflict/.test(i) && !/neither can be moved/.test(i));
  const sig = needAi.join('|');
  const repeat = !force && st.lastIssues === sig && Date.now() - (st.lastIssuesAt || 0) < 6 * 3600e3;
  const day = T.today();
  const budget = st.autoLlm && st.autoLlm.date === day ? st.autoLlm : { date: day, n: 0 };
  if (needAi.length && !repeat && (budget.n < AUTO_LLM_PER_DAY || force)) {
    budget.n++; st.autoLlm = budget;
    st.lastIssues = sig; st.lastIssuesAt = Date.now(); save('state');
    try { text = (await runAgent(autonomousPrompt(needAi, s.planDaysAhead), [])).text; }
    catch (e) { text = '⚠️ Auto-check could not use the AI: ' + e.message; }
    if (RUN.actions.some(a => !a.auto)) await plan();
  }
  const actions = RUN.actions.slice();
  const visible = actions.filter(a => !a.auto || /^(Moved|Cancelled)/.test(a.summary));
  const summary = text || (label ? `${label}: ${actions.length ? `${actions.length} change${actions.length === 1 ? '' : 's'}` : 'everything already fits'}.` : `Kept your plan in shape: ${actions.length} automatic change${actions.length === 1 ? '' : 's'}.`);
  if (text || visible.length || label) saveChat('assistant', '🤖 ' + (label && text ? label + '. ' : '') + summary, actions, { auto: true });
  st.lastAutoRun = T.nowStr(); save('state');
  return { text, actions, issues };
}

/** Adds a note to the most recent assistant message (e.g. a Google sync problem). */
export function appendToLastReply(note) {
  const c = load('chat');
  const m = [...c.messages].reverse().find(x => x.role === 'assistant');
  if (m) { m.text += '\n\n' + note; save('chat'); }
}
export { saveChat };
