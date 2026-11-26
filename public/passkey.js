// Passkeys that work on iPhone and iPad as well (Nov 22, 2026).
//
// Safari (and every browser on iOS) opens the passkey sheet only straight from a tap. The pages used to ask the server
// for the passkey's options after the tap, and the Playlists page asked for a second passkey right after making the
// first, so on an iPhone the browser could refuse without showing anything, and the page only said "cancelled".
// Now: options are fetched before the tap and kept fresh; a step that has no tap left gets its own button; errors
// say what happened and what to try; a failed set-up is noted (error name and message only) for the admin view.
(function () {
  var ua = navigator.userAgent || '';
  var iOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  // An app's own built-in browser (no "Safari/" in its name on iOS) usually can't make passkeys for other sites.
  var inApp = iOS && !/Safari\//.test(ua);

  // Nov 26, 2026: what this browser says it can do with passkeys, noted with a failure (and used to explain it).
  var caps = { uvpa: null, list: '' };
  try {
    if (window.PublicKeyCredential && PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable)
      PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().then(function (v) { caps.uvpa = v; }).catch(function () {});
    if (window.PublicKeyCredential && PublicKeyCredential.getClientCapabilities)
      PublicKeyCredential.getClientCapabilities().then(function (c) {
        caps.list = Object.keys(c || {}).filter(function (k) { return /passkey|platform|hybrid|conditional|prf/i.test(k); })
          .map(function (k) { return k + '=' + (c[k] ? 1 : 0); }).join(',');
      }).catch(function () {});
  } catch (e) {}
  function capsText() {
    return 'face/touch/passcode ' + (caps.uvpa === null ? '?' : caps.uvpa ? 'yes' : 'no') + (caps.list ? ' · ' + caps.list : '');
  }

  /** Runs the passkey call [fn] and, if it fails, notes on the error how long the browser took to refuse (e.ms). */
  function timed(fn) {
    var t = Date.now(), r;
    try { r = fn(); } catch (e) { try { e.ms = 0; } catch (x) {} throw e; }
    return Promise.resolve(r).catch(function (e) { try { e.ms = Date.now() - t; } catch (x) {} throw e; });
  }

  function post(path, data) {
    return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(data || {}) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { d._ok = r.ok; d._status = r.status; return d; }); });
  }

  // Options fetched ahead, kept 4 minutes (the server keeps a challenge 5).
  var PATHS = { register: '/api/passkeys/register/options', login: '/api/passkeys/login/options' };
  var ready = {};
  var timers = {};
  function prepare(kind) {
    return post(PATHS[kind]).then(function (o) { if (o._ok) ready[kind] = { o: o, at: Date.now() }; return o; }).catch(function () { return {}; });
  }
  function keepReady(kind) {
    prepare(kind);
    if (!timers[kind]) timers[kind] = setInterval(function () { if (!document.hidden) prepare(kind); }, 240000);
  }
  /** Options for [kind]: the ones fetched ahead (used once), else fetched now. */
  function options(kind) {
    var r = ready[kind]; ready[kind] = null;
    if (timers[kind]) setTimeout(function () { prepare(kind); }, 1000); // the next set, for another try
    if (r && Date.now() - r.at < 240000) return Promise.resolve(r.o);
    return post(PATHS[kind]);
  }

  /** Whether the page has no tap left to open a passkey with (browsers that can tell). */
  function needsTap() { var u = navigator.userActivation; return u ? !u.isActive : false; }

  /**
   * Runs [fn] (which must start the passkey at once) from a tap: straight away when the page still has the user's
   * tap, otherwise after a button of its own. [force] always asks (a second passkey prompt right after a first).
   */
  function fromTap(title, text, label, fn, force) {
    if (!force && !needsTap()) return timed(fn);
    return new Promise(function (resolve, reject) {
      var back = document.createElement('div');
      back.setAttribute('role', 'dialog'); back.setAttribute('aria-modal', 'true');
      back.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:9999;padding:20px';
      var box = document.createElement('div');
      box.style.cssText = 'background:var(--surface,#2b2521);color:var(--text,#ede8e2);border-radius:14px;max-width:420px;width:100%;padding:22px;box-shadow:0 10px 40px rgba(0,0,0,.4)';
      var h = document.createElement('h3'); h.textContent = title; h.style.marginTop = '0';
      var p = document.createElement('p'); p.textContent = text;
      var row = document.createElement('div'); row.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap';
      var no = document.createElement('button'); no.type = 'button'; no.className = 'btn btn-ghost'; no.textContent = 'Not now';
      var go = document.createElement('button'); go.type = 'button'; go.className = 'btn btn-primary'; go.textContent = label;
      function close() { back.remove(); }
      no.addEventListener('click', function () { close(); var e = new Error('Not now'); e.name = 'NotAllowedError'; e.byPage = true; reject(e); });
      // The passkey starts inside this tap (synchronously), as Safari requires.
      go.addEventListener('click', function () { close(); var r; try { r = timed(fn); } catch (e) { reject(e); return; } Promise.resolve(r).then(resolve, reject); });
      row.appendChild(no); row.appendChild(go);
      box.appendChild(h); box.appendChild(p); box.appendChild(row); back.appendChild(box);
      document.body.appendChild(back);
      go.focus();
    });
  }

  function errName(e) { return (e && (e.cause && e.cause.name || e.name)) || 'Error'; }

  /** What to tell the person when making a passkey failed. */
  function explain(e) {
    var n = errName(e);
    if (e && e.byPage) return 'No passkey was made. You can try again whenever you like.';
    if (inApp) return 'This page is open inside another app (such as the Gmail app), which can\'t make passkeys. Open avidviewer.app in Safari, sign in there with a new email link, and try again.';
    if (n === 'InvalidStateError') return 'This device already has a passkey for your account.';
    if (n === 'SecurityError') return 'This browser refused passkeys for this page. Open avidviewer.app directly in Safari or Chrome and try again.';
    if (n === 'NotSupportedError') return 'This browser can\'t make passkeys. Update it, or use Safari or Chrome.';
    if (n === 'AbortError') return 'The passkey was interrupted. Please try again.';
    // Refused within a moment: no Face ID or passcode sheet can have been shown, so it's a setting, not a cancel.
    var quick = e && typeof e.ms === 'number' && e.ms < 1500;
    // Nov 26: an iPhone being controlled from another screen (FaceTime screen sharing / remote control) also reports
    // no Face ID or passcode, so don't claim they aren't set up.
    if (n === 'NotAllowedError' && quick && caps.uvpa === false) {
      return 'This device says Face ID, Touch ID and its passcode can\'t be used right now, so it refused without asking.'
        + (iOS ? ' This happens when the iPhone or iPad is being controlled or shared from another screen (FaceTime screen sharing, remote control or mirroring): end that and tap the button on the device itself.'
          + ' Otherwise, check Settings › Face ID & Passcode (a passcode must be set) and, if Screen Time is on, that Content & Privacy Restrictions allow passcode changes.'
          : ' Make sure this computer has a PIN, fingerprint or face sign-in set up, and that it isn\'t being used through remote desktop.')
        + ' You can also make your passkey on another device (a computer with Chrome works).';
    }
    if (n === 'NotAllowedError' && quick) {
      return (iOS ? 'Your iPhone or iPad refused straight away, without showing Face ID, so a setting on it is stopping passkeys. Check, then try again:'
          + ' (1) Settings › your name › iCloud › Passwords: turn on syncing for this device (or turn on your password manager in Settings › General › AutoFill & Passwords);'
          + ' (2) Settings › Face ID & Passcode: a passcode must be set;'
          + ' (3) if Screen Time is on, Content & Privacy Restrictions must allow passcode and account changes;'
          + ' (4) tap the button on the device itself, not while it\'s being controlled or shared from another screen.'
        : 'Your browser refused straight away, without asking, so a setting is stopping passkeys. Make sure your browser or password manager can save passkeys and that this computer has a PIN, fingerprint or face sign-in set up, then try again.')
        + ' You can also make your passkey on another device (a computer with Chrome works) and use this one later.';
    }
    if (n === 'NotAllowedError') {
      return 'No passkey was made: it was cancelled, or the device didn\'t allow it.' + (iOS
        ? ' On an iPhone or iPad, passkeys are kept in iCloud Keychain: open Settings › your name › iCloud › Passwords and turn on syncing for this device (or, if you use another password manager, turn it on in Settings › General › AutoFill & Passwords), then try again.'
        : ' Make sure your browser or password manager can save passkeys, then try again.');
    }
    return 'The passkey couldn\'t be made (' + n + '). Please try again.';
  }

  /** Notes a failed set-up for the admin view: the step, the error's name and message, nothing else. */
  function report(step, e) {
    if (e && e.byPage) return;
    var how = '[' + (e && typeof e.ms === 'number' ? 'refused after ' + e.ms + ' ms' : 'time unknown') + ' · ' + capsText() + '] ';
    post('/api/passkeys/register/failed', { step: step, error: errName(e), message: (how + String((e && (e.cause && e.cause.message || e.message)) || '')).slice(0, 300) }).catch(function () {});
  }

  window.AvidPasskey = { keepReady: keepReady, options: options, fromTap: fromTap, explain: explain, report: report, iOS: iOS, inApp: inApp };
})();
