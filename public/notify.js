// Launch-news sign-up: posts to /api/notify without leaving the page.
(function () {
  var form = document.getElementById('notify-form');
  var msg = document.getElementById('form-msg');
  if (!form || !msg) return;

  if (location.search.indexOf('subscribed=1') !== -1) {
    msg.textContent = "You're on the list. We'll email you when accounts launch.";
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var button = form.querySelector('button');
    msg.className = 'form-msg';
    msg.textContent = 'Signing you up…';
    button.disabled = true;
    fetch('/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: form.email.value, website: form.website.value })
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (res.ok) {
          msg.textContent = res.d.message || "You're on the list.";
          form.reset();
        } else {
          msg.className = 'form-msg err';
          msg.textContent = res.d.error || 'Something went wrong. Please try again.';
        }
      })
      .catch(function () {
        msg.className = 'form-msg err';
        msg.textContent = "Couldn't reach the server. Please try again.";
      })
      .then(function () { button.disabled = false; });
  });
})();
