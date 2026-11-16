// avidviewer.app: serves the static site and the small /api it needs.
import { handleAccountApi } from './auth.js';
import { handleTvApi } from './devices.js';

// Phase 1: POST /api/notify stores a launch-news sign-up in D1.
// Setup codes (Nov 15): POST /api/setup stores an encrypted setup for 30 minutes; GET /api/setup/<id> hands it to a TV.

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function notify(request, env) {
  const type = request.headers.get('content-type') || '';
  const isJson = type.includes('application/json');
  let email = '';
  let trap = '';
  try {
    if (isJson) {
      const b = await request.json();
      email = String(b.email || '');
      trap = String(b.website || '');
    } else {
      const f = await request.formData();
      email = String(f.get('email') || '');
      trap = String(f.get('website') || '');
    }
  } catch {
    return json({ error: "That didn't come through. Please try again." }, 400);
  }

  const done = () => isJson
    ? json({ message: "You're on the list. We'll email you when accounts launch." })
    : Response.redirect(new URL('/?subscribed=1#notify', request.url).toString(), 303);

  // Bots fill the hidden field; pretend it worked.
  if (trap) return done();

  email = email.trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) {
    return isJson
      ? json({ error: 'Please enter a valid email address.' }, 400)
      : Response.redirect(new URL('/#notify', request.url).toString(), 303);
  }

  await env.DB.prepare(
    'INSERT OR IGNORE INTO signups (email, created_at, source, country) VALUES (?1, ?2, ?3, ?4)'
  ).bind(email, new Date().toISOString(), 'launch-news', request.cf?.country || null).run();

  return done();
}

// ---------------------------------------------------------------- setup codes
const SETUP_TTL = 30 * 60 * 1000;
const SETUP_MAX_DATA = 1_300_000;   // Base64 of ~950 KB: a backup file with room to spare
const SETUP_PER_HOUR = 20;          // codes one address can make in an hour
const SETUP_FETCHES = 5;            // a TV may retry a few times within the 30 minutes
const HEX64 = /^[0-9a-f]{64}$/;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

async function sha256hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function setupCreate(request, env) {
  let b;
  try { b = await request.json(); } catch { return json({ error: "That didn't come through. Please try again." }, 400); }
  if (b.website) return json({ expires: new Date(Date.now() + SETUP_TTL).toISOString() }); // bots
  const id = String(b.id || ''), data = String(b.data || '');
  if (!HEX64.test(id) || !data || data.length > SETUP_MAX_DATA || !B64.test(data)) {
    return json({ error: data.length > SETUP_MAX_DATA ? 'That is too big to send. A backup file should be well under 1 MB.' : 'That setup looks damaged. Please reload the page and try again.' }, 400);
  }
  const now = Date.now();
  await env.DB.prepare('DELETE FROM setup_codes WHERE expires_at < ?1').bind(now).run();
  const ipHash = await sha256hex((request.headers.get('cf-connecting-ip') || '') + new Date(now).toISOString().slice(0, 10));
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM setup_codes WHERE ip_hash = ?1 AND created_at > ?2')
    .bind(ipHash, new Date(now - 3600_000).toISOString()).first();
  if ((recent?.n || 0) >= SETUP_PER_HOUR) return json({ error: 'Too many codes from here in the last hour. Please try again later.' }, 429);
  const expires = now + SETUP_TTL;
  await env.DB.prepare('INSERT OR REPLACE INTO setup_codes (id, data, created_at, expires_at, fetches, ip_hash) VALUES (?1, ?2, ?3, ?4, 0, ?5)')
    .bind(id, data, new Date(now).toISOString(), expires, ipHash).run();
  return json({ expires: new Date(expires).toISOString() });
}

async function setupFetch(id, env) {
  if (!HEX64.test(id)) return json({ error: 'Not found.' }, 404);
  const now = Date.now();
  const row = await env.DB.prepare('SELECT data, fetches FROM setup_codes WHERE id = ?1 AND expires_at >= ?2').bind(id, now).first();
  if (!row || row.fetches >= SETUP_FETCHES) return json({ error: 'Not found.' }, 404);
  await env.DB.prepare('UPDATE setup_codes SET fetches = fetches + 1 WHERE id = ?1').bind(id).run();
  return json({ data: row.data });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.hostname === 'www.avidviewer.app') {
      url.hostname = 'avidviewer.app';
      return Response.redirect(url.toString(), 301);
    }

    // The What's new page was taken off the site (Nov 15, 2026): old links go to the user guide.
    if (url.pathname === '/releases' || url.pathname.startsWith('/releases/')) {
      return Response.redirect(new URL('/guide/', url).toString(), 302);
    }

    if (url.pathname.startsWith('/api/')) {
      // Accounts (sign-in, Account page, passkeys): see auth.js.
      try {
        const r = (await handleTvApi(request, env, url)) || (await handleAccountApi(request, env, url));
        if (r) return r;
      } catch (e) {
        console.error('account api failed', e);
        return json({ error: 'Something went wrong on our side. Please try again later.' }, 500);
      }
      if (url.pathname === '/api/notify') {
        if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
        try {
          return await notify(request, env);
        } catch (e) {
          console.error('notify failed', e);
          return json({ error: 'Something went wrong on our side. Please try again later.' }, 500);
        }
      }
      if (url.pathname === '/api/setup' || url.pathname.startsWith('/api/setup/')) {
        try {
          if (url.pathname === '/api/setup') {
            if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
            return await setupCreate(request, env);
          }
          if (request.method !== 'GET') return json({ error: 'Use GET.' }, 405);
          return await setupFetch(url.pathname.slice('/api/setup/'.length), env);
        } catch (e) {
          console.error('setup failed', e);
          return json({ error: 'Something went wrong on our side. Please try again later.' }, 500);
        }
      }
      return json({ error: 'Not found.' }, 404);
    }

    return env.ASSETS.fetch(request);
  },
};
