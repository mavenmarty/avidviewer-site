/* avidviewer.app/player-check/ (Nov 17, 2026): can this browser play the account's playlists? A first step towards a
 * web player. The passkey unlocks each playlist's login here (the same vault as the Playlists page; this page never
 * makes a vault key). Requests go from this browser straight to the provider; nothing about the logins, the streams
 * or the results is sent to avidviewer.app. Addresses shown on the page have the username and password replaced. */
(function () {
  'use strict';
  var root = document.getElementById('pc');
  if (!root) return;
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function add(p) { for (var i = 1; i < arguments.length; i++) if (arguments[i]) p.appendChild(arguments[i]); return p; }
  function say(t, bad) { var m = $('pc-msg'); m.textContent = t || ''; m.classList.toggle('bad', !!bad); }
  var TIMEOUT = 20000;

  // ------------------------------------------------------------ the vault (same as manage.js; never creates a key)
  var b64d = function (s) { return Uint8Array.from(atob(s), function (c) { return c.charCodeAt(0); }); };
  async function dec(key, text) {
    var all = b64d(text);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, key, all.slice(12)));
  }
  async function unlock(vaultRows) {
    if (!window.PublicKeyCredential || !navigator.credentials) throw new Error('This browser has no passkeys. Try Chrome, Edge or Safari.');
    if (!vaultRows.length) throw new Error('Your account doesn\'t keep any logins yet. Open Playlists and choose Set up with passkey first.');
    var salt = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('avidviewer-vault-prf:v1')));
    var cred;
    try {
      cred = await navigator.credentials.get({ publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: location.hostname, userVerification: 'required', timeout: 120000,
        extensions: { prf: { eval: { first: salt } } },
      } });
    } catch (e) { throw new Error(e && e.name === 'NotAllowedError' ? 'The passkey was cancelled, so nothing was checked.' : 'The passkey didn\'t work in this browser.'); }
    var res = cred && cred.getClientExtensionResults ? cred.getClientExtensionResults() : {};
    var out = res && res.prf && res.prf.results && res.prf.results.first;
    if (!out) throw new Error('This passkey can\'t unlock logins in this browser. Try another browser or password manager.');
    var hk = await crypto.subtle.importKey('raw', out, 'HKDF', false, ['deriveKey']);
    var kek = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('avidviewer-vault:v1') },
      hk, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    var row = vaultRows.find(function (k) { return k.credentialId === cred.id; });
    if (!row) throw new Error('Your logins are locked with a different passkey. Choose the one you used when you first saved a playlist.');
    return crypto.subtle.importKey('raw', await dec(kek, row.wrapped), 'AES-GCM', false, ['decrypt']);
  }

  // ------------------------------------------------------------ addresses
  var ON_HTTPS = location.protocol === 'https:';
  function base(server) {
    var s = String(server || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
    return s;
  }
  function httpsOf(b, port) {
    var u = new URL(b); u.protocol = 'https:'; u.port = port && String(port) !== '443' ? String(port) : ''; return u.origin + u.pathname.replace(/\/+$/, '');
  }
  var L = null; // current login, for hiding it in what's shown
  function hide(u) {
    var s = String(u || '');
    if (L) [L.username, L.password].forEach(function (x) { if (!x || String(x).length < 2) return; s = s.split(String(x)).join('•••'); s = s.split(encodeURIComponent(x)).join('•••'); });
    return s.replace(/(username|password)=[^&]*/gi, '$1=•••');
  }

  // ------------------------------------------------------------ provider API (needs the provider to allow other sites)
  async function getJson(url) {
    var ctl = new AbortController(); var t = setTimeout(function () { ctl.abort(); }, 15000);
    try {
      var r = await fetch(url, { signal: ctl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!r.ok) return { fail: 'status', status: r.status };
      try { return { data: await r.json() }; } catch (e) { return { fail: 'notjson' }; }
    } catch (e) {
      return { fail: e && e.name === 'AbortError' ? 'timeout' : (ON_HTTPS && /^http:/i.test(url) ? 'mixed' : 'blocked') };
    } finally { clearTimeout(t); }
  }
  async function getText(url) {
    var ctl = new AbortController(); var t = setTimeout(function () { ctl.abort(); }, 20000);
    try {
      var r = await fetch(url, { signal: ctl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!r.ok) return { fail: 'status', status: r.status };
      return { text: (await r.text()).slice(0, 3000000) };
    } catch (e) {
      return { fail: e && e.name === 'AbortError' ? 'timeout' : (ON_HTTPS && /^http:/i.test(url) ? 'mixed' : 'blocked') };
    } finally { clearTimeout(t); }
  }
  var WHY = {
    mixed: 'The provider only answers on http://, and browsers don\'t let an https:// page load from it.',
    blocked: 'The provider doesn\'t let other websites read from it (no CORS), or couldn\'t be reached from this browser.',
    timeout: 'The provider didn\'t answer within 15 seconds.',
    notjson: 'The provider answered, but not with what an Xtream server sends.',
  };
  function why(r) { return r.fail === 'status' ? 'The provider answered with an error (HTTP ' + r.status + ').' : WHY[r.fail] || 'Unknown problem.'; }

  // ------------------------------------------------------------ media tests (one at a time, muted)
  var video = null, hls = null;
  function stopMedia() {
    if (hls) { try { hls.destroy(); } catch (e) { /* gone */ } hls = null; }
    if (video) { try { video.pause(); } catch (e) { /* gone */ } video.removeAttribute('src'); video.load(); }
  }
  function mediaWhy(v) {
    var e = v && v.error; var m = e && e.message ? ' (' + e.message + ')' : '';
    if (!e) return 'It didn\'t start within 20 seconds.';
    if (e.code === 4) return 'This browser couldn\'t open it: the format isn\'t supported here (MKV, HEVC or MPEG-TS, for example), or the address was refused' + m + '.';
    if (e.code === 2) return 'The stream stopped arriving' + m + '.';
    if (e.code === 3) return 'The video couldn\'t be decoded' + m + '.';
    return 'Playback failed' + m + '.';
  }
  /** Plays [url] muted; resolves {ok, info} or {ok:false, why}. hlsMode: use hls.js (or Safari's own HLS). */
  function tryPlay(url, hlsMode, label) {
    return new Promise(function (resolve) {
      stopMedia();
      $('pc-stage').hidden = false; $('pc-now').textContent = 'Trying ' + label + '…';
      var done = false;
      function finish(r) { if (done) return; done = true; clearTimeout(t); var w = video.videoWidth, h = video.videoHeight; stopMedia(); if (r.ok && w) r.info = w + '×' + h; resolve(r); }
      var t = setTimeout(function () { finish({ ok: false, why: mediaWhy(video) }); }, TIMEOUT);
      video.onplaying = function () { setTimeout(function () { finish({ ok: true }); }, 1500); };
      video.onerror = function () { finish({ ok: false, why: mediaWhy(video) }); };
      if (hlsMode && window.Hls && window.Hls.isSupported()) {
        hls = new window.Hls({ enableWorker: true, lowLatencyMode: false, manifestLoadingMaxRetry: 0, levelLoadingMaxRetry: 0, fragLoadingMaxRetry: 1 });
        hls.on(window.Hls.Events.ERROR, function (_, d) {
          if (!d.fatal) return;
          var code = d.response && d.response.code;
          var w = ON_HTTPS && /^http:/i.test(url) ? WHY.mixed
            : (code === 0 || code == null) && /manifest|level|frag/i.test(d.details || '') ? 'The provider doesn\'t let other websites load its live streams (no CORS), or the stream redirects to an http:// address.'
            : code ? 'The provider answered with an error (HTTP ' + code + ').' : 'The live stream couldn\'t be played (' + d.details + ').';
          finish({ ok: false, why: w });
        });
        hls.loadSource(url); hls.attachMedia(video);
        hls.on(window.Hls.Events.MANIFEST_PARSED, function () { video.play().catch(function () { /* muted: allowed */ }); });
      } else {
        if (hlsMode && !video.canPlayType('application/vnd.apple.mpegurl')) { finish({ ok: false, why: 'This browser can\'t play live (HLS) streams.' }); return; }
        video.src = url; video.play().catch(function () { /* errors come through onerror */ });
      }
    });
  }

  // ------------------------------------------------------------ one playlist
  async function checkXtream(login, catalog, row) {
    var orig = base(login.server), u = encodeURIComponent(login.username || ''), p = encodeURIComponent(login.password || '');
    var api = function (b, q) { return b + '/player_api.php?username=' + u + '&password=' + p + (q ? '&' + q : ''); };
    // 1. The address, and whether this browser may read the provider's answers.
    var bases = [orig]; if (/^http:/i.test(orig)) bases.push(httpsOf(orig));
    var good = null, first = null, info = null;
    for (var i = 0; i < bases.length && !good; i++) {
      var r = await getJson(api(bases[i]));
      if (i === 0) first = r;
      if (r.data && r.data.user_info) { good = bases[i]; info = r.data; }
      else if (r.data && i === 0) { first = { fail: 'notjson' }; }
    }
    if (!good && info === null && first && first.fail === 'mixed' && bases[1]) {
      // the https copy failed too: say so plainly
    }
    var si = info && info.server_info || {};
    if (!good && si.https_port) bases.push(httpsOf(orig, si.https_port));
    row('Address', /^https:/i.test(orig) ? true : null, /^https:/i.test(orig) ? 'Uses https://.' : 'Uses http://. Browsers block http:// streams inside https:// pages, so a web player needs the provider on https://' + (good && good !== orig ? ' (it answered on ' + hide(good) + ').' : '.'));
    row('Provider answers this browser', !!good, good ? 'Yes' + (info.user_info.status ? ' (account ' + info.user_info.status + ')' : '') + '. A web player could list channels, movies and series from the provider.' : why(first) + ' A web player would have to use the channel lists your TVs send (live only, no guide).');
    var b = good || bases[bases.length - 1];
    var formats = info && info.user_info && info.user_info.allowed_output_formats || null;

    // 2. Live: the first live channel (the catalog your devices sent, else the provider's list).
    var liveId = null, liveName = '';
    var cat = (catalog && catalog.live || []).find(function (c) { return c.ch && c.ch.length; });
    if (cat) { liveId = cat.ch[0][0]; liveName = cat.ch[0][1]; }
    if (!liveId && good) {
      var lc = await getJson(api(b, 'action=get_live_categories'));
      var c0 = lc.data && lc.data[0];
      var ls = c0 ? await getJson(api(b, 'action=get_live_streams&category_id=' + encodeURIComponent(c0.category_id))) : {};
      var s0 = ls.data && ls.data[0]; if (s0) { liveId = s0.stream_id; liveName = s0.name; }
    }
    if (!liveId) row('Live channel', null, 'No live channel to try (no device has sent this playlist\'s channels, and the provider\'s list couldn\'t be read).');
    else if (formats && formats.length && formats.indexOf('m3u8') < 0) row('Live channel', false, 'Your provider account offers live TV only as MPEG-TS (' + formats.join(', ') + '); browsers need HLS (m3u8).');
    else {
      var lr = await tryPlay(b + '/live/' + u + '/' + p + '/' + liveId + '.m3u8', true, 'a live channel');
      row('Live channel', lr.ok, lr.ok ? 'Played' + (lr.info ? ' at ' + lr.info : '') + ' (' + liveName + ').' : lr.why);
    }

    // 3. A movie and an episode (needs the provider's lists).
    if (!good) {
      row('Movie', null, 'Not tried: movies are listed only by the provider, which this browser can\'t read.');
      row('Episode', null, 'Not tried, for the same reason.');
      return;
    }
    var vc = await getJson(api(b, 'action=get_vod_categories'));
    var vs = vc.data && vc.data[0] ? await getJson(api(b, 'action=get_vod_streams&category_id=' + encodeURIComponent(vc.data[0].category_id))) : {};
    var m0 = vs.data && vs.data.find(function (x) { return /^(mp4|m4v|webm|mov)$/i.test(x.container_extension || ''); }) || (vs.data && vs.data[0]);
    if (!m0) row('Movie', null, 'The provider listed no movies.');
    else {
      var ext = m0.container_extension || 'mp4';
      var mr = await tryPlay(b + '/movie/' + u + '/' + p + '/' + m0.stream_id + '.' + ext, false, 'a movie');
      row('Movie', mr.ok, (mr.ok ? 'Played' + (mr.info ? ' at ' + mr.info : '') : mr.why) + ' (' + ext.toUpperCase() + ' file' + ').');
    }
    var sc = await getJson(api(b, 'action=get_series_categories'));
    var ss = sc.data && sc.data[0] ? await getJson(api(b, 'action=get_series&category_id=' + encodeURIComponent(sc.data[0].category_id))) : {};
    var e0 = null;
    if (ss.data && ss.data[0]) {
      var si2 = await getJson(api(b, 'action=get_series_info&series_id=' + encodeURIComponent(ss.data[0].series_id)));
      var eps = si2.data && si2.data.episodes || {};
      Object.keys(eps).some(function (k) { e0 = (eps[k] || [])[0]; return !!e0; });
    }
    if (!e0) row('Episode', null, 'The provider listed no episodes.');
    else {
      var ext2 = e0.container_extension || 'mp4';
      var er = await tryPlay(b + '/series/' + u + '/' + p + '/' + e0.id + '.' + ext2, false, 'an episode');
      row('Episode', er.ok, (er.ok ? 'Played' + (er.info ? ' at ' + er.info : '') : er.why) + ' (' + ext2.toUpperCase() + ' file).');
    }
  }

  async function checkM3u(login, row) {
    var url = String(login.m3uUrl || '').trim();
    row('Address', /^https:/i.test(url) ? true : null, /^https:/i.test(url) ? 'Uses https://.' : 'Uses http://. Browsers block http:// streams inside https:// pages.');
    var r = await getText(url);
    if (!r.text) { row('Provider answers this browser', false, why(r) + ' A web player would have to use the channel lists your TVs send.'); return; }
    row('Provider answers this browser', true, 'Yes. The playlist file can be read here.');
    var entries = [], lines = r.text.split(/\r?\n/), name = '';
    for (var i = 0; i < lines.length && entries.length < 20000; i++) {
      var l = lines[i].trim();
      if (l.indexOf('#EXTINF') === 0) name = l.replace(/^.*,/, '');
      else if (l && l[0] !== '#') { entries.push({ name: name, url: l }); name = ''; }
    }
    var live = entries.find(function (e) { return !/\/(movie|series)\//i.test(e.url) && !/\.(mp4|mkv|avi|m4v|webm|mov)(\?|$)/i.test(e.url); });
    var movie = entries.find(function (e) { return /\/movie\//i.test(e.url) || /\.(mp4|mkv|m4v|webm|mov)(\?|$)/i.test(e.url); });
    var ep = entries.find(function (e) { return /\/series\//i.test(e.url); });
    if (!live) row('Live channel', null, 'No live channel in the file.');
    else {
      var lu = /\.m3u8(\?|$)/i.test(live.url) ? live.url : live.url.replace(/\.ts(\?|$)/i, '.m3u8$1');
      var lr = await tryPlay(lu, true, 'a live channel');
      if (!lr.ok && lu !== live.url) lr = await tryPlay(live.url, false, 'a live channel');
      row('Live channel', lr.ok, lr.ok ? 'Played' + (lr.info ? ' at ' + lr.info : '') + ' (' + live.name + ').' : lr.why);
    }
    for (var pair of [['Movie', movie], ['Episode', ep]]) {
      if (!pair[1]) { row(pair[0], null, 'None in the file.'); continue; }
      var mr = await tryPlay(pair[1].url, false, pair[0].toLowerCase());
      row(pair[0], mr.ok, mr.ok ? 'Played' + (mr.info ? ' at ' + mr.info : '') + '.' : mr.why);
    }
  }

  // ------------------------------------------------------------ the page
  var S = null;
  async function load() {
    var r = await fetch('/api/account/manage', { credentials: 'same-origin' });
    if (r.status === 401) { location.href = '/signin/?next=' + encodeURIComponent(location.pathname); return null; }
    return r.json();
  }
  function mark(v) { return v === true ? '✓' : v === false ? '✕' : '–'; }
  async function run() {
    var start = $('pc-start'); start.disabled = true; say('');
    $('pc-results').innerHTML = ''; $('pc-summary').hidden = true;
    try {
      S = S || await load(); if (!S) return;
      var pls = (S.playlists || []).filter(function (p) { return !p.removing; });
      if (!pls.length) { say('Your account has no playlists yet.', true); return; }
      say('Waiting for your passkey…');
      var key = await unlock(S.vault || []);
      say('Checking ' + pls.length + (pls.length === 1 ? ' playlist' : ' playlists') + '. Keep this tab open; it takes about a minute each.');
      var totals = { live: 0, movie: 0, episode: 0, api: 0, n: 0 };
      for (var i = 0; i < pls.length; i++) {
        var p = pls[i];
        var card = add(el('section', 'mg-card pc-card'), el('h2', null, p.name));
        var list = add(card, el('ul', 'pc-rows'));
        $('pc-results').appendChild(card);
        var row = function (label, ok, text) {
          var li = add(el('li', 'pc-row ' + (ok === true ? 'ok' : ok === false ? 'no' : 'na')), el('span', 'pc-mark', mark(ok)), el('strong', null, label), el('span', 'soft', hide(text)));
          list.appendChild(li);
          if (ok === true) { if (label === 'Live channel') totals.live++; if (label === 'Movie') totals.movie++; if (label === 'Episode') totals.episode++; if (label === 'Provider answers this browser') totals.api++; }
        };
        var v = await fetch('/api/account/playlists/vault?id=' + encodeURIComponent(p.id), { credentials: 'same-origin' }).then(function (x) { return x.json(); }).catch(function () { return {}; });
        if (!v.vault) { row('Login', null, 'This playlist\'s login isn\'t kept in your account yet, so it can\'t be tried here. Open it on the Playlists page and save the login once.'); continue; }
        var login;
        try { login = JSON.parse(new TextDecoder().decode(await dec(key, v.vault))); } catch (e) { row('Login', false, 'The login couldn\'t be unlocked with this passkey.'); continue; }
        L = login; totals.n++;
        var catalog = null;
        try { var c = await fetch('/api/account/catalog?playlist=' + encodeURIComponent(p.id), { credentials: 'same-origin' }).then(function (x) { return x.json(); }); catalog = c.catalog || null; } catch (e) { /* none */ }
        try {
          if ((login.type || p.type) === 'm3u' || (!login.server && login.m3uUrl)) await checkM3u(login, row);
          else await checkXtream(login, catalog, row);
        } catch (e) { row('Check', false, 'The check stopped: ' + (e && e.message || e)); }
        L = null; login = null;
      }
      stopMedia(); $('pc-stage').hidden = true;
      var sum = $('pc-summary'); sum.innerHTML = ''; sum.hidden = false;
      var n = totals.n;
      add(sum, el('h2', null, 'What a web player could do in this browser'),
        el('p', null, n ? ('Live TV played from ' + totals.live + ' of ' + n + ', movies from ' + totals.movie + ' of ' + n + ', episodes from ' + totals.episode + ' of ' + n + ' playlists. The provider could be read directly for ' + totals.api + ' of ' + n + '.') : 'No playlist could be tried.'),
        el('p', 'fineprint', 'Nothing from this check was sent to avidviewer.app. Run it again in another browser to compare.'));
      root.insertBefore(sum, $('pc-stage'));
      say('Done.');
    } catch (e) {
      stopMedia(); $('pc-stage').hidden = true;
      say(e && e.message || String(e), true);
    } finally { start.disabled = false; }
  }
  video = $('pc-video');
  $('pc-start').addEventListener('click', run);
  load().then(function (s) { S = s; }).catch(function () { /* shown on start */ });
})();
