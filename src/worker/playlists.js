// Playlist management (Nov 16, 2026): playlists entered on avidviewer.app go to the devices and profiles the person picks.
//
// Device side (Bearer token):
//   POST /api/tv/report     {pubkey, profiles:[{id,name,kids}]}  the device's public key and its profiles
//   GET  /api/tv/inbox      what this device should add, change or remove
//   POST /api/tv/inbox/ack  {playlistId, version, ok, error}
// Account side (signed in):
//   GET  /api/account/playlists          playlists with each device's status, and the devices with their profiles
//   POST /api/account/playlists/save     {id?, name, type, targets:[{deviceId, profiles|null, payload?}]}
//   POST /api/account/playlists/remove   {id}
//
// payload = a sealed envelope made in the browser for one device: JSON {v:1, epk, iv, ct} — an ephemeral P-256 key,
// ECDH with the device's key, HKDF-SHA256 (salt = epk, info "avidviewer-playlist:v1") → AES-256-GCM. The site can't open it.

import { json, body, randomToken } from './auth.js';
import { deviceFor } from './devices.js';

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
  return json({ ok: true });
}

async function tvInbox(request, env) {
  const [d, no] = await tvDevice(request, env); if (no) return no;
  const r = await env.DB.prepare(
    `SELECT t.playlist_id, t.action, t.payload, t.profiles, t.version, p.name, p.type FROM playlist_targets t
       JOIN account_playlists p ON p.id = t.playlist_id WHERE t.device_id = ?1 AND t.status = 'waiting' ORDER BY t.updated_at LIMIT 20`
  ).bind(d.id).all();
  await env.DB.prepare('UPDATE devices SET last_seen = ?1 WHERE id = ?2').bind(Date.now(), d.id).run();
  return json({ items: r.results.map((x) => ({
    playlistId: x.playlist_id, action: x.action, version: x.version, name: x.name, type: x.type,
    profiles: x.profiles ? JSON.parse(x.profiles) : null, payload: x.payload ? JSON.parse(x.payload) : null,
  })) });
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

export async function handlePlaylistTvApi(request, env, p) {
  if (p === '/api/tv/report' && request.method === 'POST') return tvReport(request, env);
  if (p === '/api/tv/inbox' && request.method === 'GET') return tvInbox(request, env);
  if (p === '/api/tv/inbox/ack' && request.method === 'POST') return tvAck(request, env);
  return null;
}

// ---------------------------------------------------------------- account side

async function devicesWithKeys(env, userId) {
  const r = await env.DB.prepare(
    'SELECT id, name, model, app_version, pubkey, profiles, reported_at FROM devices WHERE user_id = ?1 AND revoked_at IS NULL ORDER BY name'
  ).bind(userId).all();
  return r.results.map((d) => ({ id: d.id, name: d.name, model: d.model, appVersion: d.app_version, pubkey: d.pubkey || null,
    profiles: d.profiles ? JSON.parse(d.profiles) : [], reportedAt: d.reported_at }));
}

export async function playlistsList(env, user) {
  // Devices removed from the account no longer count as targets.
  await env.DB.prepare(`DELETE FROM playlist_targets WHERE user_id = ?1 AND device_id NOT IN
    (SELECT id FROM devices WHERE user_id = ?1 AND revoked_at IS NULL)`).bind(user.id).run();
  await env.DB.prepare(`DELETE FROM account_playlists WHERE user_id = ?1 AND removing = 1
    AND id NOT IN (SELECT playlist_id FROM playlist_targets)`).bind(user.id).run();
  const pls = await env.DB.prepare('SELECT id, name, type, created_at, updated_at, removing FROM account_playlists WHERE user_id = ?1 ORDER BY name')
    .bind(user.id).all();
  const ts = await env.DB.prepare('SELECT playlist_id, device_id, profiles, action, status, error, updated_at FROM playlist_targets WHERE user_id = ?1')
    .bind(user.id).all();
  return json({
    devices: await devicesWithKeys(env, user.id),
    playlists: pls.results.map((p) => ({
      id: p.id, name: p.name, type: p.type, updatedAt: p.updated_at, removing: Boolean(p.removing),
      targets: ts.results.filter((t) => t.playlist_id === p.id).map((t) => ({
        deviceId: t.device_id, profiles: t.profiles ? JSON.parse(t.profiles) : null, action: t.action, status: t.status, error: t.error, updatedAt: t.updated_at,
      })),
    })),
  });
}

function sealedOk(p) {
  return p && typeof p === 'object' && p.v === 1 && typeof p.epk === 'string' && typeof p.iv === 'string' && typeof p.ct === 'string'
    && JSON.stringify(p).length <= PAYLOAD_MAX;
}

export async function playlistsSave(request, env, user) {
  const b = await body(request);
  const name = clip(b?.name, 60);
  const type = b?.type === 'm3u' ? 'm3u' : b?.type === 'xtream' ? 'xtream' : '';
  if (!name || !type) return json({ error: 'Give the playlist a name and a type.' }, 400);
  const devices = new Map((await devicesWithKeys(env, user.id)).map((d) => [d.id, d]));
  const targets = Array.isArray(b?.targets) ? b.targets.slice(0, 50) : [];
  if (!targets.length) return json({ error: 'Choose at least one device.' }, 400);
  const now = Date.now();
  let id = clip(b?.id, 40);
  let existing = new Map();
  if (id) {
    const own = await env.DB.prepare('SELECT id FROM account_playlists WHERE id = ?1 AND user_id = ?2 AND removing = 0').bind(id, user.id).first();
    if (!own) return json({ error: 'That playlist is no longer in your account.' }, 404);
    const r = await env.DB.prepare('SELECT device_id, action, version, status FROM playlist_targets WHERE playlist_id = ?1').bind(id).all();
    existing = new Map(r.results.map((t) => [t.device_id, t]));
  } else {
    id = randomToken(12);
  }
  const stmts = [];
  const chosen = new Set();
  for (const t of targets) {
    const dev = devices.get(String(t?.deviceId || ''));
    if (!dev) return json({ error: 'One of those devices is no longer linked.' }, 400);
    chosen.add(dev.id);
    const profiles = Array.isArray(t.profiles) ? t.profiles.map((x) => clip(String(x), 40)).filter(Boolean).slice(0, 20) : null;
    if (profiles && !profiles.length) return json({ error: `Choose at least one profile on ${dev.name}.` }, 400);
    const prev = existing.get(dev.id);
    const sealed = t.payload == null ? null : (sealedOk(t.payload) ? JSON.stringify(t.payload) : undefined);
    if (sealed === undefined) return json({ error: 'The login for ' + dev.name + " wasn't sealed correctly. Reload the page and try again." }, 400);
    const onDevice = prev && !(prev.action === 'remove') && !(prev.action === 'add' && prev.status !== 'done');
    if (!sealed && !onDevice) return json({ error: `Enter the login again to send it to ${dev.name}.`, needLogin: dev.id }, 400);
    const action = onDevice ? 'update' : 'add';
    stmts.push(env.DB.prepare(
      `INSERT INTO playlist_targets (playlist_id, device_id, user_id, profiles, action, payload, version, status, error, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 'waiting', NULL, ?7)
       ON CONFLICT(playlist_id, device_id) DO UPDATE SET profiles = ?4, action = ?5, payload = COALESCE(?6, payload),
         version = version + 1, status = 'waiting', error = NULL, updated_at = ?7`
    ).bind(id, dev.id, user.id, profiles ? JSON.stringify(profiles) : null, action, sealed, now));
  }
  for (const [devId, prev] of existing) {
    if (chosen.has(devId)) continue;
    stmts.push(env.DB.prepare(`UPDATE playlist_targets SET action = 'remove', payload = NULL, version = version + 1, status = 'waiting',
      error = NULL, updated_at = ?1 WHERE playlist_id = ?2 AND device_id = ?3`).bind(now, id, devId));
  }
  stmts.unshift(existing.size
    ? env.DB.prepare('UPDATE account_playlists SET name = ?1, type = ?2, updated_at = ?3 WHERE id = ?4').bind(name, type, now, id)
    : env.DB.prepare('INSERT INTO account_playlists (id, user_id, name, type, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)').bind(id, user.id, name, type, now));
  if (b?.id && !existing.size) stmts[0] = env.DB.prepare('UPDATE account_playlists SET name = ?1, type = ?2, updated_at = ?3 WHERE id = ?4').bind(name, type, now, id);
  await env.DB.batch(stmts);
  return json({ ok: true, id });
}

export async function playlistsRemove(request, env, user) {
  const b = await body(request);
  const id = clip(b?.id, 40);
  const own = await env.DB.prepare('SELECT id FROM account_playlists WHERE id = ?1 AND user_id = ?2').bind(id, user.id).first();
  if (!own) return json({ ok: true });
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('UPDATE account_playlists SET removing = 1, updated_at = ?1 WHERE id = ?2').bind(now, id),
    // Devices that never got it just forget it; the others are told to remove it.
    env.DB.prepare(`DELETE FROM playlist_targets WHERE playlist_id = ?1 AND action = 'add' AND status != 'done'`).bind(id),
    env.DB.prepare(`UPDATE playlist_targets SET action = 'remove', payload = NULL, version = version + 1, status = 'waiting', error = NULL,
      updated_at = ?1 WHERE playlist_id = ?2`).bind(now, id),
    env.DB.prepare(`DELETE FROM account_playlists WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM playlist_targets WHERE playlist_id = ?1)`).bind(id),
  ]);
  return json({ ok: true });
}
