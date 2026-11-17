/* avidviewer.app/playlists, /profiles and /devices (1.15.0): the account's playlists go to profiles, profiles hide what
 * they shouldn't see, and profiles go to devices.
 *
 * Logins are typed only when a playlist is added or edited. They're kept in the account locked with a vault key that
 * only a passkey can unlock (WebAuthn PRF), so this page can lock a copy for each new device without asking again;
 * the site can't open either. PINs are hashed here (salt:sha256(salt:pin), as the app checks them); the digits never
 * leave this page. */
(function () {
  'use strict';
  var root = document.getElementById('mg');
  if (!root) return;
  var PAGE = root.dataset.page;
  var $ = function (id) { return document.getElementById(id); };
  var S = null;           // what /api/account/manage returned
  var editing = false;    // an editor is open: don't redraw under it
  var COLORS = ['#1E9BFF', '#E8833A', '#3FB68B', '#9B7BFF', '#F06BA8', '#FFD25E'];
  var INK = ['#02132E', '#2A1405', '#04241A', '#160B3A', '#3A0820', '#2A1E00'];
  var ADULT = /(\bxxx\b|\badults?\b|18\s*\+|\bporn|\berotic|\bplayboy\b|\bhustler\b)/i; // same as the app's Kids.isAdult

  // ------------------------------------------------------------ small helpers
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function add(parent) { for (var i = 1; i < arguments.length; i++) if (arguments[i]) parent.appendChild(arguments[i]); return parent; }
  function btn(text, cls, fn) { var b = el('button', cls || 'btn btn-ghost', text); b.type = 'button'; if (fn) b.addEventListener('click', fn); return b; }
  function check(label, on, fn, disabled) {
    var l = el('label', 'switch-row'); var c = el('input'); c.type = 'checkbox'; c.checked = !!on; c.disabled = !!disabled;
    if (fn) c.addEventListener('change', function () { fn(c.checked); });
    add(l, c, el('span', null, label)); l.input = c; return l;
  }
  function field(label, type, value, attrs) {
    var l = el('label', 'fld', label); var i = el('input'); i.type = type || 'text'; i.value = value || '';
    Object.keys(attrs || {}).forEach(function (k) { i.setAttribute(k, attrs[k]); });
    l.appendChild(i); l.input = i; return l;
  }
  function say(m, err) { var e = $('mg-msg'); e.textContent = m || ''; e.classList.toggle('err', !!err); }
  function post(path, data) {
    return fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })
      .then(function (r) { return r.json().then(function (j) { j._ok = r.ok; return j; }, function () { return { _ok: false, error: 'Something went wrong. Try again.' }; }); });
  }
  function ago(t) {
    if (!t) return 'never seen';
    var m = Math.round((Date.now() - t) / 60000);
    if (m < 2) return 'online now';
    if (m < 60) return 'seen ' + m + ' min ago';
    var h = Math.round(m / 60); if (h < 24) return 'seen ' + h + ' h ago';
    var d = Math.round(h / 24); return d === 1 ? 'seen yesterday' : 'seen ' + d + ' days ago';
  }
  function dur(since) {
    var m = Math.max(1, Math.round((Date.now() - since) / 60000));
    return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0') + ' min';
  }
  function avatar(p, size) {
    var a = el('span', 'mg-av', (p.name || '?').trim().charAt(0).toUpperCase());
    var c = p.kids ? 2 : (p.color || 0) % COLORS.length;
    a.style.background = COLORS[c]; a.style.color = INK[c];
    if (size) { a.style.width = a.style.height = size + 'px'; a.style.fontSize = Math.round(size * 0.48) + 'px'; }
    return a;
  }
  var prof = function (id) { return S.profiles.find(function (p) { return p.id === id; }); };
  var dev = function (id) { return S.devices.find(function (d) { return d.id === id; }); };
  var pl = function (id) { return S.playlists.find(function (p) { return p.id === id; }); };
  function names(list) { return list.length ? list.join(', ') : ''; }
  /** Devices that will have playlist [plId] (any of its profiles is on them), given its profiles [profIds]. */
  function devicesFor(profIds) {
    return S.devices.filter(function (d) { return d.managed && d.profiles.some(function (p) { return profIds.indexOf(p) >= 0; }); });
  }

  // ------------------------------------------------------------ PINs
  function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return b.toString(16).padStart(2, '0'); }).join(''); }
  async function pinHash(pin) {
    var salt = hex(crypto.getRandomValues(new Uint8Array(8)));
    return salt + ':' + hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + ':' + pin)));
  }
  function pinPair(label) {
    var box = el('div', 'row2');
    var a = field(label || 'New PIN', 'password', '', { inputmode: 'numeric', maxlength: '4', autocomplete: 'off', pattern: '[0-9]{4}' });
    var b = field('Again', 'password', '', { inputmode: 'numeric', maxlength: '4', autocomplete: 'off', pattern: '[0-9]{4}' });
    add(box, a, b);
    box.value = function () { return a.input.value; };
    box.problem = function () {
      if (!/^[0-9]{4}$/.test(a.input.value)) return 'A PIN is 4 digits.';
      if (a.input.value !== b.input.value) return "The two PINs don't match.";
      return null;
    };
    box.empty = function () { return !a.input.value && !b.input.value; };
    return box;
  }

  // ------------------------------------------------------------ the logins vault
  var V = null; // the vault key, once unlocked on this page
  var b64 = function (u8) { var s = ''; for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); };
  var unb64 = function (s) { return Uint8Array.from(atob(s), function (c) { return c.charCodeAt(0); }); };
  async function aesKey(raw, use) { return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, use); }
  async function enc(key, bytes) {
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, bytes));
    var out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12); return b64(out);
  }
  async function dec(key, text) {
    var all = unb64(text);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, key, all.slice(12)));
  }
  function VaultError(code) { var e = new Error(code); e.code = code; return e; }
  var VAULT_TEXT = {
    nopasskey: 'Keeping logins in your account needs a passkey. Add one on your Account page (Passkeys), then try again.',
    cancelled: 'The passkey was cancelled, so the login wasn\'t unlocked.',
    noprf: 'This passkey can\'t keep logins locked (your browser or password manager doesn\'t support it yet). Try another browser, or type the login again when you add a device.',
    other: 'Your logins are locked with a different passkey. Choose the passkey you used when you first saved a playlist.',
  };
  /** Unlocks the vault with a passkey (made the first time). */
  async function unlock() {
    if (V) return V;
    if (!window.PublicKeyCredential || !navigator.credentials) throw VaultError('nopasskey');
    var salt = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('avidviewer-vault-prf:v1')));
    var cred;
    try {
      cred = await navigator.credentials.get({ publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: location.hostname, userVerification: 'required', timeout: 120000,
        extensions: { prf: { eval: { first: salt } } },
      } });
    } catch (e) { throw VaultError(e && e.name === 'NotAllowedError' ? 'cancelled' : 'nopasskey'); }
    var res = cred && cred.getClientExtensionResults ? cred.getClientExtensionResults() : {};
    var out = res && res.prf && res.prf.results && res.prf.results.first;
    if (!out) throw VaultError('noprf');
    var hk = await crypto.subtle.importKey('raw', out, 'HKDF', false, ['deriveKey']);
    var kek = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('avidviewer-vault:v1') },
      hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    var row = S.vault.find(function (k) { return k.credentialId === cred.id; });
    if (row) {
      V = await aesKey(await dec(kek, row.wrapped), ['encrypt', 'decrypt']);
    } else if (!S.vault.length) {
      var raw = crypto.getRandomValues(new Uint8Array(32));
      var wrapped = await enc(kek, raw);
      var r = await post('/api/account/vault/key', { credentialId: cred.id, wrapped: wrapped });
      if (!r._ok) throw new Error(r.error || 'The key couldn\'t be saved.');
      S.vault.push({ credentialId: cred.id, wrapped: wrapped });
      V = await aesKey(raw, ['encrypt', 'decrypt']);
    } else throw VaultError('other');
    return V;
  }
  async function lockLogin(login) { return enc(await unlock(), new TextEncoder().encode(JSON.stringify(login))); }
  async function openLogin(text) { return JSON.parse(new TextDecoder().decode(await dec(await unlock(), text))); }
  var seal = function (pub, obj) { return window.AvidPlaylists.seal(pub, obj); };

  // The account's own key pair (1.15.1): devices lock their logins for its public key; its private key is kept only
  // wrapped with the vault key, so a passkey is needed to open what devices send.
  var AK = null;
  async function accountPrivate() {
    if (AK) return AK;
    var v = await unlock();
    if (S.accountKey) {
      AK = await crypto.subtle.importKey('pkcs8', await dec(v, S.accountKey.wrapped), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
      return AK;
    }
    var kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    var pub = b64(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)));
    var r = await post('/api/account/vault/account-key', { pubkey: pub, wrapped: await enc(v, new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey))) });
    if (!r._ok) throw new Error(r.error || 'The key couldn\'t be saved.');
    S.accountKey = r.accountKey;
    if (r.accountKey.pubkey !== pub) return accountPrivate(); // made at the same moment in another tab: use that one
    AK = kp.privateKey;
    return AK;
  }
  /** Opens a login a device locked for the account key. */
  async function openSealed(env) {
    var priv = await accountPrivate();
    var epk = unb64(env.epk);
    var pub = await crypto.subtle.importKey('raw', epk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    var z = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256);
    var hk = await crypto.subtle.importKey('raw', z, 'HKDF', false, ['deriveKey']);
    var key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: epk, info: new TextEncoder().encode('avidviewer-account:v1') },
      hk, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(env.iv) }, key, unb64(env.ct))));
  }
  async function deviceLogins() {
    return (await fetch('/api/account/device-logins', { credentials: 'same-origin' }).then(function (x) { return x.json(); })).items || [];
  }
  /** A device's login for an account playlist the account has no login for; or for a playlist added on that device. */
  function deviceHas(p) { return S.devicePlaylists.filter(function (x) { return x.remoteId === p.id && x.hasLogin; }); }
  /** Keeps, in the account, the logins devices sent for account playlists that had none. Returns how many. */
  async function importFromDevices() {
    var missing = S.playlists.filter(function (p) { return !p.kept && !p.removing && deviceHas(p).length; });
    if (!missing.length) return 0;
    var items = await deviceLogins();
    var out = [];
    for (var i = 0; i < missing.length; i++) {
      var p = missing[i];
      var it = items.find(function (x) { return x.remoteId === p.id; });
      if (!it) continue;
      try { out.push({ id: p.id, vault: await lockLogin(Object.assign(await openSealed(it.sealed), { name: p.name })) }); } catch (e) { if (e.code) throw e; }
    }
    if (out.length) {
      var r = await post('/api/account/playlists/import', { items: out });
      if (r._ok) S.pending = r.pending || S.pending;
      out.forEach(function (o) { var q = pl(o.id); if (q) q.kept = true; });
    }
    return out.length;
  }
  /** Everything a passkey unlock can do now: keep logins from devices, then send logins to devices waiting for one. */
  async function syncLogins() {
    await accountPrivate();
    var kept = await importFromDevices();
    var left = await sendPending();
    return { kept: kept, left: left };
  }
  /** Plain words for what a device reported when it couldn't add a playlist. */
  function friendly(err) {
    if (!err) return 'the device refused it';
    if (/handshake|ssl|certificate|tls/i.test(err)) return 'the device couldn\'t make a secure connection to the server. Check the server address (http:// or https://, as your provider gave it) and edit the playlist if it\'s wrong';
    return err;
  }

  /** Locks the saved logins for every device waiting for one; returns what's left to do by hand. */
  async function sendPending() {
    var left = [];
    var items = [];
    var vaults = {};
    for (var i = 0; i < S.pending.length; i++) {
      var p = S.pending[i];
      if (!p.kept) { left.push(p); continue; }
      if (!(p.playlistId in vaults)) {
        var r = await fetch('/api/account/playlists/vault?id=' + encodeURIComponent(p.playlistId), { credentials: 'same-origin' }).then(function (x) { return x.json(); });
        vaults[p.playlistId] = r.vault ? await openLogin(r.vault) : null;
      }
      var login = vaults[p.playlistId];
      if (!login) { left.push(p); continue; }
      items.push({ playlistId: p.playlistId, deviceId: p.deviceId, payload: await seal(p.pubkey, login) });
    }
    if (items.length) await post('/api/account/playlists/seal', { items: items });
    return left;
  }

  function renderPending() {
    var box = $('mg-pending'); box.innerHTML = '';
    var b = el('section', 'mg-banner');
    var importable = S.playlists.filter(function (p) { return !p.kept && !p.removing && deviceHas(p).length; });
    var kept = S.pending.filter(function (p) { return p.kept; });
    var typed = S.pending.filter(function (p) { return !p.kept && !importable.some(function (q) { return q.id === p.playlistId; }); });
    function unlockBtn(label) {
      var go = btn(label, 'btn btn-primary', async function () {
        go.disabled = true; say('Unlocking…');
        try {
          var r = await syncLogins();
          say(r.kept ? 'Kept ' + r.kept + (r.kept === 1 ? ' login' : ' logins') + ' in your account' + (S.pending.length ? ' and sent the logins devices were waiting for.' : '.')
            : 'Done. Devices pick up changes within a minute while Avid Viewer is open.');
          await load();
        } catch (e) { say(VAULT_TEXT[e.code] || e.message, true); go.disabled = false; }
      });
      return go;
    }
    if (!S.vault.length || !S.accountKey) {
      add(b, el('h3', null, 'Keep your logins in your account'),
        el('p', null, 'Set this up once with your passkey. Then your devices send the logins they have (locked so only your browser can open them), new devices get logins without typing, and Edit can show a saved login. The website itself can never read them.'),
        unlockBtn(S.vault.length ? 'Unlock with passkey' : 'Set up with passkey'));
    } else if (importable.length || kept.length) {
      var lines = [];
      if (importable.length) lines.push('Logins for ' + names(importable.map(function (p) { return p.name; })) + ' are ready from ' +
        names(Array.from(new Set(importable.map(function (p) { return (dev(deviceHas(p)[0].deviceId) || {}).name; })))) + '.');
      if (kept.length) lines.push('Waiting for a login: ' + kept.map(function (p) { return p.playlist + ' on ' + p.device; }).join(', ') + '.');
      add(b, el('p', null, lines.join(' ') + ' Unlock with your passkey to keep them in your account and send them.'), unlockBtn('Unlock with passkey'));
    }
    if (typed.length) {
      var uniq = {};
      typed.forEach(function (p) { (uniq[p.playlistId] = uniq[p.playlistId] || { name: p.playlist, devs: [] }).devs.push(p.device); });
      Object.keys(uniq).forEach(function (id) {
        var row = el('p', null, 'No device has sent a login for ' + uniq[id].name + ' yet, so ' + names(uniq[id].devs) +
          ' is waiting. Open Avid Viewer on a device that has it, or type it once: ');
        var a = el('a', null, 'Edit ' + uniq[id].name); a.href = '/playlists/#edit=' + id;
        add(b, add(row, a));
      });
    }
    if (b.childNodes.length) box.appendChild(b);
  }

  // ------------------------------------------------------------ loading
  async function load() {
    var r = await fetch('/api/account/manage', { credentials: 'same-origin' });
    if (r.status === 401) { location.href = '/signin/?next=' + encodeURIComponent(location.pathname); return; }
    S = await r.json();
    $('mg-loading').hidden = true; $('mg-body').hidden = false;
    renderPending();
    if (!editing) route();
  }
  function route() {
    var h = location.hash.replace(/^#/, '');
    var m = /^(edit|manage|new)(?:=(.*))?$/.exec(h);
    editing = false;
    if (PAGE === 'playlists') { if (m && m[1] === 'edit') return playlistEditor(pl(m[2]) || null); if (m && m[1] === 'new') return playlistEditor(null); return playlistsPage(); }
    if (PAGE === 'profiles') { if (m && m[1] === 'manage' && prof(m[2])) return profileManager(prof(m[2])); if (m && m[1] === 'new') return newProfile(); return profilesPage(); }
    if (PAGE === 'devices') return devicesPage();
  }
  window.addEventListener('hashchange', function () { say(''); route(); });
  function go(hash) { if ((location.hash || '#') === hash) route(); else location.hash = hash; }
  function body(title, intro) {
    var b = $('mg-body'); b.innerHTML = '';
    var head = el('header', 'page-head'); add(head, el('h1', null, title));
    if (intro) add(head, el('p', null, intro));
    b.appendChild(head); return b;
  }
  function back(text, hash) { var a = el('a', 'mg-back', '‹ ' + text); a.href = hash || '#'; return a; }

  // ------------------------------------------------------------ Watching now
  function watchingNow() {
    var on = S.devices.filter(function (d) { return d.playing; });
    if (!on.length) return null;
    var s = el('section', 'mg-card');
    add(s, el('h2', null, 'Watching now · ' + on.length + (on.length === 1 ? ' stream' : ' streams')));
    add(s, el('p', 'fineprint', 'Updates every 30 seconds. Providers often allow only one or two streams at once.'));
    var ul = el('ul', 'rows');
    on.forEach(function (d) { ul.appendChild(playingRow(d, true)); });
    add(s, ul, el('p', 'fineprint', 'What\'s being watched is never shown or sent: only the playlist, device, profile and time. Stop stream ends playback on that device within a few seconds; it can start again.'));
    return s;
  }
  function playingRow(d, withDevice) {
    var li = el('li', 'mg-playing');
    var p = d.playing;
    add(li, el('span', null, p.playlist), el('span', 'soft', (withDevice ? d.name + ' · ' : '') + (p.profile || 'no profile') + ' · playing for ' + dur(p.since)));
    if (p.stopping) li.appendChild(el('span', 'soft', 'Stopping…'));
    else li.appendChild(btn('Stop stream', 'btn btn-ghost btn-sm', async function () {
      var r = await post('/api/account/devices/stop', { deviceId: d.id });
      say(r._ok ? 'Stopping the stream on ' + d.name + '…' : r.error, !r._ok); load();
    }));
    return li;
  }

  // ------------------------------------------------------------ Playlists
  function targetText(t) {
    if (t.status === 'needs_login') return 'waiting for the login';
    if (t.status === 'needs_update') return 'needs Avid Viewer 1.15.0';
    if (t.status === 'failed') return 'couldn\'t add it: ' + friendly(t.error);
    if (t.status === 'waiting') return t.action === 'remove' ? 'still has it: removes it at its next check-in (Avid Viewer open)' : 'waiting for the device to open';
    return 'up to date';
  }
  function playlistsPage() {
    var b = body('Playlists', 'Every playlist in your account. Give each one to the profiles that should have it; profiles then go to your devices.');
    add(b, btn('＋ Add a playlist', 'btn btn-primary', function () { go('#new'); }));
    add(b, watchingNow());
    var t = el('table', 'mg-table');
    t.innerHTML = '<thead><tr><th>Playlist</th><th>Type</th><th>Profiles</th><th>On devices</th><th>In use</th><th></th></tr></thead>';
    var tb = el('tbody');
    var shown = S.playlists;
    if (!shown.length) { var r0 = el('tr'); var c0 = el('td', 'soft', 'No playlists yet. Add one, then give it to profiles.'); c0.colSpan = 6; tb.appendChild(add(r0, c0)); }
    shown.forEach(function (p) {
      var tr = el('tr');
      var n = el('td'); add(n, el('strong', null, p.name), p.removing ? el('span', 'mg-chip mg-removing', 'Removing') : null,
        el('div', 'soft', p.removing ? 'Removed from your account. It leaves this list once every device below confirms it\'s gone.' : catalogText(p)));
      var chips = el('td');
      if (!p.profiles.length) chips.appendChild(el('span', 'soft', 'Not given to a profile yet'));
      p.profiles.forEach(function (id) { var q = prof(id); if (q) chips.appendChild(el('span', 'mg-chip' + (q.kids ? ' kids' : ''), q.name)); });
      var live = p.removing ? p.targets : p.targets.filter(function (x) { return x.action !== 'remove'; });
      var wait = live.filter(function (x) { return x.status !== 'done'; });
      var dv = el('td', null, live.length ? live.length + (live.length === 1 ? ' device' : ' devices') : '—');
      live.forEach(function (x) { dv.appendChild(el('div', 'soft', (dev(x.deviceId) || {}).name + ': ' + targetText(x))); });
      var streams = S.devices.filter(function (d) { return d.playing && d.playing.playlistId === p.id; }).length;
      var edit = el('td', 'mg-acts');
      if (!p.removing) add(edit, btn('Edit', 'linkish', function () { go('#edit=' + p.id); }), btn('Remove', 'linkish mg-danger', function () { removePlaylist(p); }));
      add(tr, n, el('td', null, p.type === 'm3u' ? 'M3U link' : 'Xtream Codes'), chips, dv, el('td', null, streams ? streams + (streams === 1 ? ' stream' : ' streams') : 'No'), edit);
      tb.appendChild(tr);
    });
    add(b, add(t, tb));
    add(b, tvPlaylists());
    add(b, el('p', 'fineprint', 'On devices counts the devices that have at least one profile with the playlist. Logins are never shown after they\'re saved: they\'re locked so only your passkey and your devices can open them. Avid Viewer is a media player and doesn\'t provide any content; add only playlists you have the rights to.'));
  }

  function catalogText(p) {
    var c = p.catalog;
    if (c && !c.none) {
      var t = 'Live TV: ' + c.live + ' categories, ' + Number(c.channels).toLocaleString() + ' channels · Movies: ' + c.movie + ' · Series: ' + c.series +
        ' categories (from ' + c.device + ', ' + new Date(c.updated_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ')';
      if (!c.movie && !c.series) t += '. No movies or series: the playlist has none, or no device has opened Movies or Series with it yet.';
      return t;
    }
    var failed = p.targets.find(function (x) { return x.status === 'failed'; });
    if (failed) return 'No categories yet: ' + (dev(failed.deviceId) || {}).name + ' couldn\'t add it (' + friendly(failed.error) + ').';
    var on = p.targets.find(function (x) { return x.status === 'done' && x.action !== 'remove'; });
    if (on) return 'No categories yet: they arrive within a minute of opening Avid Viewer on ' + (dev(on.deviceId) || {}).name + '.';
    return 'No categories yet: no device has this playlist yet.';
  }
  async function removePlaylist(p) {
    if (!confirm('Remove "' + p.name + '" from your account? It comes off every profile, and every device removes it at its next check-in. A copy added on a TV by hand stays there.')) return;
    var r = await post('/api/account/playlists/remove', { id: p.id });
    say(r._ok ? 'Removed ' + p.name + '. Devices remove it within a minute while Avid Viewer is open.' : r.error, !r._ok);
    go('#'); load();
  }

  /** Playlists typed in on a TV (1.15.1): listed with their device, and "Add to account" without retyping. */
  function tvPlaylists() {
    var mine = S.devicePlaylists.filter(function (x) { return !x.remoteId && dev(x.deviceId); });
    var old = S.devices.filter(function (d) { return !d.managed; });
    if (!mine.length && !old.length) return null;
    var s = el('section', 'mg-card');
    add(s, el('h2', null, 'Added on your devices'), el('p', 'fineprint', 'Playlists typed in with the remote. Add one to your account to give it to profiles and other devices; the device keeps its copy and everything in it.'));
    var ul = el('ul', 'rows');
    mine.forEach(function (x) {
      var d = dev(x.deviceId);
      var li = el('li');
      add(li, el('span', null, x.name), el('span', 'soft', (x.type === 'm3u' ? 'M3U link' : 'Xtream Codes') + ' · on ' + d.name + (x.enabled ? '' : ' · switched off')));
      var why = !d.profiles.length ? 'Choose this device\'s profiles first (Devices page)'
        : !S.accountKey ? 'Set up locked logins (above) first'
        : !x.hasLogin ? 'Waiting for ' + d.name + ' to send its login (open Avid Viewer on it)' : null;
      if (why) li.appendChild(el('span', 'soft', why));
      else li.appendChild(btn('Add to account', 'btn btn-ghost btn-sm', async function (e) {
        var b0 = e.target; b0.disabled = true; say('Unlocking…');
        try {
          var it = (await deviceLogins()).find(function (y) { return y.deviceId === x.deviceId && y.localId === x.localId; });
          if (!it) throw new Error('The device hasn\'t sent this login yet. Open Avid Viewer on it and try again in a minute.');
          var login = Object.assign(await openSealed(it.sealed), { name: x.name });
          var r = await post('/api/account/playlists/adopt', { deviceId: x.deviceId, localId: x.localId, name: x.name, vault: await lockLogin(login) });
          if (!r._ok) throw new Error(r.error);
          S.pending = r.pending || [];
          await sendPending();
          say(x.name + ' is in your account now, for the profiles on ' + d.name + '. Other devices with those profiles get it within a minute.');
          await load();
        } catch (err) { b0.disabled = false; say(VAULT_TEXT[err.code] || err.message, true); }
      }));
      ul.appendChild(li);
    });
    old.forEach(function (d) { ul.appendChild(add(el('li'), el('span', null, d.name), el('span', 'soft', (d.appVersion ? 'On Avid Viewer ' + d.appVersion + ': u' : 'U') + 'pdate it to 1.15.1 to see its playlists here'))); });
    return add(s, ul);
  }

  function playlistEditor(p) {
    editing = true;
    var b = body(p ? p.name : 'Add a playlist');
    b.insertBefore(back('Playlists', '#'), b.firstChild);
    var f = el('form', 'mg-card'); f.noValidate = true;
    var type = p ? p.type : 'xtream';
    var seg = el('fieldset', 'seg small'); seg.setAttribute('aria-label', 'Type');
    [['xtream', 'Xtream Codes login'], ['m3u', 'M3U link']].forEach(function (x) {
      var l = el('label'); var r = el('input'); r.type = 'radio'; r.name = 'pl-type'; r.value = x[0]; r.checked = x[0] === type;
      r.addEventListener('change', function () { type = x[0]; showType(); }); add(seg, add(l, r, document.createTextNode(' ' + x[1])));
    });
    var name = field('Name', 'text', p ? p.name : '', { maxlength: '60', placeholder: 'My provider' });
    var keep = el('p', 'soft', p ? (p.kept ? 'The saved login isn\'t shown. Leave these empty to keep it; type it again only to change it.'
      : 'This playlist was saved before logins were kept in your account. Type its login once more so new devices can get it.') : '');
    var server = field('Server', 'url', '', { placeholder: 'http://server.example:8080', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    var user = field('Username', 'text', '', { autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    var pass = field('Password', 'password', '', { autocomplete: 'off' });
    var xt = add(el('div'), server, add(el('div', 'row2'), user, pass));
    var m3u = field('M3U link', 'url', '', { placeholder: 'https://…/playlist.m3u', autocomplete: 'off', spellcheck: 'false' });
    var epg = field('Guide (XMLTV) link, optional', 'url', '', { placeholder: p ? 'Leave empty to keep the current one' : 'https://…/guide.xml.gz', autocomplete: 'off', spellcheck: 'false' });
    function showType() { xt.hidden = type !== 'xtream'; m3u.hidden = type !== 'm3u'; }
    function fill(l) {
      if (l.type === 'm3u' || l.type === 'xtream') { type = l.type; seg.querySelectorAll('input').forEach(function (r) { r.checked = r.value === type; }); showType(); }
      server.input.value = l.server || ''; user.input.value = l.username || ''; pass.input.value = l.password || '';
      m3u.input.value = l.m3uUrl || ''; epg.input.value = l.epgUrl || '';
      keep.textContent = 'The saved login is shown. Change it and Save, or Cancel to leave it as it is.';
    }
    var show = null;
    if (p && p.kept) show = btn('Show the saved login', 'btn btn-ghost btn-sm', async function () {
      show.disabled = true;
      try { var r0 = await fetch('/api/account/playlists/vault?id=' + encodeURIComponent(p.id), { credentials: 'same-origin' }).then(function (x) { return x.json(); });
        fill(await openLogin(r0.vault)); show.hidden = true; say(''); }
      catch (e) { show.disabled = false; say(VAULT_TEXT[e.code] || e.message, true); }
    });
    else if (p && deviceHas(p).length && S.accountKey) {
      var from = dev(deviceHas(p)[0].deviceId) || {};
      show = btn('Fill in from ' + from.name, 'btn btn-ghost btn-sm', async function () {
        show.disabled = true;
        try { var it = (await deviceLogins()).find(function (y) { return y.remoteId === p.id; }); fill(await openSealed(it.sealed)); show.hidden = true; say(''); }
        catch (e) { show.disabled = false; say(VAULT_TEXT[e.code] || e.message, true); }
      });
    }
    add(f, seg, name, p ? keep : null, show, xt, m3u, epg);
    showType();
    add(f, el('h3', null, 'Give it to profiles'));
    var chosen = p ? p.profiles.slice() : [];
    if (!S.profiles.length) {
      var np = el('p', 'soft', 'Your account has no profiles yet. '); var a = el('a', null, 'Add a profile'); a.href = '/profiles/#new'; add(f, add(np, a));
    }
    S.profiles.forEach(function (q) {
      var on = S.devices.filter(function (d) { return d.profiles.indexOf(q.id) >= 0; }).map(function (d) { return d.name; });
      var row = el('div', 'mg-prow');
      add(row, avatar(q, 28), check(q.name + (q.kids ? ' · Kids profile' : ''), chosen.indexOf(q.id) >= 0, function (v) {
        if (v) chosen.push(q.id); else chosen = chosen.filter(function (x) { return x !== q.id; });
      }), el('span', 'soft', on.length ? 'On ' + names(on) : 'Not on a device yet'));
      f.appendChild(row);
    });
    add(f, el('p', 'fineprint', 'Each profile can hide this playlist\'s categories and channels on its own page.'));
    var btns = el('div', 'row-btns');
    var save = el('button', 'btn btn-primary', p ? 'Save' : 'Add playlist'); save.type = 'submit';
    add(btns, save, btn('Cancel', 'btn btn-ghost', function () { go('#'); }));
    if (p) btns.appendChild(btn('Remove from account', 'btn btn-danger', function () { removePlaylist(p); }));
    add(f, btns);
    if (p && p.targets.length) {
      add(f, el('h3', null, 'Where it is now'));
      var ul = el('ul', 'rows');
      p.targets.forEach(function (t) {
        var d = dev(t.deviceId); if (!d) return;
        var who = (t.profiles || []).map(function (id) { return (prof(id) || {}).name; }).filter(Boolean);
        var playing = d.playing && d.playing.playlistId === p.id ? 'Playing for ' + dur(d.playing.since) : 'Not playing';
        ul.appendChild(add(el('li'), el('span', null, d.name + (who.length ? ' · ' + names(who) : '')), el('span', 'soft', targetText(t) + ' · ' + playing)));
      });
      add(f, ul);
    }
    b.appendChild(f);

    f.addEventListener('submit', async function (e) {
      e.preventDefault();
      var n = name.input.value.trim();
      if (!n) { say('Give the playlist a name.', true); return name.input.focus(); }
      var login = type === 'xtream'
        ? { server: server.input.value.trim(), username: user.input.value.trim(), password: pass.input.value }
        : { m3uUrl: m3u.input.value.trim() };
      var typed = type === 'xtream' ? (login.server || login.username || login.password) : login.m3uUrl;
      if (!p || typed || type !== p.type) {
        if (type === 'xtream' && !(login.server && login.username && login.password)) return say('Enter the server, username and password.', true);
        if (type === 'm3u' && !/^https?:\/\//i.test(login.m3uUrl)) return say('Enter the M3U link, starting with http:// or https://.', true);
        if (type === 'xtream' && !/^https?:\/\//i.test(login.server)) login.server = 'http://' + login.server;
        typed = true;
      }
      var guide = epg.input.value.trim();
      save.disabled = true; say('Saving…');
      var data = { id: p ? p.id : null, name: n, type: type, profiles: chosen, seals: [] };
      var warn = '';
      try {
        var full = null;
        if (typed) full = Object.assign({ name: n, type: type, epgUrl: guide }, login);
        else if (guide && p.kept) {
          // A new guide link with the saved login: unlock it, change the link, lock it again.
          var r0 = await fetch('/api/account/playlists/vault?id=' + encodeURIComponent(p.id), { credentials: 'same-origin' }).then(function (x) { return x.json(); });
          full = Object.assign(await openLogin(r0.vault), { name: n, epgUrl: guide });
        } else if (guide) { save.disabled = false; return say('Type the login again to change the guide link.', true); }
        if (full) {
          try { data.vault = await lockLogin(full); }
          catch (err) { warn = (VAULT_TEXT[err.code] || err.message) + ' The login was sent to the devices that have this playlist now, but not kept for new ones.'; }
          data.loginChanged = true;
          // Every device that will have it, and older devices it was sent to directly.
          var targets = devicesFor(chosen);
          (p ? p.targets : []).forEach(function (t) { var d = dev(t.deviceId); if (d && t.action !== 'remove' && targets.indexOf(d) < 0) targets.push(d); });
          targets = targets.filter(function (d) { return d.pubkey; });
          for (var i = 0; i < targets.length; i++) data.seals.push({ deviceId: targets[i].id, payload: await seal(targets[i].pubkey, full) });
        }
      } catch (err) { save.disabled = false; return say(VAULT_TEXT[err.code] || err.message || 'That didn\'t work.', true); }
      var res = await post('/api/account/playlists/save', data);
      if (!res._ok) { save.disabled = false; return say(res.error || 'That didn\'t work. Try again.', true); }
      pass.input.value = '';
      S.pending = res.pending || [];
      // Devices that newly get this playlist need its saved login: lock it for them now (the passkey is already unlocked when a login was typed).
      if (S.pending.some(function (x) { return x.playlistId === res.id && x.kept; })) {
        try { await sendPending(); } catch (err) { warn = warn || (VAULT_TEXT[err.code] || err.message); }
      }
      say(warn || 'Saved. Devices pick up changes within a minute while Avid Viewer is open.', !!warn);
      location.hash = '#'; await load();
    });
    name.input.focus();
  }

  // ------------------------------------------------------------ Profiles
  function roleText(q) {
    if (q.kids) return 'Kids profile · no PIN';
    return (q.parent ? 'Parent · ' : '') + (q.hasPin ? 'PIN on' : 'no PIN');
  }
  function hiddenText(q) {
    var cats = 0, chans = 0, kids = 0;
    Object.keys(q.visibility).forEach(function (k) {
      var v = q.visibility[k];
      ['live', 'movie', 'series'].forEach(function (t) { cats += v.hidden[t].length; kids += v.allowed[t].length; });
      chans += v.channels.length;
    });
    if (q.kids) return 'Everything except ' + kids + (kids === 1 ? ' category' : ' categories') + (chans ? ', and ' + chans + ' channels' : '');
    if (!cats && !chans) return 'Nothing hidden';
    return cats + (cats === 1 ? ' category' : ' categories') + ', ' + chans + (chans === 1 ? ' channel' : ' channels');
  }
  function profilesPage() {
    var b = body('Profiles', 'A profile is a person (or the kids). It gets playlists, hides what it shouldn\'t see, and appears on the devices you choose.');
    add(b, btn('＋ Add a profile', 'btn btn-primary', function () { go('#new'); }));
    var need = S.profiles.some(function (q) { return q.kids; }) && S.profiles.filter(function (q) { return !q.kids && !q.hasPin; });
    if (need && need.length) add(b, add(el('section', 'mg-banner'), el('p', null, 'While a Kids profile exists, every other profile needs a PIN. Set one for ' + names(need.map(function (q) { return q.name; })) + ' (Manage › PIN).')));
    if (!S.profiles.length) add(b, el('p', 'soft', 'No profiles yet. Devices with one profile, or none, show no profiles at all.'));
    var grid = el('div', 'mg-grid');
    S.profiles.forEach(function (q) {
      var c = el('section', 'mg-card mg-prof');
      var head = add(el('div', 'mg-prof-head'), avatar(q, 48), add(el('div'), el('h3', null, q.name), el('p', 'soft', roleText(q))));
      var pls = q.playlists.map(function (id) { return (pl(id) || {}).name; }).filter(Boolean);
      var dl = el('dl', 'mg-dl');
      [['Playlists', pls.length ? names(pls) : 'None yet'], ['Devices', q.devices.length ? q.devices.length + (q.devices.length === 1 ? ' device' : ' devices') : 'None yet'],
        ['Hidden', hiddenText(q)]].forEach(function (x) { add(dl, el('dt', null, x[0]), el('dd', null, x[1])); });
      add(c, head, dl, btn('Manage', 'btn btn-ghost', function () { go('#manage=' + q.id); }));
      grid.appendChild(c);
    });
    add(b, grid);
  }

  function colorPicker(value, fn) {
    var box = el('div', 'mg-colors'); box.setAttribute('role', 'radiogroup'); box.setAttribute('aria-label', 'Colour');
    COLORS.forEach(function (c, i) {
      var s = el('button', 'mg-swatch'); s.type = 'button'; s.style.background = c; s.setAttribute('aria-label', 'Colour ' + (i + 1));
      s.setAttribute('aria-checked', String(i === value)); s.setAttribute('role', 'radio');
      s.addEventListener('click', function () { value = i; box.querySelectorAll('.mg-swatch').forEach(function (x, j) { x.setAttribute('aria-checked', String(j === i)); }); fn(i); });
      box.appendChild(s);
    });
    return box;
  }

  function newProfile() {
    editing = true;
    var b = body('New profile');
    b.insertBefore(back('Profiles', '#'), b.firstChild);
    var f = el('form', 'mg-card'); f.noValidate = true;
    var color = S.profiles.length % COLORS.length;
    var name = field('Name', 'text', '', { maxlength: '40' });
    var kids = check('Kids profile (only the categories you allow; adult categories never). Next, you\'ll set a PIN for each grown-up profile that doesn\'t have one.', false, function () { show(); });
    var parent = check('Parent (its PIN unlocks any profile on the TV)', false);
    var pin = pinPair('PIN (4 digits)');
    var pinNote = el('p', 'fineprint', '');
    var sv = el('button', 'btn btn-primary', 'Create'); sv.type = 'submit';
    function show() {
      var k = kids.input.checked;
      parent.hidden = k; pin.hidden = k;
      var kidsExist = S.profiles.some(function (q) { return q.kids; });
      pinNote.textContent = k ? '' : kidsExist ? 'A PIN is required: your account has a Kids profile.' : 'A PIN is optional. It\'s required for every grown-up profile while a Kids profile exists.';
      sv.textContent = k ? 'Next: PINs for grown-ups' : 'Create, then choose playlists';
    }
    add(f, name, add(el('label', 'fld', 'Colour'), colorPicker(color, function (i) { color = i; })), kids, parent, pin, pinNote,
      add(el('div', 'row-btns'), sv, btn('Cancel', 'btn btn-ghost', function () { go('#'); })));
    b.appendChild(f); show(); name.input.focus();
    f.addEventListener('submit', async function (e) {
      e.preventDefault();
      var n = name.input.value.trim(); if (!n) return say('Give the profile a name.', true);
      if (kids.input.checked) return kidsPins({ name: n, color: color });
      var data = { name: n, kids: false, parent: parent.input.checked, color: color, playlists: [], devices: [] };
      var kidsExist = S.profiles.some(function (q) { return q.kids; });
      if (!pin.empty() || kidsExist) { var pr = pin.problem(); if (pr) return say(pr, true); data.pin = await pinHash(pin.value()); }
      var r = await post('/api/account/profiles/save', data);
      if (!r._ok) return say(r.error, true);
      say(''); await load(); go('#manage=' + r.id);
    });
  }

  /** Step 2 of a new Kids profile (artboard 4b): every grown-up profile gets a PIN first. */
  function kidsPins(kid) {
    var b = body('Lock the grown-up profiles first', 'While a Kids profile exists, every other profile needs a 4-digit PIN, so a child can\'t switch to it on the TV. Set one for each profile below; they go to your devices with the new profile.');
    b.insertBefore(back('Profiles', '#'), b.firstChild);
    var f = el('form', 'mg-card'); f.noValidate = true;
    add(f, el('p', 'fineprint', 'NEW KIDS PROFILE · STEP 2 OF 2 · ' + kid.name));
    var grown = S.profiles.filter(function (q) { return !q.kids; });
    var pairs = {};
    if (!grown.length) add(f, el('p', 'soft', 'There are no grown-up profiles yet, so there\'s nothing to lock. Add one for yourself (with a PIN) so you can leave the Kids profile on the TV.'));
    grown.forEach(function (q) {
      var row = add(el('div', 'mg-prow'), avatar(q, 32), el('strong', null, q.name), el('span', 'soft', (q.parent ? 'Parent · ' : '') + (q.hasPin ? 'PIN set ✓' : 'no PIN yet')));
      f.appendChild(row);
      if (!q.hasPin) { pairs[q.id] = pinPair(); f.appendChild(pairs[q.id]); }
    });
    var sv = el('button', 'btn btn-primary', 'Create ' + kid.name + ' and send PINs to devices'); sv.type = 'submit';
    add(f, add(el('div', 'row-btns'), sv, btn('Cancel', 'btn btn-ghost', function () { go('#'); })),
      el('p', 'fineprint', 'PINs are saved only as a salted one-way hash, never as digits, and devices get the same hash within a minute. A parent\'s PIN also unlocks any profile on the TV. Forgot one? Change it here any time.'));
    b.appendChild(f);
    f.addEventListener('submit', async function (e) {
      e.preventDefault();
      var pins = {};
      for (var id in pairs) { var pr = pairs[id].problem(); if (pr) return say((prof(id) || {}).name + ': ' + pr, true); pins[id] = await pinHash(pairs[id].value()); }
      var r = await post('/api/account/profiles/save', { name: kid.name, kids: true, color: kid.color, pins: pins, playlists: [], devices: [] });
      if (!r._ok) return say(r.error, true);
      say(''); await load(); go('#manage=' + r.id);
    });
  }

  function profileManager(q) {
    editing = true;
    var b = body(q.name);
    b.insertBefore(back('Profiles', '#'), b.firstChild);
    var on = q.devices.map(function (id) { return (dev(id) || {}).name; }).filter(Boolean);
    b.querySelector('.page-head').appendChild(el('p', 'soft', roleText(q) + (on.length ? ' · on ' + names(on) : ' · not on a device yet')));

    // Name, PIN and colour; playlists; devices.
    var f = el('form', 'mg-card'); f.noValidate = true;
    var color = q.color, plays = q.playlists.slice(), devs = q.devices.slice();
    var name = field('Name', 'text', q.name, { maxlength: '40' });
    var parent = check('Parent (its PIN unlocks any profile on the TV)', q.parent); parent.hidden = q.kids;
    add(f, el('h2', null, 'Name, PIN and colour'), name, add(el('label', 'fld', 'Colour'), colorPicker(color, function (i) { color = i; })), parent);
    var pin = pinPair(q.hasPin ? 'Change PIN' : 'PIN (4 digits)'); pin.hidden = q.kids;
    if (!q.kids) add(f, pin, el('p', 'fineprint', q.hasPin ? 'Leave empty to keep the current PIN. You don\'t need the old one while you\'re signed in.' : 'Optional unless your account has a Kids profile.'));
    add(f, el('h2', null, 'Playlists'));
    if (!S.playlists.length) { var x = el('p', 'soft', 'No playlists in your account yet. '); var a = el('a', null, 'Add a playlist'); a.href = '/playlists/#new'; add(f, add(x, a)); }
    S.playlists.filter(function (p) { return !p.removing; }).forEach(function (p) {
      f.appendChild(check(p.name, plays.indexOf(p.id) >= 0, function (v) { plays = v ? plays.concat(p.id) : plays.filter(function (i) { return i !== p.id; }); }));
    });
    add(f, el('h2', null, 'On devices'));
    if (!S.devices.length) { var y = el('p', 'soft', 'No devices linked yet. '); var a2 = el('a', null, 'Add a device'); a2.href = '/link/'; add(f, add(y, a2)); }
    S.devices.forEach(function (d) {
      var c = check(d.name + (d.managed ? '' : ' (update Avid Viewer on it to 1.15.0 first)'), devs.indexOf(d.id) >= 0,
        function (v) { devs = v ? devs.concat(d.id) : devs.filter(function (i) { return i !== d.id; }); }, !d.managed);
      f.appendChild(c);
    });
    add(f, el('p', 'fineprint', 'The same choice as on the Devices page, seen from this profile.'));
    var sv = el('button', 'btn btn-primary', 'Save'); sv.type = 'submit';
    add(f, add(el('div', 'row-btns'), sv, btn('Remove profile', 'btn btn-danger', async function () {
      if (!confirm('Remove ' + q.name + '? It comes off every device it\'s on. Its favorites and history stay on each device in case you add it back.')) return;
      var r = await post('/api/account/profiles/remove', { id: q.id }); if (!r._ok) return say(r.error, true);
      S.pending = r.pending || []; go('#'); load();
    })));
    b.appendChild(f);
    f.addEventListener('submit', async function (e) {
      e.preventDefault();
      var n = name.input.value.trim(); if (!n) return say('Give the profile a name.', true);
      var data = { id: q.id, name: n, kids: q.kids, parent: parent.input.checked, color: color, playlists: plays, devices: devs };
      if (!q.kids && !pin.empty()) { var pr = pin.problem(); if (pr) return say(pr, true); data.pin = await pinHash(pin.value()); }
      sv.disabled = true; say('Saving…');
      var r = await post('/api/account/profiles/save', data);
      sv.disabled = false;
      if (!r._ok) return say(r.error, true);
      S.pending = r.pending || [];
      var waiting = S.pending.filter(function (x) { return x.kept; });
      if (waiting.length) { try { await sendPending(); } catch (err) { say((VAULT_TEXT[err.code] || err.message), true); await load(); return; } }
      say('Saved. Devices pick up changes within a minute while Avid Viewer is open.');
      editing = false; await load();
    });

    // What this profile can see.
    var vis = el('section', 'mg-card');
    add(vis, el('h2', null, 'What ' + q.name + ' can see'));
    var mine = S.playlists.filter(function (p) { return q.playlists.indexOf(p.id) >= 0 && !p.removing; });
    if (!mine.length) { add(vis, el('p', 'soft', 'Give ' + q.name + ' a playlist first (above), then choose what it shows.')); b.appendChild(vis); return; }
    var sel = el('select', 'mg-select'); sel.setAttribute('aria-label', 'Playlist');
    mine.forEach(function (p) { var o = el('option', null, p.name); o.value = p.id; sel.appendChild(o); });
    var area = el('div');
    add(vis, add(el('label', 'fld', 'Playlist'), sel), area);
    b.appendChild(vis);
    sel.addEventListener('change', function () { visEditor(q, sel.value, area); });
    visEditor(q, sel.value, area);
  }

  function blankVis() { return { hidden: { live: [], movie: [], series: [] }, channels: [], allowed: { live: [], movie: [], series: [] } }; }
  async function visEditor(q, plId, area) {
    area.innerHTML = ''; area.appendChild(el('p', 'soft', 'Loading the playlist\'s categories…'));
    var r = await fetch('/api/account/catalog?playlist=' + encodeURIComponent(plId), { credentials: 'same-origin' }).then(function (x) { return x.json(); });
    area.innerHTML = '';
    if (!r.catalog) { area.appendChild(el('p', 'soft', 'No device has sent this playlist\'s categories yet. Open Avid Viewer on a device that has it; they arrive within a minute.')); return; }
    var cat = r.catalog;
    var v = JSON.parse(JSON.stringify(q.visibility[plId] || blankVis()));
    var kind = 'live';
    var openCat = null;
    var tabs = el('div', 'seg small'); var list = el('div', 'mg-vis');
    var KINDS = [['live', 'Live TV'], ['movie', 'Movies'], ['series', 'Series']];
    function shown(k, n) { return q.kids ? (!ADULT.test(n) && v.allowed[k].indexOf(n) >= 0) : v.hidden[k].indexOf(n) < 0; }
    function setShown(k, n, s) {
      var list = q.kids ? v.allowed : v.hidden;
      var put = q.kids ? s : !s;
      list[k] = list[k].filter(function (x) { return x !== n; });
      if (put) list[k].push(n);
    }
    function toggle(on, fn, disabled, label) {
      var t = el('button', 'mg-toggle' + (on ? ' on' : ''), disabled ? 'Never shown' : on ? 'Shown' : 'Hidden'); t.type = 'button';
      t.setAttribute('aria-pressed', String(on)); t.setAttribute('aria-label', label + ': ' + t.textContent); t.disabled = !!disabled;
      t.addEventListener('click', function () { fn(!on); draw(); }); return t;
    }
    function rows(k) { return k === 'live' ? cat.live.map(function (g) { return [g.n, g.c, g]; }) : cat[k].map(function (x) { return [x[0], x[1], null]; }); }
    function draw() {
      tabs.innerHTML = '';
      KINDS.forEach(function (x) {
        var t = btn(x[1], 'mg-tab' + (x[0] === kind ? ' on' : ''), function () { kind = x[0]; openCat = null; draw(); }); tabs.appendChild(t);
      });
      list.innerHTML = '';
      var all = rows(kind);
      if (!all.length) { list.appendChild(el('p', 'soft', 'This playlist has no ' + (kind === 'live' ? 'live' : kind === 'movie' ? 'movie' : 'series') + ' categories.')); return; }
      list.appendChild(add(el('div', 'row-btns'),
        btn('Show all', 'btn btn-ghost btn-sm', function () { all.forEach(function (x) { if (!(q.kids && ADULT.test(x[0]))) setShown(kind, x[0], true); }); draw(); }),
        btn('Hide all', 'btn btn-ghost btn-sm', function () { all.forEach(function (x) { setShown(kind, x[0], false); }); draw(); })));
      var ul = el('ul', 'rows');
      all.forEach(function (x) {
        var n = x[0], s = shown(kind, n), adult = q.kids && ADULT.test(n);
        var li = el('li');
        var label = el(x[2] && x[2].ch.length ? 'button' : 'span', x[2] && x[2].ch.length ? 'linkish mg-cat' : null, n);
        if (label.tagName === 'BUTTON') { label.type = 'button'; label.addEventListener('click', function () { openCat = openCat === n ? null : n; draw(); }); }
        add(li, label, el('span', 'soft', x[1] + (kind === 'live' ? (x[1] === 1 ? ' channel' : ' channels') : (x[1] === 1 ? ' title' : ' titles'))), toggle(s, function (to) { setShown(kind, n, to); }, adult, n));
        ul.appendChild(li);
        if (openCat === n && x[2]) {
          var inner = el('ul', 'rows mg-chans');
          x[2].ch.forEach(function (c) {
            var hid = v.channels.indexOf(c[0]) >= 0;
            inner.appendChild(add(el('li'), el('span', null, c[1] || c[0]), toggle(s && !hid, function (to) {
              v.channels = to ? v.channels.filter(function (y) { return y !== c[0]; }) : v.channels.concat(c[0]);
              if (to && !s) setShown(kind, n, true);
            }, adult, c[1] || c[0])));
          });
          ul.appendChild(add(el('li', 'mg-chans-wrap'), inner));
        }
      });
      list.appendChild(ul);
    }
    var sv = btn('Save what ' + q.name + ' can see', 'btn btn-primary', async function () {
      sv.disabled = true;
      var res = await post('/api/account/profiles/visibility', { profileId: q.id, playlistId: plId, data: v });
      sv.disabled = false;
      if (!res._ok) return say(res.error, true);
      q.visibility[plId] = v; say('Saved. Devices pick it up within a minute.');
    });
    add(area, el('p', 'fineprint', q.kids ? 'Kids profile: everything starts hidden. Show the categories it may watch; adult categories can\'t be shown.'
      : 'Hidden categories and channels disappear from the guide, search, Favorites and Sports for this profile, on every device it\'s on.'),
      tabs, list, sv, el('p', 'fineprint', 'Names come from the playlist as ' + (cat.device || 'a device') + ' last downloaded it (' + new Date(r.updatedAt).toLocaleString() + ').'));
    draw();
  }

  // ------------------------------------------------------------ Devices
  function devicesPage() {
    var b = body('Devices', 'Choose which profiles appear on each device. Its Who\'s watching? screen shows exactly these.');
    var addA = el('a', 'btn btn-primary', '＋ Add a device'); addA.href = '/link/'; b.appendChild(addA);
    if (!S.devices.length) b.appendChild(el('p', 'soft', 'No devices linked yet. Open Avid Viewer on a TV and enter the code it shows at avidviewer.app/link.'));
    S.devices.forEach(function (d) {
      var c = el('section', 'mg-card');
      var head = el('div', 'mg-dev-head');
      add(head, add(el('div'), el('h3', null, d.name), el('p', 'soft', [d.model, d.appVersion ? 'Avid Viewer ' + d.appVersion : '', ago(d.lastSeen)].filter(Boolean).join(' · '))),
        add(el('div', 'row-btns'),
          btn('Rename', 'linkish', async function () {
            var n = prompt('New name for ' + d.name, d.name); if (!n || !n.trim()) return;
            var r = await post('/api/account/devices/rename', { id: d.id, name: n.trim() }); say(r._ok ? '' : r.error, !r._ok); load();
          }),
          btn('Remove', 'linkish', async function () {
            if (!confirm('Remove ' + d.name + ' from your account? It\'s signed out and its playlists from the account are removed. Its backup is kept for 30 days.')) return;
            await post('/api/account/devices/remove', { id: d.id }); load();
          })));
      c.appendChild(head);
      if (d.playing) c.appendChild(add(el('ul', 'rows'), playingRow(d, false)));
      c.appendChild(el('h4', null, 'Profiles on this device'));
      if (!d.managed) {
        c.appendChild(el('p', 'soft', 'Update Avid Viewer on this device to 1.15.0 or later and open it once to choose its profiles.'));
      } else if (!S.profiles.length) {
        var np = el('p', 'soft', 'No profiles in your account yet. '); var a = el('a', null, 'Add a profile'); a.href = '/profiles/#new'; c.appendChild(add(np, a));
      } else {
        var row = el('div', 'mg-checks');
        S.profiles.forEach(function (q) {
          row.appendChild(check(q.name + (q.kids ? ' (Kids)' : ''), d.profiles.indexOf(q.id) >= 0, async function (v) {
            var list = v ? d.profiles.concat(q.id) : d.profiles.filter(function (i) { return i !== q.id; });
            var r = await post('/api/account/devices/profiles', { deviceId: d.id, profiles: list });
            if (!r._ok) { say(r.error, true); return load(); }
            d.profiles = list; S.pending = r.pending || [];
            if (S.pending.some(function (x) { return x.kept && x.deviceId === d.id; })) {
              try { await sendPending(); } catch (err) { say(VAULT_TEXT[err.code] || err.message, true); }
            }
            say('Saved. ' + d.name + ' picks it up within a minute while Avid Viewer is open.');
            load();
          }));
        });
        c.appendChild(row);
      }
      b.appendChild(c);
    });
    b.appendChild(el('p', 'fineprint', 'A device with one profile (or none) shows no profiles at all. Taking a profile off a device removes that profile\'s playlists from it, unless another profile on the device has them.'));
  }

  document.querySelectorAll('.mg-signout').forEach(function (b) {
    b.addEventListener('click', function () { post('/api/auth/signout', {}).then(function () { location.href = '/'; }); });
  });
  load().catch(function () { say('Couldn\'t load your account. Reload the page.', true); });
  setInterval(function () { if (!editing && document.visibilityState === 'visible') load().catch(function () {}); }, 15000);
})();
