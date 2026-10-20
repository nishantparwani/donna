// Passkeys (WebAuthn): sign in with Windows Hello, Touch ID or Face ID instead of the password.
// No libraries: the browser hands over the public key as SPKI (getPublicKey), so registration needs no
// CBOR; sign-in checks the challenge, origin, relying-party hash, user-verification flag and signature.
// Challenges are stateless: random bytes + time, signed with the session secret, valid for 5 minutes.
const enc = new TextEncoder();
const CHALLENGE_MS = 5 * 60e3;

export const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export function unb64u(s) {
  const t = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '='.repeat((4 - t.length % 4) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
const sha256 = async data => new Uint8Array(await crypto.subtle.digest('SHA-256', data));
async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}
const concat = (a, b) => { const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; };
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** A fresh challenge (base64url) the browser signs. */
export async function newChallenge(secret) {
  const token = `${b64u(crypto.getRandomValues(new Uint8Array(16)))}.${Date.now()}`;
  return b64u(enc.encode(`${token}.${await hmac('passkey:' + secret, token)}`));
}
async function challengeOk(secret, challenge) {
  let text = '';
  try { text = new TextDecoder().decode(unb64u(challenge)); } catch { return false; }
  const [rand, ts, sig] = text.split('.');
  if (!rand || !ts || !sig || Date.now() - Number(ts) > CHALLENGE_MS || Number(ts) > Date.now() + 60e3) return false;
  return sig === await hmac('passkey:' + secret, `${rand}.${ts}`);
}

/** Checks clientDataJSON + authenticatorData; returns the parsed parts or throws. */
async function checkCommon({ clientDataJSON, authenticatorData }, type, { secret, origin, rpId }) {
  const cdBytes = unb64u(clientDataJSON);
  const cd = JSON.parse(new TextDecoder().decode(cdBytes));
  if (cd.type !== type) throw new Error('Wrong passkey response type.');
  if (cd.origin !== origin) throw new Error('Passkey made for another site.');
  if (!(await challengeOk(secret, cd.challenge))) throw new Error('This sign-in request expired. Try again.');
  const ad = unb64u(authenticatorData);
  if (ad.length < 37) throw new Error('Bad authenticator data.');
  if (!same(ad.slice(0, 32), await sha256(enc.encode(rpId)))) throw new Error('Passkey made for another site.');
  const flags = ad[32];
  if (!(flags & 0x01) || !(flags & 0x04)) throw new Error('The device did not verify you (fingerprint / face / PIN).');
  const counter = ((ad[33] << 24) | (ad[34] << 16) | (ad[35] << 8) | ad[36]) >>> 0;
  return { cdBytes, ad, counter };
}

const ALGS = {
  [-7]: { import: { name: 'ECDSA', namedCurve: 'P-256' }, verify: { name: 'ECDSA', hash: 'SHA-256' }, der: true },
  [-257]: { import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, verify: { name: 'RSASSA-PKCS1-v1_5' } },
  [-8]: { import: { name: 'Ed25519' }, verify: { name: 'Ed25519' } },
};

/** Verifies a new passkey (the user is already signed in). Returns the record to store. */
export async function verifyRegistration(body, ctx) {
  const alg = Number(body.alg);
  if (!ALGS[alg]) throw new Error('This device offers a passkey type Donna does not support.');
  const { counter } = await checkCommon(body, 'webauthn.create', ctx);
  const spki = unb64u(body.publicKey);
  await crypto.subtle.importKey('spki', spki, ALGS[alg].import, false, ['verify']); // throws if malformed
  return { id: String(body.id), publicKey: b64u(spki), alg, counter, name: String(body.name || 'Device').slice(0, 40), created: new Date().toISOString(), lastUsed: null };
}

/** WebAuthn ECDSA signatures are ASN.1 DER; WebCrypto wants raw r || s. */
function derToRaw(der) {
  let i = 2;
  if (der[1] & 0x80) i += der[1] & 0x7f;
  const int = () => { i++; const len = der[i++]; const v = der.slice(i, i + len); i += len; return v; };
  const fix = v => { while (v.length > 32 && v[0] === 0) v = v.slice(1); const out = new Uint8Array(32); out.set(v, 32 - v.length); return out; };
  const r = int(), s = int();
  return concat(fix(r), fix(s));
}

/** Verifies a sign-in. Returns the updated key record, or throws. */
export async function verifyLogin(body, keys, ctx) {
  const key = keys.find(k => k.id === String(body.id));
  if (!key) throw new Error('This passkey is not registered (it may have been removed). Sign in with the password.');
  const { cdBytes, ad, counter } = await checkCommon(body, 'webauthn.get', ctx);
  const a = ALGS[key.alg];
  const pub = await crypto.subtle.importKey('spki', unb64u(key.publicKey), a.import, false, ['verify']);
  let sig = unb64u(body.signature);
  if (a.der) sig = derToRaw(sig);
  const signed = concat(ad, await sha256(cdBytes));
  if (!(await crypto.subtle.verify(a.verify, pub, sig, signed))) throw new Error('Passkey signature did not match.');
  // A counter that goes backwards means a cloned key (synced passkeys always report 0).
  if (counter && key.counter && counter <= key.counter) throw new Error('This passkey looks copied. Sign in with the password.');
  return { ...key, counter, lastUsed: new Date().toISOString() };
}
