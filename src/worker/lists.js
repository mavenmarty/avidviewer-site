// Favorites, lists, order and names (Nov 17, 2026; app 1.16.0).
//
// Favorites and lists belong to a profile and follow it to every device; category and channel order and names belong to
// a playlist (the whole account). Either side can change them; the most recent change wins. The first time a device
// syncs a profile, its favorites and lists are combined with the account's (same list name = one list).
//
// Device (Bearer token):
//   POST /api/tv/sync  {profiles:[{id, changedAt, data}], playlists:[{id, changedAt, data}], known:{profiles:{id:hash}, playlists:{id:hash}}}
//        → {profiles:[{id, hash, data}], playlists:[{id, hash, data}]}   what the device doesn't have yet
// Account (signed in):
//   GET  /api/account/lists?profile=     POST /api/account/lists {profileId, data}
//   GET  /api/account/order?playlist=    POST /api/account/order {playlistId, data}
//
// Keys: a channel is "<account playlist id>:<the playlist's own channel id>" in lists; order uses the channel id alone.

import { json, body, sha256hex } from './auth.js';
import { deviceFor } from './devices.js';

const MAX_DOC = 900_000;
const str = (v, n = 300) => (typeof v === 'string' ? v.slice(0, n) : String(v ?? '').slice(0, n));
const arr = (a, n, f) => (Array.isArray(a) ? a.slice(0, n).map(f).filter((x) => x !== '' && x != null) : []);
const obj = (o, n, fv) => {
  const out = {};
  if (o && typeof o === 'object' && !Array.isArray(o)) for (const [k, v] of Object.entries(o).slice(0, n)) { const x = fv(v); if (x !== '' && x != null) out[str(k)] = x; }
  return out;
};

// 1.18.0: how lists and a playlist's channels are sorted. A document without them (an older app) keeps the stored one.
const LIST_SORT = ['az', 'manual'];
const CHANNEL_SORT = ['provider', 'az', 'manual'];
const pick = (v, ok) => (ok.includes(v) ? v : undefined);
export function cleanLists(d) {
  const keys = (a) => [...new Set(arr(a, 5000, (k) => str(k, 200)))];
  const out = {
    favorites: keys(d?.favorites),
    lists: arr(d?.lists, 100, (l) => (l && typeof l === 'object' ? { id: str(l.id, 60) || null, name: str(l.name, 60).trim(), hidden: Boolean(l.hidden), keys: keys(l.keys), sort: pick(l.sort, LIST_SORT) } : null))
      .filter((l) => l && l.id && l.name),
  };
  const fs = pick(d?.favSort, LIST_SORT); if (fs) out.favSort = fs;
  out.lists.forEach((l) => { if (!l.sort) delete l.sort; });
  return out;
}
export function cleanOrder(d) {
  const out = {
    groupOrder: [...new Set(arr(d?.groupOrder, 5000, (x) => str(x, 200)))],
    groupNames: obj(d?.groupNames, 5000, (v) => str(v, 80).trim()),
    channelOrder: obj(d?.channelOrder, 3000, (v) => [...new Set(arr(v, 20000, (x) => str(x, 120)))]),
    channelNames: obj(d?.channelNames, 20000, (v) => str(v, 80).trim()),
  };
  const cs = pick(d?.channelSort, CHANNEL_SORT); if (cs) out.channelSort = cs;
  return out;
}
/** Sorts a document from an older app doesn't carry stay as they were. */
export function keepSorts(next, cur, kind) {
  if (!cur) return next;
  if (kind === 'order') { if (!next.channelSort && cur.channelSort) next.channelSort = cur.channelSort; return next; }
  if (!next.favSort && cur.favSort) next.favSort = cur.favSort;
  const was = new Map((cur.lists || []).map((l) => [l.id, l.sort]));
  next.lists.forEach((l) => { if (!l.sort && was.get(l.id)) l.sort = was.get(l.id); });
  return next;
}
const hashOf = async (data) => (await sha256hex(JSON.stringify(data))).slice(0, 16);

/**
 * The first sync of a device for a profile: the account's favorites and lists combined with the device's. The newer
 * side's order comes first, then what only the other side has; lists with the same name (case ignored) become one.
 */
export function combine(account, device, deviceNewer) {
  const [a, b] = deviceNewer ? [device, account] : [account, device];
  const join = (x, y) => [...x, ...y.filter((k) => !x.includes(k))];
  const lists = a.lists.map((l) => ({ ...l, keys: [...l.keys] }));
  for (const l of b.lists) {
    const same = lists.find((m) => m.name.toLowerCase() === l.name.toLowerCase());
    if (same) same.keys = join(same.keys, l.keys);
    else lists.push({ ...l });
  }
  const out = { favorites: join(a.favorites, b.favorites), lists };
  const fs = a.favSort || b.favSort; if (fs) out.favSort = fs;
  return out;
}

async function tvSync(request, env) {
  const d = await deviceFor(request, env);
  if (!d) return json({ error: 'This device is not linked.' }, 401);
  const text = await request.text();
  if (text.length > 4_000_000) return json({ error: 'Too big.' }, 413);
  let b; try { b = JSON.parse(text); } catch { return json({ error: 'Not JSON.' }, 400); }
  const now = Date.now();
  const myProfiles = new Set((await env.DB.prepare('SELECT profile_id FROM device_profiles WHERE device_id = ?1').bind(d.id).all()).results.map((r) => r.profile_id));
  const myPlaylists = new Set((await env.DB.prepare(`SELECT playlist_id FROM playlist_targets WHERE device_id = ?1 AND action != 'remove'`).bind(d.id).all()).results.map((r) => r.playlist_id));

  // What the device changed.
  for (const p of Array.isArray(b?.profiles) ? b.profiles.slice(0, 20) : []) {
    const id = str(p?.id, 40);
    if (!myProfiles.has(id)) continue;
    const data = cleanLists(p.data);
    const at = Math.min(now, Number(p.changedAt) || now);
    const cur = await env.DB.prepare('SELECT data, updated_at FROM profile_lists WHERE profile_id = ?1').bind(id).first();
    const merged = await env.DB.prepare('SELECT 1 FROM device_list_merges WHERE device_id = ?1 AND profile_id = ?2').bind(d.id, id).first();
    let next = null;
    if (!cur) next = data;
    else if (!merged) next = combine(JSON.parse(cur.data), data, at > cur.updated_at);
    else if (at >= cur.updated_at) next = keepSorts(data, JSON.parse(cur.data), 'lists');
    if (next && JSON.stringify(next).length <= MAX_DOC) {
      await env.DB.prepare(`INSERT INTO profile_lists (profile_id, user_id, data, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4, ?5)
        ON CONFLICT(profile_id) DO UPDATE SET data = ?3, updated_at = ?4, updated_by = ?5`).bind(id, d.user_id, JSON.stringify(next), Math.max(at, cur?.updated_at || 0), d.name).run();
    }
    if (!merged) await env.DB.prepare('INSERT OR IGNORE INTO device_list_merges (device_id, profile_id, merged_at) VALUES (?1, ?2, ?3)').bind(d.id, id, now).run();
  }
  for (const p of Array.isArray(b?.playlists) ? b.playlists.slice(0, 50) : []) {
    const id = str(p?.id, 40);
    if (!myPlaylists.has(id)) continue;
    const data = cleanOrder(p.data);
    const at = Math.min(now, Number(p.changedAt) || now);
    const cur = await env.DB.prepare('SELECT data, updated_at FROM playlist_order WHERE playlist_id = ?1').bind(id).first();
    if (cur) keepSorts(data, JSON.parse(cur.data), 'order');
    if ((!cur || at >= cur.updated_at) && JSON.stringify(data).length <= MAX_DOC) {
      await env.DB.prepare(`INSERT INTO playlist_order (playlist_id, user_id, data, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4, ?5)
        ON CONFLICT(playlist_id) DO UPDATE SET data = ?3, updated_at = ?4, updated_by = ?5`).bind(id, d.user_id, JSON.stringify(data), at, d.name).run();
    }
  }

  // What the device doesn't have yet.
  const known = b?.known || {};
  const out = { profiles: [], playlists: [] };
  for (const id of myProfiles) {
    const row = await env.DB.prepare('SELECT data FROM profile_lists WHERE profile_id = ?1').bind(id).first();
    if (!row) continue;
    const data = JSON.parse(row.data);
    const h = await hashOf(data);
    if (known?.profiles?.[id] !== h) out.profiles.push({ id, hash: h, data });
  }
  for (const id of myPlaylists) {
    const row = await env.DB.prepare('SELECT data FROM playlist_order WHERE playlist_id = ?1').bind(id).first();
    if (!row) continue;
    const data = JSON.parse(row.data);
    const h = await hashOf(data);
    if (known?.playlists?.[id] !== h) out.playlists.push({ id, hash: h, data });
  }
  return json(out);
}

export async function handleListsTvApi(request, env, p) {
  if (p === '/api/tv/sync' && request.method === 'POST') return tvSync(request, env);
  return null;
}

// ---------------------------------------------------------------- account side

export async function listsGet(env, user, url) {
  const id = url.searchParams.get('profile') || '';
  const own = await env.DB.prepare('SELECT 1 FROM profiles WHERE id = ?1 AND user_id = ?2').bind(id, user.id).first();
  if (!own) return json({ error: 'That profile is no longer in your account.' }, 404);
  const row = await env.DB.prepare('SELECT data, updated_at, updated_by FROM profile_lists WHERE profile_id = ?1').bind(id).first();
  return json({ data: row ? JSON.parse(row.data) : { favorites: [], lists: [] }, updatedAt: row?.updated_at || null, updatedBy: row?.updated_by || null });
}

export async function listsSave(request, env, user) {
  const text = await request.text();
  if (text.length > MAX_DOC + 1000) return json({ error: 'Too many channels in these lists.' }, 413);
  let b; try { b = JSON.parse(text); } catch { return json({ error: 'Not JSON.' }, 400); }
  const id = str(b?.profileId, 40);
  const own = await env.DB.prepare('SELECT 1 FROM profiles WHERE id = ?1 AND user_id = ?2').bind(id, user.id).first();
  if (!own) return json({ error: 'That profile is no longer in your account.' }, 404);
  const data = cleanLists(b?.data);
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO profile_lists (profile_id, user_id, data, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4, 'the website')
    ON CONFLICT(profile_id) DO UPDATE SET data = ?3, updated_at = ?4, updated_by = 'the website'`).bind(id, user.id, JSON.stringify(data), now).run();
  return json({ ok: true, updatedAt: now, data });
}

export async function orderGet(env, user, url) {
  const id = url.searchParams.get('playlist') || '';
  const own = await env.DB.prepare('SELECT 1 FROM account_playlists WHERE id = ?1 AND user_id = ?2').bind(id, user.id).first();
  if (!own) return json({ error: 'That playlist is no longer in your account.' }, 404);
  const row = await env.DB.prepare('SELECT data, updated_at, updated_by FROM playlist_order WHERE playlist_id = ?1').bind(id).first();
  return json({ data: row ? JSON.parse(row.data) : cleanOrder({}), updatedAt: row?.updated_at || null, updatedBy: row?.updated_by || null });
}

export async function orderSave(request, env, user) {
  const text = await request.text();
  if (text.length > MAX_DOC + 1000) return json({ error: 'Too big.' }, 413);
  let b; try { b = JSON.parse(text); } catch { return json({ error: 'Not JSON.' }, 400); }
  const id = str(b?.playlistId, 40);
  const own = await env.DB.prepare('SELECT 1 FROM account_playlists WHERE id = ?1 AND user_id = ?2').bind(id, user.id).first();
  if (!own) return json({ error: 'That playlist is no longer in your account.' }, 404);
  const data = cleanOrder(b?.data);
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO playlist_order (playlist_id, user_id, data, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4, 'the website')
    ON CONFLICT(playlist_id) DO UPDATE SET data = ?3, updated_at = ?4, updated_by = 'the website'`).bind(id, user.id, JSON.stringify(data), now).run();
  return json({ ok: true, updatedAt: now, data });
}
