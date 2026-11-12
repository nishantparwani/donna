// node eval/crud-run.js [out.json|-] [word…]   Runs eval/crud.js against the real agent + a real model.
// Env: EVAL_PROVIDER (gemini|groq), EVAL_MODEL, GEMINI_API_KEY, GROQ_API_KEY, EVAL_PAUSE_MS.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NOW, FIXTURE, SCENARIOS } from './crud.js';
import { load, save, saveSettings } from '../src/store.js';
import { useFsStore } from '../src/node-store.js';
import { setNow, setTimeZone } from '../src/time.js';
import * as cal from '../src/calendar.js';
import { beginRun } from '../src/engine.js';
import { plan } from '../src/planner.js';
import { chat } from '../src/agent.js';
import { setAiBinding } from '../src/llm.js';

const [out = '-', ...words] = process.argv.slice(2);
const PROVIDER = process.env.EVAL_PROVIDER || 'gemini';
const MODEL = process.env.EVAL_MODEL || (PROVIDER === 'gemini' ? 'gemini-flash-lite-latest' : PROVIDER === 'workers-ai' ? '@cf/qwen/qwen3-30b-a3b-fp8' : 'openai/gpt-oss-120b');
const PROBE = process.env.AI_PROBE || 'http://127.0.0.1:8799';
if (PROVIDER === 'workers-ai') setAiBinding({ async run(model, input) { const r = await fetch(PROBE, { method: 'POST', body: JSON.stringify({ model, ...input }) }); const j = await r.json(); if (j.error) throw new Error(j.error); return j.out; } });
const PAUSE = Number(process.env.EVAL_PAUSE_MS ?? 4500);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const chosen = SCENARIOS.filter(s => !words.length || words.some(w => s.name.toLowerCase().includes(w.toLowerCase())));
const FIELDS = ['title', 'start', 'end', 'description', 'location', 'myStatus'];
const noise = e => e.agent && (e.kind === 'buffer' || /^focus block$/i.test(e.title) || !!e.habitId || !!e.taskId);
const snap = () => new Map(cal.all().filter(e => !noise(e)).map(e => [e.id, structuredClone(e)]));
function diffOf(a, b) {
  const removed = [...a.values()].filter(e => !b.has(e.id));
  const added = [...b.values()].filter(e => !a.has(e.id));
  const changed = [...b.values()].filter(e => a.has(e.id) && FIELDS.some(k => (a.get(e.id)[k] || '') !== (e[k] || '')));
  return { removed, added, changed };
}
const results = [];
const UNAVAILABLE = /unavailable right now|out of quota|took too long/i;
for (const sc of chosen) {
 for (let attempt = 0; ; attempt++) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'donna-crud-'));
  await useFsStore(dir);
  setNow(NOW); setTimeZone('Asia/Kolkata');
  saveSettings({ privateAi: false, geminiApiKey: PROVIDER === 'gemini' ? process.env.GEMINI_API_KEY : '', groqApiKey: PROVIDER === 'groq' ? process.env.GROQ_API_KEY : '',
    aiOrder: [PROVIDER], workersAiModel: PROVIDER === 'workers-ai' ? MODEL : '', geminiModel: PROVIDER === 'gemini' ? MODEL : 'gemini-flash-lite-latest', groqModel: PROVIDER === 'groq' ? MODEL : 'openai/gpt-oss-120b',
    autonomous: true, userName: 'Harvey', dayStart: '09:30', dayEnd: '23:30', workStart: '09:00', workEnd: '18:00' });
  const st = load('settings'); for (const k of ['geminiApiKey', 'groqApiKey', 'cerebrasApiKey', 'openrouterApiKey', 'mistralApiKey']) if (!k.startsWith(PROVIDER)) st[k] = ''; save('settings');
  cal.replaceAll(FIXTURE);
  beginRun('auto'); await plan();
  const before = snap();
  const t0 = Date.now();
  let res = { reply: '' }, crashed = '';
  const steps = [];
  try { for (const m of sc.say) { res = await chat(m); steps.push(...(res.trace || [])); } } catch (e) { crashed = e.message; res = { reply: '⚠️ ' + e.message }; }
  const seconds = (Date.now() - t0) / 1000;
  if (UNAVAILABLE.test(res.reply || '') && attempt < 4) { fs.rmSync(dir, { recursive: true, force: true }); console.log('   (model unavailable, retrying) ' + String(res.reply).slice(0, 110)); await sleep(70000); continue; }
  const after = snap();
  const diff = diffOf(before, after);
  const usage = load('state').aiUsage || { calls: {}, tokens: {} };
  const calls = Object.values(usage.calls).reduce((a, b) => a + b, 0), tokens = Object.values(usage.tokens).reduce((a, b) => a + b, 0);
  const c = { events: [...after.values()], reply: res.reply || '', diff, calls, tokens };
  const failed = [];
  for (const [label, fn] of Object.entries(sc.checks)) { let ok = false; try { ok = !!fn(c); } catch { /* counted as failed */ } if (!ok) failed.push(label); }
  const touched = [...diff.removed, ...diff.added, ...diff.changed];
  const collateral = touched.filter(e => !(sc.touch && sc.touch.test(e.title)));
  if (collateral.length) failed.push(`collateral: ${[...new Set(collateral.map(e => e.title))].slice(0, 4).join(', ')} (${collateral.length})`);
  if (/⚠️|took too long|could not finish/i.test(c.reply)) failed.push('agent error');
  const ok = !failed.length;
  if (!ok && process.env.EVAL_VERBOSE) for (const t of steps) console.log(`     ${t.tool} ${JSON.stringify(t.args).slice(0, 240)}\n       = ${JSON.stringify(t.result).slice(0, 240)}`);
  results.push({ group: sc.group, name: sc.name, ok, failed, reply: c.reply.slice(0, 400), calls, tokens, seconds, crashed });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${sc.name} (${calls}c ${tokens}t ${seconds.toFixed(1)}s)${ok ? '' : '\n   x ' + failed.join('; ') + '\n   > ' + c.reply.replace(/\n/g, ' / ').slice(0, 220)}`);
  fs.rmSync(dir, { recursive: true, force: true });
  if (calls && PAUSE) await sleep(PAUSE * calls);
  break;
 }
}
const sum = f => results.reduce((a, r) => a + f(r), 0);
const groups = {};
for (const r of results) { const g = groups[r.group] ||= { pass: 0, n: 0 }; g.n++; if (r.ok) g.pass++; }
const summary = { provider: PROVIDER, model: MODEL, pass: results.filter(r => r.ok).length, total: results.length, groups, tokens: sum(r => r.tokens), calls: sum(r => r.calls),
  avgTokens: Math.round(sum(r => r.tokens) / results.length), avgCalls: +(sum(r => r.calls) / results.length).toFixed(2), avgSeconds: +(sum(r => r.seconds) / results.length).toFixed(1), maxSeconds: Math.max(...results.map(r => r.seconds)) };
console.log('\n' + JSON.stringify(summary));
if (out !== '-') fs.writeFileSync(out, JSON.stringify({ summary, results }, null, 1));
