// Donna — Cloudflare Worker (free plan): password-protected app + API + public booking page + 15-minute cron.
// Secrets: APP_PASSWORD (login), SESSION_SECRET (cookie signing), SIRI_KEY (optional Shortcuts key).
// Bindings: DB (D1, table "kv"), AI (Workers AI, free daily allowance), ASSETS (public/).
import { useBackend } from './src/store.js';
import { handle, scheduledRun, isPublicRoute } from './src/api.js';
import { setAiBinding } from './src/llm.js';
import { isAuthed, makeCookie, clearCookie, checkPassword } from './src/auth.js';
import { newChallenge, verifyRegistration, verifyLogin } from './src/passkey.js';

const LEASE_MS = 70e3, LOCK_WAIT_MS = 55e3; // a crashed writer frees the lock after LEASE_MS
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
      const skip = ['auth', 'ratelimit', 'gcache', 'passkeys', 'metrics', 'lock', ...lazy].map(n => `'${n.replace(/'/g, '')}'`).join(', ');
      // Backups ("bak:…") are never part of a request's data.
      const { results } = await env.DB.prepare(`SELECT name, value FROM kv WHERE name NOT IN (${skip}) AND name NOT LIKE 'bak:%'`).all();
      return Object.fromEntries(results.map(r => [r.name, r.value]));
    },
    async readOne(name) {
      await ensureTable(env);
      const r = await env.DB.prepare('SELECT value FROM kv WHERE name = ?1').bind(name).first();
      return r ? r.value : undefined;
    },
    /** The encrypted "vault" row arrives with readAll (one query per request, not two). */
    async readVault(text) { return text ? openVault(env, text) : {}; },
    async writeVault(values) {
      await env.DB.prepare("INSERT INTO kv (name, value) VALUES ('vault', ?1) ON CONFLICT(name) DO UPDATE SET value = excluded.value").bind(await sealVault(env, values)).run();
    },
    /** Every row a request changed, in one D1 transaction (and one round trip instead of one per row). */
    async writeMany(rows, secrets) {
      const put = 'INSERT INTO kv (name, value) VALUES (?1, ?2) ON CONFLICT(name) DO UPDATE SET value = excluded.value';
      const stmts = rows.map(([name, text]) => env.DB.prepare(put).bind(name, text));
      if (secrets) stmts.unshift(env.DB.prepare(put).bind('vault', await sealVault(env, secrets)));
      if (stmts.length) await env.DB.batch(stmts);
    },
    /** One writer at a time across all instances: chat, cron and other devices never overwrite each other's saves. */
    async lock(fn) {
      if (!env.LOCK) return fn();
      const stub = env.LOCK.get(env.LOCK.idFromName('writer'));
      const id = crypto.randomUUID();
      const call = (op, wait = 0) => stub.fetch(`https://lock/${op}?id=${id}&ttl=${LEASE_MS}&wait=${wait}`).then(r => r.text());
      if (await call('acquire', LOCK_WAIT_MS) !== '1') throw new Error('Donna is still finishing another change. Try again in a moment.');
      const beat = setInterval(() => { call('renew').catch(() => {}); }, LEASE_MS / 2);
      try { return await fn(); }
      finally { clearInterval(beat); await call('release').catch(() => {}); }
    },
    async snapshot(day, keep) {
      await ensureTable(env);
      const skip = "('vault', 'auth', 'ratelimit', 'gcache', 'passkeys', 'lock', 'metrics')";
      // Copied inside D1 (no data passes through the Worker): cheap on the 10 ms CPU budget.
      await env.DB.prepare(`INSERT INTO kv (name, value) SELECT 'bak:' || ?1 || ':' || name, value FROM kv WHERE name NOT IN ${skip} AND name NOT LIKE 'bak:%'
        ON CONFLICT(name) DO UPDATE SET value = excluded.value`).bind(day).run();
      const cutoff = new Date(Date.parse(day + 'T00:00:00Z') - keep * 864e5).toISOString().slice(0, 10);
      await env.DB.prepare("DELETE FROM kv WHERE name LIKE 'bak:%' AND substr(name, 5, 10) <= ?1").bind(cutoff).run();
      return true;
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

// ─── Secrets at rest: AES-256-GCM, key derived from a Worker secret (never stored in the database) ───
const vaultKeys = new Map();
function vaultKey(env) {
  const material = env.VAULT_KEY || env.SESSION_SECRET || env.APP_PASSWORD;
  if (!vaultKeys.has(material)) vaultKeys.set(material, (async () => {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(material), 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('donna-vault-v1'), info: new Uint8Array() }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  })());
  return vaultKeys.get(material);
}
const b64 = u8 => btoa(String.fromCharCode(...u8));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function sealVault(env, values) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await vaultKey(env), new TextEncoder().encode(JSON.stringify(values))));
  return JSON.stringify({ v: 1, iv: b64(iv), data: b64(data) });
}
async function openVault(env, text) {
  const box = JSON.parse(text);
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, await vaultKey(env), unb64(box.data));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    // Never carry on without the keys (the app would quietly fall back to the practice calendar) or overwrite them.
    throw new Error('Saved keys cannot be decrypted: the SESSION_SECRET (or VAULT_KEY) secret changed. Restore it with npx wrangler secret put.');
  }
}

const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=(self)',
  'Strict-Transport-Security': 'max-age=31536000',
  // Event titles come from other people's invites: even if one slipped past escaping, no injected script could run.
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
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
async function lockout(env, request, { passkey = false } = {}) {
  const st = await row(env, 'auth', {});
  const now = Date.now(), who = await ipKey(request);
  const fails = (st.fails || []).filter(f => f && typeof f === 'object' && now - f.t < LOCKOUT_MS); // old rows held bare timestamps
  return {
    locked: fails.filter(f => f.ip === who).length >= LOCKOUT_FAILS || (!passkey && fails.length >= LOCKOUT_GLOBAL),
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
  async fetch(request, env, ctx) {
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
      const lock = await lockout(env, request, { passkey: true });
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
    // Which commit is live (set by npm run deploy).
    if (url.pathname === '/api/version') return json(200, { version: env.VERSION || 'dev' });

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

/**
 * The writer lock (Durable Object, SQLite class so it runs on the free plan; it keeps its state in memory only).
 * acquire waits inside the object until the lock is free, so a waiting request costs one subrequest, not a polling loop.
 */
export class WriterLock {
  constructor() { this.holder = null; this.until = 0; this.waiters = []; }
  wake() { const w = this.waiters; this.waiters = []; for (const f of w) f(); }
  async fetch(request) {
    const u = new URL(request.url);
    const id = u.searchParams.get('id') || '', ttl = Math.min(Number(u.searchParams.get('ttl')) || 60e3, 300e3);
    const free = () => !this.holder || this.until < Date.now() || this.holder === id;
    if (u.pathname === '/acquire') {
      const end = Date.now() + Math.min(Number(u.searchParams.get('wait')) || 0, 60e3);
      while (!free()) {
        const left = Math.min(end, this.until) - Date.now();
        if (Date.now() >= end) return new Response('0');
        await new Promise(r => { const t = setTimeout(r, Math.max(20, left)); this.waiters.push(() => { clearTimeout(t); r(); }); });
      }
      this.holder = id; this.until = Date.now() + ttl;
      return new Response('1');
    }
    if (u.pathname === '/renew') { if (this.holder === id) { this.until = Date.now() + ttl; return new Response('1'); } return new Response('0'); }
    if (u.pathname === '/release') { if (this.holder === id) { this.holder = null; this.until = 0; this.wake(); } return new Response('1'); }
    return new Response('?', { status: 404 });
  }
}
