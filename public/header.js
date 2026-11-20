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
