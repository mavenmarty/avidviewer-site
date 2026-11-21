// Avid Viewer accounts, step 1: sign-in by emailed link or passkey, sessions, and the Account page's API.
//
// Routes (all JSON; POSTs must come from this site's own pages, checked by Origin):
//   POST /api/auth/email            {email}            → sends a one-time sign-in link (15 minutes)
//   POST /api/auth/verify           {token}            → signs in with that link, sets the av_session cookie
//   POST /api/auth/signout                             → ends this browser's session
//   GET  /api/me                                       → the signed-in account (401 if none)
//   POST /api/account/settings      {watchHistory}
//   POST /api/account/sessions/end  {id} | {others: true}
//   POST /api/account/delete        {confirm: <email>} → deletes the account and every session and passkey
//   POST /api/passkeys/register/options | /verify      → add a passkey (signed in)
//   POST /api/passkeys/login/options | /verify         → sign in with a passkey
//   POST /api/passkeys/delete       {id}
//
// Tokens (sign-in links, session cookies) are random 32-byte values; only their SHA-256 is stored, so a copy of
// the database can't be used to sign in. Sign-in links go in the URL's #fragment, which mail scanners don't
// send to the server and don't "click", so a scanner can't use up someone's link.

import { playlistsSave, playlistsSeal, playlistsRemove, playlistVault } from './playlists.js';
import { attention, attentionDismiss, playlistsRetry } from './attention.js';
import { listsGet, listsSave, orderGet, orderSave } from './lists.js';
import { historyGet, historyPut, historyKeySave, historyDevices, historySeal, profileHistory, clearAllHistory, discoverSave, tmdbSave } from './history.js';
import { deviceBeta } from './beta.js';
import { grantTrial, licenseFor } from './licenses.js';
import { accountTroubleshooting, accountRequest } from './reseller.js';
import { accountReports, accountReport, accountReportNote } from './reports.js';
import { manage, catalogFor, profileSave, profileRemove, profilePin, profileVisibility, deviceSetProfiles, deviceStop, vaultKey, accountKeySave, deviceLogins, playlistsImport, playlistsAdopt } from './profiles.js';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { mailConfigured, sendMail } from './mail.js';
import { handleAdminApi } from './admin.js';
import { MAX_DEVICES, linkLookup, linkApprove, linkSetupToken, devicesFor, deviceRename, deviceRemove, backupsFor, backupDelete, backupPin } from './devices.js';

const LINK_TTL = 15 * 60 * 1000;
const SESSION_TTL = 30 * 24 * 3600 * 1000;
const CHALLENGE_TTL = 5 * 60 * 1000;
const LINKS_PER_EMAIL = 3;     // per 15 minutes
const LINKS_PER_IP = 10;       // per hour
const COOKIE = 'av_session';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export function randomToken(bytes = 32) {
  return isoBase64URL.fromBuffer(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function ipOf(request) { return request.headers.get('cf-connecting-ip') || ''; }

/** "Chrome on Windows" from a User-Agent, for the list of signed-in browsers. */
function labelFor(ua = '') {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari' : 'A browser';
  const os = /iPhone|iPad/.test(ua) ? 'iPhone or iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac'
    : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

function cookieValue(request, name) {
  const m = (request.headers.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : null;
}

function sessionCookie(token, maxAgeSeconds) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

/** The signed-in user for this request, or null. Touches last_seen at most once a minute. */
export async function currentUser(request, env) {
  const token = cookieValue(request, COOKIE);
  if (!token) return null;
  const hash = await sha256hex(token);
  const now = Date.now();
  const row = await env.DB.prepare(
    `SELECT s.token_hash, s.last_seen, s.method AS session_method, s.created_at AS session_started, u.id, u.email, u.created_at, u.role, u.status, u.watch_history
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?1 AND s.expires_at > ?2`
  ).bind(hash, now).first();
  if (!row || row.status !== 'active') return null;
  if (now - row.last_seen > 60_000) {
    await env.DB.prepare('UPDATE sessions SET last_seen = ?1 WHERE token_hash = ?2').bind(now, hash).run();
  }
  return { ...row, sessionHash: hash };
}

/** Admin emails come from the ADMIN_EMAILS secret (comma-separated), so no address is in the public repo. */
function isAdminEmail(env, email) {
  return String(env.ADMIN_EMAILS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean).includes(email);
}

async function startSession(request, env, userId, method = 'link') {
  const token = randomToken();
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen, label, method) VALUES (?1, ?2, ?3, ?4, ?3, ?5, ?6)'
  ).bind(await sha256hex(token), userId, now, now + SESSION_TTL, labelFor(request.headers.get('user-agent') || ''), method).run();
  await env.DB.prepare('UPDATE users SET last_sign_in = ?1 WHERE id = ?2').bind(new Date(now).toISOString(), userId).run();
  return sessionCookie(token, SESSION_TTL / 1000);
}

/** Finds or creates the account for an email address that was just proven (link) — never from user input alone. */
async function userForEmail(env, email) {
  let u = await env.DB.prepare('SELECT id, status, role FROM users WHERE email = ?1').bind(email).first();
  let created = false;
  if (!u) {
    const id = randomToken(16);
    await env.DB.prepare('INSERT INTO users (id, email, created_at, role) VALUES (?1, ?2, ?3, ?4)')
      .bind(id, email, new Date().toISOString(), isAdminEmail(env, email) ? 'admin' : 'user').run();
    u = { id, status: 'active', role: isAdminEmail(env, email) ? 'admin' : 'user' };
    created = true;
    await grantTrial(env, id); // every new account starts with a 1-month trial (Nov 20, 2026)
  } else if (u.role !== 'admin' && isAdminEmail(env, email)) {
    await env.DB.prepare("UPDATE users SET role = 'admin' WHERE id = ?1").bind(u.id).run();
  }
  return { ...u, created };
}

export async function body(request) {
  try { return await request.json(); } catch { return null; }
}

// ---------------------------------------------------------------- sign-in links

async function emailLink(request, env, url) {
  const b = await body(request);
  if (!b) return json({ error: "That didn't come through. Please try again." }, 400);
  if (b.website) return json({ message: 'Check your email for a sign-in link.' }); // bots
  const email = String(b.email || '').trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) return json({ error: 'Please enter a valid email address.' }, 400);

  const dev = env.DEV_SHOW_LINKS === '1';
  if (!mailConfigured(env) && !dev) {
    return json({ error: "Signing in by email isn't switched on yet. If you've added a passkey, use Sign in with a passkey." }, 503);
  }
  const now = Date.now();
  await env.DB.prepare('DELETE FROM sign_in_links WHERE expires_at < ?1').bind(now - 24 * 3600_000).run();
  const ipHash = await sha256hex(ipOf(request) + new Date(now).toISOString().slice(0, 10));
  const perEmail = await env.DB.prepare('SELECT COUNT(*) AS n FROM sign_in_links WHERE email = ?1 AND created_at > ?2')
    .bind(email, now - LINK_TTL).first();
  const perIp = await env.DB.prepare('SELECT COUNT(*) AS n FROM sign_in_links WHERE ip_hash = ?1 AND created_at > ?2')
    .bind(ipHash, now - 3600_000).first();
  if ((perEmail?.n || 0) >= LINKS_PER_EMAIL || (perIp?.n || 0) >= LINKS_PER_IP) {
    return json({ error: 'Too many sign-in links were asked for. Please wait a few minutes, then try again.' }, 429);
  }
  return sendSignInLink(env, url, email, typeof b.next === 'string' ? b.next : '', ipHash, dev);
}

/** Makes a one-time sign-in link and emails it (or, in local development, returns it). Also used by the admin view. */
export async function sendSignInLink(env, url, email, nextPath = '', ipHash = null, dev = env.DEV_SHOW_LINKS === '1') {
  const now = Date.now();
  const token = randomToken();
  await env.DB.prepare('INSERT INTO sign_in_links (token_hash, email, created_at, expires_at, ip_hash) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(await sha256hex(token), email, now, now + LINK_TTL, ipHash).run();
  // Where to go after signing in (e.g. /link/?c=… when linking a TV): a path on this site only.
  const next = /^\/(?!\/)[\w\-\/?=&.%]*$/.test(nextPath) ? nextPath : '';
  const link = `${url.origin}/signin/#t=${token}` + (next ? `&next=${encodeURIComponent(next)}` : '');

  if (mailConfigured(env)) {
    const text = `Here's your link to sign in to Avid Viewer:\n\n${link}\n\nIt works once, for 15 minutes. If you didn't ask for it, you can ignore this email: nobody can sign in without the link.\n`;
    const html = `<p>Here's your link to sign in to Avid Viewer:</p><p><a href="${link}">Sign in to Avid Viewer</a></p>`
      + '<p>It works once, for 15 minutes. If you didn\'t ask for it, you can ignore this email: nobody can sign in without the link.</p>';
    try {
      await sendMail(env, { to: email, subject: 'Your Avid Viewer sign-in link', text, html });
    } catch (e) {
      console.error('sign-in mail failed', e);
      return json({ error: "We couldn't send the email just now. Please try again in a few minutes." }, 502);
    }
    return json({ message: `Check ${email} for a sign-in link. It works for 15 minutes.` });
  }
  // Local development only: show the link instead of emailing it.
  return json({ message: 'Development: no mail provider, so here is the link.', devLink: link });
}

async function verifyLink(request, env) {
  const b = await body(request);
  const token = String(b?.token || '');
  if (!token) return json({ error: 'This sign-in link is incomplete. Please ask for a new one.' }, 400);
  const hash = await sha256hex(token);
  const now = Date.now();
  const row = await env.DB.prepare('SELECT email, expires_at, used_at FROM sign_in_links WHERE token_hash = ?1').bind(hash).first();
  if (!row || row.used_at || row.expires_at < now) {
    return json({ error: 'This sign-in link has expired or was already used. Please ask for a new one.' }, 400);
  }
  const used = await env.DB.prepare('UPDATE sign_in_links SET used_at = ?1 WHERE token_hash = ?2 AND used_at IS NULL').bind(now, hash).run();
  if (!used.meta?.changes) return json({ error: 'This sign-in link was already used. Please ask for a new one.' }, 400);
  const u = await userForEmail(env, row.email);
  if (u.status !== 'active') return json({ error: 'This account is suspended. Contact support@avidviewer.app.' }, 403);
  const cookie = await startSession(request, env, u.id);
  return json({ ok: true, newAccount: u.created }, 200, { 'set-cookie': cookie });
}

// ---------------------------------------------------------------- passkeys

function rp(url) { return { rpID: url.hostname, origin: url.origin }; }

async function saveChallenge(env, challenge, kind, userId = null) {
  const id = randomToken(16);
  const now = Date.now();
  await env.DB.prepare('DELETE FROM webauthn_challenges WHERE expires_at < ?1').bind(now).run();
  await env.DB.prepare('INSERT INTO webauthn_challenges (id, user_id, challenge, kind, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(id, userId, challenge, kind, now + CHALLENGE_TTL).run();
  return id;
}

async function takeChallenge(env, id, kind) {
  const row = await env.DB.prepare('SELECT user_id, challenge, kind, expires_at FROM webauthn_challenges WHERE id = ?1').bind(String(id || '')).first();
  if (row) await env.DB.prepare('DELETE FROM webauthn_challenges WHERE id = ?1').bind(id).run();
  if (!row || row.kind !== kind || row.expires_at < Date.now()) return null;
  return row;
}

async function passkeyRegisterOptions(env, url, user) {
  const existing = await env.DB.prepare('SELECT id, transports FROM passkeys WHERE user_id = ?1').bind(user.id).all();
  const options = await generateRegistrationOptions({
    rpName: 'Avid Viewer',
    rpID: rp(url).rpID,
    userName: user.email,
    userID: new TextEncoder().encode(user.id),
    attestationType: 'none',
    excludeCredentials: existing.results.map((p) => ({ id: p.id, transports: p.transports ? JSON.parse(p.transports) : undefined })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    // PRF: lets this passkey unlock the logins vault (Playlists › Set up with passkey).
    extensions: { prf: {} },
  });
  return json({ challengeId: await saveChallenge(env, options.challenge, 'register', user.id), options });
}

async function passkeyRegisterVerify(request, env, url, user) {
  const b = await body(request);
  const ch = await takeChallenge(env, b?.challengeId, 'register');
  if (!ch || ch.user_id !== user.id) return json({ error: 'That took too long. Please try again.' }, 400);
  let v;
  try {
    v = await verifyRegistrationResponse({
      response: b.response, expectedChallenge: ch.challenge, expectedOrigin: rp(url).origin, expectedRPID: rp(url).rpID,
      requireUserVerification: false,
    });
  } catch (e) {
    return json({ error: "That passkey couldn't be checked. Please try again." }, 400);
  }
  if (!v.verified || !v.registrationInfo) return json({ error: "That passkey couldn't be checked. Please try again." }, 400);
  const c = v.registrationInfo.credential;
  const name = String(b.name || '').trim().slice(0, 60) || labelFor(request.headers.get('user-agent') || '');
  await env.DB.prepare('INSERT INTO passkeys (id, user_id, public_key, counter, transports, name, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
    .bind(c.id, user.id, isoBase64URL.fromBuffer(c.publicKey), c.counter || 0, JSON.stringify(c.transports || []), name, Date.now()).run();
  return json({ ok: true });
}

async function passkeyLoginOptions(env, url) {
  const options = await generateAuthenticationOptions({ rpID: rp(url).rpID, userVerification: 'preferred' });
  return json({ challengeId: await saveChallenge(env, options.challenge, 'login'), options });
}

async function passkeyLoginVerify(request, env, url) {
  const b = await body(request);
  const ch = await takeChallenge(env, b?.challengeId, 'login');
  if (!ch) return json({ error: 'That took too long. Please try again.' }, 400);
  const id = String(b?.response?.id || '');
  const pk = await env.DB.prepare(
    'SELECT p.id, p.public_key, p.counter, p.transports, p.user_id, u.status FROM passkeys p JOIN users u ON u.id = p.user_id WHERE p.id = ?1'
  ).bind(id).first();
  if (!pk) return json({ error: "That passkey isn't linked to an Avid Viewer account. Sign in with an email link, then add it on your Account page." }, 400);
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response: b.response, expectedChallenge: ch.challenge, expectedOrigin: rp(url).origin, expectedRPID: rp(url).rpID,
      credential: { id: pk.id, publicKey: isoBase64URL.toBuffer(pk.public_key), counter: pk.counter, transports: pk.transports ? JSON.parse(pk.transports) : undefined },
      requireUserVerification: false,
    });
  } catch (e) {
    return json({ error: "That passkey couldn't be checked. Please try again." }, 400);
  }
  if (!v.verified) return json({ error: "That passkey couldn't be checked. Please try again." }, 400);
  if (pk.status !== 'active') return json({ error: 'This account is suspended. Contact support@avidviewer.app.' }, 403);
  await env.DB.prepare('UPDATE passkeys SET counter = ?1, last_used = ?2 WHERE id = ?3').bind(v.authenticationInfo.newCounter, Date.now(), pk.id).run();
  const cookie = await startSession(request, env, pk.user_id, 'passkey');
  return json({ ok: true }, 200, { 'set-cookie': cookie });
}

// ---------------------------------------------------------------- account

async function me(env, user) {
  const passkeys = await env.DB.prepare('SELECT id, name, created_at, last_used FROM passkeys WHERE user_id = ?1 ORDER BY created_at').bind(user.id).all();
  const sessions = await env.DB.prepare('SELECT token_hash, label, created_at, last_seen FROM sessions WHERE user_id = ?1 AND expires_at > ?2 ORDER BY last_seen DESC')
    .bind(user.id, Date.now()).all();
  const vault = (await env.DB.prepare('SELECT credential_id FROM vault_keys WHERE user_id = ?1').bind(user.id).all()).results.map((r) => r.credential_id);
  const akey = await env.DB.prepare('SELECT 1 FROM account_keys WHERE user_id = ?1').bind(user.id).first();
  return json({
    email: user.email,
    createdAt: user.created_at,
    lockedLogins: Boolean(vault.length && akey),
    admin: user.role === 'admin',
    adminReady: user.role === 'admin' && user.session_method === 'passkey',
    watchHistory: Boolean(user.watch_history),
    devices: await devicesFor(env, user.id),
    deviceLimit: MAX_DEVICES,
    license: await licenseFor(env, user.id),
    troubleshooting: await accountTroubleshooting(env, user.id), // Nov 21: lines, last channel loads
    backups: await backupsFor(env, user.id),
    passkeys: passkeys.results.map((p) => ({ id: p.id, name: p.name, createdAt: p.created_at, lastUsed: p.last_used, unlocksLogins: vault.includes(p.id) })),
    sessions: sessions.results.map((s) => ({
      id: s.token_hash.slice(0, 16), label: s.label || 'A browser', createdAt: s.created_at, lastSeen: s.last_seen,
      current: s.token_hash === user.sessionHash,
    })),
  });
}

async function settings(request, env, user) {
  const b = await body(request);
  if (typeof b?.watchHistory !== 'boolean') return json({ error: 'Nothing to change.' }, 400);
  await env.DB.prepare('UPDATE users SET watch_history = ?1 WHERE id = ?2').bind(b.watchHistory ? 1 : 0, user.id).run();
  // Off: every TV keeps its own places, and what the account held is deleted (decision 15).
  if (!b.watchHistory) await clearAllHistory(env, user.id);
  return json({ ok: true });
}

async function endSessions(request, env, user) {
  const b = await body(request);
  if (b?.others) {
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1 AND token_hash != ?2').bind(user.id, user.sessionHash).run();
  } else {
    const id = String(b?.id || '');
    if (!/^[0-9a-f]{16}$/.test(id)) return json({ error: 'Not found.' }, 404);
    await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?1 AND substr(token_hash, 1, 16) = ?2").bind(user.id, id).run();
  }
  return json({ ok: true });
}

async function deleteAccount(request, env, user) {
  const b = await body(request);
  if (String(b?.confirm || '').trim().toLowerCase() !== user.email) {
    return json({ error: 'Type your email address exactly to confirm.' }, 400);
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(user.id),
    env.DB.prepare('DELETE FROM passkeys WHERE user_id = ?1').bind(user.id),
    env.DB.prepare('DELETE FROM webauthn_challenges WHERE user_id = ?1').bind(user.id),
    env.DB.prepare('DELETE FROM backups WHERE user_id = ?1').bind(user.id),
    env.DB.prepare('DELETE FROM playlist_targets WHERE user_id = ?1').bind(user.id),
    env.DB.prepare('DELETE FROM device_profiles WHERE user_id = ?1').bind(user.id),
    env.DB.prepare('DELETE FROM profile_playlists WHERE user_id = ?1').bind(user.id),
    env.DB.prepare('DELETE FROM profile_visibility WHERE user_id = ?1').bind(user.id),
    env.DB.prepare('DELETE FROM playlist_catalogs WHERE user_id = ?1').bind(user.id),
    env.DB.prepare('DELETE FROM profiles WHERE user_id = ?1').bind(user.id),
    env.DB.prepare('DELETE FROM vault_keys WHERE user_id = ?1').bind(user.id),
    env.DB.prepare('DELETE FROM account_keys WHERE user_id = ?1').bind(user.id),
    env.DB.prepare('DELETE FROM attention_dismissed WHERE user_id = ?1').bind(user.id),
    env.DB.prepare('DELETE FROM profile_lists WHERE user_id = ?1').bind(user.id),
    env.DB.prepare('DELETE FROM profile_history WHERE user_id = ?1').bind(user.id),
    env.DB.prepare('DELETE FROM profile_discover WHERE user_id = ?1').bind(user.id),
    env.DB.prepare('DELETE FROM account_secrets WHERE user_id = ?1').bind(user.id),
    env.DB.prepare('DELETE FROM device_history_keys WHERE user_id = ?1').bind(user.id),
    env.DB.prepare('DELETE FROM playlist_order WHERE user_id = ?1').bind(user.id),
    env.DB.prepare('DELETE FROM device_playlists WHERE user_id = ?1').bind(user.id),
    env.DB.prepare('DELETE FROM account_playlists WHERE user_id = ?1').bind(user.id),
    env.DB.prepare('DELETE FROM devices WHERE user_id = ?1').bind(user.id),
    env.DB.prepare('DELETE FROM licenses WHERE user_id = ?1').bind(user.id),
    env.DB.prepare('DELETE FROM reseller_lines WHERE user_id = ?1').bind(user.id),
    env.DB.prepare('DELETE FROM reseller_line_devices WHERE user_id = ?1').bind(user.id),
    env.DB.prepare('DELETE FROM reseller_renewals WHERE user_id = ?1').bind(user.id),
    env.DB.prepare('DELETE FROM device_load_status WHERE user_id = ?1').bind(user.id),
    env.DB.prepare('DELETE FROM link_codes WHERE user_id = ?1').bind(user.id),
    env.DB.prepare('DELETE FROM sign_in_links WHERE email = ?1').bind(user.email),
    // Reports stay for the bug history, no longer tied to the account (reports.js).
    env.DB.prepare('UPDATE reports SET user_id = NULL, device_id = NULL WHERE user_id = ?1').bind(user.id),
    env.DB.prepare('DELETE FROM report_notes WHERE user_id = ?1').bind(user.id),
    env.DB.prepare('DELETE FROM users WHERE id = ?1').bind(user.id),
  ]);
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
}

// ---------------------------------------------------------------- router

/** Handles /api/auth/*, /api/me, /api/account/*, /api/passkeys/*; returns null for other paths. */
export async function handleAccountApi(request, env, realUrl) {
  // Local development (wrangler dev) sees requests as http://avidviewer.app; SITE_ORIGIN in .dev.vars gives the
  // address the browser really uses, for links, the Origin check and passkeys. Unset in production.
  const url = env.SITE_ORIGIN ? new URL(realUrl.pathname + realUrl.search, env.SITE_ORIGIN) : realUrl;
  const p = url.pathname;
  if (!(p.startsWith('/api/auth/') || p === '/api/me' || p.startsWith('/api/account/') || p.startsWith('/api/passkeys/') || p.startsWith('/api/link/') || p.startsWith('/api/admin/'))) return null;

  if (request.method === 'POST') {
    // Only this site's own pages may post here (with SameSite=Lax cookies, this stops cross-site form posts).
    // (wrangler dev rewrites the Origin header to the real site's address, so that one is accepted locally too.)
    const origin = request.headers.get('origin');
    if (origin !== url.origin && origin !== realUrl.origin) return json({ error: 'Not allowed.' }, 403);
  } else if (!(request.method === 'GET' && (p === '/api/me' || p === '/api/account/manage' || p === '/api/account/catalog' || p === '/api/account/playlists/vault' || p === '/api/account/device-logins' || p === '/api/account/attention' || p === '/api/account/lists' || p === '/api/account/order' || p === '/api/account/history' || p === '/api/account/history/devices' || p === '/api/account/profiles/visibility' || p === '/api/account/reports' || p === '/api/account/reports/item' || p.startsWith('/api/admin/')))) {
    return json({ error: 'Use POST.' }, 405);
  }

  switch (p) {
    case '/api/auth/email': return emailLink(request, env, url);
    case '/api/auth/verify': return verifyLink(request, env);
    case '/api/passkeys/login/options': return passkeyLoginOptions(env, url);
    case '/api/passkeys/login/verify': return passkeyLoginVerify(request, env, url);
  }

  const user = await currentUser(request, env);
  if (p === '/api/auth/signout') {
    if (user) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(user.sessionHash).run();
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
  }
  // The site header on every page: the account's name when signed in (the email's first part, owner's choice
  // Nov 19), never a 401, so signed-out visitors see no error.
  if (p === '/api/me' && url.searchParams.get('brief') === '1') {
    return json({ signedIn: Boolean(user), name: user ? String(user.email).split('@')[0] : null }, 200, { 'cache-control': 'no-store' });
  }
  if (!user) return json({ error: 'Please sign in.' }, 401);
  if (p.startsWith('/api/admin/')) return handleAdminApi(request, env, url, user);

  switch (p) {
    case '/api/me': return me(env, user);
    case '/api/account/manage': return request.method === 'GET' ? manage(env, user) : json({ error: 'Use GET.' }, 405);
    case '/api/account/catalog': return request.method === 'GET' ? catalogFor(env, user, url) : json({ error: 'Use GET.' }, 405);
    case '/api/account/playlists/save': return playlistsSave(request, env, user);
    case '/api/account/playlists/vault': return request.method === 'GET' ? playlistVault(env, user, url) : json({ error: 'Use GET.' }, 405);
    case '/api/account/playlists/seal': return playlistsSeal(request, env, user);
    case '/api/account/profiles/save': return profileSave(request, env, user);
    case '/api/account/profiles/remove': return profileRemove(request, env, user);
    case '/api/account/profiles/pin': return profilePin(request, env, user);
    case '/api/account/profiles/visibility': return profileVisibility(request, env, user);
    case '/api/account/devices/profiles': return deviceSetProfiles(request, env, user);
    case '/api/account/devices/stop': return deviceStop(request, env, user);
    case '/api/account/vault/key': return vaultKey(request, env, user);
    case '/api/account/vault/account-key': return accountKeySave(request, env, user);
    case '/api/account/device-logins': return request.method === 'GET' ? deviceLogins(env, user) : json({ error: 'Use GET.' }, 405);
    case '/api/account/attention': return request.method === 'GET' ? attention(env, user) : json({ error: 'Use GET.' }, 405);
    case '/api/account/lists': return request.method === 'GET' ? listsGet(env, user, url) : listsSave(request, env, user);
    case '/api/account/order': return request.method === 'GET' ? orderGet(env, user, url) : orderSave(request, env, user);
    case '/api/account/history': return historyGet(env, user, url);
    case '/api/account/history/put': return historyPut(request, env, user);
    case '/api/account/history/key': return historyKeySave(request, env, user);
    case '/api/account/history/devices': return historyDevices(env, user);
    case '/api/account/history/seal': return historySeal(request, env, user);
    case '/api/account/profiles/history': return profileHistory(request, env, user);
    case '/api/account/discover': return discoverSave(request, env, user);
    case '/api/account/tmdb': return tmdbSave(request, env, user);
    case '/api/account/attention/dismiss': return attentionDismiss(request, env, user);
    case '/api/account/playlists/retry': return playlistsRetry(request, env, user);
    case '/api/account/playlists/import': return playlistsImport(request, env, user);
    case '/api/account/playlists/adopt': return playlistsAdopt(request, env, user);
    case '/api/account/playlists/remove': return playlistsRemove(request, env, user);
    case '/api/account/settings': return settings(request, env, user);
    case '/api/account/sessions/end': return endSessions(request, env, user);
    case '/api/account/delete': return deleteAccount(request, env, user);
    case '/api/account/devices/rename': return deviceRename(request, env, user);
    case '/api/account/devices/remove': return deviceRemove(request, env, user);
    case '/api/account/devices/request': return request.method === 'POST' ? accountRequest(request, env, user) : json({ error: 'Use POST.' }, 405);
    case '/api/account/devices/beta': return deviceBeta(request, env, user);
    case '/api/account/reports': return accountReports(env, user);
    case '/api/account/reports/item': return accountReport(env, user, url);
    case '/api/account/reports/note': return accountReportNote(request, env, user, false);
    case '/api/account/reports/still': return accountReportNote(request, env, user, true);
    case '/api/account/backups/delete': return backupDelete(request, env, user);
    case '/api/account/backups/pin': return backupPin(request, env, user);
    case '/api/link/lookup': return linkLookup(request, env);
    case '/api/link/approve': return linkApprove(request, env, user);
    case '/api/link/setup-token': return linkSetupToken(env, user);
    case '/api/passkeys/register/options': return passkeyRegisterOptions(env, url, user);
    case '/api/passkeys/register/verify': return passkeyRegisterVerify(request, env, url, user);
    case '/api/passkeys/delete': {
      const b = await body(request);
      await env.DB.prepare('DELETE FROM passkeys WHERE id = ?1 AND user_id = ?2').bind(String(b?.id || ''), user.id).run();
      return json({ ok: true });
    }
  }
  return json({ error: 'Not found.' }, 404);
}
