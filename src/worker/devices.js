// Accounts step 2: TVs linked to an account.
//
// Linking a TV (like signing in to a streaming app on a TV):
//   1. The TV (Settings › Account) calls POST /api/tv/link/start and shows the 8-character code it gets, with a QR
//      code for avidviewer.app/link/?c=<code>. It keeps the secret device code to itself.
//   2. The person, signed in on a phone or computer, enters or scans the code on /link/ and approves it
//      (POST /api/link/lookup, then /api/link/approve).
//   3. The TV polls POST /api/tv/link/poll with its device code every 5 seconds; once approved it gets its own
//      token (shown once, stored only as SHA-256 here) and is linked.
// A setup code made while signed in carries a one-time link token (POST /api/link/setup-token); the TV that
// redeems the setup code claims it with POST /api/tv/link/claim, so setup and linking happen in one step.
//
// The TV sends its token as "Authorization: Bearer <token>" to GET /api/tv/me (who it's linked to; also updates
// last seen and app version) and POST /api/tv/signout. Removing a TV on the Account page revokes its token.
// TV routes take no cookies and no Origin header (they come from the app, not a browser).

import { json, randomToken, sha256hex, ipOf, body } from './auth.js';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // same as setup codes: no 0/O, 1/I/L
const TV_CODE_TTL = 10 * 60 * 1000;
const SETUP_LINK_TTL = 30 * 60 * 1000;
const STARTS_PER_IP = 20; // per hour

function newUserCode() {
  const out = [];
  const buf = new Uint8Array(1);
  while (out.length < 8) {
    crypto.getRandomValues(buf);
    if (buf[0] < 248) out.push(ALPHABET[buf[0] % 31]);
  }
  return out.join('');
}

export function normalizeCode(input) {
  const s = String(input || '').toUpperCase().split('').filter((c) => ALPHABET.includes(c)).join('');
  return s.length === 8 ? s : null;
}

function clip(v, n) { return typeof v === 'string' ? v.trim().slice(0, n) : ''; }

async function newDevice(env, userId, info) {
  const token = randomToken();
  const now = Date.now();
  const id = randomToken(12);
  await env.DB.prepare(
    'INSERT INTO devices (id, user_id, token_hash, name, model, app_version, created_at, last_seen) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)'
  ).bind(id, userId, await sha256hex(token), info.name || info.model || 'Device', info.model || null, info.appVersion || null, now).run();
  const u = await env.DB.prepare('SELECT email FROM users WHERE id = ?1').bind(userId).first();
  return { token, deviceId: id, name: info.name || info.model || 'Device', email: u?.email || '' };
}

function tvInfo(b) {
  return { name: clip(b?.name, 60), model: clip(b?.model, 80), appVersion: clip(b?.appVersion, 30) };
}

/** The linked device for a TV request (Authorization: Bearer <token>), or null. */
async function deviceFor(request, env) {
  const m = (request.headers.get('authorization') || '').match(/^Bearer\s+([A-Za-z0-9_-]{20,})$/);
  if (!m) return null;
  return env.DB.prepare(
    `SELECT d.id, d.name, d.user_id, d.app_version, u.email, u.status FROM devices d JOIN users u ON u.id = d.user_id
      WHERE d.token_hash = ?1 AND d.revoked_at IS NULL`
  ).bind(await sha256hex(m[1])).first();
}

// ---------------------------------------------------------------- TV side

async function tvStart(request, env, url) {
  const b = await body(request);
  const now = Date.now();
  await env.DB.prepare('DELETE FROM link_codes WHERE expires_at < ?1').bind(now - 3600_000).run();
  const ipHash = await sha256hex(ipOf(request) + new Date(now).toISOString().slice(0, 10));
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM link_codes WHERE kind = 'tv' AND ip_hash = ?1 AND created_at > ?2")
    .bind(ipHash, now - 3600_000).first();
  if ((recent?.n || 0) >= STARTS_PER_IP) return json({ error: 'Too many codes from this network. Try again in an hour.' }, 429);
  const info = tvInfo(b);
  const deviceCode = randomToken();
  let userCode;
  for (let i = 0; i < 5; i++) {
    userCode = newUserCode();
    const taken = await env.DB.prepare('SELECT 1 FROM link_codes WHERE user_code = ?1').bind(userCode).first();
    if (!taken) break;
  }
  await env.DB.prepare(
    `INSERT INTO link_codes (id, kind, user_code, secret_hash, status, device_name, device_model, app_version, created_at, expires_at, ip_hash)
     VALUES (?1, 'tv', ?2, ?3, 'pending', ?4, ?5, ?6, ?7, ?8, ?9)`
  ).bind(randomToken(12), userCode, await sha256hex(deviceCode), info.name, info.model, info.appVersion, now, now + TV_CODE_TTL, ipHash).run();
  return json({
    userCode, deviceCode, interval: 5, expiresIn: TV_CODE_TTL / 1000,
    verifyUrl: `${url.origin}/link/`, qrUrl: `${url.origin}/link/?c=${userCode}`,
  });
}

async function tvPoll(request, env) {
  const b = await body(request);
  const code = String(b?.deviceCode || '');
  if (!code) return json({ status: 'expired' }, 400);
  const hash = await sha256hex(code);
  const now = Date.now();
  const row = await env.DB.prepare("SELECT id, status, user_id, device_name, device_model, app_version, expires_at FROM link_codes WHERE kind = 'tv' AND secret_hash = ?1")
    .bind(hash).first();
  if (!row || row.status === 'used' || row.expires_at < now) return json({ status: 'expired' });
  await env.DB.prepare('UPDATE link_codes SET last_poll = ?1 WHERE id = ?2').bind(now, row.id).run();
  if (row.status !== 'approved') return json({ status: 'pending' });
  const used = await env.DB.prepare("UPDATE link_codes SET status = 'used' WHERE id = ?1 AND status = 'approved'").bind(row.id).run();
  if (!used.meta?.changes) return json({ status: 'expired' });
  const d = await newDevice(env, row.user_id, { name: row.device_name, model: row.device_model, appVersion: row.app_version });
  return json({ status: 'approved', ...d });
}

async function tvClaim(request, env) {
  const b = await body(request);
  const token = String(b?.linkToken || '');
  if (!token) return json({ error: 'Missing link.' }, 400);
  const now = Date.now();
  const row = await env.DB.prepare("SELECT id, user_id, expires_at, status FROM link_codes WHERE kind = 'setup' AND secret_hash = ?1")
    .bind(await sha256hex(token)).first();
  if (!row || row.status !== 'approved' || row.expires_at < now) return json({ error: 'This setup code can no longer link a device. Link it in Settings › Account instead.' }, 410);
  const used = await env.DB.prepare("UPDATE link_codes SET status = 'used' WHERE id = ?1 AND status = 'approved'").bind(row.id).run();
  if (!used.meta?.changes) return json({ error: 'This setup code already linked a device.' }, 410);
  return json({ status: 'approved', ...(await newDevice(env, row.user_id, tvInfo(b))) });
}

async function tvMe(request, env) {
  const d = await deviceFor(request, env);
  if (!d) return json({ error: 'This device is not linked.' }, 401);
  // A suspended account's TVs stay linked (403 changes nothing on the TV), so lifting the suspension restores them.
  if (d.status !== 'active') return json({ error: 'This account is suspended.' }, 403);
  const version = clip(request.headers.get('x-app-version') || '', 30);
  await env.DB.prepare('UPDATE devices SET last_seen = ?1, app_version = COALESCE(NULLIF(?2, \'\'), app_version) WHERE id = ?3')
    .bind(Date.now(), version, d.id).run();
  return json({ email: d.email, name: d.name, deviceId: d.id });
}

// ---------------------------------------------------------------- cloud backups (TV side)

const BACKUP_MAX = 1_000_000; // characters of .avbak text

/** The backup PIN at rest: AES-256-GCM with a key from the BACKUP_PIN_KEY secret, so a copy of the database alone can't open backups. */
async function pinKey(env) {
  if (!env.BACKUP_PIN_KEY) throw new Error('BACKUP_PIN_KEY is not set');
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('avidviewer-backup-pin:v1:' + env.BACKUP_PIN_KEY));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function sealPin(env, pin) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await pinKey(env), new TextEncoder().encode(pin)));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return b64(out);
}
async function openPin(env, sealed) {
  const all = unb64(sealed);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, await pinKey(env), all.slice(12)));
}

/** POST /api/tv/backup {data}: this TV's backup, replacing its previous one. */
async function tvBackupUpload(request, env) {
  const d = await deviceFor(request, env);
  if (!d) return json({ error: 'This device is not linked.' }, 401);
  if (d.status !== 'active') return json({ error: 'This account is suspended.' }, 403);
  const b = await body(request);
  const data = typeof b?.data === 'string' ? b.data : '';
  if (!data || data.length > BACKUP_MAX) return json({ error: data ? 'This backup is too big to keep (over 1 MB).' : 'No backup was sent.' }, 400);
  let head;
  try { head = JSON.parse(data); } catch { head = null; }
  if (!head || head.avidViewerBackup !== 1 || typeof head.data !== 'string') return json({ error: "That isn't an Avid Viewer backup." }, 400);
  const pin = typeof b?.pin === 'string' && /^[0-9]{4,12}$/.test(b.pin) ? b.pin : null;
  if (!pin) return json({ error: 'Send the backup PIN with the backup.' }, 400);
  let pinEnc;
  try { pinEnc = await sealPin(env, pin); } catch { return json({ error: "Backups aren't switched on yet. Try again later." }, 503); }
  const now = Date.now();
  const dev = await env.DB.prepare('SELECT name, model, app_version FROM devices WHERE id = ?1').bind(d.id).first();
  await env.DB.prepare(
    `INSERT INTO backups (device_id, user_id, device_name, device_model, app_version, created_at, uploaded_at, size, playlists, data, pin_enc)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
     ON CONFLICT(device_id) DO UPDATE SET user_id = ?2, device_name = ?3, device_model = ?4, app_version = ?5, created_at = ?6,
       uploaded_at = ?7, size = ?8, playlists = ?9, data = ?10, pin_enc = ?11`
  ).bind(d.id, d.user_id, dev?.name || 'Device', dev?.model || null, clip(head.appVersion, 30) || dev?.app_version || null,
    Number(head.created) || now, now, data.length, Array.isArray(head.playlistNames) ? head.playlistNames.length : null, data, pinEnc).run();
  return json({ ok: true, uploadedAt: now });
}

/** A removed device's backup stays this long (from when the device was removed), then it's deleted. */
export const REMOVED_BACKUP_DAYS = 30;
const KEEP_MS = REMOVED_BACKUP_DAYS * 24 * 60 * 60 * 1000;

/** Deletes backups of devices removed more than 30 days ago (daily cron, and before listing). */
export async function expireBackups(env, userId = null) {
  const cutoff = Date.now() - KEEP_MS;
  await env.DB.prepare(
    `DELETE FROM backups WHERE device_id IN (SELECT id FROM devices WHERE revoked_at IS NOT NULL AND revoked_at < ?1)
       ${userId ? 'AND user_id = ?2' : ''}`
  ).bind(...(userId ? [cutoff, userId] : [cutoff])).run();
}

/** The account's backups, newest first (no data). */
export async function backupsFor(env, userId, thisDevice = null) {
  await expireBackups(env, userId);
  const r = await env.DB.prepare(
    `SELECT b.device_id, b.device_name, b.device_model, b.app_version, b.created_at, b.uploaded_at, b.size, b.playlists,
            (d.revoked_at IS NOT NULL OR d.id IS NULL) AS removed, d.revoked_at
       FROM backups b LEFT JOIN devices d ON d.id = b.device_id WHERE b.user_id = ?1 ORDER BY b.created_at DESC`
  ).bind(userId).all();
  return r.results.map((x) => ({
    deviceId: x.device_id, name: x.device_name, model: x.device_model, appVersion: x.app_version, createdAt: x.created_at,
    uploadedAt: x.uploaded_at, size: x.size, playlists: x.playlists, removed: Boolean(x.removed), thisTv: x.device_id === thisDevice,
    deletesAt: x.revoked_at ? x.revoked_at + KEEP_MS : null,
  }));
}

async function tvBackupList(request, env) {
  const d = await deviceFor(request, env);
  if (!d) return json({ error: 'This device is not linked.' }, 401);
  if (d.status !== 'active') return json({ error: 'This account is suspended.' }, 403);
  return json({ backups: await backupsFor(env, d.user_id, d.id) });
}

/** GET /api/tv/backup?device=<id>: one of the account's backups, to restore. */
async function tvBackupDownload(request, env, url) {
  const d = await deviceFor(request, env);
  if (!d) return json({ error: 'This device is not linked.' }, 401);
  if (d.status !== 'active') return json({ error: 'This account is suspended.' }, 403);
  const row = await env.DB.prepare('SELECT data FROM backups WHERE device_id = ?1 AND user_id = ?2')
    .bind(url.searchParams.get('device') || d.id, d.user_id).first();
  if (!row) return json({ error: 'That backup is no longer in your account.' }, 404);
  return json({ data: row.data });
}

async function tvSignout(request, env) {
  const d = await deviceFor(request, env);
  if (d) await env.DB.prepare('UPDATE devices SET revoked_at = ?1 WHERE id = ?2').bind(Date.now(), d.id).run();
  return json({ ok: true });
}

/** /api/tv/*: requests from the app. Returns null for other paths. */
export async function handleTvApi(request, env, realUrl) {
  const url = env.SITE_ORIGIN ? new URL(realUrl.pathname + realUrl.search, env.SITE_ORIGIN) : realUrl; // local dev, as in auth.js
  const p = url.pathname;
  if (!p.startsWith('/api/tv/')) return null;
  if (p === '/api/tv/me') return request.method === 'GET' ? tvMe(request, env) : json({ error: 'Use GET.' }, 405);
  if (p === '/api/tv/backups') return request.method === 'GET' ? tvBackupList(request, env) : json({ error: 'Use GET.' }, 405);
  if (p === '/api/tv/backup' && request.method === 'GET') return tvBackupDownload(request, env, url);
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
  switch (p) {
    case '/api/tv/link/start': return tvStart(request, env, url);
    case '/api/tv/link/poll': return tvPoll(request, env);
    case '/api/tv/link/claim': return tvClaim(request, env);
    case '/api/tv/signout': return tvSignout(request, env);
    case '/api/tv/backup': return tvBackupUpload(request, env);
  }
  return json({ error: 'Not found.' }, 404);
}

// ---------------------------------------------------------------- signed-in side (called from auth.js)

async function pendingTv(env, code) {
  const c = normalizeCode(code);
  if (!c) return null;
  return env.DB.prepare("SELECT id, device_name, device_model, app_version FROM link_codes WHERE kind = 'tv' AND user_code = ?1 AND status = 'pending' AND expires_at >= ?2")
    .bind(c, Date.now()).first();
}

export async function linkLookup(request, env) {
  const b = await body(request);
  const row = await pendingTv(env, b?.code);
  if (!row) return json({ error: "That code wasn't found. Codes last 10 minutes: check the device for the current one." }, 404);
  return json({ name: row.device_name || '', model: row.device_model || '', appVersion: row.app_version || '' });
}

export async function linkApprove(request, env, user) {
  const b = await body(request);
  const row = await pendingTv(env, b?.code);
  if (!row) return json({ error: "That code wasn't found. Codes last 10 minutes: check the device for the current one." }, 404);
  const name = clip(b?.name, 60) || row.device_name || row.device_model || 'Device';
  await env.DB.prepare("UPDATE link_codes SET status = 'approved', user_id = ?1, device_name = ?2 WHERE id = ?3 AND status = 'pending'")
    .bind(user.id, name, row.id).run();
  return json({ ok: true, name });
}

export async function linkSetupToken(env, user) {
  const token = randomToken();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO link_codes (id, kind, secret_hash, status, user_id, created_at, expires_at) VALUES (?1, 'setup', ?2, 'approved', ?3, ?4, ?5)"
  ).bind(randomToken(12), await sha256hex(token), user.id, now, now + SETUP_LINK_TTL).run();
  return json({ linkToken: token });
}

export async function devicesFor(env, userId) {
  const r = await env.DB.prepare(
    'SELECT id, name, model, app_version, created_at, last_seen FROM devices WHERE user_id = ?1 AND revoked_at IS NULL ORDER BY last_seen DESC'
  ).bind(userId).all();
  return r.results.map((d) => ({ id: d.id, name: d.name, model: d.model, appVersion: d.app_version, linkedAt: d.created_at, lastSeen: d.last_seen }));
}

export async function deviceRename(request, env, user) {
  const b = await body(request);
  const name = clip(b?.name, 60);
  if (!name) return json({ error: 'Enter a name.' }, 400);
  await env.DB.prepare('UPDATE devices SET name = ?1 WHERE id = ?2 AND user_id = ?3').bind(name, String(b?.id || ''), user.id).run();
  return json({ ok: true });
}

export async function deviceRemove(request, env, user) {
  const b = await body(request);
  await env.DB.prepare('UPDATE devices SET revoked_at = ?1 WHERE id = ?2 AND user_id = ?3 AND revoked_at IS NULL')
    .bind(Date.now(), String(b?.id || ''), user.id).run();
  return json({ ok: true });
}

export async function backupDelete(request, env, user) {
  const b = await body(request);
  await env.DB.prepare('DELETE FROM backups WHERE device_id = ?1 AND user_id = ?2').bind(String(b?.deviceId || ''), user.id).run();
  return json({ ok: true });
}

/**
 * POST /api/account/backups/pin {deviceId}: the PIN of one of your backups. Shown only to a sign-in from the last hour
 * or a passkey sign-in, because with the PIN the backup opens (it holds provider logins).
 */
export async function backupPin(request, env, user) {
  const fresh = user.session_method === 'passkey' || Date.now() - Number(user.session_started || 0) < 60 * 60 * 1000;
  if (!fresh) return json({ error: 'For your security, sign in again (or use a passkey) to see a backup PIN.', signIn: true }, 403);
  const b = await body(request);
  const row = await env.DB.prepare('SELECT pin_enc FROM backups WHERE device_id = ?1 AND user_id = ?2').bind(String(b?.deviceId || ''), user.id).first();
  if (!row) return json({ error: 'That backup is no longer in your account.' }, 404);
  if (!row.pin_enc) return json({ error: "This backup's PIN wasn't saved." }, 404);
  try { return json({ pin: await openPin(env, row.pin_enc) }); } catch { return json({ error: "The PIN couldn't be read. Make a new backup on the device." }, 500); }
}
