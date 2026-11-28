// Nov 28, 2026: the simplest possible passkey, made straight from a tap with the browser's own call (no library, no
// extra dialog), for a device that refuses the account's usual passkey within milliseconds. Each try is noted for the
// admin view (step "check 1" / "check 2", the error, and what the page knew: tap, focus, secure, top frame).
(function () {
  var $ = function (id) { return document.getElementById(id); };
  function b64u(buf) { var s = ''; new Uint8Array(buf).forEach(function (b) { s += String.fromCharCode(b); }); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function unb64u(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; var b = atob(s), a = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; }
  function post(path, data) {
    return fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data || {}) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { d._ok = r.ok; d._status = r.status; return d; }); });
  }
  function say(t, err) { var m = $('pc-msg'); m.textContent = t; m.className = 'form-msg' + (err ? ' err' : ''); m.scrollIntoView({ block: 'center' }); }
  function ctx() {
    var u = navigator.userActivation;
    return 'tap ' + (u ? (u.isActive ? 'yes' : 'no') : '?') + ' · focus ' + (document.hasFocus() ? 'yes' : 'no') + ' · secure ' + (window.isSecureContext ? 'yes' : 'no') +
      ' · top ' + (window.top === window.self ? 'yes' : 'no') + ' · ' + location.hostname;
  }
  var o = null;
  function prepare() {
    return post('/api/passkeys/register/options').then(function (r) {
      if (r._status === 401) { location.href = '/signin/?next=' + encodeURIComponent('/passkey-check/'); return; }
      if (!r._ok) { $('pc-ready').textContent = r.error || 'Couldn’t get ready. Reload the page.'; return; }
      o = r; $('pc-ready').textContent = 'Ready. Tap a button below.'; $('pc-1').disabled = false; $('pc-2').disabled = false;
    });
  }
  function tryIt(n) {
    if (!o || !window.PublicKeyCredential) { say('This browser can’t make passkeys.', true); return; }
    var opt = o.options, used = o;
    o = null; // a challenge is used once
    var pk = {
      challenge: unb64u(opt.challenge),
      rp: n === 1 ? { name: 'Avid Viewer', id: opt.rp.id } : { name: 'Avid Viewer' },
      user: { id: unb64u(opt.user.id), name: opt.user.name, displayName: opt.user.name },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
      attestation: 'none', timeout: 120000,
    };
    var before = ctx(), t = Date.now(), p;
    // The browser's own call, straight inside the tap.
    try { p = navigator.credentials.create({ publicKey: pk }); } catch (e) { p = Promise.reject(e); }
    p.then(function (c) {
      var r = c.response;
      var json = { id: c.id, rawId: b64u(c.rawId), type: c.type, clientExtensionResults: c.getClientExtensionResults ? c.getClientExtensionResults() : {},
        authenticatorAttachment: c.authenticatorAttachment || undefined,
        response: { clientDataJSON: b64u(r.clientDataJSON), attestationObject: b64u(r.attestationObject), transports: r.getTransports ? r.getTransports() : [] } };
      post('/api/passkeys/register/failed', { step: 'check ' + n, error: 'OK', message: '[made after ' + (Date.now() - t) + ' ms · ' + before + ']' });
      return post('/api/passkeys/register/verify', { challengeId: used.challengeId, response: json }).then(function (v) {
        if (v._ok) say('It worked: a passkey was made and added to your account. You can use it to sign in.');
        else say('The browser made a passkey, but it couldn’t be saved to your account (' + (v.error || 'unknown') + '). Support has been told.', true);
      });
    }).catch(function (e) {
      var ms = Date.now() - t, name = (e && e.name) || 'Error';
      post('/api/passkeys/register/failed', { step: 'check ' + n, error: name, message: ('[refused after ' + ms + ' ms · ' + before + '] ' + ((e && e.message) || '')).slice(0, 300) });
      say('Your browser said no' + (ms < 1500 ? ' straight away' : '') + ' (' + name + '). That has been noted for support. You can try the other button too.', true);
    }).then(function () { prepare(); });
  }
  $('pc-1').addEventListener('click', function () { tryIt(1); });
  $('pc-2').addEventListener('click', function () { tryIt(2); });
  prepare();
})();
