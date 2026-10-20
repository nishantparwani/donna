// Runs the eval scenarios against the real agent + a real model, each in a fresh sandbox.
//   node eval/run.js                       all scenarios (Workers AI through the local probe worker)
//   node eval/run.js clear ambig           only scenarios whose name contains a word
// Env:
//   EVAL_PROVIDER=workers-ai|gemini|groq…  which provider to test (default workers-ai)
//   EVAL_MODEL=<model id>                  override the model
//   AI_PROBE=http://127.0.0.1:8799         a `wrangler dev` worker that forwards {model, ...input} to env.AI.run
//   GEMINI_API_KEY / GROQ_API_KEY …        keys for the other providers
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOW, BASE, SCENARIOS } from './scenarios.js';
import { load, save, saveSettings } from '../src/store.js';
import { useFsStore } from '../src/node-store.js';
import { setNow, setTimeZone } from '../src/time.js';
import * as cal from '../src/calendar.js';
import { beginRun } from '../src/engine.js';
import { plan } from '../src/planner.js';
import { chat } from '../src/agent.js';
import { setAiBinding } from '../src/llm.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAUSE_MS = Number(process.env.EVAL_PAUSE_MS || 500);
const PROVIDER = process.env.EVAL_PROVIDER || 'workers-ai';
const PROBE = process.env.AI_PROBE || 'http://127.0.0.1:8799';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let legacy = {};
try { legacy = JSON.parse(fs.readFileSync(path.join(HERE, '..', '..', 'local', 'data', 'settings.json'), 'utf8')); } catch { /* none */ }
const keys = {
  geminiApiKey: process.env.GEMINI_API_KEY || legacy.geminiApiKey || '',
  groqApiKey: process.env.GROQ_API_KEY || '', cerebrasApiKey: process.env.CEREBRAS_API_KEY || '',
  openrouterApiKey: process.env.OPENROUTER_API_KEY || '', mistralApiKey: process.env.MISTRAL_API_KEY || '',
};
let aiCalls = 0;
const probe = { async run(model, input) {
  aiCalls++;
  const r = await fetch(PROBE, { method: 'POST', body: JSON.stringify({ model, ...input }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.out;
} };

const filters = process.argv.slice(2).map(s => s.toLowerCase());
const chosen = SCENARIOS.filter(s => !filters.length || filters.some(f => s.name.toLowerCase().includes(f)));
const results = [];
let passed = 0, total = 0;
console.log(`Provider: ${PROVIDER}${process.env.EVAL_MODEL ? ' / ' + process.env.EVAL_MODEL : ''} · ${chosen.length} scenarios\n`);

for (const sc of chosen) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'donna-eval-'));
  await useFsStore(dir);
  setNow(NOW);
  setTimeZone('Asia/Kolkata');
  setAiBinding(PROVIDER === 'workers-ai' ? probe : null);
  const model = process.env.EVAL_MODEL;
  saveSettings({ ...keys, aiOrder: [PROVIDER], autonomous: true, dayStart: '07:00', dayEnd: '23:00',
    ...(model ? { [{ 'workers-ai': 'workersAiModel', gemini: 'geminiModel', groq: 'groqModel', cerebras: 'cerebrasModel', openrouter: 'openrouterModel', mistral: 'mistralModel' }[PROVIDER]]: model } : {}) });
  // Only the chosen provider: blank the others' keys so the router cannot fall back silently.
  const st = load('settings');
  for (const k of Object.keys(keys)) if (!k.startsWith(PROVIDER)) st[k] = '';
  save('settings');
  cal.replaceAll([...BASE, ...(sc.extra || [])]);
  if (sc.rules) { const mem = load('memory'); sc.rules.forEach((r, i) => mem.rules.push({ id: 'r' + (i + 1), text: r, source: 'eval', active: true, time: NOW })); save('memory'); }
  beginRun('auto'); await plan();

  const steps = sc.steps || [sc.say];
  aiCalls = 0;
  const realFetch = globalThis.__realFetch || (globalThis.__realFetch = globalThis.fetch);
  globalThis.fetch = (url, opts) => { if (!String(url).startsWith(PROBE)) aiCalls++; return realFetch(url, opts); };
  let out = { reply: '', actions: [] };
  const started = Date.now();
  try { for (const msg of steps) out = await chat(msg); }
  catch (e) { out = { reply: '⚠️ ' + e.message, actions: [] }; }
  globalThis.fetch = realFetch;
  const ctx = { events: cal.all().map(e => ({ ...e })), reply: out.reply || '', actions: out.actions || [], memory: load('memory'),
    tasks: load('tasks').items, habits: load('habits').items, goals: load('goals').items, settings: load('settings'), base: BASE.length + (sc.extra || []).length, calls: aiCalls };
  const failed = [];
  for (const [label, fn] of Object.entries(sc.checks)) {
    let ok = false;
    try { ok = !!fn(ctx); } catch { ok = false; }
    total++; if (ok) passed++; else failed.push(label);
  }
  const ok = failed.length === 0;
  console.log(`${ok ? '✅' : '❌'} ${sc.name}  (${((Date.now() - started) / 1000).toFixed(1)}s · ${aiCalls} model call${aiCalls === 1 ? '' : 's'}${out.model ? ' · ' + out.model : ''})`);
  if (!ok) {
    failed.forEach(f => console.log(`     ✗ ${f}`));
    console.log(`     reply: ${ctx.reply.replace(/\n/g, ' ⏎ ').slice(0, 300)}`);
    ctx.actions.filter(a => !a.auto).slice(0, 8).forEach(a => console.log(`     ${a.id}: ${a.summary}`));
    if (process.env.EVAL_VERBOSE) (out.trace || []).forEach(t => console.log(`     → ${t.tool} ${JSON.stringify(t.args).slice(0, 220)}
       ← ${JSON.stringify(t.result).slice(0, 260)}`));
  }
  results.push({ name: sc.name, ok, failed, reply: ctx.reply, actions: ctx.actions.filter(a => !a.auto), calls: aiCalls, seconds: (Date.now() - started) / 1000 });
  fs.rmSync(dir, { recursive: true, force: true });
  if (sc !== chosen[chosen.length - 1]) await sleep(PAUSE_MS);
}

const scenariosOk = results.filter(r => r.ok).length;
const avgCalls = (results.reduce((a, r) => a + r.calls, 0) / results.length).toFixed(1);
const avgSec = (results.reduce((a, r) => a + r.seconds, 0) / results.length).toFixed(1);
console.log(`\nScenarios: ${scenariosOk}/${results.length} · Checks: ${passed}/${total} · avg ${avgCalls} model calls, ${avgSec}s per scenario`);
const file = path.join(HERE, `results-${PROVIDER}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
fs.writeFileSync(file, JSON.stringify({ now: NOW, provider: PROVIDER, model: process.env.EVAL_MODEL || '', scenariosOk, scenarios: results.length, passed, total, results }, null, 1));
console.log('Saved', path.relative(process.cwd(), file));
