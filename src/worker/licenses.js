// Licenses (Nov 20, 2026, owner request), ahead of payments.
//   - Every account gets a 1-month trial: existing accounts in migration 0018, new ones in grantTrial() at sign-up.
//   - Admin › People: Grant or extend (7 days, 1, 3, 6 months, 1 year, perpetual) and Revoke, with a reason (audit log).
//     Extending starts from the current end (or now, if it has ended), so no days are lost.
//   - The owner (every admin account) is emailed once, 3 days before an account's license ends (checkEnding, run at
//     most once an hour from device check-ins, since the site has no scheduled jobs). Admin › Overview lists them too.
//   - Nothing is blocked when a license ends, for now. The payment platform will add 'paid' licenses through its webhook.
import { json, randomToken } from './auth.js';
import { sendMail, mailConfigured } from './mail.js';

const DAY = 86_400_000;
export const NOTIFY_BEFORE = 3 * DAY;
export const LENGTHS = { '7d': '7 days', '1m': '1 month', '3m': '3 months', '6m': '6 months', '1y': '1 year', perpetual: 'Perpetual' };

/** ms + a calendar length (UTC); null for perpetual. */
export function addLength(ms, length) {
  if (length === 'perpetual') return null;
  const d = new Date(ms);
  if (length === '7d') return ms + 7 * DAY;
  const months = { '1m': 1, '3m': 3, '6m': 6, '1y': 12 }[length];
  if (!months) throw new Error('unknown length');
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  if (d.getUTCDate() !== day) d.setUTCDate(0); // Jan 31 + 1 month = Feb 28/29, not Mar 3
  return d.getTime();
}

/** The account's license now: the most generous one that isn't revoked. */
export async function licenseFor(env, userId, now = Date.now()) {
  const rows = (await env.DB.prepare(
    'SELECT kind, starts_at, ends_at FROM licenses WHERE user_id = ?1 AND revoked_at IS NULL AND starts_at <= ?2'
  ).bind(userId, now).all()).results;
  return summarize(rows, now);
}

export function summarize(rows, now = Date.now()) {
  if (!rows.length) return { status: 'none' };
  const perpetual = rows.find((r) => r.ends_at == null);
  if (perpetual) return { status: 'active', kind: perpetual.kind, perpetual: true, endsAt: null };
  const best = rows.reduce((a, b) => (b.ends_at > a.ends_at ? b : a));
  const status = best.ends_at <= now ? 'expired' : best.ends_at - now <= NOTIFY_BEFORE ? 'ending' : 'active';
  return { status, kind: best.kind, perpetual: false, endsAt: best.ends_at };
}

/** A new account's 1-month trial. */
export async function grantTrial(env, userId, now = Date.now()) {
  await env.DB.prepare(
    "INSERT INTO licenses (id, user_id, kind, starts_at, ends_at, source, note, created_at) VALUES (?1, ?2, 'trial', ?3, ?4, 'auto', 'Trial for a new account', ?3)"
  ).bind(randomToken(12), userId, now, addLength(now, '1m')).run();
}

/** Admin › People: grant or extend ({userId, length, kind?}) or revoke ({userId, revoke: true}). */
export async function adminLicense(request, env, admin, audit, body) {
  const b = await body(request);
  const reason = String(b?.reason || '').trim().slice(0, 500);
  if (reason.length < 3) return json({ error: 'Give a reason (it goes in the audit log).' }, 400);
  const u = await env.DB.prepare('SELECT id, email FROM users WHERE id = ?1').bind(String(b?.userId || '')).first();
  if (!u) return json({ error: 'Account not found.' }, 404);
  const now = Date.now();
  if (b?.revoke) {
    const r = await env.DB.prepare('UPDATE licenses SET revoked_at = ?1 WHERE user_id = ?2 AND revoked_at IS NULL').bind(now, u.id).run();
    await audit(env, admin, 'license_revoke', u, `${r.meta?.changes || 0} license(s)`, reason);
    return json({ ok: true, license: await licenseFor(env, u.id, now) });
  }
  const length = String(b?.length || '');
  if (!LENGTHS[length]) return json({ error: 'Choose a length.' }, 400);
  const kind = ['trial', 'comp'].includes(b?.kind) ? b.kind : (length === 'perpetual' ? 'comp' : 'trial');
  const cur = await licenseFor(env, u.id, now);
  if (cur.perpetual && length !== 'perpetual') return json({ error: 'This account already has a perpetual license. Revoke it first to give a shorter one.' }, 409);
  const from = cur.endsAt && cur.endsAt > now ? cur.endsAt : now;
  const ends = addLength(from, length);
  await env.DB.prepare(
    "INSERT INTO licenses (id, user_id, kind, starts_at, ends_at, source, granted_by, note, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'admin', ?6, ?7, ?4)"
  ).bind(randomToken(12), u.id, kind, now, ends, admin.email, reason).run();
  const what = `${LENGTHS[length]} ${kind === 'comp' ? 'complimentary' : 'trial'}${ends ? ', until ' + new Date(ends).toISOString().slice(0, 10) : ''}`;
  await audit(env, admin, 'license_grant', u, what, reason);
  return json({ ok: true, license: await licenseFor(env, u.id, now) });
}

/** For the admin lists: each account's license, by user id. */
export async function licensesByUser(env, now = Date.now()) {
  const rows = (await env.DB.prepare(
    'SELECT user_id, kind, starts_at, ends_at FROM licenses WHERE revoked_at IS NULL AND starts_at <= ?1'
  ).bind(now).all()).results;
  const by = {};
  for (const r of rows) (by[r.user_id] ||= []).push(r);
  const out = {};
  for (const [k, v] of Object.entries(by)) out[k] = summarize(v, now);
  return out;
}

/** Accounts whose license ends within 3 days (or ended in the last 30), for Admin › Overview. */
export async function endingSoon(env, now = Date.now()) {
  const all = await licensesByUser(env, now);
  const users = (await env.DB.prepare('SELECT id, email FROM users').all()).results;
  return users.map((u) => ({ id: u.id, email: u.email, ...(all[u.id] || { status: 'none' }) }))
    .filter((x) => x.status === 'ending' || (x.status === 'expired' && now - x.endsAt < 30 * DAY))
    .sort((a, b) => a.endsAt - b.endsAt);
}

/**
 * Emails every admin about licenses ending within 3 days, once per license. Runs at most once an hour (site_state
 * 'licenses_checked_at'), from device check-ins. Without a mail provider it only marks nothing and returns.
 */
export async function checkEnding(env, now = Date.now()) {
  const last = Number((await env.DB.prepare("SELECT value FROM site_state WHERE key = 'licenses_checked_at'").first())?.value || 0);
  if (now - last < 3_600_000) return 0;
  await env.DB.prepare("INSERT INTO site_state (key, value) VALUES ('licenses_checked_at', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1").bind(String(now)).run();
  if (!mailConfigured(env)) return 0;
  // The account's best license ends within 3 days and nobody was told about that one yet.
  const due = (await env.DB.prepare(
    `SELECT l.id, l.user_id, l.ends_at, l.kind, u.email FROM licenses l JOIN users u ON u.id = l.user_id
      WHERE l.revoked_at IS NULL AND l.notified_at IS NULL AND l.ends_at IS NOT NULL AND l.ends_at > ?1 AND l.ends_at <= ?2
        AND NOT EXISTS (SELECT 1 FROM licenses o WHERE o.user_id = l.user_id AND o.revoked_at IS NULL AND o.id <> l.id
                        AND (o.ends_at IS NULL OR o.ends_at > l.ends_at))`
  ).bind(now, now + NOTIFY_BEFORE).all()).results;
  if (!due.length) return 0;
  const admins = (await env.DB.prepare("SELECT email FROM users WHERE role = 'admin' AND status = 'active'").all()).results;
  if (!admins.length) return 0;
  const day = (ms) => new Date(ms).toLocaleDateString('en-US', { timeZone: 'America/Denver', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const lines = due.map((d) => `- ${d.email}: ${d.kind === 'comp' ? 'complimentary license' : d.kind === 'paid' ? 'paid license' : 'trial'} ends ${day(d.ends_at)} (Mountain)`);
  const text = `These Avid Viewer licenses end within 3 days:\n\n${lines.join('\n')}\n\nTo extend one: avidviewer.app/admin/ › People › the account › Grant or extend.\nNothing is blocked when a license ends (for now).\n`;
  for (const a of admins) {
    await sendMail(env, { to: a.email, subject: `Avid Viewer: ${due.length} license${due.length === 1 ? '' : 's'} ending within 3 days`, text, html: `<pre style="font:14px/1.5 system-ui">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>` });
  }
  const ids = due.map((d) => d.id);
  await env.DB.prepare(`UPDATE licenses SET notified_at = ?1 WHERE id IN (${ids.map((_, i) => '?' + (i + 2)).join(',')})`).bind(now, ...ids).run();
  return due.length;
}
