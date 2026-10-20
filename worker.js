// Donna — Cloudflare Worker (free plan): password-protected app + API + public booking page + 15-minute cron.
// Secrets: APP_PASSWORD (login), SESSION_SECRET (cookie signing), SIRI_KEY (optional Shortcuts key).
// Bindings: DB (D1, table "kv"), AI (Workers AI, free daily allowance), ASSETS (public/).
import { useBackend } from './src/store.js';
import { handle, scheduledRun, isPublicRoute } from './src/api.js';
import { setAiBinding } from './src/llm.js';
import { isAuthed, makeCookie, clearCookie, checkPassword } from './src/auth.js';
import { newChallenge, verifyRegistration, verifyLogin } from './src/passkey.js';

const LOCKOUT_FAILS = 8, LOCKOUT_GLOBAL = 60, LOCKOUT_MS = 15 * 60e3;
const PUBLIC_POSTS_PER_HOUR = 12;
let installed = false, tableReady = false;

async function ensureTable(env) {
  if (tableReady) return;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS kv (name TEXT PRIMARY KEY, value TEXT NOT NULL)').run();
  tableReady = true;
}

function install(env) {
  if (env.AI) setAiBinding(env.AI);
  if (installed) return;
  useBackend({
    immediate: false,
    async readAll(lazy = []) {
      await ensureTable(env);
      const skip = ['auth', 'ratelimit', 'gcache', 'passkeys', ...lazy].map(n => `'${n.replace(/'/g, '')}'`).join(', ');
      const { results } = await env.DB.prepare(`SELECT name, value FROM kv WHERE name NOT IN (${skip})`).all();
      return Object.fromEntries(results.map(r => [r.name, r.value]));
    },
    async readOne(name) {
      await ensureTable(env);
      const r = await env.DB.prepare('SELECT value FROM kv WHERE name = ?1').bind(name).first();
      return r ? r.value : undefined;
    },
    async write(name, text) {
      await env.DB.prepare('INSERT INTO kv (name, value) VALUES (?1, ?2) ON CONFLICT(name) DO UPDATE SET value = excluded.value').bind(name, text).run();
    },
    async writeRow(name, text, guard) {
      await ensureTable(env);
      if (!guard) { await this.write(name, text); return true; }
      // Atomic: only replace a row whose guard field is older than ours.
      const r = await env.DB.prepare(`INSERT INTO kv (name, value) VALUES (?1, ?2) ON CONFLICT(name) DO UPDATE SET value = excluded.value
        WHERE COALESCE(json_extract(kv.value, '$.${guard.field.replace(/\W/g, '')}'), 0) < ?3`).bind(name, text, guard.below).run();
      return !!(r.meta && r.meta.changes);
    },
  });
  installed = true;
}

const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=(self)',
  'Strict-Transport-Security': 'max-age=31536000',
};
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY, ...headers },
});
const withSecurity = res => {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY)) r.headers.set(k, v);
  return r;
};

async function row(env, name, fallback) {
  await ensureTable(env);
  const r = await env.DB.prepare('SELECT value FROM kv WHERE name = ?1').bind(name).first();
  try { return r ? JSON.parse(r.value) : fallback; } catch { return fallback; }
}
const saveRow = (env, name, v) => env.DB.prepare('INSERT INTO kv (name, value) VALUES (?1, ?2) ON CONFLICT(name) DO UPDATE SET value = excluded.value').bind(name, JSON.stringify(v)).run();

async function ipKey(request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('donna:' + ip));
  return btoa(String.fromCharCode(...new Uint8Array(h).slice(0, 9)));
}
// Passkeys and the session "epoch" (bumped by "sign out everywhere": every older cookie stops working).
let keysMemo = null;
async function passkeys(env) {
  if (keysMemo && Date.now() - keysMemo.at < 30e3) return keysMemo.v;
  const v = await row(env, 'passkeys', { keys: [], epoch: 0 });
  keysMemo = { at: Date.now(), v };
  return v;
}
async function savePasskeys(env, v) { keysMemo = { at: Date.now(), v }; await saveRow(env, 'passkeys', v); }
const cookieSecret = (secret, epoch) => epoch ? `${secret}:${epoch}` : secret;

/** Failed sign-ins per visitor and overall, for the lockout. */
async function lockout(env, request) {
  const st = await row(env, 'auth', {});
  const now = Date.now(), who = await ipKey(request);
  const fails = (st.fails || []).filter(f => f && typeof f === 'object' && now - f.t < LOCKOUT_MS); // old rows held bare timestamps
  return {
    locked: fails.filter(f => f.ip === who).length >= LOCKOUT_FAILS || fails.length >= LOCKOUT_GLOBAL,
    async fail() { fails.push({ ip: who, t: now }); await saveRow(env, 'auth', { fails }); },
    async clear() { const others = fails.filter(f => f.ip !== who); if (others.length !== fails.length) await saveRow(env, 'auth', { fails: others }); },
  };
}

/** True if this visitor may make another public write (bookings / cancels). */
async function allowPublicWrite(env, request) {
  const st = await row(env, 'ratelimit', {});
  const now = Date.now();
  for (const [k, v] of Object.entries(st)) { st[k] = v.filter(t => now - t < 3600e3); if (!st[k].length) delete st[k]; }
  const k = await ipKey(request);
  st[k] = st[k] || [];
  if (st[k].length >= PUBLIC_POSTS_PER_HOUR) return false;
  st[k].push(now);
  await saveRow(env, 'ratelimit', st);
  return true;
}

export default {
  async fetch(request, env) {
    install(env);
    const url = new URL(request.url);
    // Never let the password or session cookie travel over plain HTTP.
    if (url.protocol === 'http:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 301);
    }
    const secure = url.protocol === 'https:';
    if (!env.APP_PASSWORD) return new Response('Set the APP_PASSWORD secret (npx wrangler secret put APP_PASSWORD).', { status: 500 });
    const secret = env.SESSION_SECRET || env.APP_PASSWORD;

    // Block cross-site requests to the API.
    const origin = request.headers.get('Origin');
    if (url.pathname.startsWith('/api/') && origin && origin !== url.origin) return json(403, { error: 'Forbidden' });

    // Public booking page and its API: no login.
    if (url.pathname.startsWith('/book/') || url.pathname === '/book') {
      return withSecurity(await env.ASSETS.fetch(new Request(url.origin + '/book', request)));
    }
    if (isPublicRoute(request.method, url.pathname)) {
      const siri = url.pathname === '/api/siri';
      if (request.method === 'POST' && !siri && !(await allowPublicWrite(env, request))) return json(429, { error: 'Too many requests. Please try again later.' });
      try {
        const r = await handle(request.method, url.pathname, url.searchParams, () => request.text(), { public: true, authorization: request.headers.get('Authorization') || '' });
        if (r.text !== undefined) return new Response(r.text, { status: r.status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY } });
        return json(r.status, r.body);
      } catch (e) {
        return siri ? new Response('Sorry, something went wrong: ' + e.message, { status: 500 }) : json(400, { error: e.message });
      }
    }

    const pk = { secret, origin: url.origin, rpId: url.hostname };
    if (url.pathname === '/api/login' && request.method === 'POST') {
      // Lockout per visitor, so a stranger guessing cannot lock you out; the global ceiling still stops brute force.
      const lock = await lockout(env, request);
      if (lock.locked) return json(429, { error: 'Too many attempts. Try again in 15 minutes.' });
      let password = '';
      try { password = (await request.json()).password; } catch { /* empty */ }
      if (checkPassword(password, env.APP_PASSWORD)) {
        await lock.clear();
        return json(200, { ok: true }, { 'Set-Cookie': await makeCookie(cookieSecret(secret, (await passkeys(env)).epoch), secure) });
      }
      await lock.fail();
      return json(401, { error: 'Wrong password' });
    }
    if (url.pathname === '/api/passkey/challenge' && request.method === 'GET') {
      const v = await passkeys(env);
      return json(200, { challenge: await newChallenge(secret), rpId: url.hostname, registered: v.keys.length });
    }
    if (url.pathname === '/api/passkey/login' && request.method === 'POST') {
      const lock = await lockout(env, request);
      if (lock.locked) return json(429, { error: 'Too many attempts. Try again in 15 minutes.' });
      try {
        const body = await request.json();
        const v = await passkeys(env);
        const key = await verifyLogin(body, v.keys, pk);
        await savePasskeys(env, { ...v, keys: v.keys.map(k => k.id === key.id ? key : k) });
        await lock.clear();
        return json(200, { ok: true, name: key.name }, { 'Set-Cookie': await makeCookie(cookieSecret(secret, v.epoch), secure) });
      } catch (e) {
        await lock.fail();
        return json(401, { error: e.message });
      }
    }
    if (url.pathname === '/api/logout') return json(200, { ok: true }, { 'Set-Cookie': clearCookie(secure) });

    const cookie = request.headers.get('Cookie') || '';
    const authed = cookie.includes('cal_session=') && await isAuthed(cookie, cookieSecret(secret, (await passkeys(env)).epoch));
    if (url.pathname.startsWith('/api/')) {
      if (!authed) return json(401, { error: 'Login required' });
      // Passkeys and sessions (signed in only).
      if (url.pathname.startsWith('/api/passkey/') || url.pathname === '/api/sessions/revoke') {
        try {
          const v = await passkeys(env);
          const list = () => v.keys.map(({ id, name, created, lastUsed }) => ({ id, name, created, lastUsed }));
          if (url.pathname === '/api/passkey/list') return json(200, { keys: list(), challenge: await newChallenge(secret), rpId: url.hostname });
          const body = await request.json().catch(() => ({}));
          if (url.pathname === '/api/passkey/register' && request.method === 'POST') {
            const key = await verifyRegistration(body, pk);
            v.keys = [...v.keys.filter(k => k.id !== key.id), key].slice(-10);
            await savePasskeys(env, v);
            return json(200, { keys: list() });
          }
          if (url.pathname === '/api/passkey/remove' && request.method === 'POST') {
            v.keys = v.keys.filter(k => k.id !== String(body.id));
            await savePasskeys(env, v);
            return json(200, { keys: list() });
          }
          if (url.pathname === '/api/sessions/revoke' && request.method === 'POST') {
            v.epoch = (Number(v.epoch) || 0) + 1;
            await savePasskeys(env, v);
            return json(200, { ok: true }, { 'Set-Cookie': await makeCookie(cookieSecret(secret, v.epoch), secure) });
          }
          return json(404, { error: 'Not found' });
        } catch (e) { return json(400, { error: e.message }); }
      }
      try {
        const r = await handle(request.method, url.pathname, url.searchParams, () => request.text(), { authEnabled: true });
        return json(r.status, r.body);
      } catch (e) {
        return json(500, { error: e.message });
      }
    }
    if (!authed && (url.pathname === '/' || url.pathname === '/index.html')) return Response.redirect(url.origin + '/login.html', 302);
    return withSecurity(await env.ASSETS.fetch(request));
  },

  async scheduled(event, env, ctx) {
    install(env);
    ctx.waitUntil(scheduledRun().catch(e => console.error('Scheduled run failed:', e.message)));
  },
};
