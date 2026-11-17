// Accounts step 3: the admin view (/admin/) and its API, /api/admin/*.
//
// Who can use it: an account whose email is in the ADMIN_EMAILS secret (role 'admin'), in a browser session that
// was signed in with a passkey (an emailed link alone isn't enough), from this site's own pages (Origin check in
// auth.js). Cloudflare Access can be added in front of /admin/ as a second sign-in.
//
// Every action that changes something is written to admin_audit with the admin, the account, a reason and the time.
// An admin can't suspend, delete or sign out their own account here (use the Account page for your own).

import { json, body, randomToken, sendSignInLink } from './auth.js';
import { backupsFor } from './devices.js';

const DAY = 24 * 3600 * 1000;

async function audit(env, admin, action, target, detail = null, reason = null) {
  await env.DB.prepare(
    'INSERT INTO admin_audit (id, at, admin_id, admin_email, action, target_id, target_email, detail, reason) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)'
  ).bind(randomToken(12), Date.now(), admin.id, admin.email, action, target?.id || null, target?.email || null, detail, reason ? String(reason).slice(0, 500) : null).run();
}

async function target(env, id) {
  return env.DB.prepare('SELECT id, email, status, role, created_at, last_sign_in, watch_history FROM users WHERE id = ?1').bind(String(id || '')).first();
}

function needReason(b) {
  const r = String(b?.reason || '').trim();
  return r.length >= 3 ? r : null;
}

// ---------------------------------------------------------------- reads

async function stats(env) {
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const one = async (sql, ...args) => (await env.DB.prepare(sql).bind(...args).first())?.n || 0;
  const users = await one('SELECT COUNT(*) AS n FROM users');
  const new7 = await one('SELECT COUNT(*) AS n FROM users WHERE created_at > ?1', iso(now - 7 * DAY));
  const new30 = await one('SELECT COUNT(*) AS n FROM users WHERE created_at > ?1', iso(now - 30 * DAY));
  const active7 = await one('SELECT COUNT(*) AS n FROM users WHERE last_sign_in > ?1', iso(now - 7 * DAY));
  const suspended = await one("SELECT COUNT(*) AS n FROM users WHERE status = 'suspended'");
  const tvs = await one('SELECT COUNT(*) AS n FROM devices WHERE revoked_at IS NULL');
  const tvs7 = await one('SELECT COUNT(*) AS n FROM devices WHERE revoked_at IS NULL AND last_seen > ?1', now - 7 * DAY);
  const passkeys = await one('SELECT COUNT(DISTINCT user_id) AS n FROM passkeys');
  const playlists = await one('SELECT COUNT(*) AS n FROM account_playlists');
  const playlistsWaiting = await one("SELECT COUNT(*) AS n FROM playlist_targets WHERE status = 'waiting'");
  const launchNews = await one('SELECT COUNT(*) AS n FROM signups');
  const backupCount = await one('SELECT COUNT(*) AS n FROM backups');
  const backupBytes = await one('SELECT COALESCE(SUM(size), 0) AS n FROM backups');
  const versions = (await env.DB.prepare(
    "SELECT COALESCE(app_version, 'unknown') AS v, COUNT(*) AS n FROM devices WHERE revoked_at IS NULL GROUP BY v ORDER BY n DESC LIMIT 12"
  ).all()).results;
  const daily = (await env.DB.prepare(
    'SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM users WHERE created_at > ?1 GROUP BY day ORDER BY day'
  ).bind(iso(now - 30 * DAY)).all()).results;
  // Whether the BACKUP_PIN_KEY secret reaches the Worker (never its value): without it backups are refused.
  const backupsReady = typeof env.BACKUP_PIN_KEY === 'string' && env.BACKUP_PIN_KEY.length > 0;
  return json({ users, new7, new30, active7, suspended, tvs, tvs7, passkeys, playlists, playlistsWaiting, launchNews, backupCount, backupBytes, backupsReady, versions, daily });
}

async function users(env, url) {
  const q = (url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 100);
  const status = url.searchParams.get('status') || '';
  const where = []; const args = [];
  if (q) { where.push(`u.email LIKE ?${args.length + 1}`); args.push(`%${q}%`); }
  if (status === 'suspended' || status === 'active') { where.push(`u.status = ?${args.length + 1}`); args.push(status); }
  const rows = (await env.DB.prepare(
    `SELECT u.id, u.email, u.created_at, u.last_sign_in, u.role, u.status,
            (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id AND d.revoked_at IS NULL) AS tvs
       FROM users u ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY u.created_at DESC LIMIT 200`
  ).bind(...args).all()).results;
  return json({ users: rows.map((u) => ({ id: u.id, email: u.email, createdAt: u.created_at, lastSignIn: u.last_sign_in, role: u.role, status: u.status, tvs: u.tvs })) });
}

async function userDetail(env, url) {
  const u = await target(env, url.searchParams.get('id'));
  if (!u) return json({ error: 'No such account.' }, 404);
  const all = (sql) => env.DB.prepare(sql).bind(u.id).all().then((r) => r.results);
  const [devices, sessions, passkeys, notes, log] = await Promise.all([
    all('SELECT id, name, model, app_version, created_at, last_seen, revoked_at FROM devices WHERE user_id = ?1 ORDER BY revoked_at IS NOT NULL, last_seen DESC'),
    all('SELECT label, method, created_at, last_seen, expires_at FROM sessions WHERE user_id = ?1 ORDER BY last_seen DESC'),
    all('SELECT name, created_at, last_used FROM passkeys WHERE user_id = ?1 ORDER BY created_at'),
    all('SELECT admin_email, at, text FROM admin_notes WHERE user_id = ?1 ORDER BY at DESC'),
    all('SELECT at, admin_email, action, detail, reason FROM admin_audit WHERE target_id = ?1 ORDER BY at DESC LIMIT 50'),
  ]);
  return json({
    user: { id: u.id, email: u.email, status: u.status, role: u.role, createdAt: u.created_at, lastSignIn: u.last_sign_in, watchHistory: Boolean(u.watch_history) },
    devices: devices.map((d) => ({ id: d.id, name: d.name, model: d.model, appVersion: d.app_version, linkedAt: d.created_at, lastSeen: d.last_seen, removedAt: d.revoked_at })),
    sessions: sessions.filter((s) => s.expires_at > Date.now()).map((s) => ({ label: s.label, method: s.method, createdAt: s.created_at, lastSeen: s.last_seen })),
    passkeys: passkeys.map((p) => ({ name: p.name, createdAt: p.created_at, lastUsed: p.last_used })),
    notes: notes.map((n) => ({ by: n.admin_email, at: n.at, text: n.text })),
    backups: (await backupsFor(env, u.id)).map((x) => ({ name: x.name, createdAt: x.createdAt, size: x.size, removed: x.removed })),
    log: log.map((a) => ({ at: a.at, by: a.admin_email, action: a.action, detail: a.detail, reason: a.reason })),
  });
}

async function auditLog(env) {
  const rows = (await env.DB.prepare('SELECT at, admin_email, action, target_email, detail, reason FROM admin_audit ORDER BY at DESC LIMIT 200').all()).results;
  return json({ entries: rows.map((a) => ({ at: a.at, by: a.admin_email, action: a.action, target: a.target_email, detail: a.detail, reason: a.reason })) });
}

async function launchNews(env, url) {
  const rows = (await env.DB.prepare('SELECT email, created_at, source, country FROM signups ORDER BY created_at DESC').all()).results;
  if (url.searchParams.get('format') === 'csv') {
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = ['email,signed_up,source,country', ...rows.map((r) => [r.email, r.created_at, r.source, r.country].map(cell).join(','))].join('\n');
    return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="avid-viewer-launch-news.csv"', 'cache-control': 'no-store' } });
  }
  return json({ signups: rows.map((r) => ({ email: r.email, at: r.created_at, source: r.source, country: r.country })) });
}

// ---------------------------------------------------------------- actions

async function addNote(request, env, admin) {
  const b = await body(request);
  const u = await target(env, b?.userId);
  const text = String(b?.text || '').trim().slice(0, 2000);
  if (!u || !text) return json({ error: 'Write a note first.' }, 400);
  await env.DB.prepare('INSERT INTO admin_notes (id, user_id, at, admin_email, text) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(randomToken(12), u.id, Date.now(), admin.email, text).run();
  await audit(env, admin, 'note', u);
  return json({ ok: true });
}

async function revokeTv(request, env, admin) {
  const b = await body(request);
  const reason = needReason(b);
  if (!reason) return json({ error: 'Give a reason (it goes in the audit log).' }, 400);
  const d = await env.DB.prepare('SELECT id, user_id, name FROM devices WHERE id = ?1 AND revoked_at IS NULL').bind(String(b?.deviceId || '')).first();
  if (!d) return json({ error: 'That device is already signed out.' }, 404);
  await env.DB.prepare('UPDATE devices SET revoked_at = ?1 WHERE id = ?2').bind(Date.now(), d.id).run();
  await audit(env, admin, 'revoke_tv', await target(env, d.user_id), d.name, reason);
  return json({ ok: true });
}

async function suspend(request, env, admin) {
  const b = await body(request);
  const reason = needReason(b);
  const u = await target(env, b?.userId);
  if (!u) return json({ error: 'No such account.' }, 404);
  if (u.id === admin.id) return json({ error: "You can't suspend your own account." }, 400);
  if (!reason) return json({ error: 'Give a reason (it goes in the audit log).' }, 400);
  const on = b?.suspend !== false;
  await env.DB.prepare('UPDATE users SET status = ?1 WHERE id = ?2').bind(on ? 'suspended' : 'active', u.id).run();
  if (on) await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(u.id).run();
  await audit(env, admin, on ? 'suspend' : 'unsuspend', u, null, reason);
  return json({ ok: true });
}

async function endSessions(request, env, admin) {
  const b = await body(request);
  const reason = needReason(b);
  const u = await target(env, b?.userId);
  if (!u) return json({ error: 'No such account.' }, 404);
  if (u.id === admin.id) return json({ error: 'Use your Account page to sign out your own browsers.' }, 400);
  if (!reason) return json({ error: 'Give a reason (it goes in the audit log).' }, 400);
  const r = await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(u.id).run();
  await audit(env, admin, 'end_sessions', u, `${r.meta?.changes || 0} browser(s)`, reason);
  return json({ ok: true });
}

async function resendLink(request, env, url, admin) {
  const b = await body(request);
  const u = await target(env, b?.userId);
  if (!u) return json({ error: 'No such account.' }, 404);
  if (u.status !== 'active') return json({ error: 'This account is suspended; lift the suspension first.' }, 400);
  const r = await sendSignInLink(env, url, u.email);
  if (r.status !== 200) return r;
  await audit(env, admin, 'resend_link', u, null, String(b?.reason || '').trim() || null);
  return r;
}

async function deleteUser(request, env, admin) {
  const b = await body(request);
  const reason = needReason(b);
  const u = await target(env, b?.userId);
  if (!u) return json({ error: 'No such account.' }, 404);
  if (u.id === admin.id) return json({ error: 'Delete your own account from your Account page.' }, 400);
  if (!reason) return json({ error: 'Give a reason (it goes in the audit log).' }, 400);
  if (String(b?.confirm || '').trim().toLowerCase() !== u.email) return json({ error: "Type the account's email address exactly to confirm." }, 400);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(u.id),
    env.DB.prepare('DELETE FROM passkeys WHERE user_id = ?1').bind(u.id),
    env.DB.prepare('DELETE FROM webauthn_challenges WHERE user_id = ?1').bind(u.id),
    env.DB.prepare('DELETE FROM backups WHERE user_id = ?1').bind(u.id),
    env.DB.prepare('DELETE FROM playlist_targets WHERE user_id = ?1').bind(u.id),
    env.DB.prepare('DELETE FROM device_profiles WHERE user_id = ?1').bind(u.id),
    env.DB.prepare('DELETE FROM profile_playlists WHERE user_id = ?1').bind(u.id),
    env.DB.prepare('DELETE FROM profile_visibility WHERE user_id = ?1').bind(u.id),
    env.DB.prepare('DELETE FROM playlist_catalogs WHERE user_id = ?1').bind(u.id),
    env.DB.prepare('DELETE FROM profiles WHERE user_id = ?1').bind(u.id),
    env.DB.prepare('DELETE FROM vault_keys WHERE user_id = ?1').bind(u.id),
    env.DB.prepare('DELETE FROM account_keys WHERE user_id = ?1').bind(u.id),
    env.DB.prepare('DELETE FROM attention_dismissed WHERE user_id = ?1').bind(u.id),
    env.DB.prepare('DELETE FROM profile_lists WHERE user_id = ?1').bind(u.id),
    env.DB.prepare('DELETE FROM profile_history WHERE user_id = ?1').bind(u.id),
    env.DB.prepare('DELETE FROM profile_discover WHERE user_id = ?1').bind(u.id),
    env.DB.prepare('DELETE FROM account_secrets WHERE user_id = ?1').bind(u.id),
    env.DB.prepare('DELETE FROM device_history_keys WHERE user_id = ?1').bind(u.id),
    env.DB.prepare('DELETE FROM playlist_order WHERE user_id = ?1').bind(u.id),
    env.DB.prepare('DELETE FROM device_playlists WHERE user_id = ?1').bind(u.id),
    env.DB.prepare('DELETE FROM account_playlists WHERE user_id = ?1').bind(u.id),
    env.DB.prepare('DELETE FROM devices WHERE user_id = ?1').bind(u.id),
    env.DB.prepare('DELETE FROM link_codes WHERE user_id = ?1').bind(u.id),
    env.DB.prepare('DELETE FROM admin_notes WHERE user_id = ?1').bind(u.id),
    env.DB.prepare('DELETE FROM sign_in_links WHERE email = ?1').bind(u.email),
    env.DB.prepare('DELETE FROM users WHERE id = ?1').bind(u.id),
  ]);
  await audit(env, admin, 'delete', u, null, reason);
  return json({ ok: true });
}

// ---------------------------------------------------------------- router (called from auth.js, signed in)

export async function handleAdminApi(request, env, url, user) {
  if (user.role !== 'admin') return json({ error: 'Not allowed.' }, 403);
  if (user.session_method !== 'passkey') return json({ error: 'Sign in with your passkey to use the admin view.', needPasskey: true }, 403);
  const p = url.pathname;
  if (request.method === 'GET') {
    switch (p) {
      case '/api/admin/stats': return stats(env);
      case '/api/admin/users': return users(env, url);
      case '/api/admin/user': return userDetail(env, url);
      case '/api/admin/audit': return auditLog(env);
      case '/api/admin/launch-news': return launchNews(env, url);
    }
    return json({ error: 'Not found.' }, 404);
  }
  switch (p) {
    case '/api/admin/note': return addNote(request, env, user);
    case '/api/admin/revoke-tv': return revokeTv(request, env, user);
    case '/api/admin/suspend': return suspend(request, env, user);
    case '/api/admin/end-sessions': return endSessions(request, env, user);
    case '/api/admin/resend-link': return resendLink(request, env, url, user);
    case '/api/admin/delete': return deleteUser(request, env, user);
  }
  return json({ error: 'Not found.' }, 404);
}
