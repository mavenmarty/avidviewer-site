/* "Needs your attention" on every account tab (Nov 17, 2026): what didn't go as expected or needs you, in plain words,
 * with what to do; the tabs show how many items each has. Refreshed every 30 s while the page is open. */
(function () {
  'use strict';
  var box = document.getElementById('mg-attention');
  if (!box) return;
  var TAB = { playlists: '/playlists/', profiles: '/profiles/', devices: '/devices/', backups: '/backups/', reports: '/reports/', account: '/account/' };
  var here = Object.keys(TAB).find(function (k) { return TAB[k] === location.pathname; }) || '';
  var open = false, showGone = false, last = { items: [], dismissed: [] };
  function post(path, data) {
    return fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  function badges(items) {
    document.querySelectorAll('.mg-tabs a').forEach(function (a) {
      var old = a.querySelector('.mg-badge'); if (old) old.remove();
      var k = Object.keys(TAB).find(function (x) { return TAB[x] === a.getAttribute('href'); });
      var mine = items.filter(function (i) { return i.tab === k && i.level !== 'info'; });
      if (!mine.length) return;
      var b = el('span', 'mg-badge' + (mine.some(function (i) { return i.level === 'error'; }) ? ' err' : ''), String(mine.length));
      b.setAttribute('aria-label', mine.length + (mine.length === 1 ? ' item needs' : ' items need') + ' attention');
      a.appendChild(b);
    });
  }

  function render(items, dismissed) {
    dismissed = dismissed || [];
    badges(items);
    // On Playlists, the logins banner above the list already asks for this.
    if (here === 'playlists') items = items.filter(function (i) { return i.kind !== 'logins'; });
    box.innerHTML = '';
    if (!items.length && !dismissed.length) { box.hidden = true; return; }
    box.hidden = false;
    if (!items.length) {
      // Nothing new: just the way back to what was dismissed.
      var quiet = el('div', 'mg-att-quiet');
      quiet.appendChild(el('span', null, 'Nothing needs your attention.'));
      quiet.appendChild(goneToggle(dismissed));
      box.appendChild(quiet);
      if (showGone) box.appendChild(goneList(dismissed));
      return;
    }
    // This tab's items first, then the rest.
    var sorted = items.filter(function (i) { return i.tab === here; }).concat(items.filter(function (i) { return i.tab !== here; }));
    var errs = items.filter(function (i) { return i.level === 'error'; }).length;
    var head = el('button', 'mg-att-head');
    head.type = 'button';
    head.setAttribute('aria-expanded', String(open || errs > 0 || sorted[0].tab === here));
    head.textContent = (errs ? '⚠ ' : '') + 'Needs your attention · ' + items.length;
    var ul = el('ul', 'mg-att-list');
    ul.hidden = head.getAttribute('aria-expanded') !== 'true';
    head.addEventListener('click', function () { open = ul.hidden; ul.hidden = !ul.hidden; head.setAttribute('aria-expanded', String(!ul.hidden)); });
    sorted.forEach(function (i) {
      var li = el('li', 'mg-att ' + i.level);
      li.appendChild(el('strong', null, i.title));
      li.appendChild(el('p', null, i.detail));
      var acts = el('div', 'mg-att-acts');
      (i.actions || []).forEach(function (a) {
        if (a.href) {
          var link = el('a', null, a.label); link.href = a.href;
          if (a.href.split('#')[0] === location.pathname) link.addEventListener('click', function () { setTimeout(function () { window.dispatchEvent(new HashChangeEvent('hashchange')); }, 0); });
          acts.appendChild(link);
        } else if (a.retry) {
          var b = el('button', 'linkish', a.label); b.type = 'button';
          b.addEventListener('click', function () {
            b.disabled = true;
            fetch('/api/account/playlists/retry', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(a.retry) })
              .then(function () { location.href = '/playlists/'; });
          });
          acts.appendChild(b);
        }
      });
      (i.actions || []).forEach(function (a) {
        if (!a.removeDevice) return;
        var rb = el('button', 'linkish', a.label); rb.type = 'button';
        rb.addEventListener('click', function () {
          if (!confirm('Remove this device from your account? It\'s signed out at its next check-in, its waiting changes are dropped, and its backup is kept for 30 days.')) return;
          rb.disabled = true;
          post('/api/account/devices/remove', { id: a.removeDevice }).then(function () { window.dispatchEvent(new Event('avid:changed')); location.reload(); });
        });
        acts.appendChild(rb);
      });
      var dm = el('button', 'linkish mg-dismiss', 'Dismiss'); dm.type = 'button';
      dm.title = 'Hide this until something about it changes';
      dm.addEventListener('click', function () { dm.disabled = true; post('/api/account/attention/dismiss', { key: i.key }).then(load); });
      acts.appendChild(dm);
      if (i.tab !== here && TAB[i.tab] && !(i.actions || []).length) { var go = el('a', null, 'Open ' + i.tab[0].toUpperCase() + i.tab.slice(1)); go.href = TAB[i.tab]; acts.appendChild(go); }
      if (acts.childNodes.length) li.appendChild(acts);
      ul.appendChild(li);
    });
    box.appendChild(head); box.appendChild(ul);
    if (dismissed.length) {
      var foot = el('div', 'mg-att-quiet'); foot.appendChild(goneToggle(dismissed)); ul.appendChild(foot);
      if (showGone) ul.appendChild(goneList(dismissed));
    }
  }
  function goneToggle(dismissed) {
    var b = el('button', 'linkish', (showGone ? 'Hide ' : 'Show ') + dismissed.length + ' dismissed'); b.type = 'button';
    b.addEventListener('click', function () { showGone = !showGone; open = true; render(last.items, last.dismissed); });
    return b;
  }
  function goneList(dismissed) {
    var ul = el('ul', 'mg-att-list mg-att-gone');
    dismissed.forEach(function (i) {
      var li = el('li', 'mg-att ' + i.level);
      li.appendChild(el('strong', null, i.title));
      li.appendChild(el('p', null, i.detail));
      var r = el('button', 'linkish', 'Show again'); r.type = 'button';
      r.addEventListener('click', function () { post('/api/account/attention/dismiss', { key: i.key, restore: true }).then(load); });
      var acts = el('div', 'mg-att-acts'); acts.appendChild(r); li.appendChild(acts);
      ul.appendChild(li);
    });
    return ul;
  }

  function load() {
    fetch('/api/account/attention', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : { items: [] }; })
      .then(function (d) { last = { items: d.items || [], dismissed: d.dismissed || [] }; render(last.items, last.dismissed); })
      .catch(function () {});
  }
  load();
  setInterval(function () { if (document.visibilityState === 'visible') load(); }, 30000);
  window.addEventListener('avid:changed', load);
})();
