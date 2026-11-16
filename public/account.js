// Sign in (/signin/) and the Account page (/account/). Passkeys use @simplewebauthn/browser (/js/webauthn.js).
(function () {
  var WA = window.SimpleWebAuthnBrowser;

  function post(path, data) {
    return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(data || {}) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { d._ok = r.ok; d._status = r.status; return d; }); });
  }
  function say(el, text, err) { if (!el) return; el.className = 'form-msg' + (err ? ' err' : ''); el.textContent = text || ''; }
  function when(ms) {
    if (!ms) return 'never';
    var d = new Date(typeof ms === 'number' ? ms : Date.parse(ms));
    return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  async function passkeySignIn(msg) {
    if (!WA || !WA.browserSupportsWebAuthn()) { say(msg, "This browser doesn't support passkeys. Use the email link instead.", true); return; }
    say(msg, 'Waiting for your passkey…');
    var o = await post('/api/passkeys/login/options');
    if (!o._ok) { say(msg, o.error || 'Something went wrong.', true); return; }
    var resp;
    try { resp = await WA.startAuthentication({ optionsJSON: o.options }); } catch (e) { say(msg, 'Passkey sign-in was cancelled.', true); return; }
    var v = await post('/api/passkeys/login/verify', { challengeId: o.challengeId, response: resp });
    if (!v._ok) { say(msg, v.error || "That didn't work.", true); return; }
    location.href = '/account/';
  }

  // ---------------------------------------------------------------- /signin/
  var form = document.getElementById('email-form');
  if (form) {
    var msg = document.getElementById('signin-msg');
    var t = (location.hash.match(/[#&]t=([A-Za-z0-9_-]+)/) || [])[1];
    // A link opened in a tab already on this page only changes the #fragment: start over so it's used.
    window.addEventListener('hashchange', function () { if (/[#&]t=/.test(location.hash)) location.reload(); });
    if (t) {
      history.replaceState(null, '', location.pathname); // don't leave the token in the address bar or history
      document.getElementById('link-state').hidden = false;
      form.hidden = true; document.querySelector('.or').hidden = true; document.getElementById('passkey-signin').hidden = true;
      post('/api/auth/verify', { token: t }).then(function (d) {
        if (d._ok) { location.href = '/account/' + (d.newAccount ? '?welcome=1' : ''); return; }
        say(document.getElementById('link-msg'), d.error || "That link didn't work.", true);
        form.hidden = false; document.querySelector('.or').hidden = false; document.getElementById('passkey-signin').hidden = false;
      });
    } else {
      fetch('/api/me', { credentials: 'same-origin' }).then(function (r) { if (r.ok) location.href = '/account/'; });
    }
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var b = form.querySelector('button'); b.disabled = true;
      say(msg, 'Sending…');
      post('/api/auth/email', { email: form.email.value, website: form.website.value }).then(function (d) {
        b.disabled = false;
        if (!d._ok) { say(msg, d.error || 'Something went wrong.', true); return; }
        say(msg, d.message);
        if (d.devLink) { var a = el('a', null, ' Open it'); a.href = d.devLink; a.id = 'dev-link'; msg.appendChild(a); }
      });
    });
    document.getElementById('passkey-signin').addEventListener('click', function () { passkeySignIn(msg); });
  }

  // ---------------------------------------------------------------- /account/
  var acct = document.getElementById('account');
  if (!acct) return;
  var me;

  function render() {
    document.getElementById('acct-email').textContent = 'Signed in as ' + me.email + (me.admin ? ' · administrator' : '');
    var pk = document.getElementById('passkeys'); pk.innerHTML = '';
    if (!me.passkeys.length) pk.appendChild(el('li', 'soft', 'No passkeys yet.'));
    me.passkeys.forEach(function (p) {
      var li = el('li'); li.appendChild(el('span', null, p.name));
      li.appendChild(el('span', 'soft', 'Added ' + when(p.createdAt) + (p.lastUsed ? ' · last used ' + when(p.lastUsed) : '')));
      var x = el('button', 'linkish', 'Remove'); x.type = 'button';
      x.addEventListener('click', function () {
        if (!confirm('Remove the passkey "' + p.name + '"?')) return;
        post('/api/passkeys/delete', { id: p.id }).then(load);
      });
      li.appendChild(x); pk.appendChild(li);
    });
    var ss = document.getElementById('sessions'); ss.innerHTML = '';
    me.sessions.forEach(function (s) {
      var li = el('li'); li.appendChild(el('span', null, s.label + (s.current ? ' (this browser)' : '')));
      li.appendChild(el('span', 'soft', 'Signed in ' + when(s.createdAt) + ' · last active ' + when(s.lastSeen)));
      if (!s.current) {
        var x = el('button', 'linkish', 'Sign out'); x.type = 'button';
        x.addEventListener('click', function () { post('/api/account/sessions/end', { id: s.id }).then(load); });
        li.appendChild(x);
      }
      ss.appendChild(li);
    });
    document.getElementById('end-others').hidden = me.sessions.length < 2;
    document.getElementById('watch-history').checked = me.watchHistory;
  }

  function load() {
    return fetch('/api/me', { credentials: 'same-origin' }).then(function (r) {
      if (r.status === 401) { location.href = '/signin/'; return; }
      return r.json().then(function (d) { me = d; acct.hidden = false; render(); });
    });
  }
  load();

  if (/[?&]welcome=1/.test(location.search)) document.getElementById('welcome').hidden = false;
  document.querySelectorAll('[data-history]').forEach(function (b) {
    b.addEventListener('click', function () {
      post('/api/account/settings', { watchHistory: b.getAttribute('data-history') === '1' }).then(function () {
        document.getElementById('welcome').hidden = true; history.replaceState(null, '', '/account/'); load();
      });
    });
  });
  document.getElementById('watch-history').addEventListener('change', function (e) {
    post('/api/account/settings', { watchHistory: e.target.checked }).then(load);
  });

  document.getElementById('add-passkey').addEventListener('click', async function () {
    var m = document.getElementById('passkey-msg');
    if (!WA || !WA.browserSupportsWebAuthn()) { say(m, "This browser doesn't support passkeys.", true); return; }
    say(m, 'Follow your browser to create the passkey…');
    var o = await post('/api/passkeys/register/options');
    if (!o._ok) { say(m, o.error || 'Something went wrong.', true); return; }
    var resp;
    try { resp = await WA.startRegistration({ optionsJSON: o.options }); } catch (e) {
      say(m, e && e.name === 'InvalidStateError' ? 'This device already has a passkey for your account.' : 'Adding the passkey was cancelled.', true); return;
    }
    var v = await post('/api/passkeys/register/verify', { challengeId: o.challengeId, response: resp });
    if (!v._ok) { say(m, v.error || "That didn't work.", true); return; }
    say(m, 'Passkey added. Next time, choose Sign in with a passkey.');
    load();
  });

  document.getElementById('end-others').addEventListener('click', function () { post('/api/account/sessions/end', { others: true }).then(load); });
  document.getElementById('signout').addEventListener('click', function () { post('/api/auth/signout').then(function () { location.href = '/'; }); });
  document.getElementById('delete-account').addEventListener('click', function () {
    var m = document.getElementById('delete-msg');
    post('/api/account/delete', { confirm: document.getElementById('delete-confirm').value }).then(function (d) {
      if (!d._ok) { say(m, d.error || "That didn't work.", true); return; }
      location.href = '/?deleted=1';
    });
  });
})();
