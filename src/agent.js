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
import { toolsFor, groupsFor, runTool, RUN, beginRun, findAction, TOOLS } from './engine.js';
import { plan, findConflicts } from './planner.js';
import { systemPrompt, wrapUserMessage, autonomousPrompt } from './prompt.js';
import { handleFeedback } from './learning.js';
import { ensureRange } from './sync.js';
import './dayplan.js';
import { quickAnswer, quickCreate, planText } from './quick.js';
import { quickReminder } from './reminders.js';
import { hinglish } from './when.js';

const MAX_STEPS = 5;
const MAX_CORRECTIONS = 1;
const REPLY_TOKENS = 1024;
const LIST_TOKENS = 4096; // a pasted list comes back as one large tool call
let CHAT_BUDGET_MS = 40000;     // a reply never takes longer than this; whatever was done by then is reported
/** Test hook. */
export function setChatBudget(ms) { CHAT_BUDGET_MS = ms; }
const CORRECTION_MIN_MS = 12000; // a self-check only runs if there is time left to act on it
const AUTO_LLM_PER_DAY = 2; // keep the free quota for chat
const AUTO_TOOLS = ['find_free_slots', 'move_event', 'finish'];
const ONE_THING = /\b(and|then|also|plus|after that|instead|everything|all|each|both|them|those|these|rest|swap|exchange)\b|[,;\n]/i;
const ASKS_PERMISSION = /\b(should i|shall i|would you like(?: me)? to|do you want(?: me)? to|want me to|let me know if|would you prefer|please confirm|can you confirm|is that (?:ok|okay|alright|fine)|does that work|if you(?:'d| would) like)\b/i;
const DISAMBIGUATION = /\bwhich (?:one|of)\b/i;
const CLAIMS_ABSENT = /\b(not (?:scheduled|found|on your calendar|in your calendar)|no (?:upcoming|such|matching|scheduled)|(?:couldn't|could not|can't|cannot) find|don't see|do not see|isn't (?:on|in) your|there (?:is|are) no)\b/i;
const CLAIMS_FULL =/\b(fully (?:booked|occupied|packed)|no (?:free|open|available) (?:time|slot|slots|space)|no room|completely booked|is full|are full)\b/i;
const ASKS_FOR_CHANGE = /\b(book|schedule|set up|add|put|move|reschedule|push|pull|shift|bump|cancel|delete|drop|remove|clear|block|decline|undo|revert|make|create|plan|replan|re-plan|rename|retitle|timetable|prepone|postpone|remind|kar do|rakh do|hata do|daal do)\b/i;
const EXPLAINS = /\b(can't|cannot|can not|unable|not possible|impossible|already|no free|no room|protected|in the past|isn't|is not|nothing|no such|couldn't|could not|won't|outside|read-only|another calendar|no event)\b/i;
const CLAIMS_CHANGE = /(^|[.!]\s+|\bI(?:'ve| have)?\s+)(booked|scheduled|moved|rescheduled|created|cancell?ed|deleted|declined|added|blocked|cleared|pushed|shifted|updated|set up|put|removed)\b/i;
const GREETING = /^\s*(hi|hii+|hello|hey|yo|hola|namaste|good (morning|afternoon|evening)|sup|hey there)( (donna|there|buddy))?\s*[!.]*\s*$/i;
const THANKS = /^\s*(thanks|thank you|thx|ty|ok|okay|cool|great|nice|perfect|awesome|👍|🙏|👌)+\s*[!.]*\s*$/i;
const UNDO = /^\s*(?:(?:no|nope|wait|actually|oops|sorry|hmm)[\s,.]+)*(undo|undo that|undo it|revert( that| it)?|put (it|that|them) back|bring (it|that|them) back|undo the last( one| change)?|undo last( change)?)\s*(please)?\s*[.!]*\s*$/i;
const UNDO_N = /^\s*undo (?:the )?last (\d+|two|three|four|five)(?: changes?)?\s*[.!]*\s*$/i;
const WORDS = { two: 2, three: 3, four: 4, five: 5 };
const QUESTION = /\?\s*$|^\s*(?:what|when|where|which|who|how|is|am|are|do|does|did|can i|could i)\b/i;
const WRITES = new Set(['create_event', 'create_events', 'move_event', 'update_event', 'update_events', 'delete_events', 'rename_in_order', 'plan_day', 'add_task', 'add_habit']);

/** Google mode: make sure the days a tool is about to touch are loaded. */
async function preload(a) {
  const days = [a.start_date, a.end_date, a.date, a.start, a.new_start, a.new_date].filter(Boolean).map(x => String(x).slice(0, 10)).filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x));
  if (days.length) await ensureRange(days.reduce((x, y) => x < y ? x : y), days.reduce((x, y) => x > y ? x : y));
}

async function toolLoop(messages, system, trace, meta) {
  for (let step = 0; step < MAX_STEPS; step++) {
    let out;
    try { out = await generate({ system, messages, tools: meta.tools, maxTokens: meta.maxTokens, deadline: meta.deadline }); }
    catch (e) { if (e instanceof OutOfTime) return { text: '', finish: 'TIME' }; throw e; }
    meta.calls++; meta.provider = `${out.provider}/${out.model}`;
    messages.push({ role: 'assistant', content: out.text, calls: out.calls, ...(out.raw && out.raw.gemini ? { _gemini: out.raw.gemini } : {}) });
    if (!out.calls.length) return { text: out.text, finish: 'STOP' };
    let report = null, allOk = true, finished = false;
    // Memory first: "Riya's email is … — book a call with Riya" must invite the address it just learned.
    const first = new Set(['remember_person', 'save_rule']);
    const ordered = [...out.calls.filter(c => first.has(c.name)), ...out.calls.filter(c => !first.has(c.name))];
    for (const c of ordered) {
      let result;
      if (c.name === 'finish') { report = String((c.args && (c.args.note || c.args.report)) || '').trim(); finished = true; result = { ok: true }; }
      else {
        try { await preload(c.args || {}); result = await runTool(c.name, c.args || {}); }
        catch (e) { result = { ok: false, error: e.message }; }
        if (result && result.ok === false) allOk = false;
        trace.push({ tool: c.name, args: c.args, result });
      }
      messages.push({ role: 'tool', callId: c.id, name: c.name, content: result });
    }
    // One-round-trip finish: the model acted and reported in the same turn, and every action succeeded.
    if (finished && allOk) return { text: report || '', finish: 'FINISH' };
    if (finished && !allOk) messages.push({ role: 'user', content: '<system_check>Some calls failed. Fix them or explain why in finish(note).</system_check>' });
    // A one-thing request that succeeded needs no second model call just to say so.
    else if (allOk && !meta.auto && RUN.actions.some(a => !a.auto) && !ONE_THING.test(RUN.userText) && !trace.some(t => t.result && t.result.ok === false)) return { text: '', finish: 'FINISH' };
  }
  return { text: '', finish: 'STEP_LIMIT' };
}

/** Returns a correction for the model, or null if the answer passes. */
function critique(res, trace) {
  const text = res.text || '';
  const changed = RUN.actions.some(a => !a.auto);
  const failed = trace.some(t => t.result && t.result.ok === false);
  if (res.finish === 'STEP_LIMIT') return changed ? null : '<system_check>Too many steps. Call finish now.</system_check>';
  if (res.finish === 'FINISH' && changed) return null;
  const silent = !text || text.length < 2 || /^<\/?[a-z_]+[^>]*>?$/i.test(text);
  if (silent && !changed && !trace.some(t => t.result && (t.result.duplicate || t.result.note || t.result.undone || t.result.result || t.result.ok))) return '<system_check>Your reply was empty. Finish the request, or say in one line why you cannot.</system_check>';
  if (silent) return null;
  if (!changed && ASKS_PERMISSION.test(text) && !DISAMBIGUATION.test(text)) {
    return '<system_check>You asked permission and changed nothing. Do it now with the tools, then call finish. Ask only if two different events genuinely fit.</system_check>';
  }
  if (!changed && CLAIMS_CHANGE.test(text) && !trace.some(t => t.result && t.result.ok && (t.result.action_id || t.result.done || t.result.task || t.result.habit || t.result.undone || t.result.result))) {
    return '<system_check>You said the calendar changed but no tool changed it. Do it now, or correct the reply.</system_check>';
  }
  if (!changed && CLAIMS_ABSENT.test(text) && !trace.some(t => t.tool === 'search_events' || t.tool === 'list_events')) {
    return '<system_check>Context shows only part of the calendar. Call search_events, then answer.</system_check>';
  }
  if (CLAIMS_FULL.test(text) && !trace.some(t => t.tool === 'find_free_slots')) {
    return '<system_check>You said there is no room without checking. Call find_free_slots, act on it, then finish.</system_check>';
  }
  // A clash is the tool's call to make, not a guess from reading the agenda.
  if (!changed && !QUESTION.test(RUN.userText) && /\b(clash|conflict|overlap|already (?:have|has|booked)|is busy|are busy)/i.test(text) && !trace.some(t => WRITES.has(t.tool))) return '<system_check>Do not refuse over a clash you saw. Call the tool now with the time the user named: it books it and tells the user about any overlap. Then finish.</system_check>';
  if (!changed && ASKS_FOR_CHANGE.test(RUN.userText) && !/\?/.test(text) && !EXPLAINS.test(text) && !failed && !trace.some(t => t.result && t.result.ok && t.tool !== 'list_events' && t.tool !== 'search_events' && t.tool !== 'find_free_slots')) {
    return '<system_check>Nothing changed and you did not say why. Do it now and call finish, or say why in one sentence.</system_check>';
  }
  return null;
}

/** The reply, written by code from what actually happened: it can't misreport, and it costs no output tokens. */
function report(res, trace) {
  const plans = trace.filter(t => t.tool === 'plan_day' && t.result && t.result.ok && t.result.timeline);
  const lines = plans.length ? [planText(plans[plans.length - 1].result)] : RUN.actions.filter(a => !a.auto).map(a => a.summary);
  const notes = [];
  for (const t of trace) {
    const r = t.result || {};
    if (r.duplicate && r.note) notes.push(r.note.replace(/, so nothing new was created\. Say so in the report\.$/, '.'));
    if (r.not_invited) notes.push(r.not_invited.replace(/\. Mention that .*$/, '.'));
    if (Array.isArray(r.errors)) notes.push(...r.errors.map(e => String(e).replace(/^E\d+: /, '')));
    if (r.ok === undefined && r.undone) notes.push(...[].concat(r.undone));
    if (r.undone && r.ok) notes.push(...[].concat(r.undone));
    if (r.ok && r.result) notes.push(r.result);
    if (r.ok && r.priority) notes.push(r.priority);
    if (r.ok && r.overlaps) notes.push(r.overlaps);
    if (r.ok && r.invited) notes.push(`Invited ${[].concat(r.invited).join(', ')} (they were emailed).`);
    if (r.ok && r.overlapping_occurrences) notes.push(`Heads-up: ${r.overlapping_occurrences} of ${r.occurrences} overlap something already booked.`);
    if (r.ok && r.skipped_while_asleep) notes.push(`Skipped ${r.skipped_while_asleep.split(' ')[0]} that fell in your sleeping hours.`);
  }
  const text = (res.text || '').trim();
  const addsToReport = text && text.length <= 300 && !CLAIMS_CHANGE.test(text) && /[a-z]{3}/i.test(text);
  const body = lines.length ? [...lines, ...notes, ...(addsToReport ? [text] : [])] : (notes.length ? [...notes, ...(text ? [text] : [])] : (text ? [text] : []));
  return [...new Set(body)].join('\n');
}

async function runAgent(userTurnText, history, { groups = [], only = null, auto = false } = {}, budgetMs = CHAT_BUDGET_MS) {
  const system = systemPrompt(groups);
  const messages = [...history, { role: 'user', content: userTurnText }];
  const trace = [];
  const meta = { calls: 0, provider: '', deadline: Date.now() + budgetMs, tools: toolsFor(groups, only), maxTokens: groups.includes('bulk') ? LIST_TOKENS : REPLY_TOKENS, auto };
  let res = await toolLoop(messages, system, trace, meta);
  for (let i = 0; i < MAX_CORRECTIONS && res.finish !== 'TIME' && meta.deadline - Date.now() > CORRECTION_MIN_MS; i++) {
    const fix = critique(res, trace);
    if (!fix) break;
    messages.push({ role: 'user', content: fix });
    const again = await toolLoop(messages, system, trace, meta);
    if (again.finish === 'TIME' && res.text) break; // keep the answer we had
    res = again;
  }
  let text = report(res, trace);
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
function recentHistory(n = 4) {
  const out = [];
  for (const m of load('chat').messages.slice(-n)) {
    if (T.diffMin(m.time, T.nowStr()) > 60) continue;
    const role = m.role === 'user' ? 'user' : 'assistant';
    if (m.auto || m.briefing) continue; // Donna's own notes aren't part of the conversation
    const limit = role === 'user' ? 300 : 400;
    const text = m.text.length > limit ? m.text.slice(0, limit) + '…' : m.text;
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
  // "cancel it" with nothing before it to point at: ask, instead of letting the model guess.
  const bare = /^\s*(?:please\s+)?(cancel|delete|remove|move|reschedule|shift|push|rename)\s+(?:it|that|this|this one|that one)\s*(?:please)?\s*[.!?]*\s*$/i.exec(message);
  if (bare) {
    const recent = load('actions').items.slice(-8).some(x => x.status === 'active' && !x.auto && x.source === 'chat' && T.diffMin(x.time, T.nowStr()) <= 60);
    const last = [...load('chat').messages].reverse().find(m => m.role === 'assistant' && !m.auto);
    const listed = last && last.listed && last.listed.length && T.diffMin(last.time, T.nowStr()) <= 60;
    if (!recent && !listed && !RUN.prevUserText) return `Which event should I ${bare[1].toLowerCase()}? Tell me its name or time, e.g. "${bare[1].toLowerCase()} the 4pm tomorrow".`;
  }
  // "remind me to X" with no day or time: a reminder (a list, not the calendar).
  const note = await quickReminder(message);
  if (note !== null) return note;
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

/** opts.budgetMs: a shorter time budget for callers that must answer sooner than the default. */
export async function chat(message, { budgetMs = CHAT_BUDGET_MS } = {}) {
  message = String(message || '').trim().slice(0, 4000);
  if (!message) return { reply: '', actions: [] };
  beginRun('chat');
  const history = recentHistory();
  const { replies, rest } = await handleFeedback(message);
  RUN.userText = hinglish(rest);
  // A short follow-up ("no, cancel it dude") refers to the previous request: what it named still counts as named.
  const prev = [...load('chat').messages].reverse().find(m => m.role === 'user');
  // A follow-up continues a recent conversation, not one from yesterday.
  RUN.prevUserText = prev && rest.split(/\s+/).length <= 8 && T.diffMin(prev.time, T.nowStr()) <= 60 ? hinglish(prev.text.slice(0, 300)) : '';
  const parts = [...replies];
  let meta = null, trace = [], path = 'none';
  const began = Date.now();
  if (rest) {
    try {
      const quick = await fastPath(RUN.userText);
      path = quick !== null ? 'code' : 'ai';
      if (quick !== null) parts.push([...(!quick || /^(Heads-up|Already|Priority|Runs alongside|Didn't invite|Colours show)/.test(quick) ? RUN.actions.filter(a => !a.auto).map(a => a.summary) : []), quick].filter(Boolean).join('\n'));
      else {
        const groups = groupsFor(rest + ' ' + RUN.prevUserText);
        const res = await runAgent(wrapUserMessage(rest, { prev: RUN.prevUserText, groups }), history, { groups }, budgetMs);
        parts.push(res.text);
        meta = res.meta; trace = res.trace;
      }
    } catch (e) {
      path = 'failed';
      // No AI available: simple "X tomorrow at 7" requests are still handled in code.
      let saved = null;
      if (/AI model|quota|unavailable/i.test(e.message)) { try { saved = await quickCreate(RUN.userText); } catch (err) { saved = '⚠️ ' + err.message; } }
      const done = RUN.actions.filter(a => !a.auto).map(a => a.summary);
      parts.push([...done, saved || '⚠️ ' + e.message].join('\n'));
    }
  }
  if ((RUN.actions.length || RUN.planNeeded) && settings().autonomous) {
    try { await plan(); } catch (e) { parts.push('⚠️ Planner: ' + e.message); }
  }
  const reply = clean(parts.join('\n\n'));
  const actions = RUN.actions.slice();
  noteMetric(path, Date.now() - began, meta && meta.provider);
  saveChat('user', message, []);
  saveChat('assistant', reply, actions, { ...(meta ? { model: meta.provider } : {}), ...(RUN.listed && RUN.listed.length ? { listed: RUN.listed.slice(0, 30) } : {}) });
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
    try { text = (await runAgent(autonomousPrompt(needAi, s.planDaysAhead), [], { only: AUTO_TOOLS, auto: true })).text; }
    catch (e) { text = '⚠️ Auto-check could not use the AI: ' + e.message; }
    if (RUN.actions.some(a => !a.auto)) await plan();
  }
  const actions = RUN.actions.slice();
  const visible = actions.filter(a => !a.auto || /^(Moved|Cancelled)/.test(a.summary));
  const summary = text || (label ? `${label}: ${actions.length ? `${actions.length} change${actions.length === 1 ? '' : 's'}` : 'everything already fits'}.` : `Kept your plan in shape: ${actions.length} automatic change${actions.length === 1 ? '' : 's'}.`);
  if (text || visible.length || label) saveChat('assistant', (label && text ? label + '. ' : '') + summary, actions, { auto: true });
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

/**
 * Daily counters for Settings → Health: how requests were answered (code / AI / failed) and how long they took.
 * Kept for 30 days in state (no extra row, no extra write).
 */
function noteMetric(path, ms, provider) {
  if (path === 'none') return;
  const st = load('state');
  const m = st.metrics && typeof st.metrics === 'object' ? st.metrics : {};
  const d = T.today();
  const row = m[d] || (m[d] = { code: 0, ai: 0, failed: 0, ms: 0, slow: 0 });
  row[path]++; row.ms += ms; if (ms > 10000) row.slow++;
  if (provider) { row.by = row.by || {}; row.by[provider.split('/')[0]] = (row.by[provider.split('/')[0]] || 0) + 1; }
  for (const k of Object.keys(m).sort().slice(0, -30)) delete m[k];
  st.metrics = m;
  save('state');
  if (typeof process === 'undefined') console.log(JSON.stringify({ event: 'chat', path, ms, provider: provider || '' })); // Workers Logs
}
