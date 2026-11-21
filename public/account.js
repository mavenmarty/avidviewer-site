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

  async function passkeySignIn(msg, next) {
    if (!WA || !WA.browserSupportsWebAuthn()) { say(msg, "This browser doesn't support passkeys. Use the email link instead.", true); return; }
    say(msg, 'Waiting for your passkey…');
    var o = await post('/api/passkeys/login/options');
    if (!o._ok) { say(msg, o.error || 'Something went wrong.', true); return; }
    var resp;
    try { resp = await WA.startAuthentication({ optionsJSON: o.options }); } catch (e) { say(msg, 'No passkey was used. If your browser said there\'s no passkey on this device, sign in with the email link above, then add one on your Account page (Passkeys › Add a passkey).', true); return; }
    var v = await post('/api/passkeys/login/verify', { challengeId: o.challengeId, response: resp });
    if (!v._ok) { say(msg, v.error || "That didn't work.", true); return; }
    location.href = next || '/playlists/';
  }

  // ---------------------------------------------------------------- /signin/
  var form = document.getElementById('email-form');
  if (form) {
    var msg = document.getElementById('signin-msg');
    var t = (location.hash.match(/[#&]t=([A-Za-z0-9_-]+)/) || [])[1];
    // After signing in, go back where the person came from (e.g. /link/?c=…): from the link's #next or ?next.
    var nextRaw = (location.hash.match(/[#&]next=([^&]+)/) || [])[1] || (location.search.match(/[?&]next=([^&]+)/) || [])[1];
    var next = '';
    try { next = nextRaw ? decodeURIComponent(nextRaw) : ''; } catch (e) { next = ''; }
    if (!/^\/(?!\/)/.test(next)) next = '';
    // A link opened in a tab already on this page only changes the #fragment: start over so it's used.
    window.addEventListener('hashchange', function () { if (/[#&]t=/.test(location.hash)) location.reload(); });
    if (t) {
      history.replaceState(null, '', location.pathname); // don't leave the token in the address bar or history
      document.getElementById('link-state').hidden = false;
      form.hidden = true; document.querySelector('.or').hidden = true; document.getElementById('passkey-signin').hidden = true;
      post('/api/auth/verify', { token: t }).then(function (d) {
        if (d._ok) { location.href = next || (d.newAccount ? '/account/?welcome=1' : '/playlists/'); return; }
        say(document.getElementById('link-msg'), d.error || "That link didn't work.", true);
        form.hidden = false; document.querySelector('.or').hidden = false; document.getElementById('passkey-signin').hidden = false;
      });
    } else {
      fetch('/api/me', { credentials: 'same-origin' }).then(function (r) { if (r.ok) location.href = next || '/playlists/'; });
    }
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var b = form.querySelector('button'); b.disabled = true;
      say(msg, 'Sending…');
      post('/api/auth/email', { email: form.email.value, website: form.website.value, next: next || undefined }).then(function (d) {
        b.disabled = false;
        if (!d._ok) { say(msg, d.error || 'Something went wrong.', true); return; }
        say(msg, d.message);
        if (d.devLink) { var a = el('a', null, ' Open it'); a.href = d.devLink; a.id = 'dev-link'; msg.appendChild(a); }
      });
    });
    document.getElementById('passkey-signin').addEventListener('click', function () { passkeySignIn(msg, next); });
  }

  // ---------------------------------------------------------------- /link/
  var lf = document.getElementById('link-form');
  if (lf) {
    var codeIn = document.getElementById('link-code'), lmsg = document.getElementById('link-msg');
    var found = null, me = null;
    var pre = (location.search.match(/[?&]c=([A-Za-z0-9-]+)/) || [])[1] || '';
    fetch('/api/me', { credentials: 'same-origin' }).then(function (r) {
      if (r.status === 401) { location.href = '/signin/?next=' + encodeURIComponent('/link/' + (pre ? '?c=' + pre : '')); return; }
      return r.json().then(function (m) {
        me = m;
        document.getElementById('link-who').textContent = 'The device will be added to ' + me.email + '.';
        lf.hidden = false;
        if (pre) { codeIn.value = pretty(pre); document.getElementById('link-intro').textContent = 'The code from your device\'s QR code is filled in. Check the device below and choose Add this device.'; lookup(); } else codeIn.focus();
      });
    });
    function pretty(v) { var c = String(v).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8); return c.length > 4 ? c.slice(0, 4) + '-' + c.slice(4) : c; }
    function reset() { found = null; fullBox.hidden = true; document.getElementById('link-go').disabled = false; document.getElementById('link-found').hidden = true; document.getElementById('link-go').textContent = 'Find my device'; }
    codeIn.addEventListener('input', function () { var v = pretty(codeIn.value); if (v !== codeIn.value) codeIn.value = v; reset(); if (v.length === 9) lookup(); });
    function lookup() {
      say(lmsg, 'Looking for the device…');
      post('/api/link/lookup', { code: codeIn.value }).then(function (d) {
        if (!d._ok) { say(lmsg, d.error || "That code wasn't found. Check the code on the device; a code works for 10 minutes, and the welcome screen shows a new one when it runs out.", true); return; }
        found = d; say(lmsg, '');
        document.getElementById('link-tv').textContent = 'Found: ' + ([d.model, d.appVersion ? 'Avid Viewer ' + d.appVersion : ''].filter(Boolean).join(' · ') || 'a device');
        document.getElementById('link-name').value = d.name || '';
        document.getElementById('link-found').hidden = false;
        document.getElementById('link-go').textContent = 'Add this device';
        document.getElementById('link-name').focus();
        if (me && me.devices.length >= (me.deviceLimit || 4)) showFull(me.devices, me.deviceLimit || 4);
      });
    }
    // Nov 20, 2026: at most 4 devices. A full account picks one to remove right here, then adds this one.
    var fullBox = document.getElementById('link-full');
    function showFull(devices, limit) {
      fullBox.innerHTML = ''; fullBox.hidden = false;
      fullBox.appendChild(el('p', 'mg-warn', 'Your account already has ' + limit + ' devices, the most it can have. Remove one you no longer use to add this one. The code on your device keeps working while you choose.'));
      var ul = el('ul', 'rows');
      devices.slice().sort(function (a, b) { return (a.lastSeen || 0) - (b.lastSeen || 0); }).forEach(function (d) {
        var li = el('li');
        var away = d.lastSeen && Date.now() - d.lastSeen > 7 * 86400000;
        var info = el('div', 'lf-info');
        info.appendChild(el('strong', null, d.name + (away ? ' · not used lately' : '')));
        info.appendChild(el('span', 'soft', [d.model, d.appVersion ? 'Avid Viewer ' + d.appVersion : '', 'last seen ' + when(d.lastSeen)].filter(Boolean).join(' · ')));
        li.appendChild(info);
        var rm = el('button', 'btn btn-ghost btn-sm', 'Remove'); rm.type = 'button';
        rm.addEventListener('click', function () {
          if (!confirm('Remove "' + d.name + '" from your account? It\'s signed out the next time it checks in and asks to be linked again. Its backup stays in your account for 30 days.')) return;
          rm.disabled = true;
          post('/api/account/devices/remove', { id: d.id }).then(function (x) {
            if (!x._ok) { rm.disabled = false; say(lmsg, x.error || "That didn't work.", true); return; }
            if (me) me.devices = me.devices.filter(function (y) { return y.id !== d.id; });
            fullBox.hidden = true; fullBox.innerHTML = '';
            say(lmsg, d.name + ' was removed. Choose Add this device to finish.');
            document.getElementById('link-go').disabled = false;
          });
        });
        li.appendChild(rm); ul.appendChild(li);
      });
      fullBox.appendChild(ul);
      var a = el('a', null, 'Manage all devices'); a.href = '/devices/';
      var fp = el('p', 'fineprint'); fp.appendChild(a); fullBox.appendChild(fp);
      document.getElementById('link-go').disabled = true;
    }
    lf.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!found) { lookup(); return; }
      post('/api/link/approve', { code: codeIn.value, name: document.getElementById('link-name').value }).then(function (d) {
        if (d.code === 'device_limit') { say(lmsg, ''); showFull(d.devices || [], d.limit || 4); return; }
        if (!d._ok) { say(lmsg, d.error || "That didn't work.", true); reset(); return; }
        document.getElementById('link-done-name').textContent = d.name;
        lf.hidden = true; document.getElementById('link-done').hidden = false;
      });
    });
    document.getElementById('link-another').addEventListener('click', function () {
      codeIn.value = ''; reset(); say(lmsg, ''); history.replaceState(null, '', '/link/');
      document.getElementById('link-done').hidden = true; lf.hidden = false; codeIn.focus();
    });
    return;
  }

  // Sign out (the tab bar on every account page).
  document.querySelectorAll('.mg-signout').forEach(function (b) {
    b.addEventListener('click', function () { post('/api/auth/signout').then(function () { location.href = '/'; }); });
  });

  // ---------------------------------------------------------------- /account/ and /backups/
  var acct = document.getElementById('account');
  if (!acct) return;
  var me;

  function render() {
    var em = document.getElementById('acct-email');
    if (em) em.textContent = 'Signed in as ' + me.email + (me.admin ? ' · administrator' : '') + '. How you sign in, where you\'re signed in, and what your account keeps.';
    // Nov 20, 2026: the account's license (every account starts with a 1-month trial).
    var lic = document.getElementById('acct-license'), L = me.license;
    if (lic && L && L.status !== 'none') {
      var dd = function (ms) { return new Date(ms).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }); };
      var k = L.kind === 'comp' ? 'Complimentary license' : L.kind === 'paid' ? 'Paid license' : 'Free trial';
      lic.textContent = L.perpetual ? k + ': doesn\u2019t expire.' : L.status === 'expired' ? k + ': ended ' + dd(L.endsAt) + '.' : k + ': until ' + dd(L.endsAt) + '.';
      lic.hidden = false;
    }
    renderTrouble();
    var ls = document.getElementById('locked-state');
    if (ls) {
      ls.innerHTML = '';
      if (me.lockedLogins) { var on = el('strong', 'mg-on', '● On. '); ls.appendChild(on); ls.appendChild(document.createTextNode('Playlist logins are kept in your account, locked so only your passkey opens them. New devices get them without typing, and the website can never read them.')); }
      else { ls.appendChild(document.createTextNode('Off. Turn it on from the Playlists page (Set up with passkey), so new devices get logins without typing. The website can never read them.')); }
      var lw = document.getElementById('locked-with');
      var un = me.passkeys.filter(function (p) { return p.unlocksLogins; }).map(function (p) { return p.name || 'A passkey'; });
      lw.textContent = me.lockedLogins ? 'Unlocks with: ' + (un.join(', ') || 'a passkey') + '. A passkey that can\'t do this (some password managers) can still sign you in.' : '';
    }
    var bt = document.getElementById('backups-title');
    if (bt) bt.textContent = 'Backups in your account · ' + me.backups.length;
    var tv = document.getElementById('devices');
    if (tv) { tv.innerHTML = '';
    if (!me.devices.length) tv.appendChild(el('li', 'soft', 'No devices linked yet.'));
    me.devices.forEach(function (d) {
      var li = el('li'); li.appendChild(el('span', null, d.name));
      li.appendChild(el('span', 'soft', [d.model, d.appVersion ? 'Avid Viewer ' + d.appVersion : '', 'last seen ' + when(d.lastSeen)].filter(Boolean).join(' · ')));
      var rn = el('button', 'linkish', 'Rename'); rn.type = 'button';
      rn.addEventListener('click', function () {
        var n = prompt('Name for this device', d.name);
        if (n && n.trim()) post('/api/account/devices/rename', { id: d.id, name: n.trim() }).then(load);
      });
      var rm = el('button', 'linkish', 'Remove'); rm.type = 'button';
      rm.addEventListener('click', function () {
        if (!confirm('Remove "' + d.name + '"? It will be signed out of your account the next time it checks in. Its playlists stay on the device, and its backup stays in your account for 30 days.')) return;
        post('/api/account/devices/remove', { id: d.id }).then(load);
      });
      li.appendChild(rn); li.appendChild(rm); tv.appendChild(li);
    });
    }
    var bk = document.getElementById('backups');
    if (bk) { bk.innerHTML = '';
    if (!me.backups.length) bk.appendChild(el('li', 'soft', 'No backups yet. Turn them on in Avid Viewer › Settings › Updates & about on a linked device.'));
    me.backups.forEach(function (x) {
      var li = el('li'); li.appendChild(el('span', null, x.name + (x.removed ? ' (removed device, deleted ' + when(x.deletesAt) + ')' : '')));
      li.appendChild(el('span', 'soft', ['backed up ' + when(x.createdAt), x.playlists != null ? x.playlists + ' playlist' + (x.playlists === 1 ? '' : 's') : '', Math.max(1, Math.round(x.size / 1024)) + ' KB'].filter(Boolean).join(' · ')));
      var pinOut = el('strong', 'pin-out');
      var show = el('button', 'linkish', 'Show PIN'); show.type = 'button';
      show.addEventListener('click', function () {
        if (pinOut.textContent) { pinOut.textContent = ''; show.textContent = 'Show PIN'; return; }
        fetch('/api/account/backups/pin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: x.deviceId }) })
          .then(function (r) { return r.json(); })
          .then(function (o) {
            if (o.pin) { pinOut.textContent = 'PIN ' + o.pin; show.textContent = 'Hide PIN'; return; }
            if (o.signIn) { if (confirm(o.error + ' Sign in now?')) location.href = '/signin/?next=' + encodeURIComponent(location.pathname); return; }
            alert(o.error || 'The PIN could not be shown.');
          });
      });
      li.appendChild(show); li.appendChild(pinOut);
      var del = el('button', 'linkish', 'Delete'); del.type = 'button';
      del.addEventListener('click', function () {
        if (!confirm('Delete the backup from "' + x.name + '"? It can\'t be undone. If that device is still linked and backups are on, it makes a new one within a day.')) return;
        post('/api/account/backups/delete', { deviceId: x.deviceId }).then(load);
      });
      li.appendChild(del); bk.appendChild(li);
    });
    }
    var pk = document.getElementById('passkeys');
    if (!pk) return;
    pk.innerHTML = '';
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

  // Nov 21, 2026: troubleshooting. Strong 8K subscriptions (confirmed with the reseller panel, through the TV app),
  // each device's last channel load, and Reload channels / Check my subscription for the devices' next check-in.
  var PROBLEM = { login: 'Login not accepted', expired: 'Subscription expired', unreachable: "Couldn't reach the server", empty: 'No channels came back', other: "Channels didn't load" };
  function ago(ms) {
    var m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return 'just now'; if (m < 60) return m + ' min ago';
    var h = Math.round(m / 60); if (h < 48) return h + ' h ago';
    return Math.round(h / 24) + ' days ago';
  }
  function renderTrouble() {
    var box = document.getElementById('trouble'); if (!box) return;
    var T = me.troubleshooting || { strong8k: [], loads: [], requested: {} };
    box.hidden = !me.devices.length && !T.strong8k.length;
    var dd = function (ms) { return new Date(ms).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }); };
    var subs = document.getElementById('trouble-subs'); subs.innerHTML = '';
    T.strong8k.forEach(function (l) {
      var expired = l.expiresAt && l.expiresAt <= Date.now();
      var soon = l.expiresAt && !expired && l.expiresAt - Date.now() < 7 * 864e5;
      var p = el('p', !l.enabled || expired ? 'mg-warn' : soon ? 'mg-warn' : 'soft');
      p.appendChild(el('strong', null, l.name + ' (Strong 8K): '));
      p.appendChild(document.createTextNode(!l.enabled ? 'turned off at Strong 8K. Contact us to turn it back on.' : expired ? 'ended ' + dd(l.expiresAt) + '. Contact us to renew.' : l.expiresAt ? 'active until ' + dd(l.expiresAt) + '.' : 'active.'));
      p.appendChild(el('span', 'fineprint', ' Checked ' + ago(l.checkedAt) + '.'));
      subs.appendChild(p);
    });
    document.getElementById('trouble-check').hidden = !T.strong8k.length;
    var names = {}; me.devices.forEach(function (d) { names[d.id] = d.name; });
    var ul = document.getElementById('trouble-loads'); ul.innerHTML = '';
    if (!T.loads.length) ul.appendChild(el('li', 'soft', me.devices.length ? 'No device has reported yet. Devices report after loading channels (Avid Viewer 1.24 or newer).' : 'No devices linked yet.'));
    T.loads.forEach(function (x) {
      var li = el('li');
      li.appendChild(el('span', null, (names[x.deviceId] || 'A device') + ' · ' + x.name));
      li.appendChild(el('span', x.ok ? 'soft' : 'mg-warn', (x.ok ? (x.channels != null ? x.channels.toLocaleString() + ' channels' : 'Loaded') : (PROBLEM[x.problem] || PROBLEM.other)) + ' · ' + ago(x.at)));
      ul.appendChild(li);
    });
    var waiting = Object.keys(T.requested || {}).filter(function (k) { return T.requested[k].reload || T.requested[k].check; }).length;
    if (waiting) say(document.getElementById('trouble-msg'), 'Waiting for ' + waiting + ' device' + (waiting === 1 ? '' : 's') + ' to check in.');
  }
  function troubleAsk(what, btn) {
    btn.disabled = true;
    post('/api/account/devices/request', { what: what }).then(function (d) {
      btn.disabled = false;
      say(document.getElementById('trouble-msg'), d._ok === false || d.error ? (d.error || "That didn't work.") : (what === 'reload' ? 'Asked ' : 'Checking on ') + d.devices + ' device' + (d.devices === 1 ? '' : 's') + '. Come back in a few minutes to see the result.');
    });
  }
  (function () {
    var r = document.getElementById('trouble-reload'), c = document.getElementById('trouble-check');
    if (r) r.addEventListener('click', function () { troubleAsk('reload', r); });
    if (c) c.addEventListener('click', function () { troubleAsk('check', c); });
  })();

  function load() {
    return fetch('/api/me', { credentials: 'same-origin' }).then(function (r) {
      if (r.status === 401) { location.href = '/signin/?next=' + encodeURIComponent(location.pathname); return; }
      return r.json().then(function (d) { me = d; acct.hidden = false; render(); });
    });
  }
  load();

  if (/[?&]welcome=1/.test(location.search) && document.getElementById('welcome')) document.getElementById('welcome').hidden = false;
  document.querySelectorAll('[data-history]').forEach(function (b) {
    b.addEventListener('click', function () {
      post('/api/account/settings', { watchHistory: b.getAttribute('data-history') === '1' }).then(function () {
        document.getElementById('welcome').hidden = true; history.replaceState(null, '', '/account/'); load();
      });
    });
  });
  if (!document.getElementById('watch-history')) return;
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

  document.getElementById('delete-account').addEventListener('click', function () {
    var m = document.getElementById('delete-msg');
    post('/api/account/delete', { confirm: document.getElementById('delete-confirm').value }).then(function (d) {
      if (!d._ok) { say(m, d.error || "That didn't work.", true); return; }
      location.href = '/?deleted=1';
    });
  });
})();
