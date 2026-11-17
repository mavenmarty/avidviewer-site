/* "Needs your attention" on every account tab (Nov 17, 2026): what didn't go as expected or needs you, in plain words,
 * with what to do; the tabs show how many items each has. Refreshed every 30 s while the page is open. */
(function () {
  'use strict';
  var box = document.getElementById('mg-attention');
  if (!box) return;
  var TAB = { playlists: '/playlists/', profiles: '/profiles/', devices: '/devices/', backups: '/backups/', account: '/account/' };
  var here = Object.keys(TAB).find(function (k) { return TAB[k] === location.pathname; }) || '';
  var open = false;
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

  function render(items) {
    badges(items);
    // On Playlists, the logins banner above the list already asks for this.
    if (here === 'playlists') items = items.filter(function (i) { return i.kind !== 'logins'; });
    box.innerHTML = '';
    if (!items.length) { box.hidden = true; return; }
    box.hidden = false;
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
      if (i.tab !== here && TAB[i.tab] && !(i.actions || []).length) { var go = el('a', null, 'Open ' + i.tab[0].toUpperCase() + i.tab.slice(1)); go.href = TAB[i.tab]; acts.appendChild(go); }
      if (acts.childNodes.length) li.appendChild(acts);
      ul.appendChild(li);
    });
    box.appendChild(head); box.appendChild(ul);
  }

  function load() {
    fetch('/api/account/attention', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : { items: [] }; })
      .then(function (d) { render(d.items || []); })
      .catch(function () {});
  }
  load();
  setInterval(function () { if (document.visibilityState === 'visible') load(); }, 30000);
  window.addEventListener('avid:changed', load);
})();
