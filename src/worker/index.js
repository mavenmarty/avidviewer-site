// avidviewer.app: serves the static site and the small /api it needs.
// Phase 1: POST /api/notify stores a launch-news sign-up in D1.

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

    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/notify') {
        if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
        try {
          return await notify(request, env);
        } catch (e) {
          console.error('notify failed', e);
          return json({ error: 'Something went wrong on our side. Please try again later.' }, 500);
        }
      }
      return json({ error: 'Not found.' }, 404);
    }

    return env.ASSETS.fetch(request);
  },
};
