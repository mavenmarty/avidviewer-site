// Beta channel (Nov 18, 2026).
//
//   Devices page   POST /api/account/devices/beta  {deviceId, offer}   the owner offers a device, or takes it back
//   TV             GET  /api/tv/me  → beta: {in, tag}                   tag: the build offered to chosen devices
//   Admin          GET  /api/admin/beta                                 offered devices, beta builds on GitHub, the offered one
//                  POST /api/admin/beta/choose {deviceId, on}           choose a device (emails its owner) or take it out
//                  POST /api/admin/beta/offer  {tag}                     offer a beta build to every chosen device
//
// Beta builds are GitHub pre-releases tagged beta-v<version>-<n>.<build> ("1.20.0 beta 2"). Public TVs never read them.
// A device that leaves keeps its beta build until a public release is newer (public builds always have higher numbers).
// Nothing here knows what anyone watches; the admin list shows the device, its app version and a partly hidden email.

import { json, body } from './auth.js';
import { sendMail, mailConfigured } from './mail.js';

const REPO = 'mavenmarty/avid-viewer';
export const BETA_TAG = /^beta-v(\d+\.\d+\.\d+)-(\d+)\.(\d+)$/;

/** "beta-v1.20.0-2.360" → "1.20.0 beta 2". */
export function betaName(tag) {
  const m = BETA_TAG.exec(tag || '');
  return m ? `${m[1]} beta ${m[2]}` : tag;
}

/** "someone@example.com" → "so•••@example.com". */
export function maskEmail(e) {
  const [u, d] = String(e || '').split('@');
  if (!d) return '•••';
  return (u.length <= 2 ? u.slice(0, 1) : u.slice(0, 2)) + '•••@' + d;
}

async function offered(env) {
  return env.DB.prepare('SELECT tag, name, offered_at, offered_by FROM beta_release WHERE id = 1').first();
}

/** For /api/tv/me: whether this device is in the beta and which build it should get. */
export async function betaFor(env, deviceId) {
  const d = await env.DB.prepare('SELECT beta_at FROM devices WHERE id = ?1').bind(deviceId).first();
  if (!d?.beta_at) return { in: false, tag: null };
  const r = await offered(env);
  return { in: true, tag: r?.tag || null };
}

// ---------------------------------------------------------------- the owner (Devices page)

export async function deviceBeta(request, env, user) {
  const b = await body(request);
  const offer = Boolean(b?.offer);
  const d = await env.DB.prepare('SELECT id FROM devices WHERE id = ?1 AND user_id = ?2 AND revoked_at IS NULL').bind(String(b?.deviceId || ''), user.id).first();
  if (!d) return json({ error: 'That device is no longer linked.' }, 404);
  // Taking the offer back also leaves the beta: the device keeps its build until a public version is newer.
  await env.DB.prepare(offer ? 'UPDATE devices SET beta_offer = 1 WHERE id = ?1' : 'UPDATE devices SET beta_offer = 0, beta_at = NULL WHERE id = ?1').bind(d.id).run();
  return json({ ok: true });
}

// ---------------------------------------------------------------- admin

/**
 * Beta builds on GitHub (pre-releases with a beta tag), newest first. Cached for 5 minutes.
 *
 * Nov 28, 2026: GitHub's API answered 403 to the website's requests without a key (60 an hour for each address, and
 * Cloudflare's addresses are shared), so beta 3 couldn't be offered. The website's GitHub key is now sent with the
 * request, and if the API still refuses, the public releases feed (releases.atom, not limited that way) is read.
 */
async function betaBuilds(env) {
  const api = `https://api.github.com/repos/${REPO}/releases?per_page=30`;
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const key = new Request(api);
  let r = cache ? await cache.match(key) : null;
  if (!r) {
    const headers = { 'User-Agent': 'avidviewer.app', 'Accept': 'application/vnd.github+json' };
    if (env && env.GITHUB_TOKEN) headers.Authorization = 'Bearer ' + env.GITHUB_TOKEN;
    const live = await fetch(api, { headers });
    if (live.ok) {
      const list = (await live.json()).filter((x) => x.prerelease).map((x) => ({ tag: x.tag_name, at: x.published_at }));
      r = new Response(JSON.stringify(list), { headers: { 'content-type': 'application/json', 'cache-control': 'max-age=300' } });
    } else {
      const feed = await fetch(`https://github.com/${REPO}/releases.atom`, { headers: { 'User-Agent': 'avidviewer.app' } });
      if (!feed.ok) throw new Error(`GitHub answered ${live.status} (and the releases feed ${feed.status})`);
      const xml = await feed.text();
      const list = [];
      for (const m of xml.matchAll(/<entry>[\s\S]*?<\/entry>/g)) {
        const tag = (m[0].match(/\/releases\/tag\/([^"<]+)"/) || [])[1];
        const at = (m[0].match(/<updated>([^<]+)<\/updated>/) || [])[1];
        if (tag) list.push({ tag: decodeURIComponent(tag), at });
      }
      r = new Response(JSON.stringify(list), { headers: { 'content-type': 'application/json', 'cache-control': 'max-age=300' } });
    }
    if (cache) await cache.put(key, r.clone());
  }
  const list = await r.json();
  return list.filter((x) => BETA_TAG.test(x.tag))
    .map((x) => ({ tag: x.tag, name: betaName(x.tag), publishedAt: x.at, build: Number(BETA_TAG.exec(x.tag)[3]) }))
    .sort((a, b) => b.build - a.build);
}

export async function adminBeta(env) {
  const [rows, rel] = await Promise.all([
    env.DB.prepare(`SELECT d.id, d.name, d.model, d.app_version, d.last_seen, d.beta_at, u.email FROM devices d JOIN users u ON u.id = d.user_id
      WHERE d.beta_offer = 1 AND d.revoked_at IS NULL AND u.status = 'active' ORDER BY d.beta_at IS NULL, d.last_seen DESC`).all(),
    offered(env),
  ]);
  let builds = [], buildsError = null;
  try { builds = await betaBuilds(env); } catch (e) { buildsError = 'Couldn\'t read the beta builds from GitHub: ' + e.message; }
  return json({
    offered: rel ? { tag: rel.tag, name: rel.name, at: rel.offered_at, by: rel.offered_by } : null,
    builds, buildsError, mail: mailConfigured(env),
    devices: rows.results.map((d) => ({
      id: d.id, name: d.name, model: d.model, appVersion: d.app_version, lastSeen: d.last_seen, chosenAt: d.beta_at, email: maskEmail(d.email),
    })),
  });
}

function chosenMail(name, site) {
  const text = `Your device "${name}" is now in the Avid Viewer beta.\n\n` +
    'It gets new versions before everyone else. Open Settings › Updates & about on it to install the newest beta when one is offered.\n\n' +
    `To leave, turn off "Offer this device beta builds" at ${site}/devices/. The device keeps its beta version until a public version catches up.\n`;
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const html = `<p>Your device <b>${esc(name)}</b> is now in the Avid Viewer beta.</p>` +
    '<p>It gets new versions before everyone else. Open Settings › Updates &amp; about on it to install the newest beta when one is offered.</p>' +
    `<p>To leave, turn off <i>Offer this device beta builds</i> at <a href="${site}/devices/">${site.replace(/^https?:\/\//, '')}/devices</a>. The device keeps its beta version until a public version catches up.</p>`;
  return { subject: 'Your device is in the Avid Viewer beta', text, html };
}

export async function adminBetaChoose(request, env, admin, audit, url) {
  const b = await body(request);
  const on = Boolean(b?.on);
  const d = await env.DB.prepare(`SELECT d.id, d.name, d.beta_at, d.beta_offer, u.id AS uid, u.email FROM devices d JOIN users u ON u.id = d.user_id
    WHERE d.id = ?1 AND d.revoked_at IS NULL`).bind(String(b?.deviceId || '')).first();
  if (!d || (on && !d.beta_offer)) return json({ error: 'That device isn\'t offered for the beta any more.' }, 404);
  if (on === Boolean(d.beta_at)) return json({ ok: true });
  await env.DB.prepare('UPDATE devices SET beta_at = ?1 WHERE id = ?2').bind(on ? Date.now() : null, d.id).run();
  await audit(env, admin, on ? 'beta_choose' : 'beta_remove', { id: d.uid, email: d.email }, d.name);
  let mailed = false;
  if (on && mailConfigured(env)) {
    try { await sendMail(env, { to: d.email, ...chosenMail(d.name, url.origin) }); mailed = true; }
    catch (e) { console.error('beta email failed', e); }
  }
  return json({ ok: true, mailed });
}

export async function adminBetaOffer(request, env, admin, audit) {
  const b = await body(request);
  const tag = String(b?.tag || '');
  if (!BETA_TAG.test(tag)) return json({ error: 'Choose a beta build.' }, 400);
  const builds = await betaBuilds(env).catch(() => null);
  if (builds && !builds.some((x) => x.tag === tag)) return json({ error: 'That build isn\'t a beta pre-release on GitHub.' }, 404);
  await env.DB.prepare(`INSERT INTO beta_release (id, tag, name, offered_at, offered_by) VALUES (1, ?1, ?2, ?3, ?4)
    ON CONFLICT(id) DO UPDATE SET tag = excluded.tag, name = excluded.name, offered_at = excluded.offered_at, offered_by = excluded.offered_by`)
    .bind(tag, betaName(tag), Date.now(), admin.email).run();
  await audit(env, admin, 'beta_offer', null, betaName(tag));
  return json({ ok: true });
}
