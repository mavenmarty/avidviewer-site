/* avidviewer.app/playlists: send playlists to linked devices and choose which profiles see them.
 * The login is sealed in the browser for each device (ECDH P-256 with the device's key → HKDF-SHA256 → AES-256-GCM);
 * Avid Viewer opens it with the private key that never leaves the device. */
(function (root) {
  'use strict';
  var INFO = 'avidviewer-playlist:v1';
  function b64(u8) { var s = ''; for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); }
  function unb64(s) { return Uint8Array.from(atob(s), function (c) { return c.charCodeAt(0); }); }

  /** Seals {name,type,server,username,password,m3uUrl,epgUrl} for the device whose public key (raw P-256, base64) is pub. */
  async function seal(pub, obj) {
    var S = root.crypto.subtle;
    var devKey = await S.importKey('raw', unb64(pub), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    var eph = await S.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    var z = await S.deriveBits({ name: 'ECDH', public: devKey }, eph.privateKey, 256);
    var epk = new Uint8Array(await S.exportKey('raw', eph.publicKey));
    var hk = await S.importKey('raw', z, 'HKDF', false, ['deriveKey']);
    var key = await S.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: epk, info: new TextEncoder().encode(INFO) }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    var iv = root.crypto.getRandomValues(new Uint8Array(12));
    var ct = new Uint8Array(await S.encrypt({ name: 'AES-GCM', iv: iv }, key, new TextEncoder().encode(JSON.stringify(obj))));
    return { v: 1, epk: b64(epk), iv: b64(iv), ct: b64(ct) };
  }
  root.AvidPlaylists = { seal: seal };
  if (typeof document === 'undefined') return;

  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function say(msg, err) { var m = $('pl-msg'); m.textContent = msg || ''; m.classList.toggle('err', !!err); }
  function post(path, data) {
    return fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })
      .then(function (r) { return r.json().then(function (j) { j._ok = r.ok; return j; }, function () { return { _ok: false, error: 'Something went wrong. Try again.' }; }); });
  }
  var state = { devices: [], playlists: [], editing: null };
  function devName(id) { var d = state.devices.find(function (x) { return x.id === id; }); return d ? d.name : 'A removed device'; }
  function profNames(dev, ids) {
    if (!ids) return 'every profile';
    var d = state.devices.find(function (x) { return x.id === dev; });
    return ids.map(function (i) { var p = d && d.profiles.find(function (q) { return q.id === i; }); return p ? p.name : 'a removed profile'; }).join(', ');
  }
  function statusText(t) {
    if (t.status === 'failed') return 'Couldn\'t add it: ' + (t.error || 'the device refused it');
    if (t.status === 'waiting') return t.action === 'remove' ? 'Removing at the next check-in' : 'Waiting for the device (open Avid Viewer on it)';
    return t.action === 'update' ? 'Up to date' : 'Added';
  }

  function render() {
    var list = $('pl-list'); list.innerHTML = '';
    if (!state.playlists.length) list.appendChild(el('li', 'soft', 'No playlists yet. Add one and choose the devices that get it.'));
    state.playlists.forEach(function (p) {
      var li = el('li');
      li.appendChild(el('span', null, p.name + (p.removing ? ' (removing)' : '')));
      li.appendChild(el('span', 'soft', p.type === 'm3u' ? 'M3U link' : 'Xtream Codes login'));
      if (!p.removing) {
        var ed = el('button', 'linkish', 'Edit'); ed.type = 'button'; ed.addEventListener('click', function () { openForm(p); }); li.appendChild(ed);
        var rm = el('button', 'linkish', 'Remove'); rm.type = 'button';
        rm.addEventListener('click', function () {
          if (!confirm('Remove "' + p.name + '" from every device it was sent to? Its channels, guide and movies are removed from those devices.')) return;
          post('/api/account/playlists/remove', { id: p.id }).then(load);
        });
        li.appendChild(rm);
      }
      var ul = el('ul', 'targets');
      p.targets.forEach(function (t) {
        ul.appendChild(el('li', 'soft', devName(t.deviceId) + ' · ' + profNames(t.deviceId, t.profiles) + ' · ' + statusText(t)));
      });
      li.appendChild(ul);
      list.appendChild(li);
    });
  }

  function load() {
    return fetch('/api/account/playlists', { credentials: 'same-origin' }).then(function (r) {
      if (r.status === 401) { location.href = '/signin/?next=' + encodeURIComponent('/playlists/'); return; }
      return r.json().then(function (j) { state.devices = j.devices; state.playlists = j.playlists; $('pl-page').hidden = false; render(); });
    });
  }

  function type() { var c = document.querySelector('input[name=pl-type]:checked'); return c ? c.value : 'xtream'; }
  function showType() { $('pl-xtream').hidden = type() !== 'xtream'; $('pl-m3u').hidden = type() !== 'm3u'; }
  document.querySelectorAll('input[name=pl-type]').forEach(function (r) { r.addEventListener('change', showType); });

  function deviceRows(p) {
    var box = $('pl-devices'); box.innerHTML = '';
    if (!state.devices.length) {
      var none = el('p', 'soft'); none.innerHTML = 'No devices are linked yet. <a href="/link/">Add a device</a> first: open Avid Viewer on it and enter the code its welcome screen shows.';
      box.appendChild(none); return;
    }
    state.devices.forEach(function (d) {
      var t = p && p.targets.find(function (x) { return x.deviceId === d.id && x.action !== 'remove'; });
      var wrap = el('div', 'pl-dev'); wrap.dataset.id = d.id;
      var lab = el('label', 'switch-row'); var cb = el('input'); cb.type = 'checkbox'; cb.className = 'dev-on'; cb.checked = !!t;
      lab.appendChild(cb); lab.appendChild(el('span', null, d.name + (d.model ? ' · ' + d.model : '')));
      wrap.appendChild(lab);
      if (!d.pubkey) {
        cb.disabled = true; cb.checked = false;
        wrap.appendChild(el('p', 'soft', 'Update Avid Viewer on this device (1.14.0 or later) and open it once to send it playlists.'));
        box.appendChild(wrap); return;
      }
      var profs = el('div', 'pl-profs'); profs.hidden = !cb.checked;
      var all = el('label', 'switch-row'); var allCb = el('input'); allCb.type = 'checkbox'; allCb.className = 'prof-all'; allCb.checked = !t || !t.profiles;
      all.appendChild(allCb); all.appendChild(el('span', null, 'Every profile' + (d.profiles.length ? '' : ' (this device has one profile)')));
      profs.appendChild(all);
      var each = el('div', 'pl-each'); each.hidden = allCb.checked;
      d.profiles.forEach(function (pr) {
        var l = el('label', 'switch-row'); var c = el('input'); c.type = 'checkbox'; c.className = 'prof'; c.value = pr.id;
        c.checked = !t || !t.profiles || t.profiles.indexOf(pr.id) >= 0;
        l.appendChild(c); l.appendChild(el('span', null, pr.name + (pr.kids ? ' (Kids)' : ''))); each.appendChild(l);
      });
      profs.appendChild(each); wrap.appendChild(profs);
      cb.addEventListener('change', function () { profs.hidden = !cb.checked; });
      allCb.addEventListener('change', function () { each.hidden = allCb.checked; });
      box.appendChild(wrap);
    });
  }

  function openForm(p) {
    state.editing = p || null;
    $('pl-form-title').textContent = p ? 'Edit ' + p.name : 'Add a playlist';
    $('f-keep').hidden = !p;
    ['f-name', 'f-server', 'f-user', 'f-pass', 'f-m3u', 'f-epg'].forEach(function (id) { $(id).value = ''; });
    $('f-name').value = p ? p.name : '';
    document.querySelector('input[name=pl-type][value=' + (p ? p.type : 'xtream') + ']').checked = true;
    showType(); deviceRows(p); say('');
    $('pl-save').textContent = p ? 'Save changes' : 'Send to devices';
    $('pl-form').hidden = false; $('pl-form').scrollIntoView({ behavior: 'smooth', block: 'start' }); $('f-name').focus();
  }
  $('pl-new').addEventListener('click', function () { openForm(null); });
  $('pl-cancel').addEventListener('click', function () { $('pl-form').hidden = true; state.editing = null; });

  $('pl-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var name = $('f-name').value.trim();
    if (!name) { say('Give the playlist a name.', true); $('f-name').focus(); return; }
    var t = type();
    var login = t === 'xtream'
      ? { server: $('f-server').value.trim(), username: $('f-user').value.trim(), password: $('f-pass').value }
      : { m3uUrl: $('f-m3u').value.trim() };
    var epg = $('f-epg').value.trim();
    var entered = t === 'xtream' ? (login.server || login.username || login.password) : login.m3uUrl;
    if (entered || !state.editing) {
      if (t === 'xtream' && !(login.server && login.username && login.password)) { say('Enter the server, username and password.', true); return; }
      if (t === 'm3u' && !/^https?:\/\//i.test(login.m3uUrl)) { say('Enter the M3U link, starting with http:// or https://.', true); return; }
      if (t === 'xtream' && !/^https?:\/\//i.test(login.server)) login.server = 'http://' + login.server;
    }
    var targets = [];
    var rows = document.querySelectorAll('.pl-dev');
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i]; if (!r.querySelector('.dev-on').checked) continue;
      var dev = state.devices.find(function (d) { return d.id === r.dataset.id; });
      var profiles = r.querySelector('.prof-all').checked ? null
        : Array.prototype.map.call(r.querySelectorAll('.prof:checked'), function (c) { return c.value; });
      if (profiles && !profiles.length) { say('Choose at least one profile on ' + dev.name + '.', true); return; }
      var target = { deviceId: dev.id, profiles: profiles };
      if (entered || !state.editing) {
        try { target.payload = await seal(dev.pubkey, Object.assign({ name: name, type: t, epgUrl: epg }, login)); }
        catch (err) { say('This browser couldn\'t lock the login for ' + dev.name + '. Try another browser.', true); return; }
      }
      targets.push(target);
    }
    if (!targets.length) { say('Choose at least one device.', true); return; }
    say('Sending…');
    var d = await post('/api/account/playlists/save', { id: state.editing ? state.editing.id : null, name: name, type: t, targets: targets });
    if (!d._ok) { say(d.error || 'That didn\'t work. Try again.', true); if (d.needLogin) $(t === 'xtream' ? 'f-server' : 'f-m3u').focus(); return; }
    $('f-pass').value = '';
    $('pl-form').hidden = true; state.editing = null;
    await load();
  });

  load();
  setInterval(function () { if ($('pl-form').hidden) load(); }, 15000); // statuses change as devices check in
})(typeof window !== 'undefined' ? window : globalThis);
