// avidviewer.app/setup: turns playlists (or a backup file) into a one-time setup code for a TV.
//
// Everything is encrypted here, in the browser, with a key made from the code. The server gets only the
// ciphertext and a fingerprint of the code, so it never sees a login, a playlist link or the code.
// Must match data/SetupCode.kt in mavenmarty/avid-viewer:
//   code   8 characters from ALPHABET, shown as XXXX-XXXX
//   id     hex SHA-256 of "avidviewer-setup-id:v1:" + code
//   key    PBKDF2-HMAC-SHA256(code, "avidviewer-setup-key:v1", 100,000 rounds) → AES-256-GCM
//   data   Base64(12-byte IV + ciphertext with its 16-byte tag)
//   JSON   {"v":1,"playlists":[{type,name,server,username,password,m3u,epg}],"backup":"<.avbak text>","link":"<token>"}
//          ("link", when signed in: a one-time token the TV trades for its own account link, /api/tv/link/claim)
(function (root) {
  var ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  var ROUNDS = 100000;
  var enc = new TextEncoder();
  var subtle = root.crypto.subtle;

  function newCode() {
    var out = '', buf = new Uint8Array(1);
    while (out.length < 8) {
      root.crypto.getRandomValues(buf);
      if (buf[0] < 248) out += ALPHABET[buf[0] % 31]; // 248 = 8 × 31: no bias
    }
    return out;
  }
  function pretty(code) { return code.slice(0, 4) + '-' + code.slice(4); }
  function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  function b64(bytes) { var s = ''; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }

  async function idFor(code) { return hex(await subtle.digest('SHA-256', enc.encode('avidviewer-setup-id:v1:' + code))); }
  async function keyFor(code) {
    var base = await subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveKey']);
    return subtle.deriveKey({ name: 'PBKDF2', salt: enc.encode('avidviewer-setup-key:v1'), iterations: ROUNDS, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  }
  async function seal(code, payload, iv) {
    iv = iv || root.crypto.getRandomValues(new Uint8Array(12));
    var ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: iv }, await keyFor(code), enc.encode(JSON.stringify(payload))));
    var all = new Uint8Array(12 + ct.length); all.set(iv, 0); all.set(ct, 12);
    return { id: await idFor(code), data: b64(all) };
  }

  root.AvidSetup = { ALPHABET: ALPHABET, newCode: newCode, pretty: pretty, idFor: idFor, seal: seal };
  if (typeof document === 'undefined') return;

  // ---------------------------------------------------------------- page
  var form = document.getElementById('setup-form');
  if (!form) return;
  var list = document.getElementById('playlists');
  var tpl = document.getElementById('playlist-tpl');
  var msg = document.getElementById('setup-msg');
  var result = document.getElementById('setup-result');
  var modeInputs = form.querySelectorAll('input[name="mode"]');

  function addPlaylist() {
    var node = tpl.content.firstElementChild.cloneNode(true);
    list.appendChild(node);
    var remove = node.querySelector('.pl-remove');
    remove.addEventListener('click', function () { node.remove(); renumber(); });
    node.querySelectorAll('input[type="radio"]').forEach(function (r) { r.addEventListener('change', function () { showType(node); }); });
    renumber(); showType(node);
  }
  function renumber() {
    list.querySelectorAll('.pl').forEach(function (n, i) {
      n.querySelector('.pl-n').textContent = 'Playlist ' + (i + 1);
      n.querySelectorAll('input[type="radio"]').forEach(function (r) { r.name = 'type-' + i; });
      n.querySelector('.pl-remove').hidden = list.children.length < 2;
    });
  }
  function showType(node) {
    var xt = node.querySelector('input[value="xtream"]').checked;
    node.querySelector('.pl-xtream').hidden = !xt;
    node.querySelector('.pl-m3u').hidden = xt;
  }
  function mode() { var m = 'playlists'; modeInputs.forEach(function (r) { if (r.checked) m = r.value; }); return m; }
  function showMode() {
    document.getElementById('mode-playlists').hidden = mode() !== 'playlists';
    document.getElementById('mode-backup').hidden = mode() !== 'backup';
  }
  modeInputs.forEach(function (r) { r.addEventListener('change', showMode); });
  document.getElementById('add-playlist').addEventListener('click', addPlaylist);
  addPlaylist(); showMode();

  // Signed in: offer to link the TV to the account too (a one-time link token travels inside the encrypted setup).
  var signedIn = false;
  fetch('/api/me', { credentials: 'same-origin' }).then(function (r) {
    if (!r.ok) return;
    return r.json().then(function (me) {
      signedIn = true;
      document.getElementById('link-email').textContent = me.email;
      document.getElementById('link-opt').hidden = false;
    });
  }).catch(function () {});

  function v(node, sel) { var el = node.querySelector(sel); return el ? el.value.trim() : ''; }
  function fail(text) { msg.className = 'form-msg err'; msg.textContent = text; }

  async function collect() {
    if (mode() === 'backup') {
      var f = document.getElementById('backup-file').files[0];
      if (!f) throw new Error('Choose your backup file (it ends in .avbak).');
      if (f.size > 900000) throw new Error('That file is too big to be an Avid Viewer backup.');
      var text = await f.text();
      var ok = false;
      try { ok = JSON.parse(text).avidViewerBackup === 1; } catch (e) { ok = false; }
      if (!ok) throw new Error("That file isn't an Avid Viewer backup (they end in .avbak).");
      return { v: 1, playlists: [], backup: text };
    }
    var out = [];
    list.querySelectorAll('.pl').forEach(function (n) {
      var xt = n.querySelector('input[value="xtream"]').checked;
      var p = xt
        ? { type: 'xtream', name: v(n, '.f-name'), server: v(n, '.f-server'), username: v(n, '.f-user'), password: n.querySelector('.f-pass').value, epg: v(n, '.f-epg') }
        : { type: 'm3u', name: v(n, '.f-name'), m3u: v(n, '.f-m3u'), epg: v(n, '.f-epg') };
      out.push(p);
    });
    out.forEach(function (p, i) {
      var which = out.length > 1 ? ' (playlist ' + (i + 1) + ')' : '';
      if (p.type === 'xtream' && (!p.server || !p.username || !p.password)) throw new Error('Enter the server, username and password' + which + '.');
      if (p.type === 'm3u' && !/^https?:\/\//i.test(p.m3u)) throw new Error('Enter the M3U link, starting with http:// or https://' + which + '.');
    });
    return { v: 1, playlists: out };
  }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    var button = form.querySelector('button[type="submit"]');
    msg.className = 'form-msg'; msg.textContent = '';
    var payload;
    try { payload = await collect(); } catch (err) { fail(err.message); return; }
    if (signedIn && document.getElementById('link-account').checked) {
      var lt = await fetch('/api/link/setup-token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: '{}' })
        .then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; });
      if (lt.linkToken) payload.link = lt.linkToken;
    }
    button.disabled = true;
    msg.textContent = 'Making your code…';
    try {
      var code = newCode();
      var sealed = await seal(code, payload);
      var r = await fetch('/api/setup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: sealed.id, data: sealed.data, website: form.website.value }),
      });
      var d = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error(d.error || 'Something went wrong. Please try again.');
      msg.textContent = '';
      document.getElementById('code').textContent = pretty(code);
      document.getElementById('code-expires').textContent = new Date(d.expires).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      result.hidden = false;
      form.hidden = true;
      result.scrollIntoView({ behavior: 'smooth', block: 'start' });
      form.querySelectorAll('.f-pass').forEach(function (p) { p.value = ''; });
    } catch (err) {
      fail(err.message || "Couldn't reach the server. Please try again.");
    } finally {
      button.disabled = false;
    }
  });

  document.getElementById('start-over').addEventListener('click', function () {
    result.hidden = true; form.hidden = false;
  });
})(typeof window !== 'undefined' ? window : globalThis);
