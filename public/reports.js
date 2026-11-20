/* Account › Reports (Nov 20, 2026): what each device sent (crash reports, playback logs) and where each one stands.
 * The list, and one report at #r=AVR-…. See src/worker/reports.js. Fixed reports leave the list 30 days after the fix. */
(function () {
  'use strict';
  var root = document.getElementById('rp');
  if (!root) return;
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function add(p) { for (var i = 1; i < arguments.length; i++) if (arguments[i]) p.appendChild(arguments[i]); return p; }
  function get(path) { return fetch(path, { credentials: 'same-origin' }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { d._ok = r.ok; d._status = r.status; return d; }); }); }
  function post(path, data) {
    return fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data || {}) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { d._ok = r.ok; return d; }); });
  }
  function when(ms) {
    if (!ms) return '';
    var d = new Date(ms), now = new Date();
    var t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return 'Today, ' + t;
    var y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return 'Yesterday, ' + t;
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + t;
  }
  function vnum(v) { var m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v || '')); return m ? (+m[1]) * 1e6 + (+m[2]) * 1e3 + (+m[3]) : -1; }
  function newer(a, b) { return vnum(a) > vnum(b); }
  var PILL = { received: 'rp-grey', looking: 'rp-teal', fixing: 'rp-blue', need_info: 'rp-amber', fixed: 'rp-amber', not_app: 'rp-dim', closed: 'rp-dim' };
  function pill(st) { return el('span', 'rp-pill ' + (PILL[st.key] || 'rp-grey'), st.label); }
  var OPEN = { received: 1, looking: 1, fixing: 1, need_info: 1 };
  var device = 'all', show = 'open', data = null;

  document.querySelectorAll('.mg-signout').forEach(function (b) {
    b.addEventListener('click', function () { post('/api/auth/signout').then(function () { location.href = '/'; }); });
  });

  function chips(label, items, cur, onPick) {
    var g = el('div', 'rp-chips'); g.setAttribute('role', 'group'); g.setAttribute('aria-label', label);
    add(g, el('span', 'rp-chips-k', label));
    items.forEach(function (it) {
      var b = el('button', 'rp-chip', it[1]); b.type = 'button'; b.setAttribute('aria-pressed', String(it[0] === cur));
      b.addEventListener('click', function () { onPick(it[0]); });
      g.appendChild(b);
    });
    return g;
  }

  function list() {
    root.innerHTML = '';
    add(root, add(el('header', 'page-head'), el('h1', null, 'Reports'),
      el('p', null, 'Problems your devices sent to Avid Viewer (crash reports and playback logs), and what’s happening with each one. Check back here: there are no emails about reports.')));
    if (!data) return;
    var reps = data.reports;
    // A fix is out for a device that's still on an older version.
    var due = {};
    reps.forEach(function (r) { if (r.updateTo && r.device.id) due[r.device.id] = { name: r.device.name, v: r.updateTo }; });
    Object.keys(due).forEach(function (k) {
      var d = due[k];
      add(root, add(el('div', 'rp-banner'), add(el('p'), el('strong', null, 'A fix is ready for ' + d.name + '. '),
        document.createTextNode('Update it to ' + d.v + ' in Settings › Updates & about, or it updates by itself within a day.'))));
    });
    var devs = []; reps.forEach(function (r) { if (r.device.id && !devs.some(function (x) { return x[0] === r.device.id; })) devs.push([r.device.id, r.device.name]); });
    var bar = el('div', 'rp-filters');
    if (devs.length > 1) add(bar, chips('Device', [['all', 'All devices']].concat(devs), device, function (v) { device = v; list(); }));
    add(bar, chips('Show', [['open', 'Open'], ['fixed', 'Fixed and closed'], ['all', 'All']], show, function (v) { show = v; list(); }));
    add(root, bar);
    var rows = reps.filter(function (r) {
      if (device !== 'all' && r.device.id !== device) return false;
      var open = !!OPEN[r.status.key];
      return show === 'all' || (show === 'open' ? open : !open);
    });
    if (!rows.length) {
      add(root, el('p', 'rp-empty', reps.length ? 'Nothing here with these filters.' : 'No reports yet. When a device sends a crash report or a playback log, it shows here.'));
    } else {
      var ul = el('ul', 'rp-list');
      rows.forEach(function (r) {
        var a = el('a', 'rp-row'); a.href = '#r=' + r.id;
        add(a, add(el('div', 'rp-st'), pill(r.status)),
          add(el('div', 'rp-what'), el('div', 'rp-title', r.title),
            el('div', 'rp-sub', (r.kind === 'playback' ? 'Playback log' : 'Crash report') + (r.bugs.length ? ' · bug ' + r.bugs.join(', ') : '') + (r.updateTo ? ' · update to ' + r.updateTo : ''))),
          add(el('div', 'rp-dev'), el('div', null, r.device.name), el('div', 'rp-sub', [r.device.model, r.device.version ? 'on ' + r.device.version : ''].filter(Boolean).join(' · '))),
          el('div', 'rp-when', when(r.sentAt)));
        add(ul, add(el('li'), a));
      });
      add(root, ul);
    }
    add(root, el('p', 'fineprint', 'Reports from every device in your account. They never say what was watched: channels and titles are short codes. A report a device sent before it was linked shows here once it’s linked. A fixed report leaves this page ' + (data.keepFixedDays || 30) + ' days after its fix was released.'));
  }

  function detail(id) {
    root.innerHTML = '';
    add(root, add(el('p', 'rp-crumb'), add(el('a', null, 'Reports'), null)));
    root.querySelector('.rp-crumb a').href = '#';
    get('/api/account/reports/item?id=' + encodeURIComponent(id)).then(function (r) {
      if (r._status === 401) { location.href = '/signin/?next=' + encodeURIComponent('/reports/'); return; }
      if (!r._ok) { add(root, el('p', 'rp-empty', r.error || 'That report was not found.')); return; }
      add(root.querySelector('.rp-crumb'), document.createTextNode(' › ' + r.device.name + ' · ' + when(r.sentAt)));
      add(root, add(el('header', 'rp-head'), el('h1', null, r.title),
        add(el('div', 'rp-headline'), pill(r.status), el('span', 'rp-sub', (r.kind === 'playback' ? 'Playback log' : 'Crash report') + ' from ' + r.device.name))));
      var ol = el('ol', 'rp-steps');
      var reached = true;
      r.steps.forEach(function (s, i) {
        var done = !!s.at;
        var li = el('li', done ? 'done' : '');
        add(li, el('span', 'rp-dot'), el('div', 'rp-step', s.label), el('div', 'rp-sub', done ? when(s.at) : (s.key === 'confirmed' ? 'after a while on the fixed version with no new reports' : '')));
        ol.appendChild(li);
      });
      add(root, ol);
      var grid = el('div', 'rp-grid'), left = el('div', 'rp-col');
      if (r.found.length) {
        var f = add(el('section', 'rp-card'), el('h2', null, 'What we found'));
        r.found.forEach(function (b) { add(f, el('p', null, b.note || b.title || 'Bug ' + b.bug)); });
        add(left, f);
      } else if (r.status.key === 'not_app') {
        add(left, add(el('section', 'rp-card'), el('h2', null, 'What we found'), el('p', null, 'This came from your provider or your network, not from Avid Viewer: for example, the provider refused a channel or stopped sending it. There’s nothing to fix in the app.')));
      }
      var todo = add(el('section', 'rp-card rp-todo'), el('h2', null, 'What to do now'));
      add(todo, el('p', null, r.updateTo ? 'Update ' + r.device.name + ' to ' + r.updateTo + ': Settings › Updates & about › Download and install. It also updates by itself within a day.'
        : r.status.key === 'fixed' ? 'Nothing: ' + r.device.name + ' already has the fix.'
        : r.status.key === 'need_info' ? 'We need more details: add a note with what you were doing when it happened.'
        : 'Nothing for now. This page shows each step as it happens.'));
      var note = el('textarea', 'rp-note'); note.rows = 3; note.maxLength = 2000; note.placeholder = 'What were you doing? Anything else we should know?';
      note.setAttribute('aria-label', 'Note');
      var msg = el('p', 'rp-msg'); msg.setAttribute('role', 'status');
      var still = el('button', 'btn btn-primary', 'It’s still happening'); still.type = 'button';
      var addNote = el('button', 'btn btn-ghost', 'Add a note'); addNote.type = 'button';
      function send(isStill) {
        still.disabled = addNote.disabled = true;
        post(isStill ? '/api/account/reports/still' : '/api/account/reports/note', { id: r.id, text: note.value }).then(function (res) {
          still.disabled = addNote.disabled = false;
          if (!res._ok) { msg.textContent = res.error || 'That didn’t work. Try again.'; return; }
          note.value = '';
          msg.textContent = isStill ? 'Thanks. It’s back with us, and ' + r.device.name + ' will send a new playback log the next time it’s on.' : 'Note added.';
          setTimeout(function () { detail(id); }, 1500);
        });
      }
      still.addEventListener('click', function () { send(true); });
      addNote.addEventListener('click', function () { send(false); });
      add(todo, note, add(el('div', 'rp-actions'), r.canStill ? still : null, addNote), msg);
      add(left, todo);
      if (r.notes.length) {
        var nl = add(el('section', 'rp-card'), el('h2', null, 'Your notes'));
        r.notes.forEach(function (n) { add(nl, add(el('p'), el('span', 'rp-sub', when(n.at) + ' · '), document.createTextNode(n.text))); });
        add(left, nl);
      }
      var aside = add(el('aside', 'rp-card'), el('h2', null, 'Report details'));
      var dl = el('dl', 'rp-dl');
      [['Device', r.device.name + (r.device.model ? ' · ' + r.device.model : '')], ['App version', r.appVersion + (r.device.version && newer(r.device.version, r.appVersion) ? ' → now ' + r.device.version : '')],
       ['Kind', r.kind === 'playback' ? 'Playback log' : 'Crash report'], ['Summary', r.summary || '—'], ['Report id', r.id]].forEach(function (x) { add(dl, el('dt', null, x[0]), el('dd', null, x[1])); });
      add(aside, dl);
      r.found.forEach(function (b) { var p = el('p', 'rp-sub'); var a = el('a', null, 'Bug #' + b.bug + ' on GitHub'); a.href = 'https://github.com/mavenmarty/avid-viewer/issues/' + b.bug; a.target = '_blank'; a.rel = 'noopener'; add(p, a, document.createTextNode(' (public; names no one)')); add(aside, p); });
      var det = el('details', 'rp-sent'); add(det, el('summary', null, 'What the device sent'), el('pre', null, r.body), el('p', 'fineprint', 'Channels and titles are codes; what you watched is never sent.'));
      add(aside, det);
      add(grid, left, aside);
      add(root, grid);
      window.scrollTo(0, 0);
    });
  }

  function load() {
    return get('/api/account/reports').then(function (d) {
      if (d._status === 401) { location.href = '/signin/?next=' + encodeURIComponent('/reports/'); return; }
      if (!d._ok) { root.innerHTML = ''; add(root, el('p', 'rp-empty', d.error || 'Couldn’t load your reports. Reload the page.')); return; }
      data = d;
    });
  }
  function route() {
    var m = /^#r=(AVR-[0-9a-f]{8})$/.exec(location.hash);
    if (m) detail(m[1]); else load().then(list);
  }
  window.addEventListener('hashchange', route);
  route();
})();
