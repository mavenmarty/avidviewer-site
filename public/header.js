// Site header: "Sign up / Sign in" becomes the account's name once signed in (opens the account pages).
(function () {
  var a = document.getElementById('hdr-account');
  if (!a) return;
  fetch('/api/me?brief=1', { credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (me) {
      if (!me || !me.signedIn || !me.name) return;
      a.textContent = me.name;
      a.href = '/playlists/';
      a.title = 'Your account';
      a.setAttribute('aria-label', 'Your account (' + me.name + ')');
    })
    .catch(function () {});
})();

// Phones: the links fold into a Menu button (the account button stays in the header).
(function () {
  var t = document.querySelector('.nav-toggle'), h = document.querySelector('.site-header');
  if (!t || !h) return;
  function set(open) { h.classList.toggle('open', open); t.setAttribute('aria-expanded', String(open)); }
  t.addEventListener('click', function () { set(!h.classList.contains('open')); });
  document.getElementById('nav-links').addEventListener('click', function (e) { if (e.target.closest('a')) set(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && h.classList.contains('open')) { set(false); t.focus(); } });
  document.addEventListener('click', function (e) { if (h.classList.contains('open') && !h.contains(e.target)) set(false); });
})();
