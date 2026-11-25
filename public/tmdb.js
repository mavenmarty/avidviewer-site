// Copy buttons on /tmdb/ and in the Discover tab: <button data-copy="id-of-element-with-the-text">.
(function () {
  document.addEventListener('click', async function (e) {
    var b = e.target.closest && e.target.closest('[data-copy]');
    if (!b) return;
    var src = document.getElementById(b.getAttribute('data-copy'));
    if (!src) return;
    var text = src.textContent.trim(), was = b.textContent;
    try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; }
    catch (err) {
      var r = document.createRange(); r.selectNodeContents(src);
      var s = window.getSelection(); s.removeAllRanges(); s.addRange(r); b.textContent = 'Selected: press Ctrl+C';
    }
    setTimeout(function () { b.textContent = was; }, 1800);
  });
})();
