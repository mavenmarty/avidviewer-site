/* Report a problem (avidviewer.app/report/?c=CODE), opened from the TV's Report a bug QR code. No sign-in: the code,
 * made by the TV, says which device it's about. See src/worker/reports.js. */
(function () {
  'use strict';
  var code = new URLSearchParams(location.search).get('c') || '';
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  var info = null;
  function expired(msg) { $('rf-for').textContent = msg; $('rf-form').hidden = true; }
  if (!/^[A-Za-z0-9]{10}$/.test(code)) { expired('Scan the QR code in Avid Viewer on your TV: Settings › Updates & about › Report a bug.'); return; }
  fetch('/api/report/form?c=' + encodeURIComponent(code)).then(function (r) { return r.json().then(function (d) { d._ok = r.ok; return d; }); }).then(function (d) {
    if (!d._ok) { expired(d.error || 'This code has expired.'); return; }
    info = d;
    var model = (d.model || '').split(' \u00b7 ')[0];
    $('rf-for').textContent = 'From ' + d.device + (model && model.indexOf(d.device) !== 0 && d.device.indexOf(model) !== 0 ? ' (' + model + ')' : '') + ' · Avid Viewer ' + d.version + '. Tell us what went wrong and we’ll look into it.';
    if (d.crash) { $('rf-crash-wrap').hidden = false; $('rf-crash-text').textContent = d.crash.split('\n')[0]; }
    $('rf-form').hidden = false;
    $('rf-what').focus();
  }).catch(function () { expired('Couldn’t load this page. Check your connection and try again.'); });

  $('rf-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var what = $('rf-what').value.trim();
    if (what.length < 5) { $('rf-msg').textContent = 'Tell us what happened (a few words is enough).'; $('rf-msg').classList.add('err'); $('rf-what').focus(); return; }
    var often = (document.querySelector('input[name=often]:checked') || {}).value || '';
    $('rf-send').disabled = true; $('rf-msg').classList.remove('err'); $('rf-msg').textContent = 'Sending…';
    fetch('/api/report/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      c: code, what: what, steps: $('rf-steps').value.trim(), where: $('rf-where').value, often: often, crash: !$('rf-crash-wrap').hidden && $('rf-crash').checked, website: $('rf-hp').value,
    }) }).then(function (r) { return r.json().then(function (d) { d._ok = r.ok; return d; }); }).then(function (d) {
      $('rf-send').disabled = false;
      if (!d._ok) { $('rf-msg').textContent = d.error || 'That didn’t work. Try again.'; $('rf-msg').classList.add('err'); return; }
      $('rf-form').hidden = true;
      var box = $('rf-done'); box.hidden = false; box.innerHTML = '';
      box.appendChild(el('h2', null, 'Thanks. It’s on its way.'));
      box.appendChild(el('p', null, 'Report ' + d.id + '.'));
      if (d.linked) {
        var p = el('p', null, 'Follow it at '); var a = el('a', null, 'avidviewer.app › Reports'); a.href = '/reports/'; p.appendChild(a);
        p.appendChild(document.createTextNode(': each step shows there as it happens.')); box.appendChild(p);
      } else {
        box.appendChild(el('p', null, 'This TV isn’t linked to an Avid Viewer account, so you can’t follow this report. Link it (Settings › Account on the TV), and it shows at avidviewer.app › Reports.'));
      }
    }).catch(function () { $('rf-send').disabled = false; $('rf-msg').textContent = 'Couldn’t send. Check your connection and try again.'; $('rf-msg').classList.add('err'); });
  });
})();
