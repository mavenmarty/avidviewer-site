// Pick up where you left off (Nov 17, 2026; app 1.17.0).
//
// What a profile watched (where it stopped, finished episodes), its Discover settings (My List, My services) and the
// account's TMDB key are locked with a history key that only the TVs and the owner's passkey have. This file only ever
// stores and hands back locked blobs: nothing here (or in the admin panel) can read a title, a time or a TV name.
// On when the account's "Keep my watch history" is on (the default) and the profile isn't switched off.
//
// Device (Bearer token):
//   POST /api/tv/history {profiles:[{id, since, put:[{item, blob|null, at}], discover:{blob, at}?}]}
//     → {enabled, key (the history key sealed for this device, or null), tmdb:{blob, at}|null,
//        profiles:[{id, enabled, seq, items:[{item, blob|null, at}], discover:{blob, at}|null}]}
// Account (signed in): history (GET), history/put, history/key, history/devices, history/seal, profiles/history,
//   discover, tmdb.

import { json, body } from './auth.js';
import { deviceFor } from './devices.js';

const BLOB = /^[A-Za-z0-9+/=]{16,40000}$/;
const ITEM = /^[A-Za-z0-9_-]{8,64}$/;
const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

async function on(env, userId) {
  const u = await env.DB.prepare('SELECT watch_history FROM users WHERE id = ?1').bind(userId).first();
  return Boolean(u?.watch_history);
}

async function tvHistory(request, env) {
  const d = await deviceFor(request, env);
  if (!d) return json({ error: 'This device is not linked.' }, 401);
  const text = await request.text();
  if (text.length > 3_000_000) return json({ error: 'Too big.' }, 413);
  const b = parse(text);
  if (!b) return json({ error: 'Not JSON.' }, 400);
  const enabled = await on(env, d.user_id);
  const now = Date.now();
  // Kids profiles never share where they stopped and have no Discover (their privacy): nothing of theirs is kept.
  const mine = new Map((await env.DB.prepare(`SELECT p.id, p.history_off FROM profiles p JOIN device_profiles dp ON dp.profile_id = p.id
      WHERE dp.device_id = ?1 AND p.user_id = ?2 AND p.kids = 0`).bind(d.id, d.user_id).all()).results.map((r) => [r.id, !r.history_off]));
  const out = [];
  for (const p of Array.isArray(b.profiles) ? b.profiles.slice(0, 20) : []) {
    const id = clip(p?.id, 40);
    if (!mine.has(id)) continue;
    const pOn = enabled && mine.get(id);
    // Discover settings sync even when history is off (they're settings, not history).
    const dsc = p.discover;
    if (dsc && BLOB.test(dsc.blob || '')) {
      const at = Math.min(now, Number(dsc.at) || now);
      await env.DB.prepare(`INSERT INTO profile_discover (profile_id, user_id, blob, updated_at) VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(profile_id) DO UPDATE SET blob = ?3, updated_at = ?4 WHERE ?4 >= profile_discover.updated_at`).bind(id, d.user_id, dsc.blob, at).run();
    }
    if (pOn) {
      const stmts = [];
      for (const it of Array.isArray(p.put) ? p.put.slice(0, 2000) : []) {
        const item = clip(it?.item, 64);
        if (!ITEM.test(item)) continue;
        const blob = it.blob == null ? null : clip(it.blob, 40000);
        if (blob !== null && !BLOB.test(blob)) continue;
        const at = Math.min(now, Number(it.at) || now);
        stmts.push(env.DB.prepare(`INSERT INTO profile_history (profile_id, user_id, item, blob, deleted, updated_at, seq) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
          ON CONFLICT(profile_id, item) DO UPDATE SET blob = ?4, deleted = ?5, updated_at = ?6, seq = ?7 WHERE ?6 >= profile_history.updated_at`)
          .bind(id, d.user_id, item, blob, blob === null ? 1 : 0, at, now));
      }
      for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
    }
    const since = Number(p.since) || 0;
    const rows = pOn ? (await env.DB.prepare('SELECT item, blob, deleted, updated_at FROM profile_history WHERE profile_id = ?1 AND seq >= ?2 ORDER BY seq LIMIT 5000')
      .bind(id, since).all()).results : [];
    const disc = await env.DB.prepare('SELECT blob, updated_at FROM profile_discover WHERE profile_id = ?1').bind(id).first();
    out.push({
      id, enabled: pOn, seq: now,
      items: rows.map((r) => ({ item: r.item, blob: r.deleted ? null : r.blob, at: r.updated_at })),
      discover: disc ? { blob: disc.blob, at: disc.updated_at } : null,
    });
  }
  const key = await env.DB.prepare('SELECT sealed FROM device_history_keys WHERE device_id = ?1 AND user_id = ?2').bind(d.id, d.user_id).first();
  const sec = await env.DB.prepare('SELECT tmdb, updated_at FROM account_secrets WHERE user_id = ?1').bind(d.user_id).first();
  return json({
    enabled, key: key ? parse(key.sealed) : null,
    tmdb: sec ? { blob: sec.tmdb, at: sec.updated_at } : null,
    profiles: out,
  });
}

export async function handleHistoryTvApi(request, env, p) {
  if (p === '/api/tv/history' && request.method === 'POST') return tvHistory(request, env);
  return null;
}

// ---------------------------------------------------------------- account side

async function ownProfile(env, user, id) {
  return env.DB.prepare('SELECT id, history_off FROM profiles WHERE id = ?1 AND user_id = ?2 AND kids = 0').bind(clip(id, 40), user.id).first();
}

/** A profile's locked places and Discover settings (opened in the browser with the passkey). */
export async function historyGet(env, user, url) {
  const p = await ownProfile(env, user, url.searchParams.get('profile'));
  if (!p) return json({ error: 'That profile is no longer in your account.' }, 404);
  const rows = (await env.DB.prepare('SELECT item, blob, updated_at FROM profile_history WHERE profile_id = ?1 AND deleted = 0 ORDER BY updated_at DESC LIMIT 2000').bind(p.id).all()).results;
  const disc = await env.DB.prepare('SELECT blob, updated_at FROM profile_discover WHERE profile_id = ?1').bind(p.id).first();
  return json({
    enabled: await on(env, user.id), off: Boolean(p.history_off),
    items: rows.map((r) => ({ item: r.item, blob: r.blob, at: r.updated_at })),
    discover: disc ? { blob: disc.blob, at: disc.updated_at } : null,
  });
}

/** Mark watched (a new locked blob) or Remove (blob null) from the website. */
export async function historyPut(request, env, user) {
  const b = await body(request);
  const p = await ownProfile(env, user, b?.profileId);
  if (!p) return json({ error: 'That profile is no longer in your account.' }, 404);
  const item = clip(b?.item, 64);
  if (!ITEM.test(item)) return json({ error: 'Not a title.' }, 400);
  const blob = b?.blob == null ? null : clip(b.blob, 40000);
  if (blob !== null && !BLOB.test(blob)) return json({ error: 'Not locked correctly.' }, 400);
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO profile_history (profile_id, user_id, item, blob, deleted, updated_at, seq) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
    ON CONFLICT(profile_id, item) DO UPDATE SET blob = ?4, deleted = ?5, updated_at = ?6, seq = ?6`).bind(p.id, user.id, item, blob, blob === null ? 1 : 0, now).run();
  return json({ ok: true });
}

/** The history key, wrapped with the vault key; only the first one is kept. */
export async function historyKeySave(request, env, user) {
  const b = await body(request);
  const wrapped = typeof b?.wrapped === 'string' && /^[A-Za-z0-9+/=]{40,400}$/.test(b.wrapped) ? b.wrapped : null;
  if (!wrapped) return json({ error: "That key wasn't made correctly." }, 400);
  await env.DB.prepare('UPDATE account_keys SET history = ?1 WHERE user_id = ?2 AND history IS NULL').bind(wrapped, user.id).run();
  const row = await env.DB.prepare('SELECT history FROM account_keys WHERE user_id = ?1').bind(user.id).first();
  if (!row) return json({ error: 'Set up locked logins first (Playlists › Set up with passkey).' }, 409);
  return json({ ok: true, history: row.history });
}

/** Linked devices that don't have the history key yet (with their public keys, to lock it for them). */
export async function historyDevices(env, user) {
  const r = await env.DB.prepare(`SELECT id, name, pubkey FROM devices WHERE user_id = ?1 AND revoked_at IS NULL AND pubkey IS NOT NULL
      AND id NOT IN (SELECT device_id FROM device_history_keys WHERE user_id = ?1)`).bind(user.id).all();
  return json({ devices: r.results.map((d) => ({ id: d.id, name: d.name, pubkey: d.pubkey })) });
}

export async function historySeal(request, env, user) {
  const b = await body(request);
  const stmts = [];
  for (const it of Array.isArray(b?.items) ? b.items.slice(0, 50) : []) {
    const s = it?.sealed;
    if (!s || typeof s !== 'object' || ![s.epk, s.iv, s.ct].every((x) => typeof x === 'string' && x.length < 2000)) continue;
    const dev = await env.DB.prepare('SELECT id FROM devices WHERE id = ?1 AND user_id = ?2 AND revoked_at IS NULL').bind(clip(it.deviceId, 40), user.id).first();
    if (!dev) continue;
    stmts.push(env.DB.prepare(`INSERT INTO device_history_keys (device_id, user_id, sealed, created_at) VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT(device_id) DO NOTHING`).bind(dev.id, user.id, JSON.stringify({ v: 1, epk: s.epk, iv: s.iv, ct: s.ct }), Date.now()));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return json({ ok: true, sealed: stmts.length });
}

/** A profile's places on every TV, or only on each TV (off deletes what the account holds). */
export async function profileHistory(request, env, user) {
  const b = await body(request);
  const p = await ownProfile(env, user, b?.profileId);
  if (!p) return json({ error: 'That profile is no longer in your account.' }, 404);
  const off = Boolean(b?.off);
  const stmts = [env.DB.prepare('UPDATE profiles SET history_off = ?1, updated_at = ?2 WHERE id = ?3').bind(off ? 1 : 0, Date.now(), p.id)];
  if (off || b?.clear) stmts.push(env.DB.prepare('DELETE FROM profile_history WHERE profile_id = ?1').bind(p.id));
  await env.DB.batch(stmts);
  return json({ ok: true, off });
}

/** Clears every profile's places (account switch turned off). */
export async function clearAllHistory(env, userId) {
  await env.DB.prepare('DELETE FROM profile_history WHERE user_id = ?1').bind(userId).run();
}

export async function discoverSave(request, env, user) {
  const b = await body(request);
  const p = await ownProfile(env, user, b?.profileId);
  if (!p) return json({ error: 'That profile is no longer in your account.' }, 404);
  if (!BLOB.test(b?.blob || '')) return json({ error: 'Not locked correctly.' }, 400);
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO profile_discover (profile_id, user_id, blob, updated_at) VALUES (?1, ?2, ?3, ?4)
    ON CONFLICT(profile_id) DO UPDATE SET blob = ?3, updated_at = ?4`).bind(p.id, user.id, b.blob, now).run();
  return json({ ok: true, at: now });
}

export async function tmdbSave(request, env, user) {
  const b = await body(request);
  const blob = b?.blob == null ? null : clip(b.blob, 2000);
  if (blob !== null && !BLOB.test(blob)) return json({ error: 'Not locked correctly.' }, 400);
  await env.DB.prepare(`INSERT INTO account_secrets (user_id, tmdb, updated_at) VALUES (?1, ?2, ?3)
    ON CONFLICT(user_id) DO UPDATE SET tmdb = ?2, updated_at = ?3`).bind(user.id, blob, Date.now()).run();
  return json({ ok: true });
}

/** For the manage page: whether a key exists, how many devices still need it, the TMDB key's presence (never its value). */
export async function historySummary(env, userId) {
  const k = await env.DB.prepare('SELECT history FROM account_keys WHERE user_id = ?1').bind(userId).first();
  const need = await env.DB.prepare(`SELECT COUNT(*) n FROM devices WHERE user_id = ?1 AND revoked_at IS NULL AND pubkey IS NOT NULL AND managed_at IS NOT NULL
      AND id NOT IN (SELECT device_id FROM device_history_keys WHERE user_id = ?1)`).bind(userId).first();
  const sec = await env.DB.prepare('SELECT tmdb FROM account_secrets WHERE user_id = ?1').bind(userId).first();
  return { wrapped: k?.history || null, devicesWaiting: need?.n || 0, tmdb: Boolean(sec?.tmdb), tmdbBlob: sec?.tmdb || null };
}
