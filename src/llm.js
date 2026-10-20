// Model router: one neutral chat format, many free providers, automatic failover.
//   • workers-ai  Cloudflare's built-in models (free daily allowance, no key; only inside the Worker)
//   • gemini      Google AI Studio key
//   • groq / cerebras / openrouter / mistral   any OpenAI-compatible free key
// A provider that is out of quota, rate-limited or misconfigured is skipped until it recovers, and the
// conversation continues on the next one — so a request never dies because one free tier ran dry.
//
// Neutral format (OpenAI style):
//   { role: 'user' | 'assistant' | 'tool', content, calls?: [{ id, name, args }], callId?, name?, _gemini? }
import { settings, load, save } from './store.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);
const OPENAI_COMPAT = {
  groq: { url: 'https://api.groq.com/openai/v1/chat/completions', label: 'Groq' },
  cerebras: { url: 'https://api.cerebras.ai/v1/chat/completions', label: 'Cerebras' },
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', label: 'OpenRouter' },
  mistral: { url: 'https://api.mistral.ai/v1/chat/completions', label: 'Mistral' },
};
export const PROVIDERS = ['workers-ai', 'gemini', ...Object.keys(OPENAI_COMPAT)];
const GEMINI_FALLBACKS = ['gemini-flash-lite-latest', 'gemini-flash-latest'];

let aiBinding = null;
/** The Worker passes env.AI here; tests pass a fake. */
export function setAiBinding(ai) { aiBinding = ai; }
let fetchImpl = (...a) => fetch(...a);
export function useFetch(fn) { fetchImpl = fn || ((...a) => fetch(...a)); }

const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
/** Tool-call ids: 9 alphanumerics is the strictest format any provider accepts (Mistral). */
export const newCallId = () => Array.from({ length: 9 }, () => ALNUM[Math.floor(Math.random() * ALNUM.length)]).join('');

// ─── Health: blocks and usage ───
function blocks() {
  const st = load('state');
  const b = st.aiBlocked || {};
  for (const [k, v] of Object.entries(b)) if (!v || v.until < Date.now()) delete b[k];
  st.aiBlocked = b;
  return b;
}
function block(key, ms, why) { const st = load('state'); st.aiBlocked = { ...blocks(), [key]: { until: Date.now() + ms, why } }; save('state'); }
function count(key, tokens = 0) {
  const st = load('state');
  const u = st.aiUsage && st.aiUsage.date === today() ? st.aiUsage : { date: today(), calls: {}, tokens: {} };
  u.calls[key] = (u.calls[key] || 0) + 1;
  u.tokens[key] = (u.tokens[key] || 0) + tokens;
  st.aiUsage = u;
  save('state');
}
export function usageToday() { const u = load('state').aiUsage; return u && u.date === today() ? u : { calls: {}, tokens: {} }; }
const untilMidnightUtc = () => { const d = new Date(); d.setUTCHours(24, 0, 5, 0); return d - Date.now(); };
/** Gemini quotas reset at midnight Pacific ≈ 08:00 UTC. */
const untilMidnightPacific = () => { const d = new Date(); d.setUTCHours(8, 0, 5, 0); if (d <= Date.now()) d.setUTCDate(d.getUTCDate() + 1); return d - Date.now(); };

/** Providers that are configured, in the user's order. */
export function configured(s = settings()) {
  const order = [...new Set([...(s.aiOrder || []), ...PROVIDERS])].filter(p => PROVIDERS.includes(p));
  return order.filter(p => p === 'workers-ai' ? !!aiBinding && !!s.workersAiModel : !!s[keyField(p)]);
}
const keyField = p => ({ gemini: 'geminiApiKey', groq: 'groqApiKey', cerebras: 'cerebrasApiKey', openrouter: 'openrouterApiKey', mistral: 'mistralApiKey' })[p];
const modelOf = (p, s) => ({ 'workers-ai': s.workersAiModel, gemini: s.geminiModel, groq: s.groqModel, cerebras: s.cerebrasModel, openrouter: s.openrouterModel, mistral: s.mistralModel })[p];

/** Public status for the Settings page. */
export function providerStatus() {
  const s = settings();
  const b = blocks();
  const u = usageToday();
  return PROVIDERS.map(p => {
    const model = modelOf(p, s);
    const key = `${p}:${model}`;
    const blk = b[key] || b[p];
    return { id: p, model, ready: configured(s).includes(p), blocked: blk ? { until: new Date(blk.until).toISOString(), why: blk.why } : null, callsToday: u.calls[key] || 0 };
  });
}

/** The request ran out of its time budget (see generate's deadline). */
export class OutOfTime extends Error {}
const CALL_MS = 25000; // one model call never waits longer than this

class ProviderError extends Error {
  constructor(msg, { retryMs = 0, blockMs = 0, fatal = false } = {}) { super(msg); this.retryMs = retryMs; this.blockMs = blockMs; this.fatal = fatal; }
}

/**
 * @param {{system: string, messages: object[], tools?: object[], maxTokens?: number, prefer?: string, deadline?: number}} req
 *   deadline: epoch ms by which the whole call (all providers, all retries) must be done
 * @returns {Promise<{text: string, calls: {id: string, name: string, args: object}[], provider: string, model: string, raw?: object}>}
 */
export async function generate(req) {
  const s = settings();
  let order = configured(s);
  if (req.prefer && order.includes(req.prefer)) order = [req.prefer, ...order.filter(p => p !== req.prefer)];
  if (!order.length) throw new Error('No AI model is set up. On the hosted app this is automatic; on the laptop add a free Gemini key in Settings → AI.');
  const errors = [];
  const left = () => (req.deadline || Infinity) - Date.now();
  for (const p of order) {
    const models = p === 'gemini' ? [...new Set([s.geminiModel, ...GEMINI_FALLBACKS])] : [modelOf(p, s)];
    for (const model of models) {
      const key = `${p}:${model}`;
      const b = blocks();
      if (b[key] || b[p]) { errors.push(`${p}: ${(b[key] || b[p]).why}`); continue; }
      for (let attempt = 0; attempt < 2; attempt++) {
        if (left() < 3000) throw new OutOfTime('Ran out of time waiting for the AI.');
        try {
          const out = await call(p, model, { ...req, timeoutMs: Math.min(CALL_MS, left() - 1000) }, s);
          count(key, out.tokens || 0);
          return { ...out, provider: p, model };
        } catch (e) {
          if (!(e instanceof ProviderError)) { errors.push(`${p}: ${e.message}`); break; }
          if (e.retryMs && e.retryMs <= 4000 && attempt === 0 && left() > e.retryMs + 8000) { await sleep(e.retryMs); continue; }
          if (e.blockMs) block(e.fatal ? p : key, e.blockMs, e.message.slice(0, 160));
          errors.push(`${p}: ${e.message.slice(0, 160)}`);
          break;
        }
      }
    }
  }
  const quota = errors.every(x => /quota|limit|429|allocation|exhausted/i.test(x));
  if (errors.length && errors.every(x => /timed out|timeout|aborted/i.test(x))) throw new OutOfTime('Every AI model was too slow to answer.');
  throw new Error(quota
    ? 'Every free AI model I can use is out of quota right now. Add another free key in Settings → AI (Groq or Cerebras take a minute) or try again later.'
    : 'The AI models are unavailable right now: ' + errors.slice(0, 3).join(' · '));
}

async function call(p, model, req, s) {
  if (p === 'gemini') return callGemini(model, req, s.geminiApiKey);
  if (p === 'workers-ai') return callWorkersAi(model, req);
  return callOpenAi(p, model, req, s[keyField(p)]);
}

// ─── OpenAI-style (Workers AI + OpenAI-compatible APIs) ───
function toOpenAiMessages(system, messages) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'tool') out.push({ role: 'tool', tool_call_id: m.callId, name: m.name, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) });
    else if (m.role === 'assistant' && m.calls && m.calls.length) {
      out.push({ role: 'assistant', content: m.content || '', tool_calls: m.calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } })) });
    } else out.push({ role: m.role, content: m.content || '' });
  }
  return out;
}
const toOpenAiTools = tools => tools && tools.length ? tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) : undefined;

function parseArgs(a) {
  if (a && typeof a === 'object') return a;
  try { return JSON.parse(a || '{}'); } catch {
    try { return JSON.parse(String(a).replace(/,\s*}$/, '}')); } catch { return {}; }
  }
}
const stripThink = t => String(t || '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^[\s\S]*<\/think>/, '').trim();

/** Some open models write tool calls as text instead of using the API field. Recover them. */
function callsFromText(text, toolNames) {
  const found = [];
  const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let m;
  while ((m = re.exec(text))) {
    const j = parseArgs(m[1]);
    if (j.name && toolNames.has(j.name)) found.push({ id: newCallId(), name: j.name, args: parseArgs(j.arguments || j.parameters || {}) });
  }
  if (!found.length) {
    const t = text.trim();
    if (/^[[{]/.test(t)) {
      const j = parseArgs(t);
      for (const c of Array.isArray(j) ? j : [j]) if (c && c.name && toolNames.has(c.name)) found.push({ id: newCallId(), name: c.name, args: parseArgs(c.arguments || c.parameters || {}) });
    }
  }
  return found;
}

function normalizeOpenAi(message, tools) {
  const names = new Set((tools || []).map(t => t.name));
  let text = stripThink(message.content);
  let calls = (message.tool_calls || []).map(c => {
    const f = c.function || c;
    return { id: newCallId(), name: f.name, args: parseArgs(f.arguments ?? f.parameters) };
  }).filter(c => c.name);
  if (!calls.length && names.size) {
    calls = callsFromText(text, names);
    if (calls.length) text = text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
  }
  return { text, calls };
}

async function callWorkersAi(model, req) {
  let out;
  try {
    let timer;
    out = await Promise.race([
      aiBinding.run(model, {
        messages: toOpenAiMessages(req.system, req.messages),
        tools: toOpenAiTools(req.tools),
        max_tokens: req.maxTokens || 2048,
        temperature: 0.2,
      }),
      new Promise((_, no) => { timer = setTimeout(() => no(new Error('timed out')), req.timeoutMs || CALL_MS); }),
    ]).finally(() => clearTimeout(timer));
  } catch (e) {
    const msg = String(e && e.message || e);
    if (/4006|daily free allocation|neurons/i.test(msg)) throw new ProviderError('Cloudflare free AI allowance used up for today', { blockMs: untilMidnightUtc() });
    if (/5035|not available on the Workers Free plan|5007|No such model/i.test(msg)) throw new ProviderError(msg, { blockMs: 24 * 3600e3 });
    if (/3040|capacity|429|rate/i.test(msg)) throw new ProviderError(msg, { retryMs: 2000, blockMs: 60e3 });
    throw new ProviderError(msg, { retryMs: 1000, blockMs: 30e3 });
  }
  const msg = out && out.choices ? out.choices[0].message : { content: out.response, tool_calls: out.tool_calls };
  const usage = out.usage || {};
  return { ...normalizeOpenAi(msg || {}, req.tools), tokens: (usage.prompt_tokens || 0) + (usage.completion_tokens || 0) };
}

async function callOpenAi(p, model, req, key) {
  const body = { model, messages: toOpenAiMessages(req.system, req.messages), temperature: 0.2, max_tokens: req.maxTokens || 2048 };
  const tools = toOpenAiTools(req.tools);
  if (tools) { body.tools = tools; body.tool_choice = 'auto'; }
  let res, text;
  try {
    res = await fetchImpl(OPENAI_COMPAT[p].url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, ...(p === 'openrouter' ? { 'X-Title': 'Donna calendar agent' } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(req.timeoutMs || CALL_MS),
    });
    text = await res.text();
  } catch (e) { throw new ProviderError(`network: ${e.message}`, { retryMs: 1000, blockMs: 30e3 }); }
  if (res.status === 401 || res.status === 403) throw new ProviderError(`${OPENAI_COMPAT[p].label} rejected the API key`, { blockMs: 6 * 3600e3, fatal: true });
  if (res.status === 429) {
    const ra = Number(res.headers.get('retry-after')) * 1000 || 0;
    const daily = /per day|daily|TPD|RPD/i.test(text);
    throw new ProviderError(`${OPENAI_COMPAT[p].label} rate limit${daily ? ' (daily quota)' : ''}`, { retryMs: daily ? 0 : (ra || 3000), blockMs: daily ? 3 * 3600e3 : Math.max(ra, 60e3) });
  }
  if (res.status === 404 || res.status === 400 && /model/i.test(text) && /not|exist|found|decommission/i.test(text)) throw new ProviderError(`model ${model} unavailable`, { blockMs: 12 * 3600e3 });
  if (res.status >= 500) throw new ProviderError(`${OPENAI_COMPAT[p].label} ${res.status}`, { retryMs: 1500, blockMs: 60e3 });
  if (!res.ok) throw new ProviderError(`${OPENAI_COMPAT[p].label} ${res.status}: ${text.slice(0, 160)}`, { blockMs: 5 * 60e3 });
  const data = JSON.parse(text);
  const msg = data.choices && data.choices[0] && data.choices[0].message || {};
  const u = data.usage || {};
  return { ...normalizeOpenAi(msg, req.tools), tokens: (u.prompt_tokens || 0) + (u.completion_tokens || 0) };
}

// ─── Gemini ───
function upperTypes(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const out = Array.isArray(schema) ? [] : {};
  for (const [k, v] of Object.entries(schema)) out[k] = k === 'type' && typeof v === 'string' ? v.toUpperCase() : (typeof v === 'object' ? upperTypes(v) : v);
  return out;
}
function toGeminiContents(messages) {
  const out = [];
  const push = (role, parts) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts.push(...parts); else out.push({ role, parts });
  };
  for (const m of messages) {
    if (m.role === 'tool') push('user', [{ functionResponse: { name: m.name, response: { result: m.content } } }]);
    else if (m.role === 'assistant') {
      if (m._gemini) { push('model', structuredClone(m._gemini)); continue; }
      const parts = [];
      if (m.content) parts.push({ text: m.content });
      (m.calls || []).forEach(c => parts.push({ functionCall: { name: c.name, args: c.args || {} }, thoughtSignature: 'skip_thought_signature_validator' }));
      push('model', parts.length ? parts : [{ text: '' }]);
    } else push('user', [{ text: m.content || '' }]);
  }
  if (out.length && out[0].role !== 'user') out.unshift({ role: 'user', parts: [{ text: '(start)' }] });
  return out;
}

async function callGemini(model, req, key) {
  const body = { contents: toGeminiContents(req.messages), systemInstruction: { parts: [{ text: req.system }] }, generationConfig: { temperature: 0.2, maxOutputTokens: req.maxTokens || 4096 } };
  if (req.tools && req.tools.length) {
    body.tools = [{ functionDeclarations: req.tools.map(t => ({ name: t.name, description: t.description, parameters: upperTypes(t.parameters) })) }];
    body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
  }
  let res, text;
  try {
    res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body), signal: AbortSignal.timeout(req.timeoutMs || CALL_MS),
    });
    text = await res.text();
  } catch (e) { throw new ProviderError(`network: ${e.message}`, { retryMs: 1000, blockMs: 30e3 }); }
  if (res.status === 404) throw new ProviderError(`model ${model} retired`, { blockMs: 24 * 3600e3 });
  if (res.status === 429) {
    const m = /"retryDelay":\s*"(\d+(?:\.\d+)?)s"/.exec(text);
    const wait = m ? Math.ceil(parseFloat(m[1]) * 1000) : 5000;
    if (/PerDay/i.test(text)) throw new ProviderError('Gemini daily quota used up', { blockMs: Math.max(untilMidnightPacific(), 3600e3) });
    throw new ProviderError('Gemini rate limit', { retryMs: wait, blockMs: Math.max(wait, 60e3) });
  }
  if (res.status === 400 && /API key/i.test(text) || res.status === 403) throw new ProviderError('Gemini rejected the API key', { blockMs: 6 * 3600e3, fatal: true });
  if (res.status >= 500) throw new ProviderError(`Gemini ${res.status}`, { retryMs: 1500, blockMs: 60e3 });
  if (!res.ok) throw new ProviderError(`Gemini ${res.status}: ${text.slice(0, 200)}`, { blockMs: 5 * 60e3 });
  const data = JSON.parse(text);
  const cand = (data.candidates || [])[0];
  const parts = (cand && cand.content && cand.content.parts) || [];
  const calls = parts.filter(p => p.functionCall).map(p => ({ id: newCallId(), name: p.functionCall.name, args: p.functionCall.args || {} }));
  const u = data.usageMetadata || {};
  return { text: parts.filter(p => p.text && !p.thought).map(p => p.text).join('').trim(), calls, raw: { gemini: parts }, tokens: u.totalTokenCount || 0 };
}

/** One-shot text completion (no tools), e.g. turning feedback into a rule. */
export async function complete(system, prompt, maxTokens = 400) {
  const out = await generate({ system, messages: [{ role: 'user', content: prompt }], maxTokens });
  return out.text;
}
