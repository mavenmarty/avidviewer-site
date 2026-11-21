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
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
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
  var ACTIONS = { suspend: 'Suspended', unsuspend: 'Lifted suspension', 'delete': 'Deleted account', revoke_tv: 'Signed out device', resend_link: 'Sent sign-in link', end_sessions: 'Signed out browsers', note: 'Added note', beta_choose: 'Chose for the beta', beta_remove: 'Took out of the beta', beta_offer: 'Offered beta build', report_add: 'Added a report to a bug', report_file: 'Filed a bug', report_not_app: 'Marked a report not an app problem', report_need_info: 'Asked for details', report_ignore: 'Ignored a report', report_undo: 'Undid an automatic match', report_reopen: 'Put a report back in the queue', bug_note: 'Changed what a bug says', license_grant: 'Granted a license', license_revoke: 'Revoked licenses', reseller_renew: 'Asked for a line renewal', reseller_renew_cancel: 'Cancelled a line renewal', reseller_renew_resolve: 'Resolved a line renewal', reseller_enable: 'Turned on a line', reseller_disable: 'Turned off a line', reseller_hosts: 'Changed the reseller addresses', reseller_add_new: 'Added a new line', reseller_add_existing: 'Added an existing line' };
  var RSSTATUS = { pending: 'Waiting for a device', running: 'Renewing', done: 'Renewed', failed: 'Failed', unknown: 'Result unknown: check the panel', cancelled: 'Cancelled', expired: 'No device checked in' };
  // Nov 20, 2026: licenses. Lengths match LENGTHS in src/worker/licenses.js.
  var LENGTHS = [['7d', '7 days'], ['1m', '1 month'], ['3m', '3 months'], ['6m', '6 months'], ['1y', '1 year'], ['perpetual', 'Perpetual']];
  function day(ms) { return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
  function licText(l) {
    if (!l || l.status === 'none') return 'No license';
    var k = l.kind === 'comp' ? 'Complimentary' : l.kind === 'paid' ? 'Paid' : 'Trial';
    if (l.perpetual) return k + ' · perpetual';
    return k + (l.status === 'expired' ? ' · ended ' : ' · ends ') + day(l.endsAt) + (l.status === 'ending' ? ' (soon)' : '');
  }

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
    ({ dash: loadStats, reports: loadReports, people: loadUsers, audit: loadAudit, news: loadNews, beta: loadBeta })[name]();
  }
  document.querySelectorAll('[role=tab]').forEach(function (b) { b.addEventListener('click', function () { tab(b.dataset.tab); }); });

  function loadStats() {
    get('/api/admin/stats').then(function (s) {
      var box = $('adm-stats'); box.innerHTML = '';
      [['Accounts', s.users], ['New, 7 days', s.new7], ['New, 30 days', s.new30], ['Signed in, 7 days', s.active7], ['Linked devices', s.tvs],
       ['Devices seen, 7 days', s.tvs7], ['With a passkey', s.passkeys], ['Suspended', s.suspended], ['Playlists', s.playlists + (s.playlistsWaiting ? ' · ' + s.playlistsWaiting + ' waiting' : '')], ['Launch news', s.launchNews], ['Backups', s.backupCount + (s.backupsReady ? ' · on' : ' · OFF: BACKUP_PIN_KEY secret missing')], ['Backup storage', Math.round((s.backupBytes || 0) / 1024) + ' KB']]
        .forEach(function (k) { var c = el('div', 'adm-stat'); c.appendChild(el('span', 'n', String(k[1] || 0))); c.appendChild(el('span', 'l', k[0])); box.appendChild(c); });
      var bars = $('adm-daily'); bars.innerHTML = '';
      var byDay = {}; (s.daily || []).forEach(function (d) { byDay[d.day] = d.n; });
      var max = Math.max(1, Math.max.apply(null, Object.values(byDay).concat([1])));
      for (var i = 29; i >= 0; i--) {
        var day = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10), n = byDay[day] || 0;
        var b = el('div', 'bar'); b.style.height = Math.max(2, Math.round(100 * n / max)) + '%'; b.title = day + ': ' + n; bars.appendChild(b);
      }
      table($('adm-versions'), ['App version', 'Devices'], (s.versions || []).map(function (v) { return { cells: [v.v, String(v.n)] }; }));
      loadReseller();
      var le = s.licensesEnding || [];
      $('adm-ending-none').hidden = le.length > 0;
      table($('adm-ending'), ['Account', 'License', ''], le.map(function (x) {
        return { cells: [x.email, licText(x), 'Open'], onclick: function () { var t = document.querySelector('[data-tab=people]'); if (t) t.click(); loadUser(x.id); } };
      }));
    });
  }

  // Nov 21, 2026: reseller lines (src/worker/reseller.js). Credits, addresses, renewals waiting or recent.
  function after(p) { return p.then(function (r) { if (r._ok) loadReseller(); return r; }); }
  function loadReseller() {
    get('/api/admin/reseller').then(function (d) {
      var st = $('adm-rs-state');
      if (!d._ok) { st.textContent = d.error || "Couldn't load."; return; }
      var bits = [d.configured ? 'Reseller key set' : 'OFF: RESELLER_API_KEY / RESELLER_API_BASE secrets missing'];
      if (d.reseller) bits.push(d.reseller.error ? d.reseller.error : d.reseller.refused ? 'The panel refused the key: ' + d.reseller.refused : 'Credits: ' + (d.reseller.credits == null ? '?' : d.reseller.credits) + (d.reseller.enabled === false ? ' (reseller account turned off)' : ''));
      bits.push(plural(d.lines || 0, 'confirmed line'));
      bits.push(d.hosts.length ? 'Addresses: ' + d.hosts.join(', ') : 'No server addresses yet');
      st.textContent = bits.join(' · ');
      st.className = !d.configured || !d.hosts.length || (d.reseller && (d.reseller.error || d.reseller.refused || (d.reseller.credits != null && Number(d.reseller.credits) < 5))) ? 'adm-warn' : 'soft';
      $('adm-rs-hosts-in').value = d.hosts.join(', ');
      table($('adm-rs-renewals'), ['Account', 'Line', 'Renewal', 'Status', ''], (d.renewals || []).map(function (r) {
        var act = r.status === 'pending' ? 'Cancel' : r.status === 'unknown' ? 'Resolve' : '';
        return { cells: [r.email || '—', r.name || '—', plural(r.months, 'month') + ' · ' + when(r.createdAt), (RSSTATUS[r.status] || r.status) + (r.message && r.status !== 'done' ? ' · ' + r.message : ''), act], onclick: act ? function () {
          ask(act === 'Cancel' ? 'Cancel this renewal?' : 'Mark this renewal resolved?', act === 'Cancel' ? 'No credits are spent.' : 'Check the line in the provider panel first. This closes it so the line can be renewed again.', false, false, function (reason) { return after(post('/api/admin/reseller/renewal', { id: r.id, action: act.toLowerCase(), reason: reason })); }, null);
        } : null };
      }));
    });
  }
  $('adm-rs-hosts').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = $('adm-rs-hosts-in').value;
    ask('Save the reseller addresses?', 'Devices check playlists on these addresses with the provider: ' + (v.trim() || '(none)'), false, false, function (reason) { return after(post('/api/admin/reseller/hosts', { hosts: v, reason: reason })); }, null);
  });

  // Nov 21, 2026: Add a line to an account: a new one from the panel, or one that already exists there.
  var shownLogin = null, packages = null;
  function addLineForm(u, s8, reloadId) {
    var f = el('form', 'adm-license adm-addline');
    var mode = el('select'); mode.setAttribute('aria-label', 'New or existing');
    [['new', 'New line'], ['existing', 'Existing line']].forEach(function (x) { var o = el('option', null, x[1]); o.value = x[0]; mode.appendChild(o); });
    var name = el('input'); name.placeholder = 'Playlist name'; name.value = 'TV'; name.setAttribute('aria-label', 'Playlist name');
    var pack = el('select'); pack.setAttribute('aria-label', 'Package'); pack.appendChild(el('option', null, 'Loading packages…'));
    var months = el('select'); months.setAttribute('aria-label', 'Months');
    [1, 3, 6, 12].forEach(function (n) { var o = el('option', null, plural(n, 'month')); o.value = String(n); months.appendChild(o); });
    var server = el('input'); server.placeholder = 'Server'; server.setAttribute('aria-label', 'Server');
    if (s8.hosts.length) server.value = 'http://' + s8.hosts[0];
    var user = el('input'); user.placeholder = 'Username'; user.setAttribute('aria-label', 'Username'); user.autocomplete = 'off';
    var pass = el('input'); pass.type = 'password'; pass.placeholder = 'Password'; pass.setAttribute('aria-label', 'Password'); pass.autocomplete = 'new-password';
    var go = el('button', 'btn btn-primary', 'Add a line'); go.type = 'submit';
    function show() { var n = mode.value === 'new'; pack.hidden = months.hidden = !n; server.hidden = user.hidden = pass.hidden = n; }
    mode.addEventListener('change', show);
    [mode, name, pack, months, server, user, pass, go].forEach(function (x) { f.appendChild(x); });
    show();
    (packages ? Promise.resolve(packages) : get('/api/admin/reseller/packages').then(function (r) { if (r._ok) packages = r.packages; return r._ok ? r.packages : r; })).then(function (list) {
      pack.innerHTML = '';
      if (!Array.isArray(list)) { pack.appendChild(el('option', null, list.error || 'No packages')); return; }
      list.forEach(function (p) { var o = el('option', null, p.name); o.value = p.id; pack.appendChild(o); });
    });
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var n = mode.value === 'new';
      var text = (n ? 'Makes a new ' + months.options[months.selectedIndex].text + ' line (' + ((pack.options[pack.selectedIndex] || {}).text || '?') + ') from your credits' : 'Attaches the line ' + user.value + ' (checked with the provider first)') +
        ' and puts it in ' + u.email + '’s account as “' + (name.value || 'TV') + '”. ' +
        (s8.accountKey ? 'Its login is locked for their passkey; they choose the profiles.' : 'They have no passkey set up, so its login is locked for each of their linked devices and every profile gets it.');
      ask(n ? 'Add a new line?' : 'Add this line?', text, false, false, function (reason) {
        var data = { userId: u.id, name: name.value, reason: reason, mode: mode.value };
        if (n) { data.months = Number(months.value); data.pack = pack.value; } else { data.server = server.value; data.username = user.value; data.password = pass.value; }
        return post('/api/admin/reseller/add-line', data).then(function (r) { if (r._ok) { shownLogin = { userId: u.id, login: r.login, delivered: r.delivered, devices: r.devices }; pass.value = ''; } return r; });
      }, reloadId);
    });
    return f;
  }

  var qTimer;
  $('adm-q').addEventListener('input', function () { clearTimeout(qTimer); qTimer = setTimeout(loadUsers, 250); });
  $('adm-status').addEventListener('change', loadUsers);
  function loadUsers() {
    get('/api/admin/users?q=' + encodeURIComponent($('adm-q').value) + '&status=' + $('adm-status').value).then(function (d) {
      table($('adm-users'), ['Email', 'Joined', 'Last sign-in', 'Devices', 'Playlists', 'License', 'Status'], (d.users || []).map(function (u) {
        // Playlists: in the account, plus "+N on devices" typed on a device and never added to the account.
        var pl = String(u.playlists || 0) + (u.deviceOnlyPlaylists ? ' + ' + u.deviceOnlyPlaylists + ' on devices' : '');
        return { cells: [u.email + (u.role === 'admin' ? ' (admin)' : ''), when(u.createdAt), when(u.lastSignIn), String(u.tvs), pl, licText(u.license), u.status], onclick: function () { loadUser(u.id); } };
      }));
    });
  }

  function loadUser(id) {
    get('/api/admin/user?id=' + encodeURIComponent(id)).then(function (d) {
      var box = $('adm-user'); box.innerHTML = '';
      if (!d._ok) { box.appendChild(el('p', 'soft', d.error || 'Not found.')); return; }
      var u = d.user;
      box.appendChild(el('h2', null, u.email));
      box.appendChild(el('p', 'soft', [u.status === 'suspended' ? 'SUSPENDED' : 'Active', u.role === 'admin' ? 'administrator' : '', 'joined ' + when(u.createdAt), 'last sign-in ' + when(u.lastSignIn), plural(u.playlists || 0, 'playlist') + ' in the account' + (u.deviceOnlyPlaylists ? ' + ' + u.deviceOnlyPlaylists + ' only on devices' : ''), 'watch history ' + (u.watchHistory ? 'on' : 'off')].filter(Boolean).join(' · ')));

      var acts = el('div', 'btn-row');
      function act(label, cls, fn) { var b = el('button', 'btn ' + cls, label); b.type = 'button'; b.addEventListener('click', fn); acts.appendChild(b); }
      act('Send sign-in link', 'btn-ghost', function () { ask('Send a sign-in link?', 'Emails ' + u.email + ' a one-time sign-in link (15 minutes).', false, true, function (reason) { return post('/api/admin/resend-link', { userId: u.id, reason: reason }); }, id); });
      act('Sign out all browsers', 'btn-ghost', function () { ask('Sign out every browser?', u.email + ' will need to sign in again on the website. Linked devices stay linked.', false, false, function (reason) { return post('/api/admin/end-sessions', { userId: u.id, reason: reason }); }, id); });
      if (u.status === 'suspended') act('Lift suspension', 'btn-ghost', function () { ask('Lift the suspension?', u.email + ' can sign in again; their devices keep working.', false, false, function (reason) { return post('/api/admin/suspend', { userId: u.id, suspend: false, reason: reason }); }, id); });
      else act('Suspend', 'btn-danger', function () { ask('Suspend this account?', u.email + " can't sign in, and is signed out of every browser. Linked devices stay linked but can't use account features until the suspension is lifted.", false, false, function (reason) { return post('/api/admin/suspend', { userId: u.id, suspend: true, reason: reason }); }, id); });
      act('Delete account', 'btn-danger', function () { ask('Delete this account?', 'Deletes ' + u.email + ' with its passkeys, browsers, linked devices and notes. The audit log keeps a record. This cannot be undone.', true, false, function (reason, confirmText) { return post('/api/admin/delete', { userId: u.id, reason: reason, confirm: confirmText }); }, null); });
      box.appendChild(acts);

      // License: what the account has now, Grant or extend (from the current end, so no days are lost), Revoke, history.
      box.appendChild(el('h3', null, 'License'));
      box.appendChild(el('p', u.license && (u.license.status === 'ending' || u.license.status === 'expired') ? 'adm-warn' : 'soft', licText(u.license)));
      var lf = el('form', 'adm-license');
      var sel = el('select'); sel.setAttribute('aria-label', 'Length');
      LENGTHS.forEach(function (x) { var o = el('option', null, x[1]); o.value = x[0]; sel.appendChild(o); });
      var kind = el('select'); kind.setAttribute('aria-label', 'Kind');
      [['trial', 'Trial'], ['comp', 'Complimentary']].forEach(function (x) { var o = el('option', null, x[1]); o.value = x[0]; kind.appendChild(o); });
      sel.addEventListener('change', function () { if (sel.value === 'perpetual') kind.value = 'comp'; });
      var gb = el('button', 'btn btn-primary', u.license && u.license.status !== 'none' && u.license.status !== 'expired' ? 'Extend' : 'Grant'); gb.type = 'submit';
      lf.appendChild(sel); lf.appendChild(kind); lf.appendChild(gb);
      lf.addEventListener('submit', function (e) {
        e.preventDefault();
        var len = sel.options[sel.selectedIndex].text;
        ask((gb.textContent === 'Extend' ? 'Extend by ' : 'Grant ') + len.toLowerCase() + '?', len === 'Perpetual' ? u.email + ' gets a license that never ends.' : (gb.textContent === 'Extend' ? 'Adds ' + len.toLowerCase() + ' from the current end date for ' : 'Gives ') + u.email + (gb.textContent === 'Extend' ? '.' : ' a ' + len.toLowerCase() + ' ' + (kind.value === 'comp' ? 'complimentary license' : 'trial') + ', starting now.'), false, false, function (reason) { return post('/api/admin/license', { userId: u.id, length: sel.value, kind: kind.value, reason: reason }); }, id);
      });
      if (u.license && u.license.status !== 'none') { var rv = el('button', 'linkish', 'Revoke license'); rv.type = 'button'; rv.addEventListener('click', function () { ask('Revoke the license?', 'Ends every license on ' + u.email + ' now. Nothing is blocked on their devices for now.', false, false, function (reason) { return post('/api/admin/license', { userId: u.id, revoke: true, reason: reason }); }, id); }); lf.appendChild(rv); }
      box.appendChild(lf);
      if ((d.licenses || []).length) {
        var ll = el('ul', 'rows');
        d.licenses.forEach(function (l) { var li = el('li'); li.appendChild(el('span', null, (l.kind === 'comp' ? 'Complimentary' : l.kind === 'paid' ? 'Paid' : 'Trial') + ': ' + day(l.startsAt) + ' – ' + (l.endsAt ? day(l.endsAt) : 'perpetual') + (l.revokedAt ? ' (revoked ' + day(l.revokedAt) + ')' : ''))); li.appendChild(el('span', 'soft', (l.source === 'auto' ? 'automatic' : l.by || l.source) + (l.note ? ' · "' + l.note + '"' : ''))); ll.appendChild(li); });
        box.appendChild(ll);
      }

      // lines confirmed in this account: renew (from your credits, at a device's next check-in), turn on/off.
      var s8 = d.reseller || { lines: [], renewals: [] };
      if (s8.lines.length || s8.renewals.length || s8.on) {
        box.appendChild(el('h3', null, 'Reseller lines'));
        // The login of a line just added, shown once (never stored by the website).
        if (shownLogin && shownLogin.userId === u.id) {
          var lg = el('div', 'setup-card');
          lg.appendChild(el('p', null, 'Added. Pass these on to the customer if they need them; they won\u2019t be shown again.'));
          [['Server', shownLogin.login.server], ['Username', shownLogin.login.username], ['Password', shownLogin.login.password], ['M3U link', shownLogin.login.m3u]]
            .forEach(function (x) { var p = el('p', 'mono'); p.appendChild(el('strong', null, x[0] + ': ')); p.appendChild(document.createTextNode(x[1])); lg.appendChild(p); });
          lg.appendChild(el('p', 'fineprint', shownLogin.delivered === 'account' ? 'It\u2019s in their account, locked for their passkey: their Playlists page keeps it the next time they unlock, and they choose the profiles.' : 'Sent to ' + plural(shownLogin.devices, 'linked device') + ' (every profile has it; they can change that on their Playlists page).'));
          box.appendChild(lg); shownLogin = null;
        }
        if (s8.on) box.appendChild(addLineForm(u, s8, id));
        var sl = el('ul', 'rows');
        s8.lines.forEach(function (l) {
          var li = el('li');
          var ended = l.expiresAt && l.expiresAt <= Date.now();
          li.appendChild(el('span', !l.enabled || ended ? 'adm-warn' : null, (l.name || 'line') + ': ' + (!l.enabled ? 'turned off' : ended ? 'ended ' + day(l.expiresAt) : l.expiresAt ? 'until ' + day(l.expiresAt) : 'active')));
          li.appendChild(el('span', 'soft', 'line ' + l.lineId + ' · on ' + plural(l.devices, 'device') + ' · checked ' + when(l.checkedAt)));
          var f = el('form', 'adm-license');
          var m = el('select'); m.setAttribute('aria-label', 'Months');
          [1, 3, 6, 12].forEach(function (n) { var o = el('option', null, plural(n, 'month')); o.value = String(n); m.appendChild(o); });
          var rb = el('button', 'btn btn-primary', 'Renew'); rb.type = 'submit';
          f.appendChild(m); f.appendChild(rb);
          f.addEventListener('submit', function (e) {
            e.preventDefault();
            ask('Renew for ' + plural(Number(m.value), 'month') + '?', 'Uses your reseller credits. It happens the next time a device with this line checks in' + (l.devices ? '' : ' (no device has it right now)') + '.', false, false, function (reason) { return post('/api/admin/reseller/renew', { userId: u.id, lineId: l.lineId, months: Number(m.value), reason: reason }); }, id);
          });
          var tb = el('button', 'linkish', l.enabled ? 'Turn off at the provider' : 'Turn on at the provider'); tb.type = 'button';
          tb.addEventListener('click', function () {
            ask(l.enabled ? 'Turn this line off?' : 'Turn this line on?', l.enabled ? 'Channels stop working on every device using this line until it is turned back on.' : 'Channels work again on devices using this line.', false, false, function (reason) { return post('/api/admin/reseller/line', { userId: u.id, lineId: l.lineId, enabled: !l.enabled, reason: reason }); }, id);
          });
          f.appendChild(tb);
          li.appendChild(f);
          sl.appendChild(li);
        });
        box.appendChild(sl);
        if (s8.renewals.length) {
          var rl = el('ul', 'rows');
          s8.renewals.forEach(function (r) {
            var li = el('li');
            li.appendChild(el('span', null, plural(r.months, 'month') + ': ' + (RSSTATUS[r.status] || r.status) + (r.expiresAfter ? ', now until ' + day(r.expiresAfter) : '')));
            li.appendChild(el('span', 'soft', (r.by || '') + ' · ' + when(r.createdAt) + (r.message && r.status !== 'done' ? ' · ' + r.message : '')));
            if (r.status === 'pending' || r.status === 'unknown') {
              var act = r.status === 'pending' ? 'cancel' : 'resolve';
              var cb = el('button', 'linkish', act === 'cancel' ? 'Cancel' : 'Mark resolved'); cb.type = 'button';
              cb.addEventListener('click', function () { ask(act === 'cancel' ? 'Cancel this renewal?' : 'Mark resolved?', act === 'cancel' ? 'No credits are spent.' : 'Check the line in the provider panel first.', false, false, function (reason) { return post('/api/admin/reseller/renewal', { id: r.id, action: act, reason: reason }); }, id); });
              li.appendChild(cb);
            }
            rl.appendChild(li);
          });
          box.appendChild(rl);
        }
      }

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
  // ---------------------------------------------------------------- beta channel
  function loadBeta() {
    get('/api/admin/beta').then(function (b) {
      if (!b._ok) { $('adm-beta-offered').textContent = b.error || 'Couldn\'t load the beta.'; return; }
      $('adm-beta-offered').textContent = b.offered ? 'Offered now: ' + b.offered.name + ' (since ' + when(b.offered.at) + ', by ' + b.offered.by + ')' : 'No beta build offered yet.';
      var sel = $('adm-beta-build'); sel.innerHTML = '';
      b.builds.forEach(function (x) { var o = el('option', null, x.name + ' · ' + when(x.publishedAt)); o.value = x.tag; if (b.offered && b.offered.tag === x.tag) o.selected = true; sel.appendChild(o); });
      if (!b.builds.length) { var o = el('option', null, b.buildsError || 'No beta builds yet'); o.value = ''; sel.appendChild(o); }
      $('adm-beta-offer').disabled = !b.builds.length;
      $('adm-beta-mail').textContent = b.mail ? 'Choosing a device emails its owner.' : 'Email isn\'t set up, so owners see it only on the website and TV.';
      var t = $('adm-beta-devices'); t.innerHTML = '';
      var tr = el('tr'); ['Beta', 'Device', 'Model', 'App version', 'Last check-in', 'Account'].forEach(function (h) { tr.appendChild(el('th', null, h)); }); t.appendChild(tr);
      if (!b.devices.length) { var e = el('tr'); var td = el('td', 'soft', 'No devices offered yet.'); td.colSpan = 6; e.appendChild(td); t.appendChild(e); }
      b.devices.forEach(function (d) {
        var row = el('tr'); var c = el('td'); var box = el('input'); box.type = 'checkbox'; box.checked = !!d.chosenAt;
        box.setAttribute('aria-label', 'Beta for ' + d.name);
        box.addEventListener('change', function () {
          box.disabled = true;
          post('/api/admin/beta/choose', { deviceId: d.id, on: box.checked }).then(function (r) {
            if (!r._ok) alert(r.error || 'That didn\'t work.');
            loadBeta();
          });
        });
        c.appendChild(box); row.appendChild(c);
        [d.name, d.model || '—', d.appVersion || '—', when(d.lastSeen), d.email].forEach(function (v) { row.appendChild(el('td', null, v)); });
        t.appendChild(row);
      });
    });
  }
  $('adm-beta-offer').addEventListener('click', function () {
    var tag = $('adm-beta-build').value; if (!tag) return;
    var name = $('adm-beta-build').selectedOptions[0].textContent.split(' · ')[0];
    if (!confirm('Offer ' + name + ' to every device in the beta?')) return;
    post('/api/admin/beta/offer', { tag: tag }).then(function (r) { if (!r._ok) alert(r.error || 'That didn\'t work.'); loadBeta(); });
  });

  // ---------------------------------------------------------------- reports (src/worker/reports.js)
  var KIND = { crash: 'Crash report', playback: 'Playback log', security: 'Security alert', problem: 'Report a problem (from the QR code)' };
  var BUGST = { open: 'Being fixed', need_info: 'Needs details', fixed: 'Fixed', closed: 'Closed' };
  function rpAct(id, action, extra) {
    var d = Object.assign({ id: id, action: action }, extra || {});
    return post('/api/admin/reports/triage', d).then(function (r) {
      if (!r._ok) { alert(r.error || 'That didn\'t work.'); return; }
      if (r.openUrl) window.open(r.openUrl, '_blank', 'noopener');
      loadReports();
    });
  }
  function btn(text, cls, fn) { var b = el('button', 'btn ' + (cls || 'btn-ghost'), text); b.type = 'button'; b.addEventListener('click', fn); return b; }
  function reportRow(r, auto) {
    var box = el('div', 'adm-rp-row');
    var head = el('div', 'adm-rp-top');
    head.appendChild(el('strong', null, KIND[r.kind] || r.kind));
    head.appendChild(el('span', 'soft', r.device + (r.email ? ' (' + r.email + ')' : '') + ' · ' + (r.deviceInfo || 'device not given') + ' · ' + r.appVersion + ' · ' + when(r.sentAt) + (r.source === 'relay' ? ' · by email relay' : r.source === 'form' ? ' · written on avidviewer.app' : '')));
    box.appendChild(head);
    box.appendChild(el('div', null, r.summary || r.title));
    if (r.reopenedAt) box.appendChild(el('div', 'adm-rp-flag', 'Back from the account: “It’s still happening” (' + when(r.reopenedAt) + ')'));
    if (r.bugs.length) box.appendChild(el('div', 'adm-rp-sugg', (auto ? 'Added by itself to ' : 'On ') + r.bugs.map(function (b) { return '#' + b.number + (b.title ? ' ' + b.title : ''); }).join(', ')));
    else if (r.suggestions.length) box.appendChild(el('div', 'adm-rp-sugg', 'Suggested: ' + r.suggestions.map(function (b) { return '#' + b.bug + (b.title ? ' ' + b.title : ''); }).join(', ')));
    else if (r.signatures.length && r.signatures.every(function (k) { return k.indexOf('provider|') === 0; })) box.appendChild(el('div', 'adm-rp-sugg', 'Suggested: not an app problem (only provider or network trouble)'));
    var acts = el('div', 'adm-rp-acts');
    if (auto) {
      acts.appendChild(btn('Undo', 'btn-ghost', function () { rpAct(r.id, 'undo'); }));
    } else {
      if (r.suggestions.length) {
        var nums = r.suggestions.map(function (b) { return b.bug; });
        acts.appendChild(btn('Add to #' + nums.join(', #'), 'btn-primary', function () { rpAct(r.id, 'add', { bugs: nums }); }));
      }
      acts.appendChild(btn('Add to bug…', 'btn-ghost', function () {
        var n = prompt('Add ' + r.id + ' to which bug? (number, or several separated by commas)'); if (!n) return;
        rpAct(r.id, 'add', { bugs: n.split(/[ ,#]+/).filter(Boolean).map(Number) });
      }));
      acts.appendChild(btn('File new bug', 'btn-ghost', function () {
        var t = prompt('Title for the new bug', r.summary || r.title); if (t == null) return;
        rpAct(r.id, 'file', { title: t });
      }));
      acts.appendChild(btn('Not an app problem', 'btn-ghost', function () { rpAct(r.id, 'not_app'); }));
      acts.appendChild(btn('Need details', 'btn-ghost', function () { rpAct(r.id, 'need_info'); }));
      acts.appendChild(btn('Ignore', 'btn-ghost', function () { if (confirm('Ignore ' + r.id + '? It disappears from the account\'s Reports page.')) rpAct(r.id, 'ignore'); }));
    }
    acts.appendChild(btn('Open', 'btn-ghost', function () { showReport(r.id); }));
    box.appendChild(acts);
    return box;
  }
  function showReport(id) {
    get('/api/admin/reports/item?id=' + encodeURIComponent(id)).then(function (r) {
      var c = $('adm-rp-item'); c.innerHTML = ''; c.hidden = false;
      c.appendChild(el('h2', null, r.id + ' · ' + (KIND[r.kind] || r.kind)));
      c.appendChild(el('p', 'soft', 'Keys: ' + (r.signatures.join(' · ') || 'none') + (r.bugs.length ? ' · on #' + r.bugs.map(function (b) { return b.number; }).join(', #') : '')));
      (r.notes || []).forEach(function (n) { c.appendChild(el('p', null, 'Note from the account (' + when(n.at) + '): ' + n.text)); });
      if (r.state !== 'new') c.appendChild(btn('Put back in the queue', 'btn-ghost', function () { rpAct(r.id, 'reopen'); }));
      var pre = el('pre', 'adm-rp-pre', r.body); c.appendChild(pre);
      c.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
  function loadReports() {
    get('/api/admin/reports').then(function (d) {
      if (!d._ok) { $('adm-rp-new').textContent = d.error || 'Couldn\'t load reports.'; return; }
      $('adm-rp-sync').textContent = 'GitHub last read ' + (d.syncedAt ? when(d.syncedAt) : 'never') + '. ' +
        (d.webhook ? 'The webhook updates bugs as they change.' : 'No webhook yet (GITHUB_WEBHOOK_SECRET): bugs are read every few minutes while this page or a Reports page is open.') + ' ' +
        (d.canFile ? 'File new bug files it on GitHub directly.' : 'File new bug opens GitHub\'s new-issue page, filled in (no GITHUB_TOKEN); the report links itself once it\'s submitted.');
      $('adm-rp-new-h').textContent = 'New · ' + d.queue.length;
      var nb = $('adm-rp-new'); nb.innerHTML = '';
      if (!d.queue.length) nb.appendChild(el('p', 'soft', 'Nothing waiting.'));
      d.queue.forEach(function (r) { nb.appendChild(reportRow(r, false)); });
      $('adm-rp-auto-h').textContent = 'Added by themselves (last 24 hours) · ' + d.auto.length;
      var ab = $('adm-rp-auto'); ab.innerHTML = '';
      if (!d.auto.length) ab.appendChild(el('p', 'soft', 'None.'));
      d.auto.forEach(function (r) { ab.appendChild(reportRow(r, true)); });
      var bb = $('adm-rp-bugs'); bb.innerHTML = '';
      if (!d.bugs.length) bb.appendChild(el('p', 'soft', 'No bugs read from GitHub yet.'));
      d.bugs.forEach(function (b) {
        var row = el('div', 'adm-rp-bug');
        var top = el('div', 'adm-rp-top');
        var a = el('a', null, '#' + b.number); a.href = 'https://github.com/mavenmarty/avid-viewer/issues/' + b.number; a.target = '_blank'; a.rel = 'noopener';
        top.appendChild(a); top.appendChild(el('strong', null, b.title));
        top.appendChild(el('span', 'adm-rp-st', (BUGST[b.status] || b.status) + (b.fixed_in ? ' in ' + b.fixed_in : '')));
        row.appendChild(top);
        row.appendChild(el('div', 'soft', b.reports + (b.reports === 1 ? ' report' : ' reports') + ' · ' + b.devices + (b.devices === 1 ? ' device' : ' devices') + (b.latest ? ' · latest from ' + b.latest : '')));
        var note = el('textarea'); note.rows = 2; note.value = b.public_note || ''; note.placeholder = 'What the account\'s Reports page says (“What we found”). Empty: the bug\'s title.';
        note.setAttribute('aria-label', 'What people see about bug ' + b.number);
        var save = btn('Save', 'btn-ghost', function () { post('/api/admin/bugs/note', { number: b.number, note: note.value }).then(function (r) { save.textContent = r._ok ? 'Saved' : 'Failed'; }); });
        row.appendChild(note); row.appendChild(save);
        bb.appendChild(row);
      });
    });
  }
  $('adm-rp-sync-now').addEventListener('click', function () {
    var b = $('adm-rp-sync-now'); b.disabled = true;
    post('/api/admin/bugs/sync', {}).then(function (r) { b.disabled = false; if (r.error) alert(r.error); loadReports(); });
  });

  function loadNews() {
    get('/api/admin/launch-news').then(function (d) {
      table($('adm-news'), ['Email', 'Signed up', 'Source', 'Country'], (d.signups || []).map(function (s) { return { cells: [s.email, when(s.at), s.source || '', s.country || ''] }; }));
    });
  }

  start();
})();
