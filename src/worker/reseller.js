// Reseller lines (Nov 21, 2026, owner). The owner is the reseller for these lines.
//
//   - Panel API: the RESELLER_API_BASE secret (the panel's api.php address), with the reseller key in the
//     RESELLER_API_KEY secret. The key never leaves the Worker.
//   - Logins are never stored or logged. The TV app sends a login only for one panel call: to confirm a line
//     (device_info) or to carry out a renewal (renew). It does so only for playlists on the reseller server
//     addresses set in Admin › Dashboard (also checked here).
//   - The site keeps the panel's line id, the expiry date and whether the line is on (reseller_lines).
//   - Renewals are admin-only until payments are live. They run from the owner's credits, at the next check-in of a
//     device that has the line. A renewal is claimed in one statement (pending -> running), so it can't run twice;
//     if the panel doesn't answer after it was sent, it is marked 'unknown' and never retried by itself.
//   - Turning a line on or off (device_status) needs only the line id: an admin action, with a reason.
//
// Troubleshooting on the Account page (any provider): each device's last channel load per playlist (with the
// subscription's end date when the provider gives one), and
// "Reload channels now" / "Check my subscription", which the device picks up at its next check-in.
import { json, randomToken, body } from './auth.js';
import { deviceFor } from './devices.js';
import { reconcile } from './profiles.js';

const DAY = 86_400_000;
export const MONTHS = [1, 3, 6, 12];
const PENDING_TTL = 7 * DAY;
const PROBLEMS = ['login', 'expired', 'unreachable', 'empty', 'other'];

function clip(v, n) { return typeof v === 'string' ? v.trim().slice(0, n) : ''; }

export function configured(env) { return typeof env.RESELLER_API_KEY === 'string' && env.RESELLER_API_KEY.length > 0 && typeof env.RESELLER_API_BASE === 'string' && env.RESELLER_API_BASE.length > 0; }

/** Server addresses (host names) that are reseller lines, set by an admin. */
export async function hostsFor(env) {
  const v = (await env.DB.prepare("SELECT value FROM site_state WHERE key = 'reseller_hosts'").first())?.value;
  try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a.filter((h) => typeof h === 'string') : []; } catch { return []; }
}

/** "http://Line.Example.com:8080/" -> "line.example.com". */
export function hostOf(s) {
  const t = String(s || '').trim().toLowerCase();
  if (!t) return '';
  try { return new URL(/^[a-z]+:\/\//.test(t) ? t : 'http://' + t).hostname; } catch { return ''; }
}

/** One panel call. Never logs the URL (it carries the reseller key, and sometimes a login). */
export async function panel(env, params) {
  let u;
  try { u = new URL(String(env.RESELLER_API_BASE).trim().replace(/^["']|["']$/g, '')); }
  catch { return { reached: false, why: 'RESELLER_API_BASE is not a valid web address' }; }
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  u.searchParams.set('api_key', String(env.RESELLER_API_KEY).trim());
  let r;
  try { r = await fetch(u.toString(), { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (compatible; AvidViewer/1.0)' }, signal: AbortSignal.timeout(15_000) }); }
  catch (e) { return { reached: false, why: e?.name === 'TimeoutError' ? 'no answer within 15 seconds' : 'connection failed (' + String(e?.message || e?.name || 'error').slice(0, 80) + ')' }; }
  const text = await r.text().catch(() => '');
  let data = null;
  try { data = JSON.parse(text); } catch { data = null; }
  if (Array.isArray(data) && params.action !== 'bouquet') data = data[0] || null;
  // Why it isn't usable, for the admin card: status and type only, plus a short start of the body without the key.
  const key = String(env.RESELLER_API_KEY || '').trim();
  const peek = text.slice(0, 120).replace(/\s+/g, ' ').split(key || '\u0000').join('…');
  const why = data ? null : `HTTP ${r.status}, ${r.headers.get('content-type') || 'no content type'}${peek ? ': "' + peek + '"' : ', empty answer'}`;
  return { reached: true, httpOk: r.ok, data, why };
}

function truthy(v) { return v === true || v === 1 || /^(true|1|ok|success|enabled?|active)$/i.test(String(v ?? '')); }

/** The panel's "expire": seconds, ms or a date string -> ms (null if missing). */
export function expiryMs(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
  const t = Date.parse(String(v).replace(' ', 'T'));
  return Number.isFinite(t) ? t : null;
}

/** device_info for a login: {line_id, expires_at, enabled} when it's one of the owner's lines, else null. */
async function lineInfo(env, username, password) {
  const r = await panel(env, { action: 'device_info', username, password });
  if (!r.reached) return { error: 'unreachable' };
  const d = r.data;
  const id = d && (d.user_id ?? d.id);
  if (!d || id == null || id === '' || (d.status != null && !truthy(d.status))) return { line: null };
  return { line: { lineId: String(id), expiresAt: expiryMs(d.expire ?? d.exp_date), enabled: d.enabled == null ? true : truthy(d.enabled) } };
}

async function saveLine(env, d, localId, name, line, now) {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO reseller_lines (user_id, line_id, name, expires_at, enabled, checked_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
       ON CONFLICT(user_id, line_id) DO UPDATE SET name = COALESCE(?3, name), expires_at = COALESCE(?4, expires_at), enabled = ?5, checked_at = ?6`
    ).bind(d.user_id, line.lineId, name || null, line.expiresAt, line.enabled ? 1 : 0, now),
    env.DB.prepare(
      `INSERT INTO reseller_line_devices (device_id, local_id, user_id, line_id, checked_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(device_id, local_id) DO UPDATE SET user_id = ?3, line_id = ?4, checked_at = ?5`
    ).bind(d.id, localId, d.user_id, line.lineId, now),
  ]);
}

/** What /api/tv/me adds for the device: reseller addresses, renewals it should carry out, and requests from the website. */
export async function tvMeExtras(env, d, now = Date.now()) {
  const out = {};
  const dev = await env.DB.prepare('SELECT reload_requested_at, check_requested_at FROM devices WHERE id = ?1').bind(d.id).first();
  if (dev?.reload_requested_at) out.reloadChannels = true;
  if (dev?.check_requested_at) out.checkSubscription = true;
  if (dev?.reload_requested_at || dev?.check_requested_at) {
    await env.DB.prepare('UPDATE devices SET reload_requested_at = NULL, check_requested_at = NULL WHERE id = ?1').bind(d.id).run();
  }
  if (configured(env)) {
    const hosts = await hostsFor(env);
    if (hosts.length) {
      await env.DB.prepare("UPDATE reseller_renewals SET status = 'expired', done_at = ?1, message = 'No device with this line checked in within 7 days.' WHERE status = 'pending' AND created_at < ?2")
        .bind(now, now - PENDING_TTL).run();
      const renew = (await env.DB.prepare(
        `SELECT r.id, ld.local_id FROM reseller_renewals r JOIN reseller_line_devices ld ON ld.user_id = r.user_id AND ld.line_id = r.line_id
          WHERE r.status = 'pending' AND ld.device_id = ?1`
      ).bind(d.id).all()).results;
      out.reseller = { hosts, renew: renew.map((x) => ({ id: x.id, localId: x.local_id })) };
    }
  }
  return out;
}

/** POST /api/tv/reseller/check {playlists:[{localId, name, server, username, password}]} (at most 10). */
async function tvCheck(request, env, d) {
  if (!configured(env)) return json({ error: 'Not set up.' }, 503);
  const b = await body(request);
  const list = Array.isArray(b?.playlists) ? b.playlists.slice(0, 10) : [];
  const hosts = await hostsFor(env);
  const now = Date.now();
  const results = [];
  for (const p of list) {
    const localId = clip(p?.localId, 80);
    if (!localId) continue;
    if (!hosts.includes(hostOf(p?.server))) { results.push({ localId, confirmed: false, reason: 'not_reseller' }); continue; }
    const username = clip(p?.username, 200), password = clip(p?.password, 200);
    if (!username || !password) { results.push({ localId, confirmed: false, reason: 'no_login' }); continue; }
    const r = await lineInfo(env, username, password);
    if (r.error) { results.push({ localId, confirmed: false, reason: 'unreachable' }); continue; }
    if (!r.line) {
      await env.DB.prepare('DELETE FROM reseller_line_devices WHERE device_id = ?1 AND local_id = ?2').bind(d.id, localId).run();
      results.push({ localId, confirmed: false, reason: 'not_found' });
      continue;
    }
    await saveLine(env, d, localId, clip(p?.name, 80), r.line, now);
    results.push({ localId, confirmed: true, expiresAt: r.line.expiresAt, enabled: r.line.enabled });
  }
  return json({ results });
}

/** POST /api/tv/reseller/renew {id, localId, username, password}: carries out a pending renewal. */
async function tvRenew(request, env, d) {
  if (!configured(env)) return json({ error: 'Not set up.' }, 503);
  const b = await body(request);
  const id = clip(b?.id, 40), localId = clip(b?.localId, 80);
  const username = clip(b?.username, 200), password = clip(b?.password, 200);
  const rn = await env.DB.prepare("SELECT * FROM reseller_renewals WHERE id = ?1 AND user_id = ?2 AND status = 'pending'").bind(id, d.user_id).first();
  if (!rn) return json({ ok: false, error: 'No such renewal waiting.' }, 404);
  if (!username || !password) return json({ ok: false, error: 'Send the login.' }, 400);
  // The login must be this renewal's line, so a device can't spend credits on another line.
  const before = await lineInfo(env, username, password);
  if (before.error) return json({ ok: false, retry: true, error: "Couldn't reach the provider." }, 502);
  if (!before.line || before.line.lineId !== rn.line_id) return json({ ok: false, error: "This playlist isn't the line being renewed." }, 409);
  const now = Date.now();
  const claim = await env.DB.prepare("UPDATE reseller_renewals SET status = 'running', started_at = ?1, device_id = ?2, expires_before = ?3 WHERE id = ?4 AND status = 'pending'")
    .bind(now, d.id, before.line.expiresAt, rn.id).run();
  if (!claim.meta?.changes) return json({ ok: false, error: 'Already being renewed.' }, 409);
  const r = await panel(env, { action: 'renew', type: 'm3u', username, password, sub: rn.months });
  const finish = (status, message, after = null) => env.DB.prepare('UPDATE reseller_renewals SET status = ?1, done_at = ?2, message = ?3, expires_after = ?4 WHERE id = ?5')
    .bind(status, Date.now(), message ? String(message).slice(0, 300) : null, after, rn.id).run();
  if (!r.reached) { await finish('unknown', "Sent, but the provider didn't answer. Check the line in the provider panel before trying again."); return json({ ok: false, error: 'No answer from the provider.' }, 502); }
  const msg = r.data?.message ?? r.data?.messasge ?? null; // the panel spells it "messasge"
  if (!r.data || !truthy(r.data.status)) { await finish('failed', msg || 'The provider refused the renewal.'); return json({ ok: false, error: 'The provider refused the renewal.' }, 502); }
  const after = await lineInfo(env, username, password);
  if (after.line) await saveLine(env, d, localId || 'unknown', null, after.line, Date.now());
  await finish('done', msg, after.line?.expiresAt ?? null);
  return json({ ok: true, expiresAt: after.line?.expiresAt ?? null });
}

/** POST /api/tv/load-status {playlists:[{localId, name, ok, channels, problem, detail}]}: the device's last channel loads. */
async function tvLoadStatus(request, env, d) {
  const b = await body(request);
  const list = Array.isArray(b?.playlists) ? b.playlists.slice(0, 30) : [];
  const now = Date.now();
  const stmts = [];
  for (const p of list) {
    const localId = clip(p?.localId, 80);
    if (!localId) continue;
    const ok = p?.ok === true;
    const problem = ok ? null : (PROBLEMS.includes(p?.problem) ? p.problem : 'other');
    const at = Number.isFinite(p?.at) && p.at > now - 30 * DAY && p.at <= now + 60_000 ? p.at : now;
    stmts.push(env.DB.prepare(
      `INSERT INTO device_load_status (device_id, local_id, user_id, name, ok, channels, problem, detail, at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       ON CONFLICT(device_id, local_id) DO UPDATE SET user_id = ?3, name = ?4, ok = ?5, channels = ?6, problem = ?7, detail = ?8, at = ?9, expires_at = ?10`
    ).bind(d.id, localId, d.user_id, clip(p?.name, 80) || null, ok ? 1 : 0, Number.isFinite(p?.channels) ? Math.max(0, Math.floor(p.channels)) : null, problem, clip(p?.detail, 200) || null, at,
      Number.isFinite(p?.expiresAt) && p.expiresAt > 0 ? Math.floor(p.expiresAt) : null));
  }
  // Playlists the device no longer has.
  const keep = list.map((p) => clip(p?.localId, 80)).filter(Boolean);
  stmts.push(env.DB.prepare(`DELETE FROM device_load_status WHERE device_id = ?1${keep.length ? ` AND local_id NOT IN (${keep.map((_, i) => '?' + (i + 2)).join(',')})` : ''}`).bind(d.id, ...keep));
  await env.DB.batch(stmts);
  return json({ ok: true });
}

export async function handleResellerTvApi(request, env, p) {
  if (p !== '/api/tv/reseller/check' && p !== '/api/tv/reseller/renew' && p !== '/api/tv/load-status') return null;
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
  const d = await deviceFor(request, env);
  if (!d) return json({ error: 'This device is not linked.' }, 401);
  if (d.status !== 'active') return json({ error: 'This account is suspended.' }, 403);
  if (p === '/api/tv/reseller/check') return tvCheck(request, env, d);
  if (p === '/api/tv/reseller/renew') return tvRenew(request, env, d);
  return tvLoadStatus(request, env, d);
}

// ---------------------------------------------------------------- Account page (signed in)

/** For /api/me: confirmed lines and each device's last channel loads. */
export async function accountTroubleshooting(env, userId) {
  const lines = (await env.DB.prepare('SELECT line_id, name, expires_at, enabled, checked_at FROM reseller_lines WHERE user_id = ?1 ORDER BY name').bind(userId).all()).results;
  const loads = (await env.DB.prepare(
    `SELECT s.device_id, s.local_id, s.name, s.ok, s.channels, s.problem, s.at, s.expires_at FROM device_load_status s
       JOIN devices d ON d.id = s.device_id AND d.revoked_at IS NULL WHERE s.user_id = ?1 ORDER BY s.name`
  ).bind(userId).all()).results;
  const pending = (await env.DB.prepare("SELECT id, reload_requested_at, check_requested_at FROM devices WHERE user_id = ?1 AND revoked_at IS NULL").bind(userId).all()).results;
  return {
    reseller: lines.map((l) => ({ name: l.name || 'Subscription', expiresAt: l.expires_at, enabled: Boolean(l.enabled), checkedAt: l.checked_at })),
    loads: loads.map((x) => ({ deviceId: x.device_id, name: x.name || 'Playlist', ok: Boolean(x.ok), channels: x.channels, problem: x.problem, at: x.at, expiresAt: x.expires_at })),
    requested: Object.fromEntries(pending.map((x) => [x.id, { reload: Boolean(x.reload_requested_at), check: Boolean(x.check_requested_at) }])),
  };
}

/** POST /api/devices/request {deviceId?, what: 'reload'|'check'}: for one device, or every device when deviceId is empty. */
export async function accountRequest(request, env, user) {
  const b = await body(request);
  const what = b?.what === 'reload' ? 'reload_requested_at' : b?.what === 'check' ? 'check_requested_at' : null;
  if (!what) return json({ error: 'Unknown request.' }, 400);
  const id = clip(b?.deviceId, 40);
  const r = await env.DB.prepare(`UPDATE devices SET ${what} = ?1 WHERE user_id = ?2 AND revoked_at IS NULL${id ? ' AND id = ?3' : ''}`)
    .bind(Date.now(), user.id, ...(id ? [id] : [])).run();
  if (!r.meta?.changes) return json({ error: id ? 'That device is no longer linked.' : 'No devices are linked.' }, 404);
  return json({ ok: true, devices: r.meta.changes });
}

// ---------------------------------------------------------------- admin

/** GET /api/admin/reseller: set-up state, addresses, credit balance, renewals waiting or recent. */
export async function adminReseller(env) {
  const hosts = await hostsFor(env);
  let reseller = null;
  if (configured(env)) {
    const r = await panel(env, { action: 'reseller' });
    reseller = r.reached && r.data
      ? { credits: r.data.credits ?? null, enabled: r.data.enabled == null ? null : truthy(r.data.enabled), refused: r.data.status != null && !truthy(r.data.status) ? String(r.data.message ?? r.data.messasge ?? 'no reason given').slice(0, 120) : null }
      : { error: "Couldn't reach the provider: " + (r.why || 'unknown') + '.' };
  }
  const renewals = (await env.DB.prepare(
    `SELECT r.id, r.status, r.months, r.created_at, r.done_at, r.message, r.requested_by, u.email, l.name FROM reseller_renewals r
       LEFT JOIN users u ON u.id = r.user_id LEFT JOIN reseller_lines l ON l.user_id = r.user_id AND l.line_id = r.line_id
      WHERE r.status IN ('pending', 'running', 'unknown') OR r.created_at > ?1 ORDER BY r.created_at DESC LIMIT 50`
  ).bind(Date.now() - 30 * DAY).all()).results;
  const lines = (await env.DB.prepare('SELECT COUNT(*) AS n FROM reseller_lines').first())?.n || 0;
  return json({ configured: configured(env), hosts, reseller, lines, renewals: renewals.map((r) => ({ id: r.id, status: r.status, months: r.months, createdAt: r.created_at, doneAt: r.done_at, message: r.message, by: r.requested_by, email: r.email, name: r.name })) });
}

/**
 * For Admin › People › an account: each line with where it stands. Its account playlist (the one Add a line made, or
 * the one a device that confirmed the line has it as), whether the account has kept its login, the profiles that have
 * it, and every device it goes to through those profiles (with how far it got), plus devices that confirmed it.
 */
const TARGET_STATE = { done: 'has it', waiting: 'sending', needs_login: 'waiting for their passkey', needs_update: 'needs an app update', failed: "couldn't add it" };
export async function adminLinesFor(env, userId) {
  const all = (sql) => env.DB.prepare(sql).bind(userId).all().then((r) => r.results);
  const [lines, confirmed, playlists, profs, targets] = await Promise.all([
    all('SELECT line_id, name, expires_at, enabled, checked_at, playlist_id FROM reseller_lines WHERE user_id = ?1 ORDER BY name'),
    all(`SELECT ld.line_id, ld.device_id, d.name AS device, dp.remote_id FROM reseller_line_devices ld JOIN devices d ON d.id = ld.device_id AND d.revoked_at IS NULL
           LEFT JOIN device_playlists dp ON dp.device_id = ld.device_id AND dp.local_id = ld.local_id WHERE ld.user_id = ?1`),
    all('SELECT id, name, (vault IS NOT NULL) AS kept, (sealed IS NOT NULL) AS sealed, removing FROM account_playlists WHERE user_id = ?1'),
    all('SELECT pp.playlist_id, pr.name FROM profile_playlists pp JOIN profiles pr ON pr.id = pp.profile_id WHERE pp.user_id = ?1 ORDER BY pr.sort, pr.name'),
    all(`SELECT t.playlist_id, t.device_id, t.action, t.status, t.error, d.name AS device FROM playlist_targets t JOIN devices d ON d.id = t.device_id AND d.revoked_at IS NULL
           WHERE t.user_id = ?1 AND t.action <> 'remove'`),
  ]);
  const renewals = (await env.DB.prepare('SELECT id, line_id, status, months, created_at, done_at, message, requested_by, expires_before, expires_after FROM reseller_renewals WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 30').bind(userId).all()).results;
  return {
    lines: lines.map((l) => {
      const conf = confirmed.filter((c) => c.line_id === l.line_id);
      const pid = l.playlist_id || conf.map((c) => c.remote_id).find(Boolean) || null;
      const pl = playlists.find((p) => p.id === pid && !p.removing) || null;
      const devices = new Map();
      for (const t of targets.filter((t) => t.playlist_id === pid)) devices.set(t.device_id, { name: t.device, state: TARGET_STATE[t.status] || t.status, error: t.error || null });
      for (const c of conf) devices.set(c.device_id, { name: c.device, state: 'has it (confirmed)' });
      return {
        lineId: l.line_id, name: l.name, expiresAt: l.expires_at, enabled: Boolean(l.enabled), checkedAt: l.checked_at,
        playlist: pl ? { name: pl.name, kept: Boolean(pl.kept), waitingForPasskey: !pl.kept && Boolean(pl.sealed) } : null,
        profiles: pl ? profs.filter((p) => p.playlist_id === pl.id).map((p) => p.name) : [],
        devices: [...devices.values()],
      };
    }),
    renewals: renewals.map((r) => ({ id: r.id, lineId: r.line_id, status: r.status, months: r.months, createdAt: r.created_at, doneAt: r.done_at, message: r.message, by: r.requested_by, expiresBefore: r.expires_before, expiresAfter: r.expires_after })),
    // For Add a line › Existing line › Link to: the account's playlists (Nov 22).
    playlists: playlists.filter((p) => !p.removing).map((p) => ({ id: p.id, name: p.name })),
  };
}

async function lineOf(env, b) {
  return env.DB.prepare('SELECT l.user_id, l.line_id, l.name, u.email, u.id FROM reseller_lines l JOIN users u ON u.id = l.user_id WHERE l.user_id = ?1 AND l.line_id = ?2')
    .bind(String(b?.userId || ''), String(b?.lineId || '')).first();
}
function reasonOf(b) { const r = String(b?.reason || '').trim(); return r.length >= 3 ? r.slice(0, 500) : null; }

/** POST /api/admin/reseller/renew {userId, lineId, months, reason}: a renewal for the next check-in of a device with the line. */
async function adminRenew(request, env, admin, audit) {
  if (!configured(env)) return json({ error: 'Add the RESELLER_API_KEY and RESELLER_API_BASE secrets first.' }, 503);
  const b = await body(request);
  const reason = reasonOf(b);
  if (!reason) return json({ error: 'Give a reason (it goes in the audit log).' }, 400);
  const months = Number(b?.months);
  if (!MONTHS.includes(months)) return json({ error: 'Choose 1, 3, 6 or 12 months.' }, 400);
  const l = await lineOf(env, b);
  if (!l) return json({ error: 'That line is not in this account.' }, 404);
  const busy = await env.DB.prepare("SELECT status FROM reseller_renewals WHERE user_id = ?1 AND line_id = ?2 AND status IN ('pending', 'running', 'unknown')").bind(l.user_id, l.line_id).first();
  if (busy) return json({ error: busy.status === 'unknown' ? 'The last renewal of this line has an unknown result. Check it in the provider panel, then mark it resolved.' : 'This line already has a renewal waiting.' }, 409);
  const id = randomToken(12);
  await env.DB.prepare("INSERT INTO reseller_renewals (id, user_id, line_id, months, status, requested_by, reason, created_at) VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?7)")
    .bind(id, l.user_id, l.line_id, months, admin.email, reason, Date.now()).run();
  await audit(env, admin, 'reseller_renew', { id: l.user_id, email: l.email }, `${l.name || 'line'}: ${months} month${months === 1 ? '' : 's'}`, reason);
  return json({ ok: true, id });
}

/** POST /api/admin/reseller/renewal {id, action: 'cancel'|'resolve', reason}: cancel a waiting one, or close an unknown one. */
async function adminRenewal(request, env, admin, audit) {
  const b = await body(request);
  const reason = reasonOf(b);
  if (!reason) return json({ error: 'Give a reason (it goes in the audit log).' }, 400);
  const from = b?.action === 'resolve' ? 'unknown' : b?.action === 'cancel' ? 'pending' : null;
  if (!from) return json({ error: 'Unknown action.' }, 400);
  const rn = await env.DB.prepare('SELECT r.id, r.user_id, u.email FROM reseller_renewals r LEFT JOIN users u ON u.id = r.user_id WHERE r.id = ?1 AND r.status = ?2').bind(String(b?.id || ''), from).first();
  if (!rn) return json({ error: from === 'pending' ? 'That renewal is no longer waiting.' : 'Nothing to resolve.' }, 404);
  await env.DB.prepare('UPDATE reseller_renewals SET status = ?1, done_at = ?2, message = COALESCE(message, \'\') || ?3 WHERE id = ?4')
    .bind(from === 'pending' ? 'cancelled' : 'failed', Date.now(), from === 'pending' ? '' : ' Resolved by ' + admin.email + ': ' + reason, rn.id).run();
  await audit(env, admin, from === 'pending' ? 'reseller_renew_cancel' : 'reseller_renew_resolve', { id: rn.user_id, email: rn.email }, null, reason);
  return json({ ok: true });
}

/** POST /api/admin/reseller/line {userId, lineId, enabled, reason}: turns the line on or off at the provider (device_status). */
async function adminLineStatus(request, env, admin, audit) {
  if (!configured(env)) return json({ error: 'Add the RESELLER_API_KEY and RESELLER_API_BASE secrets first.' }, 503);
  const b = await body(request);
  const reason = reasonOf(b);
  if (!reason) return json({ error: 'Give a reason (it goes in the audit log).' }, 400);
  const l = await lineOf(env, b);
  if (!l) return json({ error: 'That line is not in this account.' }, 404);
  const on = b?.enabled === true;
  const r = await panel(env, { action: 'device_status', id: l.line_id, status: on ? 'enable' : 'disable' });
  if (!r.reached) return json({ error: "Couldn't reach the provider. Nothing was changed here; check the panel." }, 502);
  if (!r.data || !truthy(r.data.status)) return json({ error: 'the provider refused: ' + (r.data?.message || 'no reason given') }, 502);
  await env.DB.prepare('UPDATE reseller_lines SET enabled = ?1, checked_at = ?2 WHERE user_id = ?3 AND line_id = ?4').bind(on ? 1 : 0, Date.now(), l.user_id, l.line_id).run();
  await audit(env, admin, on ? 'reseller_enable' : 'reseller_disable', { id: l.user_id, email: l.email }, l.name || 'line', reason);
  return json({ ok: true });
}

/** POST /api/admin/reseller/hosts {hosts: "a.com, b.net", reason}. */
async function adminHosts(request, env, admin, audit) {
  const b = await body(request);
  const reason = reasonOf(b);
  if (!reason) return json({ error: 'Give a reason (it goes in the audit log).' }, 400);
  const hosts = [...new Set(String(b?.hosts || '').split(/[\s,]+/).map(hostOf).filter(Boolean))].slice(0, 20);
  await env.DB.prepare("INSERT INTO site_state (key, value) VALUES ('reseller_hosts', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1").bind(JSON.stringify(hosts)).run();
  await audit(env, admin, 'reseller_hosts', null, hosts.join(', ') || '(none)', reason);
  return json({ ok: true, hosts });
}


// ---------------------------------------------------------------- admin: add a line to an account (Nov 21, 2026)
//
// A new line (panel action=new, from the owner's credits) or one that already exists (confirmed with device_info).
// The website handles the login only for this request: it's locked for the account's key (accounts with locked logins:
// the playlist is the account's, given to no profile yet), or for each linked device (accounts without: given to every
// profile so their devices get it), shown to the admin once, and never stored or logged.

const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** The same envelope the browser (public/playlists.js) and the TV (DeviceKey.seal) make: ECDH P-256 → HKDF-SHA256 → AES-GCM. */
export async function sealFor(pubB64, obj, info) {
  const S = crypto.subtle;
  const to = await S.importKey('raw', unb64(pubB64), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const eph = await S.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const z = await S.deriveBits({ name: 'ECDH', public: to }, eph.privateKey, 256);
  const epk = new Uint8Array(await S.exportKey('raw', eph.publicKey));
  const hk = await S.importKey('raw', z, 'HKDF', false, ['deriveKey']);
  const key = await S.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: epk, info: new TextEncoder().encode(info) }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await S.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj))));
  return { v: 1, epk: b64(epk), iv: b64(iv), ct: b64(ct) };
}

/** "http://host:port/get.php?username=u&password=p&type=m3u_plus…" → {server, username, password} (null if not that kind). */
export function loginFromUrl(url) {
  try {
    const u = new URL(String(url));
    const username = u.searchParams.get('username') || '', password = u.searchParams.get('password') || '';
    if (!username || !password) return null;
    return { server: `${u.protocol}//${u.host}`, username, password };
  } catch { return null; }
}

/** GET /api/admin/reseller/packages: the panel's packages (bouquets) for the New line form. */
export async function adminPackages(env) {
  if (!configured(env)) return json({ error: 'Add the RESELLER_API_KEY and RESELLER_API_BASE secrets first.' }, 503);
  const r = await panel(env, { action: 'bouquet' });
  if (!r.reached || !Array.isArray(r.data)) return json({ error: "Couldn't get the packages: " + (r.why || 'unexpected answer') + '.' }, 502);
  return json({ packages: r.data.map((p) => ({ id: String(p.id ?? ''), name: String(p.name ?? p.id ?? '') })).filter((p) => p.id) });
}

/**
 * POST /api/admin/reseller/add-line {userId, name, reason, mode: 'new', months, pack} or {…, mode: 'existing', server,
 * username, password}: makes or confirms the line, puts its playlist in the account and answers the login once.
 */
async function adminAddLine(request, env, admin, audit) {
  if (!configured(env)) return json({ error: 'Add the RESELLER_API_KEY and RESELLER_API_BASE secrets first.' }, 503);
  const b = await body(request);
  const reason = reasonOf(b);
  if (!reason) return json({ error: 'Give a reason (it goes in the audit log).' }, 400);
  const u = await env.DB.prepare("SELECT id, email, status FROM users WHERE id = ?1").bind(String(b?.userId || '')).first();
  if (!u) return json({ error: 'Account not found.' }, 404);
  const name = clip(b?.name, 60) || 'TV';
  // Nov 22, 2026 (owner): an existing line can be linked to a playlist the account already has, instead of adding one.
  const linkTo = b?.mode === 'existing' && b?.playlistId ? await env.DB.prepare('SELECT id, name FROM account_playlists WHERE id = ?1 AND user_id = ?2 AND removing = 0').bind(String(b.playlistId), u.id).first() : null;
  if (b?.mode === 'existing' && b?.playlistId && !linkTo) return json({ error: 'That playlist is no longer in the account.' }, 400);
  if (!linkTo && await env.DB.prepare('SELECT 1 FROM account_playlists WHERE user_id = ?1 AND lower(name) = lower(?2) AND removing = 0').bind(u.id, name).first()) {
    return json({ error: `That account already has a playlist called ${name}. Choose another name.` }, 400);
  }
  const hosts = await hostsFor(env);
  let login, lineId, made = false, newId = null;
  if (b?.mode === 'new') {
    const months = Number(b?.months);
    if (!MONTHS.includes(months)) return json({ error: 'Choose 1, 3, 6 or 12 months.' }, 400);
    const pack = clip(String(b?.pack ?? ''), 40);
    if (!pack) return json({ error: 'Choose a package.' }, 400);
    // The panel keeps a note with the line: the account's id, never its email.
    const r = await panel(env, { action: 'new', type: 'm3u', sub: months, pack, notes: 'Avid Viewer ' + u.id.slice(0, 8) });
    if (!r.reached) return json({ error: "The panel didn't answer, so the line may or may not have been made. Check the panel before trying again." }, 502);
    if (!r.data || !truthy(r.data.status)) return json({ error: 'The panel refused: ' + (r.data?.message ?? r.data?.messasge ?? r.why ?? 'no reason given') }, 502);
    newId = r.data.user_id != null ? String(r.data.user_id) : null;
    login = loginFromUrl(r.data.url);
    if (!login) return json({ error: "The line was made, but its playlist link didn't come back. Find it in the panel (note: Avid Viewer " + u.id.slice(0, 8) + ') and use Existing line.' }, 502);
    made = true;
  } else if (b?.mode === 'existing') {
    const server = clip(b?.server, 200);
    login = { server: /^[a-z]+:\/\//i.test(server) ? server.replace(/\/+$/, '') : 'http://' + server.replace(/\/+$/, ''), username: clip(b?.username, 200), password: clip(b?.password, 200) };
    if (!hostOf(login.server) || !login.username || !login.password) return json({ error: 'Enter the server, username and password.' }, 400);
  } else return json({ error: 'Choose New line or Existing line.' }, 400);
  if (hosts.length && !hosts.includes(hostOf(login.server)) && b?.mode === 'existing') {
    return json({ error: 'That server is not one of your reseller addresses (Dashboard › Reseller lines).' }, 400);
  }
  const info = await lineInfo(env, login.username, login.password);
  if (!made && (info.error || !info.line)) return json({ error: info.error ? "Couldn't reach the panel to check the line." : "That login isn't one of your lines." }, 400);
  lineId = info.line?.lineId || newId;
  const now = Date.now();
  if (linkTo) {
    // Only the line is recorded, pointing at the account's own playlist; nothing is added or sent to devices.
    await env.DB.prepare(
      `INSERT INTO reseller_lines (user_id, line_id, name, expires_at, enabled, checked_at, created_at, playlist_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7)
       ON CONFLICT(user_id, line_id) DO UPDATE SET name = ?3, expires_at = COALESCE(?4, expires_at), enabled = ?5, checked_at = ?6, playlist_id = ?7`
    ).bind(u.id, lineId, linkTo.name, info.line?.expiresAt ?? null, info.line.enabled ? 1 : 0, now, linkTo.id).run();
    await audit(env, admin, 'reseller_link_existing', { id: u.id, email: u.email }, `line ${lineId} linked to ${linkTo.name}`, reason);
    return json({ ok: true, id: linkTo.id, linked: true, name: linkTo.name, expiresAt: info.line?.expiresAt ?? null });
  }
  const playlist = { name, type: 'xtream', server: login.server, username: login.username, password: login.password, m3uUrl: '', epgUrl: '' };
  const id = randomToken(12);
  const akey = await env.DB.prepare('SELECT pubkey FROM account_keys WHERE user_id = ?1').bind(u.id).first();
  const stmts = [];
  let delivered;
  if (akey?.pubkey) {
    const sealed = await sealFor(akey.pubkey, playlist, 'avidviewer-account:v1');
    stmts.push(env.DB.prepare('INSERT INTO account_playlists (id, user_id, name, type, vault, sealed, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?6)')
      .bind(id, u.id, name, 'xtream', JSON.stringify(sealed), now));
    delivered = 'account';
  } else {
    stmts.push(env.DB.prepare('INSERT INTO account_playlists (id, user_id, name, type, vault, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?5)')
      .bind(id, u.id, name, 'xtream', now));
    const profs = (await env.DB.prepare('SELECT id FROM profiles WHERE user_id = ?1').bind(u.id).all()).results;
    for (const p of profs) stmts.push(env.DB.prepare('INSERT INTO profile_playlists (profile_id, playlist_id, user_id) VALUES (?1, ?2, ?3)').bind(p.id, id, u.id));
    delivered = 'devices';
  }
  if (lineId) {
    stmts.push(env.DB.prepare(
      `INSERT INTO reseller_lines (user_id, line_id, name, expires_at, enabled, checked_at, created_at, playlist_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7)
       ON CONFLICT(user_id, line_id) DO UPDATE SET name = ?3, expires_at = COALESCE(?4, expires_at), enabled = ?5, checked_at = ?6, playlist_id = ?7`
    ).bind(u.id, lineId, name, info.line?.expiresAt ?? null, info.line ? (info.line.enabled ? 1 : 0) : 1, now, id));
  }
  await env.DB.batch(stmts);
  let devices = 0;
  if (delivered === 'devices') {
    // Every profile has it now: lock the login for each linked device that's waiting for it.
    await reconcile(env, u.id);
    const waiting = (await env.DB.prepare(
      `SELECT t.device_id, d.pubkey FROM playlist_targets t JOIN devices d ON d.id = t.device_id
        WHERE t.playlist_id = ?1 AND t.status = 'needs_login' AND d.revoked_at IS NULL AND d.pubkey IS NOT NULL`
    ).bind(id).all()).results;
    const up = [];
    for (const w of waiting) {
      up.push(env.DB.prepare(`UPDATE playlist_targets SET payload = ?1, status = 'waiting', error = NULL, version = version + 1, updated_at = ?2
        WHERE playlist_id = ?3 AND device_id = ?4`).bind(JSON.stringify(await sealFor(w.pubkey, playlist, 'avidviewer-playlist:v1')), now, id, w.device_id));
    }
    if (up.length) await env.DB.batch(up);
    devices = up.length;
  }
  await audit(env, admin, made ? 'reseller_add_new' : 'reseller_add_existing', { id: u.id, email: u.email },
    `${name}${made ? `, ${b.months} month${Number(b.months) === 1 ? '' : 's'}` : ''}, ${delivered === 'account' ? 'locked for the account' : devices + ' device(s)'}`, reason);
  const m3u = `${login.server}/get.php?username=${encodeURIComponent(login.username)}&password=${encodeURIComponent(login.password)}&type=m3u_plus&output=ts`;
  return json({ ok: true, id, delivered, devices, expiresAt: info.line?.expiresAt ?? null, login: { server: login.server, username: login.username, password: login.password, m3u } });
}

export function handleResellerAdmin(request, env, p, admin, audit) {
  switch (p) {
    case '/api/admin/reseller/renew': return adminRenew(request, env, admin, audit);
    case '/api/admin/reseller/renewal': return adminRenewal(request, env, admin, audit);
    case '/api/admin/reseller/line': return adminLineStatus(request, env, admin, audit);
    case '/api/admin/reseller/hosts': return adminHosts(request, env, admin, audit);
    case '/api/admin/reseller/add-line': return adminAddLine(request, env, admin, audit);
  }
  return null;
}
