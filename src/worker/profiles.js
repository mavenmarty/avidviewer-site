// Account profiles (1.15.0): the account's playlists go to profiles, profiles hide what they shouldn't see, and profiles
// go to devices. A device gets a playlist when any of its profiles has it (reconcile turns the assignments into the
// playlist_targets rows that devices already pick up from /api/tv/inbox).
//
// Device side (Bearer token):
//   POST /api/tv/report    {v:2, pubkey, profiles:[{id,name,kids,parent,color,pin}], visibility:{localProfileId:{playlistId:vis}}}
//                          the first time: the device's profiles are merged into the account by name → {profileMap}
//   GET  /api/tv/inbox?ph= also returns the device's profiles when they changed (see playlists.js)
//   POST /api/tv/catalog   {playlistId, live:[{n,c,ch:[[id,name]…]}], movie:[[n,c]…], series:[[n,c]…]}
//   POST /api/tv/playing   {playing, playlistId, playlistName, profileId, profileName, startedAt} → {stop}
// Account side (signed in):
//   GET  /api/account/manage                  playlists, profiles, devices (with Watching now), pending logins
//   GET  /api/account/catalog?playlist=       one playlist's categories and channels, for a profile's visibility
//   POST /api/account/profiles/save           {id?, name, kids, parent, color, pin?, playlists:[], devices:[], pins:{id:pin}}
//   POST /api/account/profiles/remove         {id}
//   POST /api/account/profiles/visibility     {profileId, playlistId, data}
//   POST /api/account/devices/profiles        {deviceId, profiles:[]}
//   POST /api/account/devices/stop            {deviceId}
//   POST /api/account/vault/key               {credentialId, wrapped}
// What's being watched is never sent: Watching now has only the playlist, profile, device and start time.

import { json, body, randomToken, sha256hex } from './auth.js';
import { deviceFor } from './devices.js';

const clip = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const PIN = /^[0-9a-f]{8,64}:[0-9a-f]{64}$/;
const CATALOG_MAX = 1_900_000;
const PLAYING_FRESH = 45_000; // a device reports every 15 s while playing
const VIS_MAX = 400_000;

function strList(a, n = 5000, len = 200) {
  return Array.isArray(a) ? a.slice(0, n).map((x) => clip(String(x ?? ''), len)).filter(Boolean) : [];
}
/** A visibility record, cleaned: {hidden:{live,movie,series}, channels, allowed:{live,movie,series}}. */
export function cleanVis(v) {
  const kinds = (o) => ({ live: strList(o?.live), movie: strList(o?.movie), series: strList(o?.series) });
  return { hidden: kinds(v?.hidden), channels: strList(v?.channels, 20000), allowed: kinds(v?.allowed) };
}
const visEmpty = (v) => !v.channels.length && ['live', 'movie', 'series'].every((k) => !v.hidden[k].length && !v.allowed[k].length);

// ---------------------------------------------------------------- reconcile

/**
 * Brings playlist_targets in line with the assignments, for the account's devices that use account profiles (1.15.0+).
 * New (playlist, device) pairs wait for the login to be locked for that device in the browser ('needs_login'), or for
 * the app to be updated ('needs_update'). Returns the pairs waiting for a login.
 */
export async function reconcile(env, userId) {
  const devs = (await env.DB.prepare('SELECT id, pubkey FROM devices WHERE user_id = ?1 AND revoked_at IS NULL AND managed_at IS NOT NULL')
    .bind(userId).all()).results;
  const managed = new Map(devs.map((d) => [d.id, d]));
  const want = new Map(); // "pl|dev" → [profileIds]
  const rows = (await env.DB.prepare(
    `SELECT dp.device_id, pp.playlist_id, dp.profile_id FROM device_profiles dp
       JOIN profile_playlists pp ON pp.profile_id = dp.profile_id
       JOIN account_playlists p ON p.id = pp.playlist_id AND p.removing = 0
      WHERE dp.user_id = ?1 ORDER BY dp.profile_id`
  ).bind(userId).all()).results;
  for (const r of rows) {
    if (!managed.has(r.device_id)) continue;
    const k = r.playlist_id + '|' + r.device_id;
    if (!want.has(k)) want.set(k, []);
    want.get(k).push(r.profile_id);
  }
  const have = (await env.DB.prepare('SELECT playlist_id, device_id, profiles, action, status FROM playlist_targets WHERE user_id = ?1')
    .bind(userId).all()).results;
  const now = Date.now();
  const stmts = [];
  const seen = new Set();
  for (const t of have) {
    if (!managed.has(t.device_id)) continue; // older apps keep what 1.14.0 sent them
    const k = t.playlist_id + '|' + t.device_id;
    seen.add(k);
    const profs = want.get(k);
    const onDevice = t.action === 'remove' || t.action === 'update' || (t.action === 'add' && t.status === 'done');
    if (!profs) {
      if (t.action === 'remove') continue;
      stmts.push(onDevice
        ? env.DB.prepare(`UPDATE playlist_targets SET action = 'remove', payload = NULL, version = version + 1, status = 'waiting', error = NULL,
            updated_at = ?1 WHERE playlist_id = ?2 AND device_id = ?3`).bind(now, t.playlist_id, t.device_id)
        : env.DB.prepare('DELETE FROM playlist_targets WHERE playlist_id = ?1 AND device_id = ?2').bind(t.playlist_id, t.device_id));
      continue;
    }
    const pj = JSON.stringify(profs);
    if (t.action === 'remove') {
      // Still on the device: keep it, for these profiles.
      stmts.push(env.DB.prepare(`UPDATE playlist_targets SET action = 'update', profiles = ?1, version = version + 1, status = 'waiting',
        error = NULL, updated_at = ?2 WHERE playlist_id = ?3 AND device_id = ?4`).bind(pj, now, t.playlist_id, t.device_id));
    } else if (t.profiles !== pj) {
      stmts.push(onDevice && t.status !== 'needs_login'
        ? env.DB.prepare(`UPDATE playlist_targets SET action = 'update', profiles = ?1, version = version + 1, status = 'waiting', error = NULL,
            updated_at = ?2 WHERE playlist_id = ?3 AND device_id = ?4`).bind(pj, now, t.playlist_id, t.device_id)
        : env.DB.prepare('UPDATE playlist_targets SET profiles = ?1, version = version + 1, updated_at = ?2 WHERE playlist_id = ?3 AND device_id = ?4')
          .bind(pj, now, t.playlist_id, t.device_id));
    }
  }
  for (const [k, profs] of want) {
    if (seen.has(k)) continue;
    const [pl, dev] = k.split('|');
    stmts.push(env.DB.prepare(
      `INSERT INTO playlist_targets (playlist_id, device_id, user_id, profiles, action, payload, version, status, error, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'add', NULL, 1, ?5, NULL, ?6)`
    ).bind(pl, dev, userId, JSON.stringify(profs), managed.get(dev).pubkey ? 'needs_login' : 'needs_update', now));
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return pendingLogins(env, userId);
}

/** (playlist, device) pairs waiting for the login to be locked for the device in the browser. */
export async function pendingLogins(env, userId) {
  return (await env.DB.prepare(
    `SELECT t.playlist_id, t.device_id, d.pubkey, d.name AS device_name, p.name AS playlist_name, (p.vault IS NOT NULL) AS kept
       FROM playlist_targets t JOIN devices d ON d.id = t.device_id JOIN account_playlists p ON p.id = t.playlist_id
      WHERE t.user_id = ?1 AND t.status = 'needs_login' AND d.revoked_at IS NULL AND d.pubkey IS NOT NULL`
  ).bind(userId).all()).results.map((r) => ({
    playlistId: r.playlist_id, deviceId: r.device_id, pubkey: r.pubkey, device: r.device_name, playlist: r.playlist_name, kept: Boolean(r.kept),
  }));
}

// ---------------------------------------------------------------- device side

async function tvDevice(request, env) {
  const d = await deviceFor(request, env);
  if (!d) return [null, json({ error: 'This device is not linked.' }, 401)];
  if (d.status !== 'active') return [null, json({ error: 'This account is suspended.' }, 403)];
  return [d, null];
}

export function reportedProfilesFor(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 20).map((p) => ({
    id: clip(String(p?.id ?? ''), 60), name: clip(p?.name, 40) || 'Profile', kids: Boolean(p?.kids), parent: Boolean(p?.parent),
    color: Math.max(0, Math.min(20, Number(p?.color) || 0)), pin: typeof p?.pin === 'string' && PIN.test(p.pin) ? p.pin : null,
  })).filter((p) => p.id);
}

/**
 * The first report from a 1.15.0+ device: its profiles become account profiles (same name = same profile), they're put
 * on this device, and what 1.14.0 sent it becomes those profiles' playlists, so nothing changes on the device.
 * A device with only the untouched starting profile ("Me") and nothing from the account adds no profile.
 */
export async function mergeDevice(env, d, reported, visibility) {
  const legacy = (await env.DB.prepare(`SELECT t.playlist_id, t.profiles FROM playlist_targets t JOIN account_playlists p ON p.id = t.playlist_id
      WHERE t.device_id = ?1 AND t.action != 'remove' AND p.removing = 0`).bind(d.id).all()).results;
  const lone = reported.length === 1 && reported[0].name === 'Me' && !reported[0].kids && !reported[0].pin;
  const map = {};
  const now = Date.now();
  if (!(lone && !legacy.length)) {
    const acct = (await env.DB.prepare('SELECT id, name, pin, sort FROM profiles WHERE user_id = ?1').bind(d.user_id).all()).results;
    let sort = acct.reduce((m, p) => Math.max(m, p.sort), 0);
    const stmts = [];
    for (const p of reported) {
      const same = acct.find((a) => a.name.toLowerCase() === p.name.toLowerCase());
      if (same) {
        map[p.id] = same.id;
        if (!same.pin && p.pin) stmts.push(env.DB.prepare('UPDATE profiles SET pin = ?1, updated_at = ?2 WHERE id = ?3').bind(p.pin, now, same.id));
      } else {
        const id = randomToken(12);
        map[p.id] = id;
        acct.push({ id, name: p.name, pin: p.pin, sort: ++sort });
        stmts.push(env.DB.prepare(`INSERT INTO profiles (id, user_id, name, kids, parent, color, pin, sort, created_at, updated_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`).bind(id, d.user_id, p.name, p.kids ? 1 : 0, p.parent ? 1 : 0, p.color, p.pin, sort, now));
      }
      stmts.push(env.DB.prepare('INSERT OR IGNORE INTO device_profiles (device_id, profile_id, user_id) VALUES (?1, ?2, ?3)')
        .bind(d.id, map[p.id], d.user_id));
    }
    const mine = new Set((await env.DB.prepare('SELECT id FROM account_playlists WHERE user_id = ?1').bind(d.user_id).all()).results.map((r) => r.id));
    for (const t of legacy) {
      const ids = t.profiles ? JSON.parse(t.profiles).map((x) => map[x]).filter(Boolean) : Object.values(map);
      for (const pid of ids) {
        stmts.push(env.DB.prepare('INSERT OR IGNORE INTO profile_playlists (profile_id, playlist_id, user_id) VALUES (?1, ?2, ?3)')
          .bind(pid, t.playlist_id, d.user_id));
      }
    }
    // What each profile hid on the device (or, for Kids, could see) in the account's playlists, unless the account
    // already says otherwise for that profile.
    for (const [local, perPl] of Object.entries(visibility && typeof visibility === 'object' ? visibility : {})) {
      if (!map[local] || !perPl || typeof perPl !== 'object') continue;
      for (const [pl, v] of Object.entries(perPl)) {
        if (!mine.has(pl)) continue;
        const vis = cleanVis(v);
        if (visEmpty(vis)) continue;
        stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO profile_visibility (profile_id, playlist_id, user_id, data, updated_at)
          VALUES (?1, ?2, ?3, ?4, ?5)`).bind(map[local], pl, d.user_id, JSON.stringify(vis), now));
      }
    }
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  }
  await env.DB.prepare('UPDATE devices SET managed_at = ?1 WHERE id = ?2').bind(now, d.id).run();
  await reconcile(env, d.user_id);
  return map;
}

/** The profiles on device [deviceId], in the account's order, as the device needs them; and their hash. */
export async function deviceProfiles(env, deviceId) {
  const ps = (await env.DB.prepare(
    `SELECT p.id, p.name, p.kids, p.parent, p.color, p.pin FROM device_profiles dp JOIN profiles p ON p.id = dp.profile_id
      WHERE dp.device_id = ?1 ORDER BY p.sort, p.created_at`
  ).bind(deviceId).all()).results;
  const ids = ps.map((p) => p.id);
  const pls = ids.length ? (await env.DB.prepare(
    `SELECT pp.profile_id, pp.playlist_id FROM profile_playlists pp JOIN account_playlists a ON a.id = pp.playlist_id AND a.removing = 0
      WHERE pp.profile_id IN (SELECT profile_id FROM device_profiles WHERE device_id = ?1)`
  ).bind(deviceId).all()).results : [];
  const vis = ids.length ? (await env.DB.prepare(
    'SELECT profile_id, playlist_id, data FROM profile_visibility WHERE profile_id IN (SELECT profile_id FROM device_profiles WHERE device_id = ?1)'
  ).bind(deviceId).all()).results : [];
  const list = ps.map((p) => {
    const mine = pls.filter((x) => x.profile_id === p.id).map((x) => x.playlist_id).sort();
    const v = {};
    for (const r of vis) if (r.profile_id === p.id && mine.includes(r.playlist_id)) v[r.playlist_id] = JSON.parse(r.data);
    return { id: p.id, name: p.name, kids: Boolean(p.kids), parent: Boolean(p.parent), color: p.color, pin: p.pin || '', playlists: mine, visibility: v };
  });
  return { list, hash: (await sha256hex(JSON.stringify(list))).slice(0, 24) };
}

async function tvCatalog(request, env) {
  const [d, no] = await tvDevice(request, env); if (no) return no;
  const text = await request.text();
  if (text.length > CATALOG_MAX) return json({ error: 'Too big.' }, 413);
  let b; try { b = JSON.parse(text); } catch { return json({ error: 'Not JSON.' }, 400); }
  const pl = clip(b?.playlistId, 40);
  const own = await env.DB.prepare('SELECT 1 FROM account_playlists WHERE id = ?1 AND user_id = ?2').bind(pl, d.user_id).first();
  if (!own) return json({ ok: true, ignored: true });
  const cats = (a) => (Array.isArray(a) ? a.slice(0, 3000).map((x) => [clip(String(x?.[0] ?? ''), 200), Number(x?.[1]) || 0]).filter((x) => x[0]) : []);
  const live = Array.isArray(b?.live) ? b.live.slice(0, 3000).map((g) => ({
    n: clip(String(g?.n ?? ''), 200), c: Number(g?.c) || 0,
    ch: Array.isArray(g?.ch) ? g.ch.slice(0, 5000).map((x) => [clip(String(x?.[0] ?? ''), 120), clip(String(x?.[1] ?? ''), 120)]).filter((x) => x[0]) : [],
  })).filter((g) => g.n) : [];
  const data = JSON.stringify({ live, movie: cats(b?.movie), series: cats(b?.series), device: d.name });
  await env.DB.prepare(`INSERT INTO playlist_catalogs (playlist_id, user_id, data, updated_at) VALUES (?1, ?2, ?3, ?4)
    ON CONFLICT(playlist_id) DO UPDATE SET data = ?3, updated_at = ?4`).bind(pl, d.user_id, data, Date.now()).run();
  return json({ ok: true });
}

async function tvPlaying(request, env) {
  const [d, no] = await tvDevice(request, env); if (no) return no;
  const b = await body(request);
  const now = Date.now();
  const row = await env.DB.prepare('SELECT stop_at FROM devices WHERE id = ?1').bind(d.id).first();
  const stop = Boolean(row?.stop_at);
  if (!b?.playing || stop) {
    await env.DB.prepare('UPDATE devices SET playing = NULL, playing_at = NULL, stop_at = NULL, last_seen = ?1 WHERE id = ?2').bind(now, d.id).run();
    return json({ ok: true, stop });
  }
  const playing = {
    playlistId: clip(b.playlistId, 40) || null, playlist: clip(b.playlistName, 60) || 'A playlist',
    profileId: clip(b.profileId, 60) || null, profile: clip(b.profileName, 40) || null,
    since: Math.min(now, Number(b.startedAt) || now),
  };
  await env.DB.prepare('UPDATE devices SET playing = ?1, playing_at = ?2, last_seen = ?2 WHERE id = ?3').bind(JSON.stringify(playing), now, d.id).run();
  return json({ ok: true, stop: false });
}

export async function handleProfileTvApi(request, env, p) {
  if (p === '/api/tv/catalog' && request.method === 'POST') return tvCatalog(request, env);
  if (p === '/api/tv/playing' && request.method === 'POST') return tvPlaying(request, env);
  return null;
}

// ---------------------------------------------------------------- account side

export async function manage(env, user) {
  const uid = user.id;
  // Devices removed from the account no longer count.
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM playlist_targets WHERE user_id = ?1 AND device_id NOT IN (SELECT id FROM devices WHERE user_id = ?1 AND revoked_at IS NULL)`).bind(uid),
    env.DB.prepare(`DELETE FROM device_profiles WHERE user_id = ?1 AND device_id NOT IN (SELECT id FROM devices WHERE user_id = ?1 AND revoked_at IS NULL)`).bind(uid),
    env.DB.prepare(`DELETE FROM account_playlists WHERE user_id = ?1 AND removing = 1 AND id NOT IN (SELECT playlist_id FROM playlist_targets)`).bind(uid),
  ]);
  const now = Date.now();
  const [devs, pls, ts, profs, pp, dp, vis, cats, keys] = await Promise.all([
    env.DB.prepare(`SELECT id, name, model, app_version, pubkey, profiles, managed_at, last_seen, playing, playing_at, stop_at FROM devices
      WHERE user_id = ?1 AND revoked_at IS NULL ORDER BY created_at`).bind(uid).all(),
    env.DB.prepare('SELECT id, name, type, updated_at, removing, (vault IS NOT NULL) AS kept FROM account_playlists WHERE user_id = ?1 ORDER BY name').bind(uid).all(),
    env.DB.prepare('SELECT playlist_id, device_id, profiles, action, status, error, updated_at FROM playlist_targets WHERE user_id = ?1').bind(uid).all(),
    env.DB.prepare('SELECT id, name, kids, parent, color, (pin IS NOT NULL) AS has_pin, sort FROM profiles WHERE user_id = ?1 ORDER BY sort, created_at').bind(uid).all(),
    env.DB.prepare('SELECT profile_id, playlist_id FROM profile_playlists WHERE user_id = ?1').bind(uid).all(),
    env.DB.prepare('SELECT device_id, profile_id FROM device_profiles WHERE user_id = ?1').bind(uid).all(),
    env.DB.prepare('SELECT profile_id, playlist_id, data FROM profile_visibility WHERE user_id = ?1').bind(uid).all(),
    env.DB.prepare('SELECT playlist_id, updated_at FROM playlist_catalogs WHERE user_id = ?1').bind(uid).all(),
    env.DB.prepare('SELECT credential_id, wrapped FROM vault_keys WHERE user_id = ?1').bind(uid).all(),
  ]);
  return json({
    devices: devs.results.map((d) => ({
      id: d.id, name: d.name, model: d.model, appVersion: d.app_version, pubkey: d.pubkey || null, managed: Boolean(d.managed_at),
      lastSeen: d.last_seen, ownProfiles: d.profiles ? JSON.parse(d.profiles) : [],
      profiles: dp.results.filter((x) => x.device_id === d.id).map((x) => x.profile_id),
      playing: d.playing && d.playing_at > now - PLAYING_FRESH ? { ...JSON.parse(d.playing), stopping: Boolean(d.stop_at) } : null,
    })),
    playlists: pls.results.map((p) => ({
      id: p.id, name: p.name, type: p.type, updatedAt: p.updated_at, removing: Boolean(p.removing), kept: Boolean(p.kept),
      profiles: pp.results.filter((x) => x.playlist_id === p.id).map((x) => x.profile_id),
      catalogAt: cats.results.find((c) => c.playlist_id === p.id)?.updated_at || null,
      targets: ts.results.filter((t) => t.playlist_id === p.id).map((t) => ({
        deviceId: t.device_id, profiles: t.profiles ? JSON.parse(t.profiles) : null, action: t.action, status: t.status, error: t.error, updatedAt: t.updated_at,
      })),
    })),
    profiles: profs.results.map((p) => ({
      id: p.id, name: p.name, kids: Boolean(p.kids), parent: Boolean(p.parent), color: p.color, hasPin: Boolean(p.has_pin),
      playlists: pp.results.filter((x) => x.profile_id === p.id).map((x) => x.playlist_id),
      devices: dp.results.filter((x) => x.profile_id === p.id).map((x) => x.device_id),
      visibility: Object.fromEntries(vis.results.filter((v) => v.profile_id === p.id).map((v) => [v.playlist_id, JSON.parse(v.data)])),
    })),
    vault: keys.results.map((k) => ({ credentialId: k.credential_id, wrapped: k.wrapped })),
    pending: await pendingLogins(env, uid),
  });
}

export async function catalogFor(env, user, url) {
  const row = await env.DB.prepare('SELECT data, updated_at FROM playlist_catalogs WHERE playlist_id = ?1 AND user_id = ?2')
    .bind(url.searchParams.get('playlist') || '', user.id).first();
  if (!row) return json({ catalog: null });
  return json({ catalog: JSON.parse(row.data), updatedAt: row.updated_at });
}

async function ownIds(env, table, userId, ids) {
  if (!ids.length) return [];
  const r = await env.DB.prepare(`SELECT id FROM ${table} WHERE user_id = ?1`).bind(userId).all();
  const mine = new Set(r.results.map((x) => x.id));
  return ids.filter((i) => mine.has(i));
}

/** A Kids profile needs a PIN on every other profile: the ones still missing one, after [pins] are set. */
async function missingPins(env, userId) {
  const r = (await env.DB.prepare('SELECT id, name, kids, pin FROM profiles WHERE user_id = ?1').bind(userId).all()).results;
  if (!r.some((p) => p.kids)) return [];
  return r.filter((p) => !p.kids && !p.pin).map((p) => ({ id: p.id, name: p.name }));
}

export async function profileSave(request, env, user) {
  const b = await body(request);
  const name = clip(b?.name, 40);
  if (!name) return json({ error: 'Give the profile a name.' }, 400);
  const kids = Boolean(b?.kids);
  const now = Date.now();
  let id = clip(b?.id, 40);
  const pins = b?.pins && typeof b.pins === 'object' ? b.pins : {};
  for (const v of Object.values(pins)) if (!(typeof v === 'string' && PIN.test(v))) return json({ error: 'A PIN wasn\'t made correctly. Reload the page.' }, 400);
  const pin = b?.pin === '' ? '' : (typeof b?.pin === 'string' && PIN.test(b.pin) ? b.pin : undefined);
  const others = (await env.DB.prepare('SELECT id, name, kids, pin FROM profiles WHERE user_id = ?1').bind(user.id).all()).results;
  if (others.some((p) => p.id !== id && p.name.toLowerCase() === name.toLowerCase())) return json({ error: `There's already a profile called ${name}.` }, 400);
  if (id && !others.some((p) => p.id === id)) return json({ error: 'That profile is no longer in your account.' }, 404);
  // The Kids rule, checked before anything is saved: every grown-up profile needs a PIN while a Kids profile exists.
  const after = others.filter((p) => p.id !== id).map((p) => ({ ...p, pin: pins[p.id] || p.pin }));
  after.push({ id: id || 'new', name, kids, pin: kids ? null : (pin === undefined ? others.find((p) => p.id === id)?.pin : pin || null) });
  if (after.some((p) => p.kids)) {
    const missing = after.filter((p) => !p.kids && !p.pin);
    if (missing.length) return json({ error: 'While a Kids profile exists, every other profile needs a PIN: ' + missing.map((p) => p.name).join(', ') + '.', needPins: missing.map((p) => p.id) }, 400);
  }
  const playlists = await ownIds(env, 'account_playlists', user.id, strList(b?.playlists, 100, 40));
  const managedDevs = new Set((await env.DB.prepare('SELECT id FROM devices WHERE user_id = ?1 AND revoked_at IS NULL AND managed_at IS NOT NULL')
    .bind(user.id).all()).results.map((r) => r.id));
  const devices = strList(b?.devices, 100, 40).filter((d) => managedDevs.has(d));
  const stmts = [];
  const color = Math.max(0, Math.min(5, Number(b?.color) || 0));
  if (id) {
    stmts.push(env.DB.prepare('UPDATE profiles SET name = ?1, kids = ?2, parent = ?3, color = ?4, updated_at = ?5 WHERE id = ?6')
      .bind(name, kids ? 1 : 0, !kids && b?.parent ? 1 : 0, color, now, id));
  } else {
    id = randomToken(12);
    const sort = others.length ? (await env.DB.prepare('SELECT MAX(sort) AS m FROM profiles WHERE user_id = ?1').bind(user.id).first()).m + 1 : 1;
    stmts.push(env.DB.prepare(`INSERT INTO profiles (id, user_id, name, kids, parent, color, pin, sort, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8, ?8)`).bind(id, user.id, name, kids ? 1 : 0, !kids && b?.parent ? 1 : 0, color, sort, now));
  }
  if (kids) stmts.push(env.DB.prepare('UPDATE profiles SET pin = NULL WHERE id = ?1').bind(id));
  else if (pin !== undefined) stmts.push(env.DB.prepare('UPDATE profiles SET pin = ?1 WHERE id = ?2').bind(pin || null, id));
  for (const [pid, v] of Object.entries(pins)) {
    if (others.some((p) => p.id === pid && !p.kids)) stmts.push(env.DB.prepare('UPDATE profiles SET pin = ?1, updated_at = ?2 WHERE id = ?3').bind(v, now, pid));
  }
  if (Array.isArray(b?.playlists)) {
    stmts.push(env.DB.prepare('DELETE FROM profile_playlists WHERE profile_id = ?1').bind(id));
    for (const pl of playlists) stmts.push(env.DB.prepare('INSERT INTO profile_playlists (profile_id, playlist_id, user_id) VALUES (?1, ?2, ?3)').bind(id, pl, user.id));
  }
  if (Array.isArray(b?.devices)) {
    stmts.push(env.DB.prepare('DELETE FROM device_profiles WHERE profile_id = ?1').bind(id));
    for (const dv of devices) stmts.push(env.DB.prepare('INSERT INTO device_profiles (device_id, profile_id, user_id) VALUES (?1, ?2, ?3)').bind(dv, id, user.id));
  }
  await env.DB.batch(stmts);
  return json({ ok: true, id, pending: await reconcile(env, user.id) });
}

export async function profileRemove(request, env, user) {
  const b = await body(request);
  const id = clip(b?.id, 40);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM profile_playlists WHERE profile_id = ?1 AND user_id = ?2').bind(id, user.id),
    env.DB.prepare('DELETE FROM device_profiles WHERE profile_id = ?1 AND user_id = ?2').bind(id, user.id),
    env.DB.prepare('DELETE FROM profile_visibility WHERE profile_id = ?1 AND user_id = ?2').bind(id, user.id),
    env.DB.prepare('DELETE FROM profiles WHERE id = ?1 AND user_id = ?2').bind(id, user.id),
  ]);
  return json({ ok: true, pending: await reconcile(env, user.id) });
}

export async function profilePin(request, env, user) {
  const b = await body(request);
  const id = clip(b?.id, 40);
  const pin = typeof b?.pin === 'string' && PIN.test(b.pin) ? b.pin : null;
  const p = await env.DB.prepare('SELECT kids FROM profiles WHERE id = ?1 AND user_id = ?2').bind(id, user.id).first();
  if (!p || p.kids) return json({ error: 'A Kids profile has no PIN.' }, 400);
  if (!pin && (await env.DB.prepare('SELECT 1 FROM profiles WHERE user_id = ?1 AND kids = 1').bind(user.id).first())) {
    return json({ error: 'While a Kids profile exists, this profile needs a PIN. Change it instead of removing it.' }, 400);
  }
  await env.DB.prepare('UPDATE profiles SET pin = ?1, updated_at = ?2 WHERE id = ?3').bind(pin, Date.now(), id).run();
  return json({ ok: true });
}

export async function profileVisibility(request, env, user) {
  const text = await request.text();
  if (text.length > VIS_MAX) return json({ error: 'Too many items. Hide whole categories instead of single channels.' }, 413);
  let b; try { b = JSON.parse(text); } catch { return json({ error: 'Not JSON.' }, 400); }
  const prof = clip(b?.profileId, 40), pl = clip(b?.playlistId, 40);
  const ok = await env.DB.prepare(`SELECT 1 FROM profiles p, account_playlists a WHERE p.id = ?1 AND a.id = ?2 AND p.user_id = ?3 AND a.user_id = ?3`)
    .bind(prof, pl, user.id).first();
  if (!ok) return json({ error: 'That profile or playlist is no longer in your account.' }, 404);
  const vis = cleanVis(b?.data);
  await env.DB.prepare(`INSERT INTO profile_visibility (profile_id, playlist_id, user_id, data, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
    ON CONFLICT(profile_id, playlist_id) DO UPDATE SET data = ?4, updated_at = ?5`).bind(prof, pl, user.id, JSON.stringify(vis), Date.now()).run();
  return json({ ok: true });
}

export async function deviceSetProfiles(request, env, user) {
  const b = await body(request);
  const dev = await env.DB.prepare('SELECT id, managed_at FROM devices WHERE id = ?1 AND user_id = ?2 AND revoked_at IS NULL').bind(clip(b?.deviceId, 40), user.id).first();
  if (!dev) return json({ error: 'That device is no longer linked.' }, 404);
  if (!dev.managed_at) return json({ error: 'Update Avid Viewer on this device to 1.15.0 or later and open it once, then choose its profiles.' }, 400);
  const ids = await ownIds(env, 'profiles', user.id, strList(b?.profiles, 20, 40));
  const stmts = [env.DB.prepare('DELETE FROM device_profiles WHERE device_id = ?1').bind(dev.id)];
  for (const id of ids) stmts.push(env.DB.prepare('INSERT INTO device_profiles (device_id, profile_id, user_id) VALUES (?1, ?2, ?3)').bind(dev.id, id, user.id));
  await env.DB.batch(stmts);
  return json({ ok: true, pending: await reconcile(env, user.id) });
}

export async function deviceStop(request, env, user) {
  const b = await body(request);
  const r = await env.DB.prepare('UPDATE devices SET stop_at = ?1 WHERE id = ?2 AND user_id = ?3 AND playing IS NOT NULL')
    .bind(Date.now(), clip(b?.deviceId, 40), user.id).run();
  return json({ ok: true, stopping: Boolean(r.meta?.changes) });
}

export async function vaultKey(request, env, user) {
  const b = await body(request);
  const cred = clip(b?.credentialId, 400), wrapped = clip(b?.wrapped, 400);
  if (!cred || !/^[A-Za-z0-9+/=]{40,400}$/.test(wrapped)) return json({ error: 'That key wasn\'t made correctly.' }, 400);
  await env.DB.prepare(`INSERT INTO vault_keys (user_id, credential_id, wrapped, created_at) VALUES (?1, ?2, ?3, ?4)
    ON CONFLICT(user_id, credential_id) DO NOTHING`).bind(user.id, cred, wrapped, Date.now()).run();
  return json({ ok: true });
}

export { missingPins };
