// avidviewer.app: serves the static site and the small /api it needs.
import { handleAccountApi } from './auth.js';
import { handleTvApi } from './devices.js';
import { githubWebhook } from './reports.js';

// Phase 1: POST /api/notify stores a launch-news sign-up in D1.
// Setup codes (Nov 15–16, 2026) are retired: /api/setup answers 410 and /setup/ goes to /playlists/.

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


export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.hostname === 'www.avidviewer.app') {
      url.hostname = 'avidviewer.app';
      return Response.redirect(url.toString(), 301);
    }

    // The setup page was retired with setup codes (Nov 16, 2026): playlists are sent to linked devices instead.
    if (url.pathname === '/setup' || url.pathname.startsWith('/setup/')) {
      return Response.redirect(new URL('/playlists/', url).toString(), 302);
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
      // GitHub tells the site when an issue changes (reports.js), signed with GITHUB_WEBHOOK_SECRET.
      if (url.pathname === '/api/github/webhook' && request.method === 'POST') {
        try { return await githubWebhook(request, env); } catch (e) { console.error('webhook failed', e); return json({ error: 'Failed.' }, 500); }
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
      // Setup codes were retired on Nov 16, 2026 (playlists now go to linked devices from /playlists/).
      if (url.pathname === '/api/setup' || url.pathname.startsWith('/api/setup/')) {
        return json({ error: 'Setup codes have been replaced: link the device to your account with the code on its screen, then add playlists at avidviewer.app/playlists.' }, 410);
      }
      return json({ error: 'Not found.' }, 404);
    }

    return env.ASSETS.fetch(request);
  },
};
