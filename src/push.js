// Web Push (works on iPhone for the home-screen app, iOS 16.4+, and on Android/desktop browsers).
// Everything is done with Web Crypto: VAPID keys are generated once and kept in the database,
// messages are signed (RFC 8292) and encrypted (RFC 8291, aes128gcm). No third-party service.
import { load, save, settings } from './store.js';

const enc = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4)), c => c.charCodeAt(0));
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

/** The server's VAPID key pair, created on first use. */
export async function vapid() {
  const p = load('push');
  if (p.vapid) return p.vapid;
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  p.vapid = { publicKey: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)), privateJwk: await crypto.subtle.exportKey('jwk', kp.privateKey) };
  save('push');
  return p.vapid;
}

export function subscribe(sub, device) {
  if (!sub || !sub.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) throw new Error('Invalid push subscription.');
  const p = load('push');
  p.subscriptions = (p.subscriptions || []).filter(s => s.endpoint !== sub.endpoint);
  p.subscriptions.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, device: String(device || '').slice(0, 80), added: new Date().toISOString() });
  p.subscriptions = p.subscriptions.slice(-10);
  save('push');
  return p.subscriptions.length;
}
export function unsubscribe(endpoint) {
  const p = load('push');
  p.subscriptions = (p.subscriptions || []).filter(s => s.endpoint !== endpoint);
  save('push');
}

async function vapidHeader(endpoint) {
  const v = await vapid();
  const aud = new URL(endpoint).origin;
  const header = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:' + (settings().userEmail || 'donna@example.com') })));
  const key = await crypto.subtle.importKey('jwk', v.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${v.publicKey}`;
}

async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

/** RFC 8291 message encryption: returns the request body for one subscription. */
export async function encrypt(payload, sub) {
  const uaPublic = unb64u(sub.keys.p256dh);
  const authSecret = unb64u(sub.keys.auth);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(enc.encode(payload), new Uint8Array([2]))));
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return concat(header, asPublic, body);
}

let fetchImpl = (...a) => fetch(...a);
export function usePushFetch(fn) { fetchImpl = fn || ((...a) => fetch(...a)); }

/**
 * Sends a notification to every subscribed device. Never throws: returns how many got it.
 * @param {{title: string, body: string, url?: string, tag?: string}} msg
 */
export async function notify(msg) {
  const p = load('push');
  const subs = p.subscriptions || [];
  if (!subs.length) return 0;
  const payload = JSON.stringify({ title: String(msg.title || settings().agentName).slice(0, 80), body: String(msg.body || '').slice(0, 300), url: msg.url || '/#today', tag: msg.tag || '' });
  let sent = 0;
  const dead = [];
  for (const s of subs) {
    try {
      const res = await fetchImpl(s.endpoint, {
        method: 'POST',
        headers: { Authorization: await vapidHeader(s.endpoint), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'normal' },
        body: await encrypt(payload, s),
      });
      if (res.status === 404 || res.status === 410) dead.push(s.endpoint);
      else if (res.ok) sent++;
    } catch { /* one device failing never stops the others */ }
  }
  if (dead.length) { p.subscriptions = subs.filter(s => !dead.includes(s.endpoint)); save('push'); }
  return sent;
}
