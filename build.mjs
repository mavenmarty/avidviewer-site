// Builds the static site into dist/.
// - Pages in src/pages/*.html are wrapped in the shared layout.
// - The user guide and release notes are pulled from the app repo's docs/USER_GUIDE.md,
//   so they always match the latest published app.
import { readFile, writeFile, mkdir, readdir, cp, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { Marked } from 'marked';

const OUT = 'dist';
const GUIDE_RAW = 'https://raw.githubusercontent.com/mavenmarty/avid-viewer/main/docs';
const SITE = 'https://avidviewer.app';

const logo = `<svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true"><rect width="34" height="34" rx="9" fill="#E9A23B"/><path d="M5 17c3.5-6 7.5-9 12-9s8.5 3 12 9c-3.5 6-7.5 9-12 9s-8.5-3-12-9z" fill="none" stroke="#1A1208" stroke-width="2.4" stroke-linejoin="round"/><circle cx="17" cy="17" r="4.2" fill="#1A1208"/></svg>`;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function layout({ title, description, nav, path, body, scripts = '' }) {
  const cur = (k) => (nav === k ? ' aria-current="page"' : '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${SITE}${path}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${SITE}${path}">
<meta property="og:type" content="website">
<meta name="theme-color" content="#14100D">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/site.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-header">
  <div class="wrap">
    <a class="brand" href="/">${logo}<span>Avid Viewer</span></a>
    <nav class="nav" aria-label="Main">
      <a href="/#features">Features</a>
      <a href="/#devices">Devices</a>
      <a href="/guide/"${cur('guide')}>User guide</a>
      <a href="/support/"${cur('support')}>Support</a>
      <a href="/account/"${cur('account')}>Account</a>
      <a class="btn btn-primary" href="/#notify">Get launch news</a>
    </nav>
  </div>
</header>
<main id="main">
${body}
</main>
<footer class="site-footer">
  <div class="wrap">
    <nav aria-label="Footer">
      <a href="/guide/">User guide</a>
      <a href="/support/">Support</a>
      <a href="/privacy/">Privacy</a>
      <a href="/terms/">Terms</a>
    </nav>
    <p class="disclaimer">Avid Viewer is a player for playlists you supply. It includes no channels, streams or subscriptions to content. © ${new Date().getFullYear()} Avid Viewer.</p>
  </div>
</footer>
${scripts}
</body>
</html>
`;
}

async function writePage(path, html) {
  const dir = join(OUT, path);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.html'), html);
}

function readMeta(src) {
  const m = src.match(/^<!--\s*(\{[\s\S]*?\})\s*-->\s*/);
  if (!m) throw new Error('page is missing its meta comment');
  return { meta: JSON.parse(m[1]), body: src.slice(m[0].length) };
}

// GitHub-style heading ids, so the guide's own #links keep working.
function slug(text) {
  return text.toLowerCase().trim()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

function makeMarked(toc) {
  const seen = new Map();
  const md = new Marked();
  md.use({
    renderer: {
      heading({ tokens, depth, text }) {
        const inner = this.parser.parseInline(tokens);
        let id = slug(text);
        const n = seen.get(id) || 0;
        seen.set(id, n + 1);
        if (n) id = `${id}-${n}`;
        if (toc && (depth === 2 || depth === 3)) toc.push({ depth, id, text: inner.replace(/<[^>]+>/g, '') });
        return `<h${depth} id="${id}">${inner}</h${depth}>\n`;
      },
    },
  });
  return md;
}

async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
}

async function buildGuide() {
  const src = await fetchText(`${GUIDE_RAW}/USER_GUIDE.md`);
  const cut = src.search(/^## Release notes\s*$/m);
  if (cut < 0) throw new Error('USER_GUIDE.md has no "## Release notes" heading');
  let guide = src.slice(0, cut);
  // Release notes aren't on the website for now (owner, Nov 15, 2026): the guide stops before them.

  // Drop the title line and maintainer comments; the page has its own header.
  guide = guide.replace(/^# .*\n/, '').replace(/<!--[\s\S]*?-->\n?/g, '');
  const intro = guide.match(/^\s*(This guide covers[^\n]*)\n/);
  const version = intro && intro[1].match(/Avid Viewer ([\d.]+)/);
  guide = guide.replace(/^\s*This guide covers[^\n]*\n/, '').replace(/^\*\*Contents:\*\*[^\n]*\n/m, '');
  // Links to the release notes now live on their own page.
  // Links into the release notes become plain text.
  guide = guide.replace(/\[([^\]]+)\]\(#release-notes\)/g, '$1');

  // Images: copy every images/... the guide uses.
  const imgs = [...new Set([...guide.matchAll(/\]\((images\/[^)\s]+)\)/g)].map((m) => m[1]))];
  await mkdir(join(OUT, 'guide/images'), { recursive: true });
  for (const img of imgs) {
    const r = await fetch(`${GUIDE_RAW}/${img}`);
    if (!r.ok) { console.warn(`skipped ${img}: HTTP ${r.status}`); continue; }
    await writeFile(join(OUT, 'guide', img), Buffer.from(await r.arrayBuffer()));
  }

  const toc = [];
  const guideHtml = makeMarked(toc).parse(guide).replace(/<img /g, '<img loading="lazy" ');
  const tocHtml = toc.map((t) => `<a href="#${t.id}"${t.depth === 3 ? ' class="sub"' : ''}>${t.text}</a>`).join('\n');
  const v = version ? version[1] : '';
  await writePage('guide', layout({
    title: 'User guide — Avid Viewer',
    description: 'How to install and use Avid Viewer on Android TV and Fire TV.',
    nav: 'guide', path: '/guide/',
    body: `<div class="wrap">
<header class="page-head"><h1>User guide</h1><p>${v ? `For Avid Viewer ${esc(v)}. ` : ''}Always the latest version. Need a copy on paper? <button type="button" class="linklike" onclick="window.print()">Print this guide</button>.</p></header>
<div class="doc">
<nav class="toc" aria-label="Guide contents">${tocHtml}</nav>
<article class="prose">${guideHtml}</article>
</div></div>`,
  }));

  console.log(`guide: ${toc.length} headings, ${imgs.length} images${v ? `, version ${v}` : ''}`);
}

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await cp('public', OUT, { recursive: true });
  // Passkeys in the browser: @simplewebauthn/browser's bundle (global SimpleWebAuthnBrowser).
  await mkdir(join(OUT, 'js'), { recursive: true });
  await cp('node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js', join(OUT, 'js', 'webauthn.js'));

  for (const f of await readdir('src/pages')) {
    if (!f.endsWith('.html')) continue;
    const { meta, body } = readMeta(await readFile(join('src/pages', f), 'utf8'));
    const name = basename(f, '.html');
    const path = name === 'index' ? '/' : `/${name}/`;
    const scripts = name === 'index' ? '<script src="/notify.js" defer></script>'
      : name === 'playlists' || name === 'profiles' || name === 'devices' ? '<script src="/playlists.js" defer></script><script src="/manage.js" defer></script>'
      : name === 'signin' || name === 'account' || name === 'backups' || name === 'link' ? '<script src="/js/webauthn.js" defer></script><script src="/account.js" defer></script>'
      : name === 'admin' ? '<script src="/js/webauthn.js" defer></script><script src="/admin.js" defer></script>' : '';
    const html = layout({ ...meta, path, body, scripts });
    if (name === 'index') await writeFile(join(OUT, 'index.html'), html);
    else if (name === '404') await writeFile(join(OUT, '404.html'), html);
    else await writePage(name, html);
  }

  await buildGuide();
}

main().catch((e) => { console.error(e); process.exit(1); });
