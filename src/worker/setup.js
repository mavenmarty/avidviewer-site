// First-time setup (Nov 26, 2026): /start/ takes a new account from the TV that sent it to a playing TV in four steps
// (account, TV, playlist, passkey), then offers four optional "Make it yours" steps. Nothing here can read a login:
// the page seals the login for the TV in the browser (playlists.js) and keeps it with the passkey (manage.js).
//
//   POST /api/account/setup  {start?, passkeySkipped?, done?:{profiles|sees|area|discover: bool}, postal?: '58102' | ''}
//   setupStatus(env, uid)    what's done, for /api/account/manage and Needs your attention
//   tvPostal(env, userId)    {code, at} for /api/tv/me, so every TV gets the postal code set on the website

import { json, body } from './auth.js';

export const OPTIONAL = ['profiles', 'sees', 'area', 'discover'];
const NAMES = { profiles: 'Who’s watching', sees: 'What each profile sees', area: 'Your area and favorites', discover: 'Discover' };
const POSTAL = /^[A-Za-z0-9][A-Za-z0-9 -]{1,9}$/;

function parse(text) {
  try { const o = JSON.parse(text || 'null'); return o && typeof o === 'object' ? o : null; } catch { return null; }
}

/** What setup knows about the account. `started` is false for accounts that never opened /start/. */
export async function setupStatus(env, uid) {
  const u = await env.DB.prepare('SELECT setup, postal_code, postal_at FROM users WHERE id = ?1').bind(uid).first();
  const s = parse(u?.setup) || {};
  const [profiles, vis, secret, disc, vault, devs, pls] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS n FROM profiles WHERE user_id = ?1').bind(uid).first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM profile_visibility WHERE user_id = ?1').bind(uid).first(),
    env.DB.prepare('SELECT tmdb IS NOT NULL AS has FROM account_secrets WHERE user_id = ?1').bind(uid).first().catch(() => null),
    env.DB.prepare('SELECT COUNT(*) AS n FROM profile_discover WHERE user_id = ?1').bind(uid).first().catch(() => null),
    env.DB.prepare('SELECT COUNT(*) AS n FROM vault_keys WHERE user_id = ?1').bind(uid).first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM devices WHERE user_id = ?1 AND revoked_at IS NULL').bind(uid).first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM account_playlists WHERE user_id = ?1 AND removing = 0').bind(uid).first(),
  ]);
  const doneFlag = s.done && typeof s.done === 'object' ? s.done : {};
  const done = {
    profiles: Boolean(doneFlag.profiles) || (profiles?.n || 0) > 1,
    sees: Boolean(doneFlag.sees) || (vis?.n || 0) > 0,
    area: Boolean(doneFlag.area) || Boolean(u?.postal_code),
    discover: Boolean(doneFlag.discover) || Boolean(secret?.has) || (disc?.n || 0) > 0,
  };
  return {
    started: Boolean(s.started),
    tv: (devs?.n || 0) > 0,
    playlist: (pls?.n || 0) > 0,
    passkey: (vault?.n || 0) > 0,
    passkeySkipped: Boolean(s.passkeySkipped),
    done,
    left: OPTIONAL.filter((k) => !done[k]),
    names: NAMES,
    postal: u?.postal_code || '',
    postalAt: u?.postal_at || null,
  };
}

export async function setupSave(request, env, user) {
  const b = await body(request);
  if (!b) return json({ error: "That didn't come through. Please try again." }, 400);
  const row = await env.DB.prepare('SELECT setup FROM users WHERE id = ?1').bind(user.id).first();
  const s = parse(row?.setup) || {};
  if (b.start && !s.started) s.started = Date.now();
  if (typeof b.passkeySkipped === 'boolean') s.passkeySkipped = b.passkeySkipped;
  if (b.done && typeof b.done === 'object') {
    s.done = s.done && typeof s.done === 'object' ? s.done : {};
    for (const k of OPTIONAL) if (typeof b.done[k] === 'boolean') s.done[k] = b.done[k];
  }
  const stmts = [env.DB.prepare('UPDATE users SET setup = ?1 WHERE id = ?2').bind(JSON.stringify(s), user.id)];
  if (typeof b.postal === 'string') {
    const code = b.postal.trim().toUpperCase();
    if (code && !POSTAL.test(code)) return json({ error: 'Enter a postal code, like 58102.' }, 400);
    stmts.push(env.DB.prepare('UPDATE users SET postal_code = ?1, postal_at = ?2 WHERE id = ?3').bind(code || null, Date.now(), user.id));
  }
  await env.DB.batch(stmts);
  return json({ ok: true, setup: await setupStatus(env, user.id) });
}

/** For /api/tv/me: the postal code set on the website, if any, and when. */
export async function tvPostal(env, userId) {
  const u = await env.DB.prepare('SELECT postal_code, postal_at FROM users WHERE id = ?1').bind(userId).first();
  return u?.postal_at ? { code: u.postal_code || '', at: u.postal_at } : null;
}

/** For Needs your attention: unfinished setup, only for accounts that started it on /start/. */
export async function setupAttention(env, uid) {
  const s = await setupStatus(env, uid);
  if (!s.started) return [];
  const out = [];
  if (s.playlist && !s.passkey && s.passkeySkipped) {
    out.push({ key: 'setup:passkey', level: 'info', tab: 'playlists', title: 'Your logins aren’t kept in your account yet',
      detail: 'Your TV has its login. Without a passkey, the next TV you add asks you to type it again. A passkey takes one Face ID, fingerprint or PIN.',
      actions: [{ label: 'Set up with passkey', href: '/start/#passkey' }] });
  }
  if (s.left.length) {
    out.push({ key: 'setup:' + s.left.join(','), level: 'info', tab: 'playlists', title: 'Finish setting up',
      detail: `${s.left.length} of 4 left: ${s.left.map((k) => s.names[k]).join(', ')}. All optional; dismiss this if you don’t need them.`,
      actions: [{ label: 'Continue setup', href: '/start/#yours' }] });
  }
  return out;
}
