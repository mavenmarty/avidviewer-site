// The admin view (/admin/). See src/worker/admin.js for the rules: an admin account signed in with a passkey.
(function () {
  var WA = window.SimpleWebAuthnBrowser;
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function get(path) { return fetch(path, { credentials: 'same-origin' }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { d._ok = r.ok; d._status = r.status; return d; }); }); }
  function post(path, data) {
    return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(data || {}) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { d._ok = r.ok; d._status = r.status; return d; }); });
  }
  function when(v) {
    if (!v) return '—';
    var d = new Date(typeof v === 'number' ? v : Date.parse(v));
    return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  function table(t, head, rows) {
    t.innerHTML = '';
    var tr = el('tr'); head.forEach(function (h) { tr.appendChild(el('th', null, h)); }); t.appendChild(tr);
    if (!rows.length) { var e = el('tr'); var td = el('td', 'soft', 'Nothing yet.'); td.colSpan = head.length; e.appendChild(td); t.appendChild(e); }
    rows.forEach(function (r) { var row = el('tr'); r.cells.forEach(function (c) { row.appendChild(el('td', null, c)); }); if (r.onclick) { row.tabIndex = 0; row.addEventListener('click', r.onclick); row.addEventListener('keydown', function (e) { if (e.key === 'Enter') r.onclick(); }); } t.appendChild(row); });
  }
  var ACTIONS = { suspend: 'Suspended', unsuspend: 'Lifted suspension', 'delete': 'Deleted account', revoke_tv: 'Signed out device', resend_link: 'Sent sign-in link', end_sessions: 'Signed out browsers', note: 'Added note' };

  // ---------------------------------------------------------------- gate
  function start() {
    get('/api/me').then(function (me) {
      if (me._status === 401) { location.href = '/signin/?next=' + encodeURIComponent('/admin/'); return; }
      $('adm-who').textContent = 'Signed in as ' + me.email;
      if (!me.admin) { gate("This account isn't an administrator."); return; }
      if (!me.adminReady) {
        gate(me.passkeys.length ? 'For safety, the admin view needs a sign-in with your passkey, not just an email link.' : 'The admin view needs a passkey. Add one on your Account page first, then sign in with it here.');
        if (me.passkeys.length) $('adm-passkey').hidden = false; else { var a = el('a', 'btn btn-primary', 'Add a passkey'); a.href = '/account/'; $('adm-gate').insertBefore(a, $('adm-gate-err')); }
        return;
      }
      $('adm').hidden = false; tab('dash');
    });
  }
  function gate(text) { $('adm-gate').hidden = false; $('adm-gate-msg').textContent = text; }
  $('adm-passkey').addEventListener('click', async function () {
    var o = await post('/api/passkeys/login/options');
    var resp; try { resp = await WA.startAuthentication({ optionsJSON: o.options }); } catch (e) { $('adm-gate-err').textContent = 'Passkey sign-in was cancelled.'; return; }
    var v = await post('/api/passkeys/login/verify', { challengeId: o.challengeId, response: resp });
    if (!v._ok) { $('adm-gate-err').textContent = v.error || "That didn't work."; return; }
    location.reload();
  });

  // ---------------------------------------------------------------- tabs
  var loaded = {};
  function tab(name) {
    document.querySelectorAll('[role=tab]').forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.tab === name)); });
    document.querySelectorAll('[data-panel]').forEach(function (p) { p.hidden = p.dataset.panel !== name; });
    ({ dash: loadStats, people: loadUsers, audit: loadAudit, news: loadNews })[name]();
  }
  document.querySelectorAll('[role=tab]').forEach(function (b) { b.addEventListener('click', function () { tab(b.dataset.tab); }); });

  function loadStats() {
    get('/api/admin/stats').then(function (s) {
      var box = $('adm-stats'); box.innerHTML = '';
      [['Accounts', s.users], ['New, 7 days', s.new7], ['New, 30 days', s.new30], ['Signed in, 7 days', s.active7], ['Linked devices', s.tvs],
       ['Devices seen, 7 days', s.tvs7], ['With a passkey', s.passkeys], ['Suspended', s.suspended], ['Setup codes, 24 h', s.setupCodes24h], ['Launch news', s.launchNews], ['Backups', s.backupCount], ['Backup storage', Math.round((s.backupBytes || 0) / 1024) + ' KB']]
        .forEach(function (k) { var c = el('div', 'adm-stat'); c.appendChild(el('span', 'n', String(k[1] || 0))); c.appendChild(el('span', 'l', k[0])); box.appendChild(c); });
      var bars = $('adm-daily'); bars.innerHTML = '';
      var byDay = {}; (s.daily || []).forEach(function (d) { byDay[d.day] = d.n; });
      var max = Math.max(1, Math.max.apply(null, Object.values(byDay).concat([1])));
      for (var i = 29; i >= 0; i--) {
        var day = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10), n = byDay[day] || 0;
        var b = el('div', 'bar'); b.style.height = Math.max(2, Math.round(100 * n / max)) + '%'; b.title = day + ': ' + n; bars.appendChild(b);
      }
      table($('adm-versions'), ['App version', 'Devices'], (s.versions || []).map(function (v) { return { cells: [v.v, String(v.n)] }; }));
    });
  }

  var qTimer;
  $('adm-q').addEventListener('input', function () { clearTimeout(qTimer); qTimer = setTimeout(loadUsers, 250); });
  $('adm-status').addEventListener('change', loadUsers);
  function loadUsers() {
    get('/api/admin/users?q=' + encodeURIComponent($('adm-q').value) + '&status=' + $('adm-status').value).then(function (d) {
      table($('adm-users'), ['Email', 'Joined', 'Last sign-in', 'Devices', 'Status'], (d.users || []).map(function (u) {
        return { cells: [u.email + (u.role === 'admin' ? ' (admin)' : ''), when(u.createdAt), when(u.lastSignIn), String(u.tvs), u.status], onclick: function () { loadUser(u.id); } };
      }));
    });
  }

  function loadUser(id) {
    get('/api/admin/user?id=' + encodeURIComponent(id)).then(function (d) {
      var box = $('adm-user'); box.innerHTML = '';
      if (!d._ok) { box.appendChild(el('p', 'soft', d.error || 'Not found.')); return; }
      var u = d.user;
      box.appendChild(el('h2', null, u.email));
      box.appendChild(el('p', 'soft', [u.status === 'suspended' ? 'SUSPENDED' : 'Active', u.role === 'admin' ? 'administrator' : '', 'joined ' + when(u.createdAt), 'last sign-in ' + when(u.lastSignIn), 'watch history ' + (u.watchHistory ? 'on' : 'off')].filter(Boolean).join(' · ')));

      var acts = el('div', 'btn-row');
      function act(label, cls, fn) { var b = el('button', 'btn ' + cls, label); b.type = 'button'; b.addEventListener('click', fn); acts.appendChild(b); }
      act('Send sign-in link', 'btn-ghost', function () { ask('Send a sign-in link?', 'Emails ' + u.email + ' a one-time sign-in link (15 minutes).', false, true, function (reason) { return post('/api/admin/resend-link', { userId: u.id, reason: reason }); }, id); });
      act('Sign out all browsers', 'btn-ghost', function () { ask('Sign out every browser?', u.email + ' will need to sign in again on the website. Linked devices stay linked.', false, false, function (reason) { return post('/api/admin/end-sessions', { userId: u.id, reason: reason }); }, id); });
      if (u.status === 'suspended') act('Lift suspension', 'btn-ghost', function () { ask('Lift the suspension?', u.email + ' can sign in again; their devices keep working.', false, false, function (reason) { return post('/api/admin/suspend', { userId: u.id, suspend: false, reason: reason }); }, id); });
      else act('Suspend', 'btn-danger', function () { ask('Suspend this account?', u.email + " can't sign in, and is signed out of every browser. Linked devices stay linked but can't use account features until the suspension is lifted.", false, false, function (reason) { return post('/api/admin/suspend', { userId: u.id, suspend: true, reason: reason }); }, id); });
      act('Delete account', 'btn-danger', function () { ask('Delete this account?', 'Deletes ' + u.email + ' with its passkeys, browsers, linked devices and notes. The audit log keeps a record. This cannot be undone.', true, false, function (reason, confirmText) { return post('/api/admin/delete', { userId: u.id, reason: reason, confirm: confirmText }); }, null); });
      box.appendChild(acts);

      box.appendChild(el('h3', null, 'Devices'));
      var tvs = el('ul', 'rows');
      if (!d.devices.length) tvs.appendChild(el('li', 'soft', 'No devices linked.'));
      d.devices.forEach(function (t) {
        var li = el('li'); li.appendChild(el('span', null, t.name));
        li.appendChild(el('span', 'soft', [t.model, t.appVersion ? 'Avid Viewer ' + t.appVersion : '', 'linked ' + when(t.linkedAt), 'last seen ' + when(t.lastSeen), t.removedAt ? 'removed ' + when(t.removedAt) : ''].filter(Boolean).join(' · ')));
        if (!t.removedAt) { var x = el('button', 'linkish', 'Sign out this device'); x.type = 'button'; x.addEventListener('click', function () { ask('Sign out "' + t.name + '"?', 'The device unlinks itself the next time it checks in. Its playlists stay on the device.', false, false, function (reason) { return post('/api/admin/revoke-tv', { deviceId: t.id, reason: reason }); }, id); }); li.appendChild(x); }
        tvs.appendChild(li);
      });
      box.appendChild(tvs);

      box.appendChild(el('h3', null, 'Signed-in browsers'));
      var ss = el('ul', 'rows');
      if (!d.sessions.length) ss.appendChild(el('li', 'soft', 'None.'));
      d.sessions.forEach(function (s) { var li = el('li'); li.appendChild(el('span', null, s.label || 'A browser')); li.appendChild(el('span', 'soft', (s.method === 'passkey' ? 'passkey' : 'email link') + ' · signed in ' + when(s.createdAt) + ' · last active ' + when(s.lastSeen))); ss.appendChild(li); });
      box.appendChild(ss);
      box.appendChild(el('p', 'soft', 'Backups: ' + (d.backups.length ? d.backups.map(function (x) { return x.name + (x.removed ? ' (removed device)' : '') + ', ' + when(x.createdAt) + ', ' + Math.max(1, Math.round(x.size / 1024)) + ' KB'; }).join('; ') : 'none')));
      box.appendChild(el('p', 'soft', 'Passkeys: ' + (d.passkeys.length ? d.passkeys.map(function (p) { return p.name; }).join(', ') : 'none')));

      box.appendChild(el('h3', null, 'Notes'));
      var nf = el('form', 'adm-note');
      var ta = el('textarea'); ta.rows = 2; ta.maxLength = 2000; ta.placeholder = 'Add a private note (only admins see it)'; nf.appendChild(ta);
      var nb = el('button', 'btn btn-ghost', 'Add note'); nf.appendChild(nb);
      nf.addEventListener('submit', function (e) { e.preventDefault(); if (!ta.value.trim()) return; post('/api/admin/note', { userId: u.id, text: ta.value }).then(function () { loadUser(id); }); });
      box.appendChild(nf);
      var nl = el('ul', 'rows');
      d.notes.forEach(function (n) { var li = el('li'); li.appendChild(el('span', null, n.text)); li.appendChild(el('span', 'soft', n.by + ' · ' + when(n.at))); nl.appendChild(li); });
      box.appendChild(nl);

      box.appendChild(el('h3', null, 'History'));
      var hl = el('ul', 'rows');
      if (!d.log.length) hl.appendChild(el('li', 'soft', 'No admin actions yet.'));
      d.log.forEach(function (a) { var li = el('li'); li.appendChild(el('span', null, (ACTIONS[a.action] || a.action) + (a.detail ? ': ' + a.detail : ''))); li.appendChild(el('span', 'soft', a.by + ' · ' + when(a.at) + (a.reason ? ' · "' + a.reason + '"' : ''))); hl.appendChild(li); });
      box.appendChild(hl);
    });
  }

  // A confirmation with a reason (and, for deletes, the email typed again). reasonOptional for sending a link.
  function ask(title, text, needConfirm, reasonOptional, run, reloadId) {
    var dlg = $('adm-dialog');
    $('adm-d-title').textContent = title; $('adm-d-text').textContent = text; $('adm-d-err').textContent = '';
    $('adm-d-reason').value = ''; $('adm-d-confirm').value = ''; $('adm-d-confirm-wrap').hidden = !needConfirm;
    $('adm-d-reason').placeholder = reasonOptional ? 'Optional' : 'Required';
    dlg.showModal();
    $('adm-form').onsubmit = function (e) {
      if (e.submitter && e.submitter.value === 'cancel') return;
      e.preventDefault();
      var reason = $('adm-d-reason').value.trim();
      if (!reasonOptional && reason.length < 3) { $('adm-d-err').textContent = 'Give a reason; it goes in the audit log.'; return; }
      run(reason, $('adm-d-confirm').value).then(function (r) {
        if (!r._ok) { $('adm-d-err').textContent = r.error || "That didn't work."; return; }
        dlg.close();
        loadUsers();
        if (reloadId) loadUser(reloadId); else $('adm-user').innerHTML = '<p class="soft">Done. Choose another account.</p>';
      });
    };
  }

  function loadAudit() {
    get('/api/admin/audit').then(function (d) {
      table($('adm-audit'), ['When', 'Admin', 'Action', 'Account', 'Reason'], (d.entries || []).map(function (a) {
        return { cells: [when(a.at), a.by, (ACTIONS[a.action] || a.action) + (a.detail ? ': ' + a.detail : ''), a.target || '—', a.reason || ''] };
      }));
    });
  }
  function loadNews() {
    get('/api/admin/launch-news').then(function (d) {
      table($('adm-news'), ['Email', 'Signed up', 'Source', 'Country'], (d.signups || []).map(function (s) { return { cells: [s.email, when(s.at), s.source || '', s.country || ''] }; }));
    });
  }

  start();
})();
