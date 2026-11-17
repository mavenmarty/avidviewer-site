// Playlist management: playlists entered on avidviewer.app. Since 1.15.0 they go to profiles, and profiles go to devices
// (profiles.js turns that into the rows below); devices on 1.14.0 keep what was sent to them directly.
//
// Device side (Bearer token):
//   POST /api/tv/report     {pubkey, profiles:[{id,name,kids}]} (1.14.0) or {v:2, …} (1.15.0: see profiles.js)
//   GET  /api/tv/inbox?ph=  what this device should add, change or remove; and its profiles when their hash isn't ph
//   POST /api/tv/inbox/ack  {playlistId, version, ok, error}
// Account side (signed in):
//   POST /api/account/playlists/save     {id?, name, type, profiles:[ids], vault?, seals:[{deviceId, payload}]}
//   POST /api/account/playlists/seal     {items:[{playlistId, deviceId, payload}]}  logins locked for devices waiting for them
//   POST /api/account/playlists/remove   {id}
//
// payload = a sealed envelope made in the browser for one device: JSON {v:1, epk, iv, ct} — an ephemeral P-256 key,
// ECDH with the device's key, HKDF-SHA256 (salt = epk, info "avidviewer-playlist:v1") → AES-256-GCM. The site can't open it.
// vault = the login encrypted in the browser with the account's vault key (see profiles.js); the site can't open it either.

import { json, body, randomToken } from './auth.js';
import { deviceFor } from './devices.js';
import { mergeDevice, deviceProfiles, reconcile, reportedProfilesFor, pendingLogins } from './profiles.js';

const clip = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const PAYLOAD_MAX = 16_000;

function cleanProfiles(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 20).map((p) => ({ id: clip(String(p?.id ?? ''), 40), name: clip(p?.name, 40) || 'Profile', kids: Boolean(p?.kids) }))
    .filter((p) => p.id);
}

async function tvDevice(request, env) {
  const d = await deviceFor(request, env);
  if (!d) return [null, json({ error: 'This device is not linked.' }, 401)];
  if (d.status !== 'active') return [null, json({ error: 'This account is suspended.' }, 403)];
  return [d, null];
}

async function tvReport(request, env) {
  const [d, no] = await tvDevice(request, env); if (no) return no;
  const b = await body(request);
  const pubkey = typeof b?.pubkey === 'string' && /^[A-Za-z0-9+/]{86}[A-Za-z0-9+/=]{2}$/.test(b.pubkey) ? b.pubkey : null;
  if (!pubkey) return json({ error: 'Send the device key.' }, 400);
  await env.DB.prepare('UPDATE devices SET pubkey = ?1, profiles = ?2, reported_at = ?3 WHERE id = ?4')
    .bind(pubkey, JSON.stringify(cleanProfiles(b?.profiles)), Date.now(), d.id).run();
  if (b?.v !== 2) return json({ ok: true });
  // 1.15.0: the first report merges the device's profiles into the account.
  if (d.managed_at) return json({ ok: true, managed: true, profileMap: {} });
  const reported = Array.isArray(b?.profiles) ? b.profiles : [];
  const map = await mergeDevice(env, d, reportedProfilesFor(reported), b?.visibility);
  return json({ ok: true, managed: true, profileMap: map });
}

async function tvInbox(request, env, url) {
  const [d, no] = await tvDevice(request, env); if (no) return no;
  const r = await env.DB.prepare(
    `SELECT t.playlist_id, t.action, t.payload, t.profiles, t.version, p.name, p.type FROM playlist_targets t
       JOIN account_playlists p ON p.id = t.playlist_id WHERE t.device_id = ?1 AND t.status = 'waiting' ORDER BY t.updated_at LIMIT 20`
  ).bind(d.id).all();
  await env.DB.prepare('UPDATE devices SET last_seen = ?1 WHERE id = ?2').bind(Date.now(), d.id).run();
  const out = { items: r.results.map((x) => ({
    playlistId: x.playlist_id, action: x.action, version: x.version, name: x.name, type: x.type,
    profiles: x.profiles ? JSON.parse(x.profiles) : null, payload: x.payload ? JSON.parse(x.payload) : null,
  })) };
  if (d.managed_at) {
    // The device's profiles (1.15.0), only when they changed since the hash it has.
    const { list, hash } = await deviceProfiles(env, d.id);
    out.managed = true;
    out.profilesHash = hash;
    if (url?.searchParams.get('ph') !== hash) out.profiles = list;
  }
  return json(out);
}

async function tvAck(request, env) {
  const [d, no] = await tvDevice(request, env); if (no) return no;
  const b = await body(request);
  const ok = Boolean(b?.ok);
  const row = await env.DB.prepare('SELECT action, version FROM playlist_targets WHERE playlist_id = ?1 AND device_id = ?2')
    .bind(String(b?.playlistId || ''), d.id).first();
  if (!row || row.version !== Number(b?.version)) return json({ ok: true, stale: true }); // something newer is waiting
  const now = Date.now();
  if (row.action === 'remove' && ok) {
    await env.DB.prepare('DELETE FROM playlist_targets WHERE playlist_id = ?1 AND device_id = ?2').bind(String(b.playlistId), d.id).run();
    await env.DB.prepare(`DELETE FROM account_playlists WHERE id = ?1 AND removing = 1
      AND NOT EXISTS (SELECT 1 FROM playlist_targets WHERE playlist_id = ?1)`).bind(String(b.playlistId)).run();
  } else {
    // The sealed login is no longer needed once the device has it (or has failed to use it).
    await env.DB.prepare(`UPDATE playlist_targets SET status = ?1, error = ?2, payload = NULL, updated_at = ?3
      WHERE playlist_id = ?4 AND device_id = ?5`).bind(ok ? 'done' : 'failed', ok ? null : clip(b?.error, 300) || 'The device couldn\'t add it.', now, String(b.playlistId), d.id).run();
  }
  return json({ ok: true });
}

export async function handlePlaylistTvApi(request, env, p, url) {
  if (p === '/api/tv/report' && request.method === 'POST') return tvReport(request, env);
  if (p === '/api/tv/inbox' && request.method === 'GET') return tvInbox(request, env, url);
  if (p === '/api/tv/inbox/ack' && request.method === 'POST') return tvAck(request, env);
  return null;
}

// ---------------------------------------------------------------- account side

function sealedOk(p) {
  return p && typeof p === 'object' && p.v === 1 && typeof p.epk === 'string' && typeof p.iv === 'string' && typeof p.ct === 'string'
    && JSON.stringify(p).length <= PAYLOAD_MAX;
}
const vaultOk = (v) => typeof v === 'string' && v.length <= PAYLOAD_MAX && /^[A-Za-z0-9+/=]{40,}$/.test(v);

/** Puts sealed logins on this playlist's devices; [changed] = a new login, so every device on it needs the new one. */
async function applySeals(env, userId, playlistId, seals, changed) {
  const rows = (await env.DB.prepare('SELECT device_id, action, status FROM playlist_targets WHERE playlist_id = ?1 AND user_id = ?2')
    .bind(playlistId, userId).all()).results;
  const byDev = new Map();
  for (const s of seals) if (sealedOk(s?.payload)) byDev.set(String(s.deviceId || ''), JSON.stringify(s.payload));
  const now = Date.now();
  const stmts = [];
  for (const t of rows) {
    if (t.action === 'remove' || t.status === 'needs_update') continue;
    const sealed = byDev.get(t.device_id);
    if (sealed) {
      stmts.push(env.DB.prepare(`UPDATE playlist_targets SET payload = ?1, status = 'waiting', error = NULL, version = version + 1, updated_at = ?2
        WHERE playlist_id = ?3 AND device_id = ?4`).bind(sealed, now, playlistId, t.device_id));
    } else if (changed && t.status !== 'needs_login') {
      // Keeps the old login until the new one is locked for this device.
      stmts.push(env.DB.prepare(`UPDATE playlist_targets SET status = 'needs_login', version = version + 1, updated_at = ?1
        WHERE playlist_id = ?2 AND device_id = ?3`).bind(now, playlistId, t.device_id));
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
}

export async function playlistsSave(request, env, user) {
  const b = await body(request);
  const name = clip(b?.name, 60);
  const type = b?.type === 'm3u' ? 'm3u' : b?.type === 'xtream' ? 'xtream' : '';
  if (!name || !type) return json({ error: 'Give the playlist a name and a type.' }, 400);
  if (b?.vault != null && !vaultOk(b.vault)) return json({ error: "The login wasn't locked correctly. Reload the page and try again." }, 400);
  const seals = Array.isArray(b?.seals) ? b.seals.slice(0, 50) : [];
  if (seals.some((s) => !sealedOk(s?.payload))) return json({ error: "The login wasn't locked correctly for a device. Reload the page and try again." }, 400);
  const now = Date.now();
  let id = clip(b?.id, 40);
  if (id) {
    const own = await env.DB.prepare('SELECT id FROM account_playlists WHERE id = ?1 AND user_id = ?2 AND removing = 0').bind(id, user.id).first();
    if (!own) return json({ error: 'That playlist is no longer in your account.' }, 404);
    await env.DB.prepare('UPDATE account_playlists SET name = ?1, type = ?2, vault = COALESCE(?3, vault), updated_at = ?4 WHERE id = ?5')
      .bind(name, type, b?.vault || null, now, id).run();
  } else {
    if (!b?.vault && !seals.length) return json({ error: 'Enter the login.' }, 400);
    id = randomToken(12);
    await env.DB.prepare('INSERT INTO account_playlists (id, user_id, name, type, vault, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)')
      .bind(id, user.id, name, type, b?.vault || null, now).run();
  }
  if (Array.isArray(b?.profiles)) {
    const mine = new Set((await env.DB.prepare('SELECT id FROM profiles WHERE user_id = ?1').bind(user.id).all()).results.map((r) => r.id));
    const stmts = [env.DB.prepare('DELETE FROM profile_playlists WHERE playlist_id = ?1').bind(id)];
    for (const pid of b.profiles.map((x) => String(x)).filter((x) => mine.has(x)).slice(0, 50)) {
      stmts.push(env.DB.prepare('INSERT INTO profile_playlists (profile_id, playlist_id, user_id) VALUES (?1, ?2, ?3)').bind(pid, id, user.id));
    }
    await env.DB.batch(stmts);
  }
  await reconcile(env, user.id);
  await applySeals(env, user.id, id, seals, Boolean(b?.vault) || Boolean(b?.loginChanged));
  return json({ ok: true, id, pending: await pendingLogins(env, user.id) });
}

/** GET /api/account/playlists/vault?id=: the playlist's login, still locked with the account's vault key. */
export async function playlistVault(env, user, url) {
  const row = await env.DB.prepare('SELECT vault FROM account_playlists WHERE id = ?1 AND user_id = ?2').bind(url.searchParams.get('id') || '', user.id).first();
  return json({ vault: row?.vault || null });
}

export async function playlistsSeal(request, env, user) {
  const b = await body(request);
  const items = Array.isArray(b?.items) ? b.items.slice(0, 200) : [];
  const now = Date.now();
  const stmts = [];
  for (const it of items) {
    if (!sealedOk(it?.payload)) continue;
    stmts.push(env.DB.prepare(`UPDATE playlist_targets SET payload = ?1, status = 'waiting', error = NULL, version = version + 1, updated_at = ?2
      WHERE playlist_id = ?3 AND device_id = ?4 AND user_id = ?5 AND status = 'needs_login'`)
      .bind(JSON.stringify(it.payload), now, String(it.playlistId || ''), String(it.deviceId || ''), user.id));
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return json({ ok: true, sent: stmts.length });
}

export async function playlistsRemove(request, env, user) {
  const b = await body(request);
  const id = clip(b?.id, 40);
  const own = await env.DB.prepare('SELECT id FROM account_playlists WHERE id = ?1 AND user_id = ?2').bind(id, user.id).first();
  if (!own) return json({ ok: true });
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('UPDATE account_playlists SET removing = 1, vault = NULL, updated_at = ?1 WHERE id = ?2').bind(now, id),
    env.DB.prepare('DELETE FROM profile_playlists WHERE playlist_id = ?1').bind(id),
    env.DB.prepare('DELETE FROM profile_visibility WHERE playlist_id = ?1').bind(id),
    env.DB.prepare('DELETE FROM playlist_catalogs WHERE playlist_id = ?1').bind(id),
    // Devices that never got it just forget it; the others are told to remove it.
    env.DB.prepare(`DELETE FROM playlist_targets WHERE playlist_id = ?1 AND action = 'add' AND status != 'done'`).bind(id),
    env.DB.prepare(`UPDATE playlist_targets SET action = 'remove', payload = NULL, version = version + 1, status = 'waiting', error = NULL,
      updated_at = ?1 WHERE playlist_id = ?2`).bind(now, id),
    env.DB.prepare(`DELETE FROM account_playlists WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM playlist_targets WHERE playlist_id = ?1)`).bind(id),
  ]);
  return json({ ok: true });
}
