// Same theme and accent as the app (saved on this device).
try { const g = k => JSON.parse(localStorage.getItem('donna.' + k) || '""'); if (g('theme')) document.documentElement.dataset.theme = g('theme'); if (g('accent')) document.documentElement.dataset.accent = g('accent'); } catch { /* private mode */ }
  'use strict';
  if (localStorage.getItem('donna.theme')) document.documentElement.dataset.theme = JSON.parse(localStorage.getItem('donna.theme')) || '';
  const $ = id => document.getElementById(id);
  const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64u = s => { const t = s.replace(/-/g, '+').replace(/_/g, '/'); return Uint8Array.from(atob(t + '='.repeat((4 - t.length % 4) % 4)), c => c.charCodeAt(0)); };
  const isApple = /iPhone|iPad|Macintosh/.test(navigator.userAgent);
  const isWindows = /Windows/.test(navigator.userAgent);
  $('pkLabel').textContent = isWindows ? 'Sign in with Windows Hello' : isApple ? (/iPhone|iPad/.test(navigator.userAgent) ? 'Sign in with Face ID' : 'Sign in with Touch ID') : 'Sign in with fingerprint / face';
  const done = () => { location.href = '/'; };

  let pending = null; // the autofill (conditional) request, cancelled when the button is pressed
  async function passkey(conditional) {
    if (pending) { pending.abort(); pending = null; }
    const ctl = new AbortController();
    if (conditional) pending = ctl;
    const err = $('err');
    err.textContent = '';
    try {
      const { challenge, rpId, registered } = await (await fetch('/api/passkey/challenge')).json();
      if (!registered && !conditional) { err.textContent = 'No passkey yet. Sign in with the password once, then add this device in Settings → Security.'; return; }
      const cred = await navigator.credentials.get({ publicKey: { challenge: unb64u(challenge), rpId, userVerification: 'required', timeout: 60000 }, signal: ctl.signal, ...(conditional ? { mediation: 'conditional' } : {}) });
      if (!cred) return;
      const r = cred.response;
      const res = await fetch('/api/passkey/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        id: cred.id, clientDataJSON: b64u(r.clientDataJSON), authenticatorData: b64u(r.authenticatorData), signature: b64u(r.signature) }) });
      if (res.ok) { localStorage.setItem('donna.passkey', 'true'); return done(); }
      err.textContent = (await res.json().catch(() => ({}))).error || 'Passkey sign-in failed.';
    } catch (e) {
      if (!conditional && e.name !== 'AbortError') err.textContent = e.name === 'NotAllowedError' ? 'Cancelled, or no passkey for this site on this device.' : e.message;
    }
  }

  if (window.PublicKeyCredential) {
    $('pk').classList.remove('hidden'); $('or').classList.remove('hidden');
    $('pk').onclick = () => passkey(false);
    if (localStorage.getItem('donna.passkey') === 'true') { $('pk').focus(); }
    else { $('pwBtn').classList.add('primary'); $('pk').classList.remove('primary'); }
    // Passkeys also show up in the password field's autofill list.
    PublicKeyCredential.isConditionalMediationAvailable?.().then(ok => { if (ok) passkey(true); }).catch(() => {});
  } else $('pwBtn').classList.add('primary');

  $('f').onsubmit = async e => {
    e.preventDefault();
    const err = $('err');
    err.textContent = '';
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('pw').value }) });
    if (r.ok) done();
    else err.textContent = (await r.json().catch(() => ({}))).error || 'Sign-in failed';
  };
