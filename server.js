// Donna — laptop server. Run: node server.js  (add --open to launch the app window)
// Optional: set APP_PASSWORD to require a login (e.g. when exposing it through a tunnel).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { useFsStore } from './src/node-store.js';
import { handle, scheduledRun, session, isPublicRoute } from './src/api.js';
import { load } from './src/store.js';
import { learnProfile } from './src/learning.js';
import { isAuthed, makeCookie, clearCookie, checkPassword } from './src/auth.js';
import { setAiBinding } from './src/llm.js';

const PORT = Number(process.env.PORT || 4321);
const HOST = process.env.HOST || '127.0.0.1'; // only this computer can reach the app by default
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const URL_ = `http://localhost:${PORT}`;
const PASSWORD = process.env.APP_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('cal-agent:' + PASSWORD).digest('hex');

await useFsStore();

// Development: AI_PROBE points at a `wrangler dev` worker that forwards to Workers AI (see eval/run.js).
if (process.env.AI_PROBE) setAiBinding({ async run(model, input) {
  const r = await fetch(process.env.AI_PROBE, { method: 'POST', body: JSON.stringify({ model, ...input }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.out;
} });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

function send(res, code, data, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
}
async function readBody(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 20e6) throw new Error('Request too large'); }
  return raw;
}
function serveFile(res, file) {
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, URL_);
  const origin = req.headers.origin;
  if (origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return send(res, 403, { error: 'Forbidden' });
  try {
    if (u.pathname === '/api/login' && req.method === 'POST') {
      const { password } = JSON.parse(await readBody(req) || '{}');
      if (!PASSWORD || checkPassword(password, PASSWORD)) return send(res, 200, { ok: true }, { 'Set-Cookie': await makeCookie(SECRET, false) });
      return send(res, 401, { error: 'Wrong password' });
    }
    if (u.pathname === '/api/logout') return send(res, 200, { ok: true }, { 'Set-Cookie': clearCookie(false) });
    if (u.pathname.startsWith('/book')) return serveFile(res, path.join(PUBLIC, 'book.html'));
    if (u.pathname.startsWith('/api/')) {
      const open = isPublicRoute(req.method, u.pathname);
      if (!open && PASSWORD && !(await isAuthed(req.headers.cookie, SECRET))) return send(res, 401, { error: 'Login required' });
      const r = await handle(req.method, u.pathname, u.searchParams, () => readBody(req), { authEnabled: !!PASSWORD, authorization: req.headers.authorization || '' });
      if (r.text !== undefined) { res.writeHead(r.status, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end(r.text); }
      return send(res, r.status, r.body);
    }
    if (req.method !== 'GET') return send(res, 404, { error: 'Not found' });
    const file = path.normalize(path.join(PUBLIC, u.pathname === '/' ? 'index.html' : u.pathname));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, { error: 'Not found' });
    serveFile(res, file);
  } catch (e) {
    console.error(e.message);
    send(res, 500, { error: e.message });
  }
});

function openWindow() {
  const cmd = process.platform === 'win32' ? `start "" msedge --app=${URL_}`
    : process.platform === 'darwin' ? `open -na "Google Chrome" --args --app=${URL_}` : `xdg-open ${URL_}`;
  exec(cmd, err => { if (err) exec(process.platform === 'win32' ? `start "" ${URL_}` : `open ${URL_}`); });
}

server.on('error', e => {
  if (e.code === 'EADDRINUSE') { console.log(`Already running at ${URL_}`); if (process.argv.includes('--open')) openWindow(); setTimeout(() => process.exit(0), 500); }
  else throw e;
});

server.listen(PORT, HOST, async () => {
  console.log(`Donna running at ${URL_}  (Ctrl+C to stop)`);
  if (process.argv.includes('--open')) openWindow();
  const mem = load('memory');
  if (!mem.profile || !mem.profile.updated) {
    try { await session(() => learnProfile(), { days: [-60, 0] }); } catch (e) { console.error('Could not learn profile yet:', e.message); }
  }
});

// Background autonomy while the app runs: every 15 minutes.
setInterval(() => scheduledRun().catch(e => console.error('Auto-run failed:', e.message)), 15 * 60e3);
