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
  function when(t) { var m = Math.round((Date.now() - t) / 60000); return m < 2 ? 'just now' : ago(t).replace('seen ', ''); }
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
    cancelled: 'The passkey was cancelled, so the login wasn\'t unlocked. If your browser said there\'s no passkey on this device, use the device where you made it, or add one here: Account › Passkeys › Add a passkey.',
    noprf: 'This passkey can\'t keep logins locked (your browser or password manager doesn\'t support it yet). Try another browser, or type the login again when you add a device.',
    other: 'Your logins are locked with a different passkey. Choose the passkey you used when you first saved a playlist.',
  };
  /** Makes the account's first passkey (Nov 17: an account without one only got the browser's "no passkey on this
   * device", since this page used to only ask for an existing passkey). */
  async function createPasskey() {
    var WA = window.SimpleWebAuthnBrowser;
    if (!WA || !WA.browserSupportsWebAuthn()) throw VaultError('nopasskey');
    say('Create your passkey: follow your browser (Face ID, fingerprint or your device PIN).');
    var o = await post('/api/passkeys/register/options', {});
    if (!o._ok) throw new Error(o.error || 'The passkey couldn\'t be started.');
    var resp;
    try { resp = await WA.startRegistration({ optionsJSON: o.options }); }
    catch (e) { throw VaultError(e && e.name === 'InvalidStateError' ? 'other' : 'cancelled'); }
    var v = await post('/api/passkeys/register/verify', { challengeId: o.challengeId, response: resp });
    if (!v._ok) throw new Error(v.error || 'The passkey couldn\'t be saved.');
    S.passkeys = (S.passkeys || 0) + 1;
    say('Passkey created. Now confirm it once more to lock your logins with it.');
  }
  /** Unlocks the vault with a passkey (made the first time). */
  async function unlock() {
    if (V) return V;
    if (!window.PublicKeyCredential || !navigator.credentials) throw VaultError('nopasskey');
    if (!S.passkeys) await createPasskey();
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
  function deviceHas(p) {
    var d = S.devicePlaylists.filter(function (x) { return x.remoteId === p.id && x.hasLogin; });
    // Nov 21, 2026: a line added for you by Avid Viewer, locked for your account key until your passkey keeps it.
    return p.accountSealed ? d.concat([{ remoteId: p.id, hasLogin: true, deviceId: 'account', name: 'Avid Viewer' }]) : d;
  }
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
    try { await historyKey(); } catch (e) { if (e.code) throw e; }
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
    if (PAGE !== 'playlists') return; // elsewhere, Needs your attention points here
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
        !S.passkeys ? el('p', 'fineprint', 'You don\'t have a passkey yet. Set up with passkey creates one first (Face ID, fingerprint or your device PIN), then asks you to confirm it once more.') : null,
        unlockBtn(S.vault.length ? 'Unlock with passkey' : 'Set up with passkey'));
    } else if (importable.length || kept.length) {
      var lines = [];
      if (importable.length) lines.push('Logins for ' + names(importable.map(function (p) { return p.name; })) + ' are ready from ' +
        names(Array.from(new Set(importable.map(function (p) { return (dev(deviceHas(p)[0].deviceId) || deviceHas(p)[0]).name; })))) + '.');
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
    window.dispatchEvent(new Event('avid:changed'));
    renderPending();
    if (!editing) route();
  }
  function route() {
    var h = location.hash.replace(/^#/, '');
    var m = /^(edit|manage|new|finish)(?:=(.*))?$/.exec(h);
    editing = false;
    var sub = m && m[2] ? m[2].split('/') : [];
    if (PAGE === 'playlists') {
      if (m && m[1] === 'edit' && sub[1] === 'order' && pl(sub[0])) return orderTab(pl(sub[0]));
      if (m && m[1] === 'edit') return playlistEditor(pl(sub[0]) || null);
      if (m && m[1] === 'new') return playlistEditor(null);
      return playlistsPage();
    }
    if (PAGE === 'profiles') {
      if (m && m[1] === 'manage' && prof(sub[0])) return profileManager(prof(sub[0]), sub[1] || '');
      if (m && m[1] === 'finish' && prof(m[2])) return kidsPins(prof(m[2]));
      if (m && m[1] === 'new') return newProfile();
      if (h === 'history') return historyUnlockPage();
      return profilesPage();
    }
    if (PAGE === 'devices') return devicesPage();
  }
  // Unsaved choices (What X can see is the one editor with a Save button): ask before leaving them.
  var unsaved = null; // () => true while the open editor has changes not saved yet
  var lastHash = location.hash;
  function leaveOk() { return !(unsaved && unsaved()) || confirm('You have changes that aren’t saved. Leave without saving them?'); }
  window.addEventListener('beforeunload', function (e) { if (unsaved && unsaved()) { e.preventDefault(); e.returnValue = ''; } });
  window.addEventListener('hashchange', function () {
    if (!leaveOk()) { history.replaceState(null, '', lastHash || location.pathname); return; }
    unsaved = null; lastHash = location.hash; say(''); route();
  });
  function go(hash) { if ((location.hash || '#') === hash) route(); else location.hash = hash; }
  function body(title, intro) {
    // A fresh page each time: a tab still loading for the page before (another profile, say) fills that old page,
    // which is no longer shown, never this one (Nov 17: Evan's lists appeared on Maven's page).
    var host = $('mg-body'); host.innerHTML = '';
    var b = el('div', 'mg-page'); host.appendChild(b);
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
    if (p) b.appendChild(subTabs([['Login & profiles', '#edit=' + p.id, ''], ['Order & names', '#edit=' + p.id + '/order', 'order']], ''));
    var f = el('form', 'mg-card'); f.noValidate = true;
    var type = p ? p.type : 'xtream';
    var seg = el('fieldset', 'seg small'); seg.setAttribute('aria-label', 'Type');
    [['xtream', 'Xtream Codes login'], ['m3u', 'M3U link']].forEach(function (x) {
      var l = el('label'); var r = el('input'); r.type = 'radio'; r.name = 'pl-type'; r.value = x[0]; r.checked = x[0] === type;
      r.addEventListener('change', function () { type = x[0]; showType(); }); add(seg, add(l, r, document.createTextNode(' ' + x[1])));
    });
    var name = field('Name', 'text', p ? p.name : '', { maxlength: '60', placeholder: 'My provider' });
    if (!p) {
      // Already typed on a device? Adding it here too would be a second copy there: point to Add to account.
      var twin = el('p', 'mg-warn'); twin.hidden = true;
      name.input.addEventListener('input', function () {
        var n = name.input.value.trim().toLowerCase();
        var on = S.devicePlaylists.filter(function (x) { return !x.remoteId && n && x.name.toLowerCase() === n; });
        twin.hidden = !on.length;
        if (on.length) twin.textContent = name.input.value.trim() + ' is already on ' + names(on.map(function (x) { return (dev(x.deviceId) || {}).name; })) +
          ', typed there. Use Add to account under Added on your devices instead, so it keeps its favorites and isn\'t added twice.';
      });
    }
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
      var from = dev(deviceHas(p)[0].deviceId) || deviceHas(p)[0];
      show = btn('Fill in from ' + from.name, 'btn btn-ghost btn-sm', async function () {
        show.disabled = true;
        try { var it = (await deviceLogins()).find(function (y) { return y.remoteId === p.id; }); fill(await openSealed(it.sealed)); show.hidden = true; say(''); }
        catch (e) { show.disabled = false; say(VAULT_TEXT[e.code] || e.message, true); }
      });
    }
    add(f, seg, name, p ? null : twin, p ? keep : null, show, xt, m3u, epg);
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

    if (!S.profiles.length) add(b, el('p', 'soft', 'No profiles yet. Devices with one profile, or none, show no profiles at all.'));
    var grid = el('div', 'mg-grid');
    S.profiles.forEach(function (q) {
      var c = el('section', 'mg-card mg-prof');
      var head = add(el('div', 'mg-prof-head'), avatar(q, 48), add(el('div'), el('h3', null, q.name), el('p', 'soft', roleText(q))));
      var pls = q.playlists.map(function (id) { return (pl(id) || {}).name; }).filter(Boolean);
      var dl = el('dl', 'mg-dl');
      [['Playlists', pls.length ? names(pls) : 'None yet'], ['Devices', q.devices.length ? q.devices.length + (q.devices.length === 1 ? ' device' : ' devices') : 'None yet'],
        ['Hidden', hiddenText(q)]].forEach(function (x) { add(dl, el('dt', null, x[0]), el('dd', null, x[1])); });
      var waitPins = []; // Nov 22, 2026: grown-up PINs are optional; a Kids profile goes to devices straight away
      if (waitPins.length) add(c, el('p', 'mg-warn', 'Not on your devices yet: ' + names(waitPins.map(function (x) { return x.name; })) + (waitPins.length === 1 ? ' needs' : ' need') + ' a PIN first.'),
        btn('Finish setting up', 'btn btn-primary', function () { go('#finish=' + q.id); }));
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
    var kids = check('Kids profile (only the categories you allow; adult categories never). Grown-up profiles can have a PIN so a child can\'t switch into them; that\'s up to you.', false, function () { show(); });
    var parent = check('Parent (its PIN unlocks any profile on the TV)', false);
    var pin = pinPair('PIN (4 digits)');
    var pinNote = el('p', 'fineprint', '');
    var sv = el('button', 'btn btn-primary', 'Create'); sv.type = 'submit';
    function show() {
      var k = kids.input.checked;
      parent.hidden = k; pin.hidden = k;
      var kidsExist = S.profiles.some(function (q) { return q.kids; });
      pinNote.textContent = k ? '' : kidsExist ? 'A PIN is optional. With a Kids profile in your account, a PIN keeps a child from switching into this profile.' : 'A PIN is optional.';
      sv.textContent = 'Create, then choose playlists';
    }
    add(f, name, add(el('label', 'fld', 'Colour'), colorPicker(color, function (i) { color = i; })), kids, parent, pin, pinNote,
      add(el('div', 'row-btns'), sv, btn('Cancel', 'btn btn-ghost', function () { go('#'); })));
    b.appendChild(f); show(); name.input.focus();
    f.addEventListener('submit', async function (e) {
      e.preventDefault();
      var n = name.input.value.trim(); if (!n) return say('Give the profile a name.', true);
      var data = { name: n, kids: kids.input.checked, parent: !kids.input.checked && parent.input.checked, color: color, playlists: [], devices: [] };
      if (!kids.input.checked && !pin.empty()) { var pr = pin.problem(); if (pr) return say(pr, true); data.pin = await pinHash(pin.value()); }
      var r = await post('/api/account/profiles/save', data);
      if (!r._ok) return say(r.error, true);
      say(''); await load(); go('#manage=' + r.id);
    });
  }

  /** Step 2 of a new Kids profile (artboard 4b): every grown-up profile gets a PIN first. */
  function kidsPins(kid) {
    var b = body(kid.id ? 'Finish setting up ' + kid.name : 'Lock the grown-up profiles first', 'While a Kids profile exists, every other profile needs a 4-digit PIN, so a child can\'t switch to it on the TV. Set one for each profile below; they go to your devices with the new profile.');
    b.insertBefore(back('Profiles', '#'), b.firstChild);
    var f = el('form', 'mg-card'); f.noValidate = true;
    add(f, el('p', 'fineprint', kid.id ? 'KIDS PROFILE · NOT ON YOUR DEVICES UNTIL THESE PINS ARE SET' : 'NEW KIDS PROFILE · STEP 2 OF 2 · ' + kid.name));
    var grown = S.profiles.filter(function (q) { return !q.kids; });
    var pairs = {};
    if (!grown.length) add(f, el('p', 'soft', 'There are no grown-up profiles yet, so there\'s nothing to lock. Add one for yourself (with a PIN) so you can leave the Kids profile on the TV.'));
    grown.forEach(function (q) {
      var row = add(el('div', 'mg-prow'), avatar(q, 32), el('strong', null, q.name), el('span', 'soft', (q.parent ? 'Parent · ' : '') + (q.hasPin ? 'PIN set ✓' : 'no PIN yet')));
      f.appendChild(row);
      if (!q.hasPin) { pairs[q.id] = pinPair(); f.appendChild(pairs[q.id]); }
    });
    var sv = el('button', 'btn btn-primary', (kid.id ? 'Save PINs and send ' : 'Create ') + kid.name + (kid.id ? ' to devices' : ' and send PINs to devices')); sv.type = 'submit';
    add(f, add(el('div', 'row-btns'), sv, btn('Cancel', 'btn btn-ghost', function () { go('#'); })),
      el('p', 'fineprint', 'PINs are saved only as a salted one-way hash, never as digits, and devices get the same hash within a minute. A parent\'s PIN also unlocks any profile on the TV. Forgot one? Change it here any time.'));
    b.appendChild(f);
    f.addEventListener('submit', async function (e) {
      e.preventDefault();
      var pins = {};
      for (var id in pairs) { var pr = pairs[id].problem(); if (pr) return say((prof(id) || {}).name + ': ' + pr, true); pins[id] = await pinHash(pairs[id].value()); }
      var r = kid.id
        ? await post('/api/account/profiles/save', { id: kid.id, name: kid.name, kids: true, color: kid.color, pins: pins })
        : await post('/api/account/profiles/save', { name: kid.name, kids: true, color: kid.color, pins: pins, playlists: [], devices: [] });
      if (!r._ok) return say(r.error, true);
      say(''); await load(); go('#manage=' + r.id);
    });
  }

  /** Tabs inside a page (a profile's Overview / What it can see / Favorites & lists; a playlist's Login / Order). */
  function subTabs(items, current) {
    var nav = el('nav', 'mg-subtabs'); nav.setAttribute('aria-label', 'Sections');
    items.forEach(function (x) { var a = el('a', null, x[0]); a.href = x[1]; if (x[2] === current) a.setAttribute('aria-current', 'page'); nav.appendChild(a); });
    return nav;
  }
  function profileManager(q, tab) {
    editing = true;
    var b = body(q.name);
    b.insertBefore(back('Profiles', '#'), b.firstChild);
    var on = q.devices.map(function (id) { return (dev(id) || {}).name; }).filter(Boolean);
    b.querySelector('.page-head').appendChild(el('p', 'soft', roleText(q) + (on.length ? ' · on ' + names(on) : ' · not on a device yet')));
    b.appendChild(subTabs([['Overview', '#manage=' + q.id, ''], ['What ' + q.name + ' can see', '#manage=' + q.id + '/see', 'see'], ['Favorites & lists', '#manage=' + q.id + '/lists', 'lists'], ['Watching', '#manage=' + q.id + '/watching', 'watching'], ['Discover', '#manage=' + q.id + '/discover', 'discover']], tab));
    if (tab === 'lists') return listsTab(q, b);
    if ((tab === 'watching' || tab === 'discover') && q.kids) return kidsPrivacyNote(q, b, tab);
    if (tab === 'watching') return watchingTab(q, b);
    if (tab === 'discover') return discoverTab(q, b);
    if (tab !== 'see') {

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
    return;
    }

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
    var shownPl = sel.value;
    sel.addEventListener('change', function () {
      if (!leaveOk()) { sel.value = shownPl; return; }
      shownPl = sel.value; visEditor(q, sel.value, area);
    });
    visEditor(q, sel.value, area);
  }

  function blankVis() { return { hidden: { live: [], movie: [], series: [] }, channels: [], allowed: { live: [], movie: [], series: [] } }; }
  async function visEditor(q, plId, area) {
    var ticket = area.dataset.ticket = String(Date.now() + Math.random());
    area.innerHTML = ''; area.appendChild(el('p', 'soft', 'Loading the playlist\'s categories…'));
    // This profile's saved choices, read fresh for this profile and playlist (never another page's copy).
    var [r, mineNow] = await Promise.all([
      fetch('/api/account/catalog?playlist=' + encodeURIComponent(plId), { credentials: 'same-origin' }).then(function (x) { return x.json(); }),
      getJson('/api/account/profiles/visibility?profile=' + encodeURIComponent(q.id) + '&playlist=' + encodeURIComponent(plId)),
    ]);
    if (area.dataset.ticket !== ticket || !area.isConnected) return; // another playlist or page was chosen meanwhile
    area.innerHTML = '';
    if (!r.catalog) { area.appendChild(el('p', 'soft', 'No device has sent this playlist\'s categories yet. Open Avid Viewer on a device that has it; they arrive within a minute.')); return; }
    var cat = r.catalog;
    if (mineNow && mineNow._ok !== false && mineNow.profileId === q.id) { if (mineNow.data) q.visibility[plId] = mineNow.data; else delete q.visibility[plId]; }
    var savedAt = mineNow && mineNow.updatedAt;
    var v = JSON.parse(JSON.stringify(q.visibility[plId] || blankVis()));
    var savedJson = JSON.stringify(v);
    function dirty() { return JSON.stringify(v) !== savedJson; }
    unsaved = function () { return area.isConnected && area.dataset.ticket === ticket && dirty(); };
    var plName = (pl(plId) || {}).name || 'this playlist';
    var whose = el('p', 'mg-whose');
    function drawWhose() { whose.textContent = 'Editing ' + q.name + '’s choices for ' + plName + ' · ' + (savedAt ? 'last saved ' + when(savedAt) : 'not saved yet') + '. Other profiles keep their own.'; }
    drawWhose();
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
      drawBar();
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
    // Owner, Nov 19: changes here need Save, and people lost them by leaving without scrolling down to it. The Save
    // button is now at the top as well as the bottom, with a line saying whether anything is waiting to be saved.
    var saving = false;
    async function saveVis() {
      saving = true; drawBar();
      var res = await post('/api/account/profiles/visibility', { profileId: q.id, playlistId: plId, data: v });
      saving = false;
      if (!res._ok) { drawBar(); return say(res.error, true); }
      if (res.profileId && res.profileId !== q.id) { drawBar(); return say('That was saved for another profile. Reload the page and try again.', true); }
      q.visibility[plId] = JSON.parse(JSON.stringify(v)); savedJson = JSON.stringify(v); savedAt = res.updatedAt || Date.now(); drawWhose(); drawBar();
      say('Saved for ' + q.name + ' only. Devices pick it up within a minute.');
    }
    var label = 'Save what ' + q.name + ' can see';
    var topSv = btn(label, 'btn btn-primary', saveVis), sv = btn(label, 'btn btn-primary', saveVis);
    var barNote = el('span', 'mg-savenote');
    var bar = add(el('div', 'mg-savebar'), topSv, barNote);
    function drawBar() {
      var d = dirty();
      topSv.disabled = sv.disabled = saving || !d;
      topSv.textContent = sv.textContent = saving ? 'Saving…' : label;
      barNote.textContent = saving ? '' : d ? 'You have changes that aren’t saved yet.' : 'All changes saved.';
      bar.classList.toggle('dirty', d && !saving);
    }
    add(area, bar, el('p', 'fineprint', q.kids ? 'Kids profile: everything starts hidden. Show the categories it may watch; adult categories can\'t be shown.'
      : 'Hidden categories and channels disappear from the guide, search, Favorites and Sports for this profile, on every device it\'s on.'),
      whose, tabs, list, sv, el('p', 'fineprint', 'Names come from the playlist as ' + (cat.device || 'a device') + ' last downloaded it (' + new Date(r.updatedAt).toLocaleString() + ').'));
    draw();
  }

  // ------------------------------------------------------------ Pick up where you left off (1.17.0)
  // What each profile watched, its Discover settings and the account's TMDB key are locked with a history key H that
  // only the TVs and your passkey have. The browser makes H at the first unlock (wrapped with the vault key) and locks a
  // copy for each linked device. Blobs: AES-GCM, base64(iv || ct), JSON inside.
  var H = null, HRAW = null;
  async function historyKey() {
    if (H) return H;
    var v = await unlock();
    await accountPrivate(); // the account's key row must exist first
    var wrapped = S.history && S.history.wrapped;
    if (!wrapped) {
      var raw = crypto.getRandomValues(new Uint8Array(32));
      var r = await post('/api/account/history/key', { wrapped: await enc(v, raw) });
      if (!r._ok) throw new Error(r.error || 'The key couldn’t be saved.');
      wrapped = r.history; S.history = Object.assign(S.history || {}, { wrapped: wrapped });
    }
    HRAW = await dec(v, wrapped);
    H = await aesKey(HRAW, ['encrypt', 'decrypt']);
    await shareHistoryKey();
    return H;
  }
  /** Locks the history key for every linked device that doesn't have it yet. Returns how many got it. */
  async function shareHistoryKey() {
    if (!HRAW) return 0;
    var d = await getJson('/api/account/history/devices');
    var items = [];
    for (var i = 0; i < (d.devices || []).length; i++) items.push({ deviceId: d.devices[i].id, sealed: await seal(d.devices[i].pubkey, { historyKey: b64(HRAW) }) });
    if (items.length) await post('/api/account/history/seal', { items: items });
    if (S.history) S.history.devicesWaiting = 0;
    if (items.length) window.dispatchEvent(new Event('avid:changed'));
    return items.length;
  }
  /** An item id like the TVs make (HMAC-SHA256 with the history key, base64url, 22 characters). */
  async function hItem(match) {
    await historyKey();
    var k = await crypto.subtle.importKey('raw', HRAW, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    var sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(match)));
    return b64(sig).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 22);
  }
  async function hOpen(text) { return JSON.parse(new TextDecoder().decode(await dec(await historyKey(), text))); }
  async function hLock(obj) { return enc(await historyKey(), new TextEncoder().encode(JSON.stringify(obj))); }
  function clock(ms) {
    var s = Math.max(0, Math.round((ms || 0) / 1000)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(ss).padStart(2, '0');
  }
  function unlockCard(q, text, after) {
    var c = el('section', 'mg-card');
    add(c, el('p', 'soft', text), btn('Unlock with passkey', 'btn btn-primary', async function () {
      try { await historyKey(); after(); } catch (e) { say(e.code ? VAULT_TEXT[e.code] : (e.message || 'Couldn’t unlock.'), true); }
    }));
    return c;
  }

  /** Kids profiles: no Discover and no pick up where you left off, for their privacy. */
  function kidsPrivacyNote(q, b, tab) {
    b.appendChild(add(el('section', 'mg-card mg-card-quiet'),
      el('h2', null, tab === 'watching' ? 'Not shared for Kids profiles' : 'No Discover for Kids profiles'),
      el('p', 'soft', 'For their privacy, Kids profiles don\u2019t offer Discover or pick up where you left off. Nothing ' + q.name + ' watches is sent to your account: each TV keeps ' + q.name + '\u2019s place in a movie or episode on that TV only, and Discover isn\u2019t on ' + q.name + '\u2019s menu.'),
      el('p', 'fineprint', 'What ' + q.name + ' can watch is set on the \u201cWhat ' + q.name + ' can see\u201d tab.')));
  }

  // ---- a profile's Watching tab
  async function watchingTab(q, b) {
    var wait = el('p', 'soft', 'Loading…'); b.appendChild(wait);
    var d = await getJson('/api/account/history?profile=' + encodeURIComponent(q.id));
    wait.remove();
    if (!d.enabled) {
      b.appendChild(add(el('section', 'mg-card'), el('h2', null, 'Watch history is off for your account'),
        el('p', 'soft', 'Each TV keeps its own place. Turn on “Keep my watch history” on the Account tab to pick up on any TV.'),
        (function () { var a = el('a', 'linkish', 'Open the Account tab'); a.href = '/account/'; return a; })()));
      return;
    }
    var list = el('section', 'mg-card'); b.appendChild(list);
    var norm = function (x) { return String(x || '').toLowerCase().replace(/\s+/g, ' ').trim(); };
    /**
     * What Continue watching shows (1.17.1), the same rule as the TVs: movies part-way; a series (one row) until its
     * latest episode is watched, back when a TV finds a new one; a series removed stays off until something new happens.
     */
    function shown(rows) {
      var hideAt = {}, groups = {}, out = [];
      rows.forEach(function (r) {
        if (r.v.t === 'h') hideAt[norm(r.v.series)] = Math.max(hideAt[norm(r.v.series)] || 0, r.at);
        else if (r.v.t === 'e') (groups[norm(r.v.series)] = groups[norm(r.v.series)] || []).push(r);
        // 1.18.0: the last live channel, until the program that was on ends.
        else if (r.v.t === 'l') { if (Date.now() < (r.v.until || 0)) out.push({ kind: 'l', at: r.at, r: r }); }
        else if (!r.v.done) out.push({ kind: 'm', at: r.at, r: r });
      });
      Object.keys(groups).forEach(function (k) {
        var g = groups[k].slice().sort(function (a, c) { return c.at - a.at; });
        var lastS = 0, lastE = 0;
        g.forEach(function (r) { var s2 = r.v.lastS || 0, e2 = r.v.lastE || 0; if (s2 > lastS || (s2 === lastS && e2 > lastE)) { lastS = s2; lastE = e2; } });
        var part = g.filter(function (r) { return !r.v.done; })[0];
        var latestDone = lastS > 0 && g.some(function (r) { return r.v.done && r.v.s === lastS && r.v.e === lastE; });
        if (!part && latestDone) return;
        if ((hideAt[k] || 0) >= g[0].at) return;
        out.push({ kind: 's', at: g[0].at, rows: g, part: part, top: part || g[0], lastS: lastS, lastE: lastE });
      });
      return out.sort(function (a, c) { return c.at - a.at; });
    }
    function drawList(rows) {
      list.innerHTML = '';
      var items = shown(rows);
      add(list, el('h2', null, 'Continue watching \u00b7 ' + items.length));
      if (!items.length) { list.appendChild(el('p', 'soft', q.off ? '' : 'Nothing yet. Where ' + q.name + ' stops in a movie or episode shows up here and on every TV.')); return; }
      add(list, el('p', 'soft', 'Movies part-way, series until their latest episode is watched (a new episode or season brings a series back), and the last live channel until its program ends, from every TV. Locked so only your TVs and your passkey can read it.'));
      var ul = el('ul', 'mg-rows mg-watch');
      items.forEach(function (it) {
        var v = it.kind === 'm' || it.kind === 'l' ? it.r.v : it.top.v, li = el('li');
        var what = it.kind === 'l' ? 'Live TV \u00b7 until ' + new Date(v.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
          : it.kind === 'm' ? 'Movie \u00b7 ' + clock(v.pos) + (v.dur ? ' of ' + clock(v.dur) : '')
          : it.part ? 'Series \u00b7 S' + v.s + ' E' + v.e + ' \u00b7 ' + clock(v.pos) + (v.dur ? ' of ' + clock(v.dur) : '')
          : 'Series \u00b7 watched S' + v.s + ' E' + v.e + ' \u00b7 ' + (it.lastS ? 'up next' : 'more to watch');
        var bar = it.kind === 'l' ? null : el('span', 'mg-bar'); if (bar) { var fill = el('span'); fill.style.width = (v.done ? 0 : v.dur ? Math.min(100, Math.round(100 * v.pos / v.dur)) : 0) + '%'; bar.appendChild(fill); }
        add(li, add(el('span', 'mg-name'), el('span', 'mg-strong', it.kind === 's' ? (v.series || v.title) : it.kind === 'l' ? v.name : v.title), el('span', 'mg-provider', what), bar),
          el('span', 'mg-provider mg-where', (v.tv || 'A TV') + ' \u00b7 ' + when(it.at)),
          it.kind === 'm' ? btn('Mark watched', 'btn btn-ghost btn-sm', async function () {
            var nv = Object.assign({}, v, { done: true, pos: 0, tv: 'the website' });
            var x = await post('/api/account/history/put', { profileId: q.id, item: it.r.item, blob: await hLock(nv) });
            if (!x._ok) return say(x.error || 'Couldn\u2019t change it.', true);
            it.r.v = nv; it.r.at = Date.now(); say('Marked watched on every TV.'); drawList(rows);
          }) : null,
          btn('Remove', 'btn btn-ghost btn-sm', async function () {
            if (it.kind === 'm' || it.kind === 'l') {
              var x = await post('/api/account/history/put', { profileId: q.id, item: it.r.item, blob: null });
              if (!x._ok) return say(x.error || 'Couldn\u2019t remove it.', true);
              rows.splice(rows.indexOf(it.r), 1);
            } else {
              // A series: off until something new happens (a hide marker the TVs follow), and its part-way episode goes.
              var hv = { t: 'h', series: v.series, tv: 'the website' };
              var id = await hItem('h|' + norm(v.series));
              var y = await post('/api/account/history/put', { profileId: q.id, item: id, blob: await hLock(hv) });
              if (!y._ok) return say(y.error || 'Couldn\u2019t remove it.', true);
              for (var i = 0; i < it.rows.length; i++) if (!it.rows[i].v.done) { await post('/api/account/history/put', { profileId: q.id, item: it.rows[i].item, blob: null }); rows.splice(rows.indexOf(it.rows[i]), 1); }
              rows.push({ item: id, at: Date.now(), v: hv });
            }
            say('Removed from Continue watching on every TV.'); drawList(rows);
          }));
        ul.appendChild(li);
      });
      list.appendChild(ul);
    }
    async function load() {
      var rows = [];
      for (var i = 0; i < d.items.length; i++) { try { rows.push({ item: d.items[i].item, at: d.items[i].at, v: await hOpen(d.items[i].blob) }); } catch (e) { if (e.code) throw e; } }
      rows.sort(function (a, c) { return c.at - a.at; });
      drawList(rows);
    }
    if (H) await load();
    else if (!d.items.length) drawList([]);
    else { list.appendChild(unlockCard(q, 'Continue watching · ' + d.items.length + (d.items.length === 1 ? ' title' : ' titles') + ' from your TVs. Unlock with your passkey to see them.', function () { load(); })); }

    var set = el('section', 'mg-card'); b.appendChild(set);
    add(set, el('h2', null, 'Watch history for ' + q.name),
      check('Keep ' + q.name + '’s place in movies and episodes on every TV', !q.historyOff, async function (onNow) {
        if (!onNow && !confirm('Turn off for ' + q.name + '? Each TV goes back to keeping its own place, and what your account holds for ' + q.name + ' is deleted.')) { route(); return; }
        var x = await post('/api/account/profiles/history', { profileId: q.id, off: !onNow });
        if (!x._ok) return say(x.error || 'Couldn’t change it.', true);
        q.historyOff = !onNow; say(onNow ? 'On: ' + q.name + '’s place follows to every TV.' : 'Off for ' + q.name + '.'); route();
      }),
      el('p', 'fineprint', 'Off: each TV keeps its own place, and what the account has for ' + q.name + ' is deleted. Pause history on a TV stops that TV from sending. Of live TV, only the last channel is shared (until its program ends), never a list of channels. Neither the website nor its admins can read any of it.'),
      btn('Clear ' + q.name + '’s history', 'btn btn-ghost', async function () {
        if (!confirm('Delete everything your account holds for ' + q.name + '? Each TV keeps what it has itself.')) return;
        var x = await post('/api/account/profiles/history', { profileId: q.id, off: q.historyOff, clear: true });
        if (!x._ok) return say(x.error || 'Couldn’t clear it.', true);
        say('Cleared.'); route();
      }));
  }

  // ---- a profile's Discover tab (and the account's TMDB key)
  var SERVICES = [[8, 'Netflix'], [1899, 'Max'], [337, 'Disney+'], [9, 'Prime Video'], [15, 'Hulu'], [350, 'Apple TV+'], [386, 'Peacock'], [531, 'Paramount+'], [43, 'Starz'], [37, 'Showtime'], [283, 'Crunchyroll'], [73, 'Tubi']];
  async function discoverTab(q, b) {
    var wait = el('p', 'soft', 'Loading…'); b.appendChild(wait);
    var d = await getJson('/api/account/history?profile=' + encodeURIComponent(q.id));
    wait.remove();
    if (!H) {
      b.appendChild(unlockCard(q, 'Discover settings, My List and the TMDB key are locked so only your TVs and your passkey can read them. Unlock to see and change them.', function () { route(); }));
      return;
    }
    var D = { myList: [], services: [], start: 'all', grownUps: true };
    if (d.discover) try { D = Object.assign(D, await hOpen(d.discover.blob)); } catch (e) { if (e.code) throw e; }
    async function save(msg) {
      var x = await post('/api/account/discover', { profileId: q.id, blob: await hLock(D) });
      say(x._ok ? (msg || 'Saved · TVs pick it up within a minute while Avid Viewer is open') : (x.error || 'Couldn’t save.'), !x._ok);
    }
    var sv = el('section', 'mg-card'); b.appendChild(sv);
    add(sv, el('h2', null, 'My streaming services'), el('p', 'soft', 'The services ' + q.name + ' subscribes to. Discover can then show only what ' + q.name + ' can watch now.'));
    var chips = el('div', 'mg-chips');
    var all = SERVICES.map(function (x) { return { id: x[0], name: x[1] }; });
    D.services.forEach(function (s) { if (!all.some(function (a) { return a.id === s.id; })) all.push(s); });
    all.forEach(function (s) {
      chips.appendChild(check(s.name, D.services.some(function (x) { return x.id === s.id; }), function (on) {
        D.services = on ? D.services.concat([{ id: s.id, name: s.name, logo: s.logo || '' }]) : D.services.filter(function (x) { return x.id !== s.id; });
        save();
      }));
    });
    sv.appendChild(chips);
    var st = el('section', 'mg-card'); b.appendChild(st);
    add(st, el('h2', null, 'When Discover opens'));
    [['all', 'Everything', 'Trending and new titles, wherever they are.'], ['provider', 'On your provider', 'Only titles ' + q.name + '’s playlists have.'], ['services', 'My services', 'Only titles on the services above.']].forEach(function (o) {
      var l = el('label', 'switch-row'); var r = el('input'); r.type = 'radio'; r.name = 'dstart'; r.checked = D.start === o[0];
      r.addEventListener('change', function () { D.start = o[0]; save(); });
      add(l, r, add(el('span'), el('strong', null, o[1]), el('span', 'fineprint', ' · ' + o[2]))); st.appendChild(l);
    });
    add(st, check('Show titles for grown-ups (rated R / TV-MA and up)', D.grownUps !== false, function (on) { D.grownUps = on; save(); }),
      el('p', 'fineprint', q.kids ? 'Kids profiles never see Discover.' : 'Off: Discover leaves out movies rated R or NC-17 and series rated TV-MA.'));
    if (!q.kids) {
      var gs = el('section', 'mg-card'); b.appendChild(gs);
      add(gs, el('h2', null, 'Movies and Series'),
        check('Sort Movies and Series by genre', D.genres !== false, function (on) { D.genres = on; save(); }),
        el('p', 'fineprint', 'On by default: ' + q.name + '’s Movies and Series list TMDB genres (Action, Comedy, Drama…) in place of the provider’s categories. Needs a TMDB key. Each TV looks titles up by name and year.'));
    }
    var ml = el('section', 'mg-card'); b.appendChild(ml);
    function drawList() {
      ml.innerHTML = '';
      var mv = D.myList.filter(function (x) { return x.t === 'movie'; }).length;
      add(ml, el('h2', null, 'My List · ' + D.myList.length), el('p', 'soft', mv + (mv === 1 ? ' movie, ' : ' movies, ') + (D.myList.length - mv) + ' series, added from Discover, Movies or Series. They follow ' + q.name + ' to every TV. Stream addresses are never sent: each TV finds the title in its own playlists.'));
      var ul = el('ul', 'mg-rows');
      D.myList.forEach(function (x, i) {
        add(ul, add(el('li'), add(el('span', 'mg-name'), el('span', 'mg-strong', x.name), el('span', 'mg-provider', (x.t === 'movie' ? 'Movie' : 'Series') + (x.year ? ' · ' + x.year : '') + (x.cat ? ' · ' + x.cat : ''))),
          btn('Remove', 'btn btn-ghost btn-sm', function () { D.myList.splice(i, 1); save('Removed from My List on every TV.'); drawList(); })));
      });
      ml.appendChild(ul);
    }
    drawList();
    // The account's TMDB key.
    var tk = el('section', 'mg-card mg-card-quiet'); b.appendChild(tk);
    var has = S.history && S.history.tmdb;
    add(tk, el('h2', null, 'For the whole account: TMDB key'),
      el('p', 'soft', 'Discover uses a free key from themoviedb.org (Settings › API). Enter it once here and every TV gets it, locked so the website and its admins can’t read it.'),
      el('p', has ? 'mg-ok' : 'soft', has ? '● Saved for your TVs' : 'Not saved in your account yet (a TV may still have its own).'));
    var f = field(has ? 'Replace the key' : 'TMDB API key', 'password', '', { autocomplete: 'off', maxlength: '200' });
    add(tk, f, add(el('div', 'row'), btn('Save key', 'btn btn-primary', async function () {
      var k = f.input.value.trim(); if (!/^[A-Za-z0-9._-]{16,}$/.test(k)) return say('That doesn’t look like a TMDB key (Settings › API on themoviedb.org).', true);
      var x = await post('/api/account/tmdb', { blob: await hLock({ tmdb: k }) });
      if (!x._ok) return say(x.error || 'Couldn’t save it.', true);
      S.history.tmdb = true; f.input.value = ''; say('Saved. Your TVs get it within a minute while Avid Viewer is open.'); route();
    }), has ? btn('Remove', 'btn btn-ghost', async function () {
      if (!confirm('Remove the TMDB key from your account? TVs keep the copy they have until you remove it there.')) return;
      var x = await post('/api/account/tmdb', { blob: null });
      if (x._ok) { S.history.tmdb = false; say('Removed from your account.'); route(); }
    }) : null));
  }

  /** #history (from Needs your attention): unlock once so every TV gets the history key. */
  function historyUnlockPage() {
    var b = body('Share where you stopped between TVs');
    b.insertBefore(back('Profiles', '#'), b.firstChild);
    var n = (S.history && S.history.devicesWaiting) || 0;
    b.appendChild(unlockCard(null, (n ? n + (n === 1 ? ' TV is' : ' TVs are') + ' waiting for the key that keeps what you watch private. ' : '') + 'Unlock once with your passkey; the TVs get the key within a minute while Avid Viewer is open.', function () { say('Done: your TVs get the key within a minute.'); go('#'); }));
  }

  // ------------------------------------------------------------ Favorites & lists, Order & names (1.16.0)
  // Favorites and lists belong to a profile and follow it to every device; order and names belong to a playlist.
  // Changes here or on a TV go to the account; the most recent change wins. Live TV only for now.

  /**
   * Drag-and-drop for the rows of [ul] (each <li> has data-i and a .mg-handle): mouse or touch on the handle, the page
   * scrolling at the window's edges; with a keyboard, Space on the handle picks the row up, ↑ ↓ move it, Space drops it,
   * Esc puts it back. [move](from, to) changes the order and redraws.
   */
  var kbGrab = null; // {list, i} while a row is picked up with the keyboard
  function sortable(ul, listId, move) {
    ul.classList.add('mg-sortable');
    ul.querySelectorAll('.mg-handle').forEach(function (h) {
      var li = h.closest('li'), from = Number(li.dataset.i);
      if (kbGrab && kbGrab.list === listId && kbGrab.i === from) { li.classList.add('mg-grabbed'); setTimeout(function () { h.focus(); }, 0); }
      h.addEventListener('keydown', function (e) {
        var grabbed = kbGrab && kbGrab.list === listId && kbGrab.i === from;
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); kbGrab = grabbed ? null : { list: listId, i: from }; li.classList.toggle('mg-grabbed', !grabbed); say(grabbed ? 'Dropped.' : 'Picked up. Use the arrow keys, then Space to drop.'); }
        else if (grabbed && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          e.preventDefault();
          var to = from + (e.key === 'ArrowUp' ? -1 : 1);
          if (to < 0 || to >= ul.querySelectorAll(':scope > li[data-i]').length) return;
          kbGrab = { list: listId, i: to }; move(from, to);
        } else if (e.key === 'Escape' && grabbed) { kbGrab = null; li.classList.remove('mg-grabbed'); }
      });
      h.addEventListener('pointerdown', function (e) {
        if (e.button !== 0) return;
        e.preventDefault();
        var rows = Array.prototype.slice.call(ul.querySelectorAll(':scope > li[data-i]'));
        var startY = e.clientY, scrollStart = window.scrollY, to = from, line = el('li', 'mg-dropline'); line.setAttribute('aria-hidden', 'true');
        line.appendChild(el('span', null, 'Drop here'));
        li.classList.add('mg-dragging');
        try { h.setPointerCapture(e.pointerId); } catch (err) {}
        var lastY = e.clientY, timer = setInterval(function () {
          var edge = 70, v = lastY < edge ? -(edge - lastY) / 3 : lastY > innerHeight - edge ? (lastY - innerHeight + edge) / 3 : 0;
          if (v) { window.scrollBy(0, v); place(lastY); }
        }, 16);
        var others = rows.filter(function (r) { return r !== li; });
        function place(y) {
          lastY = y;
          li.style.transform = 'translateY(' + (y - startY + window.scrollY - scrollStart) + 'px)';
          to = 0;
          others.forEach(function (r) { var bx = r.getBoundingClientRect(); if (y > bx.top + bx.height / 2) to++; });
          if (to < others.length) ul.insertBefore(line, others[to]); else others[others.length - 1].after(line);
        }
        function moveH(ev) { place(ev.clientY); }
        function up() {
          clearInterval(timer);
          h.removeEventListener('pointermove', moveH); h.removeEventListener('pointerup', up); h.removeEventListener('pointercancel', up);
          li.classList.remove('mg-dragging'); li.style.transform = ''; line.remove();
          if (to !== from) move(from, to);
        }
        h.addEventListener('pointermove', moveH); h.addEventListener('pointerup', up); h.addEventListener('pointercancel', up);
      });
    });
  }
  function handle(label) { var h = el('button', 'mg-handle', '⋮⋮'); h.type = 'button'; h.setAttribute('aria-label', 'Move ' + label + ' (drag, or Space then arrow keys)'); return h; }
  function moveButtons(label, i, n, move) {
    var box = el('span', 'mg-moves');
    [['⤒', 'Move to top', 0], ['▲', 'Move up', i - 1], ['▼', 'Move down', i + 1], ['⤓', 'Move to bottom', n - 1]].forEach(function (x) {
      var b = btn(x[0], 'mg-mv', function () { move(i, x[2]); });
      b.title = x[1]; b.setAttribute('aria-label', x[1] + ': ' + label); b.disabled = x[2] < 0 || x[2] >= n || x[2] === i;
      box.appendChild(b);
    });
    return box;
  }
  function moved(a, from, to) { a = a.slice(); var x = a.splice(from, 1)[0]; a.splice(to, 0, x); return a; }
  /** Rename in place: an input with Save and Cancel; empty = back to the provider's name. */
  function renameRow(slot, current, provider, save) {
    slot.innerHTML = '';
    var box = el('span', 'mg-rename');
    var inp = el('input'); inp.value = current; inp.setAttribute('aria-label', 'New name for ' + provider); inp.maxLength = 80;
    var ok = btn('Save', 'btn btn-primary btn-sm', function () { save(inp.value.trim()); });
    var no = btn('Cancel', 'btn btn-ghost btn-sm', function () { save(null); });
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); ok.click(); } if (e.key === 'Escape') { e.preventDefault(); no.click(); } });
    add(box, add(el('span', 'mg-rename-row'), inp, ok, no), el('span', 'fineprint', 'From the provider: ' + provider + ' · Empty = the provider’s name · Enter saves, Esc cancels'));
    slot.appendChild(box); inp.focus(); inp.select();
  }
  /** Saves a document a moment after the last change; an Undo stack of earlier versions. */
  function saver(path, idKey, id, status) {
    var timer = null, stack = [];
    return {
      push: function (prev) { stack.push(JSON.stringify(prev)); if (stack.length > 50) stack.shift(); },
      undo: function () { return stack.length ? JSON.parse(stack.pop()) : null; },
      canUndo: function () { return stack.length > 0; },
      save: function (data) {
        status.textContent = 'Saving…';
        clearTimeout(timer);
        timer = setTimeout(async function () {
          var b = {}; b[idKey] = id; b.data = data;
          var r = await post(path, b);
          status.textContent = r._ok ? 'Saved · devices pick it up within a minute while Avid Viewer is open' : (r.error || 'Couldn’t save. Check your connection; your change is kept on this page.');
          status.classList.toggle('err', !r._ok);
        }, 500);
      },
    };
  }
  async function getJson(path) { return fetch(path, { credentials: 'same-origin' }).then(function (r) { return r.json(); }); }
  // 1.18.0 sorting: A–Z by the name as shown (renames count), case ignored — the same order the TV uses.
  function byName(a, b) { var x = a.toLowerCase(), y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : (a < b ? -1 : a > b ? 1 : 0); }
  var SORT_LABEL = { provider: 'Provider’s order', az: 'A–Z', manual: 'Manual' };
  function sortSeg(label, modes, current, pick) {
    var g = el('div', 'mg-sortseg'); g.setAttribute('role', 'group'); g.setAttribute('aria-label', label);
    g.appendChild(el('span', null, label + ':'));
    modes.forEach(function (m) {
      var t = btn(SORT_LABEL[m], 'btn btn-ghost btn-sm' + (m === current ? ' on' : ''), function () { if (m !== current) pick(m); });
      t.setAttribute('aria-pressed', String(m === current)); g.appendChild(t);
    });
    return g;
  }
  function effectiveOrder(all, order) { var seen = {}; var out = []; (order || []).forEach(function (x) { if (all.indexOf(x) >= 0 && !seen[x]) { seen[x] = 1; out.push(x); } }); all.forEach(function (x) { if (!seen[x]) out.push(x); }); return out; }

  // ---- a playlist's order and names
  async function orderTab(p) {
    editing = true;
    var b = body(p.name);
    b.insertBefore(back('Playlists', '#'), b.firstChild);
    b.appendChild(subTabs([['Login & profiles', '#edit=' + p.id, ''], ['Order & names', '#edit=' + p.id + '/order', 'order']], 'order'));
    var wait = el('p', 'soft', 'Loading the playlist’s categories…'); b.appendChild(wait);
    var [cat, ord] = await Promise.all([getJson('/api/account/catalog?playlist=' + encodeURIComponent(p.id)), getJson('/api/account/order?playlist=' + encodeURIComponent(p.id))]);
    wait.remove();
    if (!cat.catalog) { b.appendChild(el('p', 'soft', 'No device has sent this playlist’s categories yet. Open Avid Viewer on a device that has it; they arrive within a minute.')); return; }
    var groups = cat.catalog.live || [];
    if (!groups.length) { b.appendChild(el('p', 'soft', 'This playlist has no live TV categories.')); return; }
    var D = ord.data;
    var status = el('p', 'mg-savestate', ord.updatedAt ? 'Last changed ' + when(ord.updatedAt) + ' by ' + (ord.updatedBy || 'a device') : 'In the provider’s order and names');
    var sv = saver('/api/account/order', 'playlistId', p.id, status);
    var selected = null, filter = '';
    add(b, el('p', 'soft', 'The order and names here are what every profile and device shows for ' + p.name + '. What each profile can see is set on its own page.'));
    var wrap = el('div', 'mg-order'); b.appendChild(wrap);
    var foot = el('div', 'mg-order-foot'); b.appendChild(foot);
    var allRaw = groups.map(function (g) { return g.n; });
    function change(mut) { sv.push(D); D = JSON.parse(JSON.stringify(D)); mut(D); sv.save(D); draw(); }
    // How this playlist's channels are sorted: the setting, else Manual when it has an order of its own, else the provider's.
    function sortOf(d) { return d.channelSort || (Object.keys(d.channelOrder || {}).some(function (k) { return (d.channelOrder[k] || []).length; }) ? 'manual' : 'provider'); }
    function shownChans(d, g) {
      var all = g.ch.map(function (c) { return c[0]; }), names = {}; g.ch.forEach(function (c) { names[c[0]] = d.channelNames[c[0]] || c[1]; });
      var m = sortOf(d);
      if (m === 'az') return all.slice().sort(function (a, b2) { return byName(names[a], names[b2]); });
      if (m === 'provider') return all;
      return effectiveOrder(all, d.channelOrder[g.n]);
    }
    // Manual starts from the order shown now, in every category.
    function toManual(d) { if (sortOf(d) === 'manual') return; groups.forEach(function (g) { d.channelOrder[g.n] = shownChans(d, g); }); d.channelSort = 'manual'; }
    function draw() {
      wrap.innerHTML = '';
      // Categories
      var order = effectiveOrder(allRaw, D.groupOrder);
      if (!selected) selected = order[0];
      var left = el('section', 'mg-card mg-order-cats');
      add(left, el('h2', null, 'Live TV categories · ' + order.length));
      add(left, add(el('div', 'mg-arrange'), el('span', null, 'Arrange:'),
        btn('A–Z', 'linkish', function () { change(function (d) { d.groupOrder = order.slice().sort(function (a, b2) { return (d.groupNames[a] || a).localeCompare(d.groupNames[b2] || b2); }); }); }),
        btn('Provider’s order', 'linkish', function () { change(function (d) { d.groupOrder = []; }); })));
      var ul = el('ul', 'mg-rows');
      function moveCat(from, to) { change(function (d) { d.groupOrder = moved(order, from, to); }); }
      order.forEach(function (raw, i) {
        var g = groups.find(function (x) { return x.n === raw; }) || { c: 0 };
        var shown = D.groupNames[raw] || raw;
        var li = el('li', raw === selected ? 'on' : null); li.dataset.i = i;
        var nameSlot = el('span', 'mg-name');
        var nm = btn(shown, 'linkish mg-pick', function () { selected = raw; draw(); });
        add(nameSlot, nm, D.groupNames[raw] ? el('span', 'mg-provider', 'from the provider: ' + raw) : null);
        var ren = btn('Rename', 'linkish', function () {
          renameRow(nameSlot, shown, raw, function (v) {
            if (v === null) return draw();
            change(function (d) { if (v && v !== raw) d.groupNames[raw] = v; else delete d.groupNames[raw]; });
          });
        });
        add(li, handle(shown), el('span', 'mg-pos', String(i + 1)), nameSlot, el('span', 'mg-count', String(g.c)), ren, moveButtons(shown, i, order.length, moveCat));
        ul.appendChild(li);
      });
      left.appendChild(ul);
      sortable(ul, 'cats', moveCat);
      // Channels of the selected category
      var g = groups.find(function (x) { return x.n === selected; }) || { ch: [] };
      var allCh = g.ch.map(function (c) { return c[0]; });
      var nameOf = {}; g.ch.forEach(function (c) { nameOf[c[0]] = c[1]; });
      var mode = sortOf(D);
      var corder = shownChans(D, g);
      var right = el('section', 'mg-card mg-order-chans');
      var find = el('input'); find.type = 'search'; find.placeholder = 'Find a channel'; find.value = filter; find.setAttribute('aria-label', 'Find a channel');
      find.addEventListener('input', function () { filter = find.value; drawChans(); find.focus(); });
      add(right, add(el('div', 'mg-row-head'), el('h2', null, (D.groupNames[selected] || selected) + ' · ' + corder.length + ' channels'), find));
      add(right, sortSeg('Sort channels', ['provider', 'az', 'manual'], mode, function (m) { change(function (d) { if (m === 'manual') toManual(d); else d.channelSort = m; }); }),
        el('p', 'fineprint', 'For every category of ' + p.name + ', on every profile and device. A–Z uses the names as shown, renames included. Dragging a channel switches to Manual, starting from the order shown.'));
      var cul = el('ul', 'mg-rows'); right.appendChild(cul);
      var note = el('p', 'fineprint'); right.appendChild(note);
      function moveCh(from, to) { change(function (d) { toManual(d); d.channelOrder[selected] = moved(corder, from, to); }); }
      function drawChans() {
        cul.innerHTML = '';
        var q = filter.trim().toLowerCase();
        var list = corder.map(function (id, i) { return { id: id, i: i }; }).filter(function (x) { return !q || (D.channelNames[x.id] || nameOf[x.id] || '').toLowerCase().indexOf(q) >= 0; });
        var cap = 400;
        list.slice(0, cap).forEach(function (x) {
          var id = x.id, i = x.i, shown = D.channelNames[id] || nameOf[id] || id;
          var li = el('li'); li.dataset.i = i;
          var nameSlot = el('span', 'mg-name'); add(nameSlot, el('span', 'mg-strong', shown), D.channelNames[id] ? el('span', 'mg-provider', 'from the provider: ' + (nameOf[id] || id)) : null);
          var ren = btn('Rename', 'linkish', function () {
            renameRow(nameSlot, shown, nameOf[id] || id, function (v) {
              if (v === null) return drawChans();
              change(function (d) { if (v && v !== nameOf[id]) d.channelNames[id] = v; else delete d.channelNames[id]; });
            });
          });
          add(li, q ? el('span', 'mg-handle-off') : handle(shown), el('span', 'mg-pos', String(i + 1)), nameSlot, ren, moveButtons(shown, i, corder.length, moveCh));
          cul.appendChild(li);
        });
        if (!q) sortable(cul, 'chans:' + selected, moveCh);
        note.textContent = (list.length > cap ? 'Showing the first ' + cap + ' of ' + list.length + '; use Find or ⤒ / ⤓ for the rest. ' : '') +
          (q ? 'Clear Find to drag. ' : '') + 'Drag by ⋮⋮ (the page scrolls at the edges), ⤒ / ⤓ for the top or bottom, ▲ ▼ for one step. Keyboard: Tab to ⋮⋮, Space, ↑ ↓, Space. A renamed channel shows the provider’s name underneath.';
      }
      drawChans();
      add(wrap, left, right);
      foot.innerHTML = '';
      add(foot, status, btn('Undo last change', 'btn btn-ghost', function () { var u = sv.undo(); if (u) { D = u; sv.save(D); draw(); } }),
        btn('Reset all to the provider’s order and names', 'btn btn-danger', function () {
          if (!confirm('Put every category and channel of ' + p.name + ' back in the provider’s order, with the provider’s names, on every device?')) return;
          change(function (d) { d.groupOrder = []; d.groupNames = {}; d.channelOrder = {}; d.channelNames = {}; d.channelSort = 'provider'; });
        }));
    }
    draw();
  }

  // ---- a profile's favorites and lists
  async function listsTab(q, b) {
    var wait = el('p', 'soft', 'Loading…'); b.appendChild(wait);
    var mine = S.playlists.filter(function (p) { return q.playlists.indexOf(p.id) >= 0 && !p.removing; });
    var [L, cats, ords] = await Promise.all([
      getJson('/api/account/lists?profile=' + encodeURIComponent(q.id)),
      Promise.all(mine.map(function (p) { return getJson('/api/account/catalog?playlist=' + encodeURIComponent(p.id)); })),
      Promise.all(mine.map(function (p) { return getJson('/api/account/order?playlist=' + encodeURIComponent(p.id)); })),
    ]);
    wait.remove();
    // Every channel this profile may see: key "<playlist>:<id>" → {name, group, playlist}.
    var CH = {}, byPl = {};
    mine.forEach(function (p, k) {
      var c = cats[k].catalog, names = (ords[k].data || {}).channelNames || {}, gnames = (ords[k].data || {}).groupNames || {};
      var v = q.visibility[p.id] || { hidden: { live: [] }, allowed: { live: [] }, channels: [] };
      byPl[p.id] = [];
      if (!c) return;
      c.live.forEach(function (g) {
        var ok = q.kids ? (v.allowed.live || []).indexOf(g.n) >= 0 && !ADULT.test(g.n) : (v.hidden.live || []).indexOf(g.n) < 0;
        if (!ok) return;
        var shownG = gnames[g.n] || g.n;
        byPl[p.id].push({ raw: g.n, name: shownG, ch: g.ch });
        g.ch.forEach(function (x) { if ((v.channels || []).indexOf(x[0]) < 0) CH[p.id + ':' + x[0]] = { name: names[x[0]] || x[1], group: shownG, playlist: p.name }; });
      });
    });
    var D = L.data, current = 'fav';
    var status = el('p', 'mg-savestate', L.updatedAt ? 'Last changed ' + when(L.updatedAt) + ' by ' + (L.updatedBy || 'a device') : 'Nothing saved yet');
    var sv = saver('/api/account/lists', 'profileId', q.id, status);
    var wrap = el('div', 'mg-lists'); b.appendChild(wrap);
    var foot = el('div', 'mg-order-foot'); b.appendChild(foot);
    if (!mine.length) { wrap.appendChild(el('p', 'soft', 'Give ' + q.name + ' a playlist first (Overview), then add channels to its lists.')); return; }
    function change(mut) { sv.push(D); D = JSON.parse(JSON.stringify(D)); mut(D); sv.save(D); draw(); }
    function storedKeys(d) { return current === 'fav' ? d.favorites : (d.lists.find(function (l) { return l.id === current; }) || { keys: [] }).keys; }
    function listSort(d) { return (current === 'fav' ? d.favSort : (d.lists.find(function (l) { return l.id === current; }) || {}).sort) === 'az' ? 'az' : 'manual'; }
    // As the TV shows it: A–Z mixes every playlist by name; channels not found keep their place at the end.
    function keysOf(d) {
      var k = storedKeys(d); if (listSort(d) !== 'az') return k;
      var found = k.filter(function (x) { return CH[x]; }).sort(function (a, b2) { return byName(CH[a].name, CH[b2].name); });
      return found.concat(k.filter(function (x) { return !CH[x]; }));
    }
    function setSort(d, m) {
      var shown = keysOf(d);
      if (current === 'fav') d.favSort = m; else d.lists.forEach(function (l) { if (l.id === current) l.sort = m; });
      if (m === 'manual') setKeys(d, shown);
    }
    function setKeys(d, keys) { if (current === 'fav') d.favorites = keys; else d.lists = d.lists.map(function (l) { return l.id === current ? Object.assign({}, l, { keys: keys }) : l; }); }
    function draw() {
      wrap.innerHTML = '';
      if (current !== 'fav' && !D.lists.some(function (l) { return l.id === current; })) current = 'fav';
      // Lists
      var left = el('div', 'mg-lists-left');
      var fav = btn('★ Favorites', 'mg-listbtn' + (current === 'fav' ? ' on' : ''), function () { current = 'fav'; adding = false; draw(); });
      fav.appendChild(el('span', 'mg-count', String(D.favorites.length)));
      left.appendChild(fav);
      var lul = el('ul', 'mg-rows mg-listrows');
      function moveList(from, to) { change(function (d) { d.lists = moved(d.lists, from, to); }); }
      D.lists.forEach(function (l, i) {
        var li = el('li', l.id === current ? 'on' : null); li.dataset.i = i;
        var pick = btn(l.name + (l.hidden ? ' (hidden on the TV)' : ''), 'linkish mg-pick', function () { current = l.id; adding = false; draw(); });
        add(li, handle(l.name), pick, el('span', 'mg-count', String(l.keys.length)));
        lul.appendChild(li);
      });
      left.appendChild(lul);
      sortable(lul, 'lists', moveList);
      add(left, btn('＋ New list', 'btn btn-ghost btn-sm', function () {
        var n = prompt('Name for the new list'); if (!n || !n.trim()) return;
        if (D.lists.some(function (l) { return l.name.toLowerCase() === n.trim().toLowerCase(); })) return say('There’s already a list called ' + n.trim() + '.', true);
        var id = 'w' + Math.random().toString(36).slice(2, 10);
        change(function (d) { d.lists.push({ id: id, name: n.trim(), hidden: false, keys: [] }); }); current = id; draw();
      }), el('p', 'fineprint', 'Drag lists to change their order on the TV. ★ Favorites is always first.'));
      // Channels in the selected list
      var keys = keysOf(D);
      var right = el('section', 'mg-card mg-lists-right');
      var title = current === 'fav' ? '★ Favorites' : (D.lists.find(function (l) { return l.id === current; }) || {}).name;
      add(right, add(el('div', 'mg-row-head'), el('h2', null, title + ' · ' + keys.length + (keys.length === 1 ? ' channel' : ' channels')),
        btn(adding ? 'Done adding' : '＋ Add channels', adding ? 'btn btn-ghost' : 'btn btn-primary', function () {
          var n = Object.keys(picked).length;
          if (adding && n) {
            if (confirm('Add the ' + n + (n === 1 ? ' channel' : ' channels') + ' you ticked? (Cancel leaves them out.)')) addPicked(); else picked = {};
          }
          adding = !adding; draw();
        })));
      if (adding) right.appendChild(addPanel(keys));
      add(right, sortSeg('Sort', ['az', 'manual'], listSort(D), function (m) { change(function (d) { setSort(d, m); }); }),
        el('p', 'fineprint', 'A–Z mixes channels from every playlist by name. Dragging switches to Manual, starting from the order shown.'));
      var ul = el('ul', 'mg-rows');
      function moveCh(from, to) { change(function (d) { if (listSort(d) !== 'manual') setSort(d, 'manual'); setKeys(d, moved(keysOf(d), from, to)); }); }
      if (!keys.length) ul.appendChild(el('li', 'soft', 'No channels yet. Choose Add channels.'));
      keys.forEach(function (k, i) {
        var c = CH[k], li = el('li'); li.dataset.i = i;
        var pid = k.split(':')[0], cid = k.slice(pid.length + 1);
        var nameSlot = el('span', 'mg-name');
        add(nameSlot, el('span', 'mg-strong', c ? c.name : 'A channel not in ' + q.name + '’s playlists'), el('span', 'mg-provider', c ? c.playlist + ' · ' + c.group : 'hidden for ' + q.name + ', or its playlist was removed'));
        var acts = [];
        if (c) acts.push(btn('Rename', 'linkish', function () {
          var k2 = mine.findIndex(function (p) { return p.id === pid; });
          var provider = ((cats[k2].catalog.live.find(function (g) { return g.ch.some(function (x) { return x[0] === cid; }); }) || { ch: [] }).ch.find(function (x) { return x[0] === cid; }) || [0, c.name])[1];
          renameRow(nameSlot, c.name, provider, async function (v) {
            if (v === null) return draw();
            var od = JSON.parse(JSON.stringify(ords[k2].data));
            if (v && v !== provider) od.channelNames[cid] = v; else delete od.channelNames[cid];
            var r = await post('/api/account/order', { playlistId: pid, data: od });
            if (!r._ok) return say(r.error || 'Couldn’t rename it.', true);
            ords[k2].data = r.data; CH[k].name = v || provider;
            say('Renamed in ' + c.playlist + ': every profile and device shows the new name.'); draw();
          });
        }));
        var rm = btn('✕', 'mg-mv mg-rm', function () { change(function (d) { setKeys(d, storedKeys(d).filter(function (x) { return x !== k; })); }); });
        rm.title = 'Remove from ' + title; rm.setAttribute('aria-label', 'Remove ' + (c ? c.name : 'this channel') + ' from ' + title);
        add(li, handle(c ? c.name : 'channel'), el('span', 'mg-pos', String(i + 1)), nameSlot);
        acts.forEach(function (a) { li.appendChild(a); });
        add(li, moveButtons(c ? c.name : 'channel', i, keys.length, moveCh), rm);
        ul.appendChild(li);
      });
      right.appendChild(ul);
      sortable(ul, 'list:' + current, moveCh);
      add(right, el('p', 'fineprint', 'Drag by ⋮⋮ (the page scrolls at the edges), ⤒ / ⤓ for the top or bottom, ▲ ▼ for one step. Keyboard: Tab to ⋮⋮, Space, ↑ ↓, Space. Rename changes the channel’s name in its playlist, on every profile and device. Changes made on the TV come back here; the most recent change wins.'));
      if (current !== 'fav') {
        var l = D.lists.find(function (x) { return x.id === current; });
        add(right, add(el('div', 'mg-listopts'), el('strong', null, 'List options:'),
          btn('Rename', 'linkish', function () { var n = prompt('New name for ' + l.name, l.name); if (n && n.trim()) change(function (d) { d.lists.forEach(function (x) { if (x.id === l.id) x.name = n.trim(); }); }); }),
          btn(l.hidden ? 'Show on the TV' : 'Hide on the TV', 'linkish', function () { change(function (d) { d.lists.forEach(function (x) { if (x.id === l.id) x.hidden = !x.hidden; }); }); }),
          btn('Delete list', 'linkish mg-danger', function () { if (confirm('Delete the list ' + l.name + '? Its channels stay in your playlists.')) change(function (d) { d.lists = d.lists.filter(function (x) { return x.id !== l.id; }); }); })));
      }
      add(wrap, left, right);
      foot.innerHTML = '';
      add(foot, status, btn('Undo last change', 'btn btn-ghost', function () { var u = sv.undo(); if (u) { D = u; sv.save(D); draw(); } }));
    }
    var adding = false, addPl = mine[0] && mine[0].id, addCat = '', addFind = '', picked = {};
    function addPicked() {
      var add2 = Object.keys(picked); if (!add2.length) return;
      picked = {};
      change(function (d) { setKeys(d, storedKeys(d).concat(add2.filter(function (k) { return storedKeys(d).indexOf(k) < 0; }))); });
      say('Added ' + add2.length + (add2.length === 1 ? ' channel.' : ' channels.'));
    }
    function addPanel(keys) {
      var box = el('div', 'mg-addpanel');
      var find = el('input'); find.type = 'search'; find.placeholder = 'Search ' + q.name + '’s channels'; find.value = addFind; find.setAttribute('aria-label', 'Search channels');
      var sel = el('select', 'mg-select'); sel.setAttribute('aria-label', 'Playlist');
      mine.forEach(function (p) { var o = el('option', null, p.name); o.value = p.id; o.selected = p.id === addPl; sel.appendChild(o); });
      // Owner, Nov 19: ticked channels are only added with the Add button, so it's at the top as well as the bottom.
      var topbar = el('div', 'mg-addfoot mg-addtop');
      add(box, add(el('div', 'mg-row-head'), find, sel), topbar);
      var cols = el('div', 'mg-addcols'), catNav = el('nav', 'mg-addcats'), res = el('div', 'mg-addres');
      add(cols, catNav, res); box.appendChild(cols);
      var footer = el('div', 'mg-addfoot'); box.appendChild(footer);
      function drawAdd() {
        catNav.innerHTML = ''; res.innerHTML = '';
        var gs = byPl[addPl] || [];
        if (!gs.length) { res.appendChild(el('p', 'soft', 'No categories for this playlist yet (a device sends them after it loads the playlist).')); }
        if (!addCat && gs.length) addCat = gs[0].raw;
        gs.forEach(function (g) {
          var a = btn(g.name, 'mg-addcat' + (g.raw === addCat && !addFind ? ' on' : ''), function () { addCat = g.raw; addFind = ''; find.value = ''; drawAdd(); });
          a.appendChild(el('span', 'mg-count', String(g.ch.length))); catNav.appendChild(a);
        });
        var qq = addFind.trim().toLowerCase();
        var rows = [];
        if (qq) Object.keys(CH).forEach(function (k) { if (CH[k].name.toLowerCase().indexOf(qq) >= 0) rows.push(k); });
        else (gs.find(function (g) { return g.raw === addCat; }) || { ch: [] }).ch.forEach(function (x) { var k = addPl + ':' + x[0]; if (CH[k]) rows.push(k); });
        // Every channel in the category (or every match), however many: no first-300 limit.
        var free = rows.filter(function (k) { return keys.indexOf(k) < 0; });
        var boxes = [];
        function syncAllBtns() {
          var n = free.filter(function (k) { return picked[k]; }).length;
          allB.disabled = !free.length || n === free.length; noneB.disabled = !n;
        }
        var allB = btn('Select all', 'btn btn-ghost btn-sm', function () { free.forEach(function (k) { picked[k] = 1; }); boxes.forEach(function (b2) { if (!b2.disabled) b2.checked = true; }); syncAllBtns(); drawFoot(); });
        var noneB = btn('Select none', 'btn btn-ghost btn-sm', function () { free.forEach(function (k) { delete picked[k]; }); boxes.forEach(function (b2) { if (!b2.disabled) b2.checked = false; }); syncAllBtns(); drawFoot(); });
        allB.setAttribute('aria-label', 'Select all ' + free.length + ' channels shown'); noneB.setAttribute('aria-label', 'Select none of the channels shown');
        add(res, add(el('div', 'mg-addhead'), el('p', 'fineprint', (qq ? rows.length + ' match “' + addFind.trim() + '” in all of ' + q.name + '’s playlists' : rows.length + (rows.length === 1 ? ' channel' : ' channels')) + (rows.length - free.length ? ' · ' + (rows.length - free.length) + ' already in the list' : '')),
          add(el('div', 'row-btns'), allB, noneB)));
        var frag = document.createDocumentFragment();
        rows.forEach(function (k) {
          var c = CH[k], already = keys.indexOf(k) >= 0;
          var l = el('label', 'mg-addrow'); var cb = el('input'); cb.type = 'checkbox'; cb.checked = already || !!picked[k]; cb.disabled = already;
          cb.addEventListener('change', function () { if (cb.checked) picked[k] = 1; else delete picked[k]; syncAllBtns(); drawFoot(); });
          boxes.push(cb);
          add(l, cb, add(el('span', 'mg-name'), el('span', 'mg-strong', c.name), el('span', 'mg-provider', c.playlist + ' · ' + c.group)), already ? el('span', 'mg-ok', 'Already in the list') : null);
          frag.appendChild(l);
        });
        res.appendChild(frag);
        syncAllBtns();
        drawFoot();
      }
      function drawFoot() {
        var n = Object.keys(picked).length;
        [topbar, footer].forEach(function (f) {
          f.innerHTML = '';
          add(f, el('span', null, n ? n + ' ticked · not added yet; they go at the end' : 'Tick channels, then Add'),
            btn('Add ' + (n || '') + (n === 1 ? ' channel' : ' channels'), 'btn btn-primary', addPicked));
          f.lastChild.disabled = !n;
          f.classList.toggle('dirty', n > 0);
        });
      }
      var t = null;
      find.addEventListener('input', function () { clearTimeout(t); t = setTimeout(function () { addFind = find.value; drawAdd(); find.focus(); }, 200); });
      sel.addEventListener('change', function () { addPl = sel.value; addCat = ''; addFind = ''; drawAdd(); });
      drawAdd();
      return box;
    }
    draw();
  }

  // ------------------------------------------------------------ Devices
  function devicesPage() {
    var b = body('Devices', 'Choose which profiles appear on each device. Its Who\'s watching? screen shows exactly these.');
    // Nov 20, 2026: at most 4 devices per account.
    var limit = S.deviceLimit || 4, full = S.devices.length >= limit;
    var count = el('p', 'mg-count' + (full ? ' mg-warn' : ''), S.devices.length + ' of ' + limit + ' devices linked' +
      (full ? '. That\'s the most an account can have: remove one you no longer use to add another.' : '.'));
    count.id = 'device-count';
    if (full) {
      var addD = el('button', 'btn btn-primary', '＋ Add a device'); addD.type = 'button'; addD.disabled = true; addD.title = 'Remove a device first';
      add(b, count, addD);
    } else {
      var addA = el('a', 'btn btn-primary', '＋ Add a device'); addA.href = '/link/'; add(b, count, addA);
    }
    if (!S.devices.length) b.appendChild(el('p', 'soft', 'No devices linked yet. Open Avid Viewer on a TV and enter the code it shows at avidviewer.app/link.'));
    S.devices.forEach(function (d) {
      var c = el('section', 'mg-card');
      var head = el('div', 'mg-dev-head');
      var isAway = d.lastSeen && Date.now() - d.lastSeen > 7 * 86400000;
      add(head, add(el('div'), add(el('h3', null, d.name), isAway ? el('span', 'mg-chip mg-away', 'Away') : null),
        el('p', 'soft', [d.model, d.appVersion ? 'Avid Viewer ' + d.appVersion : '', ago(d.lastSeen)].filter(Boolean).join(' · ')),
        isAway ? el('p', 'fineprint', 'Changes wait for it and arrive when Avid Viewer is opened on it again. If you no longer use it, remove it' + (full ? ' to make room for another device.' : '.')) : null),
        add(el('div', 'row-btns'),
          btn('Rename', 'linkish', async function () {
            var n = prompt('New name for ' + d.name, d.name); if (!n || !n.trim()) return;
            var r = await post('/api/account/devices/rename', { id: d.id, name: n.trim() }); say(r._ok ? '' : r.error, !r._ok); load();
          }),
          btn('Remove', 'linkish', async function () {
            if (!confirm('Remove ' + d.name + ' from your account? It\'s signed out and asks to be linked again, and its playlists from the account are removed. Its backup is kept for 30 days. This frees a place for another device.')) return;
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
      c.appendChild(betaBlock(d));
      b.appendChild(c);
    });
    b.appendChild(el('p', 'fineprint', 'A device with one profile (or none) shows no profiles at all. Taking a profile off a device removes that profile\'s playlists from it, unless another profile on the device has them.'));
  }

  /** Beta channel (Nov 18, 2026): the owner offers a device; we choose some offered devices to get new versions early. */
  function betaBlock(d) {
    var box = el('div', 'mg-beta');
    add(box, el('h4', null, 'Beta versions'));
    add(box, check('Offer this device beta builds', d.betaOffer, async function (v) {
      if (!v && d.inBeta && !confirm('Leave the beta on ' + d.name + '? It keeps its beta version until a public version catches up, then updates as usual.')) return load();
      var r = await post('/api/account/devices/beta', { deviceId: d.id, offer: v });
      if (!r._ok) { say(r.error, true); return load(); }
      say(v ? 'Offered. If ' + d.name + ' is chosen, you\'ll get an email and it shows Beta in Settings › Updates & about.' : d.name + ' gets public versions only.');
      load();
    }));
    var status = d.inBeta ? 'In the beta: it gets new versions before everyone else.'
      : d.betaOffer ? 'Offered · waiting to be chosen.' : 'Public versions.';
    add(box, add(el('p', 'soft'), d.inBeta ? el('span', 'mg-chip', 'Beta') : null, document.createTextNode(' ' + status)));
    add(box, el('p', 'fineprint', 'Beta versions can have rough edges. Crash reports and playback logs from them are marked beta. Nothing about what you watch is shared.'));
    return box;
  }

  document.querySelectorAll('.mg-signout').forEach(function (b) {
    b.addEventListener('click', function () { post('/api/auth/signout', {}).then(function () { location.href = '/'; }); });
  });
  load().catch(function () { say('Couldn\'t load your account. Reload the page.', true); });
  setInterval(function () { if (!editing && document.visibilityState === 'visible') load().catch(function () {}); }, 15000);
})();
