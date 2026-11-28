// Reports and bug status (Nov 20, 2026; design canvas boards 37–41, note q24).
//
//   Device   POST /api/tv/reports        {app, kind, version, device, summary, crash}  crash report, playback log or
//                                        security alert. Linked or not (a device that isn't linked is limited per
//                                        network and is told so). Answers {ok, id, linked}.
//            POST /api/tv/reports/claim  {ids}   after linking, the reports this device sent before.
//            (the email relay forwards what older versions send here too, with its own report id)
//   Account  GET  /api/account/reports          the account's devices' reports (fixed ones for 30 days after the fix)
//            GET  /api/account/reports/item?id=
//            POST /api/account/reports/note     {id, text}
//            POST /api/account/reports/still    {id, text?}   "It's still happening": back in the queue, and the
//                                                device sends a new playback log next time it checks in
//   Admin    GET  /api/admin/reports            the queue (new, added by themselves today) and the bugs
//            GET  /api/admin/reports/item?id=
//            POST /api/admin/reports/triage     {id, action: add|file|not_app|need_info|ignore|undo|reopen, bugs?, title?}
//            POST /api/admin/bugs/note          {number, note}   what the account's Reports page says about a bug
//            POST /api/admin/bugs/sync          read GitHub now
//   GitHub   POST /api/github/webhook           issues and comments (signed with GITHUB_WEBHOOK_SECRET)
//
// Bugs are the public repo's GitHub issues, read every few minutes (and at once through the webhook). An issue that
// quotes a report id (AVR-1a2b3c4d) is linked to that report. Its status: open = being fixed; label "needs-info";
// label "fixed-in:1.21.1" (or the milestone) = fixed in that version, also while it stays open to check the fix;
// closed as completed = fixed; closed as not planned = closed. No emails are sent about reports (owner, Nov 20).
//
// Matching: each report gets match keys (signaturesOf). When the admin adds a report to a bug, its keys are learned
// (bug_signatures); a later report whose app keys are all learned for open bugs is added to them by itself.

import { json, body, randomToken, sha256hex, ipOf } from './auth.js';

const REPO = 'mavenmarty/avid-viewer';
const DAY = 24 * 3600 * 1000;
const KEEP_FIXED = 30 * DAY;
const UNLINKED_PER_HOUR = 20;
const KINDS = new Set(['crash', 'playback', 'security', 'problem']);

function clip(v, n) { return typeof v === 'string' ? v.slice(0, n) : ''; }
function parse(s, d) { try { return JSON.parse(s); } catch { return d; } }

// ---------------------------------------------------------------- match keys

/** Version "1.21.1" → comparable number. */
export function vnum(v) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? (+m[1]) * 1e6 + (+m[2]) * 1e3 + (+m[3]) : -1;
}

/**
 * Match keys for a report. "app" keys point at something in the app; "provider" keys at the provider or network.
 *   crash:    exit|blocked|<screen> · exit|not-responding|<screen> · exit|memory|<screen> · exit|no-reason|<screen>
 *             · exit|system-other · exit|native · crash|<Exception>|<first app frame>
 *   playback: playback|picture-stops · playback|decoder-behind · playback|decoding-failed · playback|zero-freezes
 *             · provider|refused · provider|not-found · provider|paused
 */
export function signaturesOf(kind, text) {
  const t = String(text || '');
  const out = [];
  if (kind === 'crash') {
    if (/closed while in use/i.test(t)) {
      const screens = [...t.matchAll(/Screen: ([A-Za-z][\w &-]*)/g)].map((m) => m[1].trim());
      const last = screens.length ? screens[screens.length - 1] : 'unknown';
      const blocked = [...t.matchAll(/Main thread blocked \d+ s on ([A-Za-z][\w &-]*)/g)].map((m) => m[1].trim());
      const likely = (/Likely: ([^\n]*)/.exec(t) || [])[1] || '';
      if (blocked.length) out.push('exit|blocked|' + blocked[blocked.length - 1]);
      else if (/stopped responding|not responding|ANR/i.test(likely)) out.push('exit|not-responding|' + last);
      else if (/low memory|out of memory/i.test(likely)) out.push('exit|memory|' + last);
      else if (/native/i.test(likely)) out.push('exit|native');
      else if (/without saying why|reason 13/i.test(likely)) out.push('exit|system-other');
      else if (/doesn't say why|free memory/i.test(likely)) out.push('exit|no-reason|' + last);
      else out.push('exit|other|' + last);
    } else {
      const ex = /(?:Error: )?(?:[\w$]+\.)*([A-Z][\w$]*(?:Exception|Error))\b/.exec(t);
      const frame = /\bat (com\.avidviewer\.[\w$.]+)\(/.exec(t) || /\bat ([\w$.]+)\(/.exec(t);
      if (ex) out.push('crash|' + ex[1] + '|' + (frame ? frame[1].replace(/\$\d+/g, '') : '?'));
    }
  } else if (kind === 'playback') {
    const count = (re) => (t.match(re) || []).length;
    if (count(/\bPICTURE\b[^\n]*Picture stopped/g) >= 2) out.push('playback|picture-stops');
    const fullBuffer = [...t.matchAll(/\((\d+) s was buffered, no download errors/g)].filter((m) => +m[1] >= 20).length;
    if (/decoder fell behind/.test(t) || fullBuffer >= 3) out.push('playback|decoder-behind');
    if (/ERROR_CODE_DECOD(ING_FAILED|ER_INIT_FAILED)/.test(t)) out.push('playback|decoding-failed');
    if (count(/Froze 0 s/g) >= 20) out.push('playback|zero-freezes');
    if (/provider answered HTTP 4\d\d|ERROR_CODE_IO_BAD_HTTP_STATUS/.test(t)) out.push('provider|refused');
    if (/server not found|Can't find the provider's server|UnknownHost/i.test(t)) out.push('provider|not-found');
    if (/data stopped arriving/i.test(t)) out.push('provider|paused');
  }
  return out;
}

const appKeys = (sigs) => sigs.filter((s) => !s.startsWith('provider|'));

// ---------------------------------------------------------------- bugs from GitHub

export function issueStatus(i) {
  const labels = (i.labels || []).map((l) => (typeof l === 'string' ? l : l.name) || '');
  const fixedLabel = labels.map((l) => /^fixed-in:\s*v?(\d+\.\d+\.\d+)$/i.exec(l)).find(Boolean);
  const fixedIn = fixedLabel ? fixedLabel[1] : (i.milestone && /^v?\d+\.\d+\.\d+$/.test(i.milestone.title) ? i.milestone.title.replace(/^v/, '') : null);
  if (i.state === 'closed') return { status: i.state_reason === 'not_planned' ? 'closed' : 'fixed', fixedIn };
  if (fixedIn) return { status: 'fixed', fixedIn };
  if (labels.some((l) => /^needs?-info$/i.test(l))) return { status: 'need_info', fixedIn: null };
  return { status: 'open', fixedIn: null };
}

async function state(env, key) { return (await env.DB.prepare('SELECT value FROM site_state WHERE key = ?1').bind(key).first())?.value || null; }
async function setState(env, key, value) {
  await env.DB.prepare('INSERT INTO site_state (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2').bind(key, String(value)).run();
}

function gh(env, path, init = {}) {
  const headers = { 'User-Agent': 'avidviewer.app', 'Accept': 'application/vnd.github+json', ...(init.headers || {}) };
  if (env.GITHUB_TOKEN) headers.Authorization = 'Bearer ' + env.GITHUB_TOKEN;
  return fetch('https://api.github.com/repos/' + REPO + path, { ...init, headers });
}

/** Links every report id quoted in [text] to bug [n] (a person filed or commented it on GitHub). */
async function linkQuoted(env, n, text, now) {
  const ids = [...new Set(String(text || '').match(/AVR-[0-9a-f]{8}/g) || [])];
  for (const id of ids) {
    const r = await env.DB.prepare('SELECT id, state FROM reports WHERE id = ?1').bind(id).first();
    if (!r) continue;
    await env.DB.batch([
      env.DB.prepare('INSERT OR IGNORE INTO report_bugs (report_id, bug, auto, added_at) VALUES (?1, ?2, 0, ?3)').bind(id, n, now),
      env.DB.prepare("UPDATE reports SET state = 'triaged', triaged_at = COALESCE(triaged_at, ?2), updated_at = ?2 WHERE id = ?1 AND state IN ('new', 'need_info')").bind(id, now),
    ]);
  }
}

/**
 * Reads the repo's issues (newest changes first) into bugs, at most every 5 minutes unless [force]. Unauthenticated
 * reads of a public repo are enough; GITHUB_TOKEN, when set, raises GitHub's limit.
 */
export async function syncBugs(env, force = false) {
  const now = Date.now();
  const last = Number(await state(env, 'bugs_synced_at') || 0);
  if (!force && now - last < 5 * 60 * 1000) return { skipped: true };
  await setState(env, 'bugs_synced_at', now);
  const etag = force ? null : await state(env, 'bugs_etag');
  let r;
  try { r = await gh(env, '/issues?state=all&per_page=100&sort=updated&direction=desc', { headers: etag ? { 'If-None-Match': etag } : {} }); }
  catch (e) { return { error: String(e) }; }
  if (r.status === 304) return { unchanged: true };
  if (!r.ok) return { error: 'GitHub answered ' + r.status };
  if (r.headers.get('etag')) await setState(env, 'bugs_etag', r.headers.get('etag'));
  const since = Number(await state(env, 'bugs_comments_at') || 0);
  let commentReads = 0;
  for (const i of await r.json()) {
    if (i.pull_request) continue;
    const { status, fixedIn } = issueStatus(i);
    const old = await env.DB.prepare('SELECT status, fixed_at FROM bugs WHERE number = ?1').bind(i.number).first();
    const fixedAt = status === 'fixed' ? (old?.status === 'fixed' && old.fixed_at ? old.fixed_at : (i.closed_at ? Date.parse(i.closed_at) : now)) : null;
    await env.DB.prepare(`INSERT INTO bugs (number, title, state, status, fixed_in, fixed_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      ON CONFLICT(number) DO UPDATE SET title = ?2, state = ?3, status = ?4, fixed_in = ?5, fixed_at = ?6, updated_at = ?7`)
      .bind(i.number, clip(i.title, 200), i.state, status, fixedIn, fixedAt, Date.parse(i.updated_at) || now).run();
    await linkQuoted(env, i.number, i.body, now);
    // Report ids quoted in newer comments (e.g. "earlier reports of the same hang: AVR-…"), a few issues per read.
    if (i.comments > 0 && Date.parse(i.updated_at) > since && commentReads < 10) {
      commentReads++;
      try {
        const c = await gh(env, `/issues/${i.number}/comments?per_page=100`);
        if (c.ok) for (const x of await c.json()) await linkQuoted(env, i.number, x.body, now);
      } catch { /* next time */ }
    }
  }
  await setState(env, 'bugs_comments_at', now);
  return { ok: true };
}

async function verifyWebhook(request, env, raw) {
  const sig = request.headers.get('x-hub-signature-256') || '';
  if (!env.GITHUB_WEBHOOK_SECRET || !sig.startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.GITHUB_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
  const want = sig.slice(7);
  if (hex.length !== want.length) return false;
  let diff = 0;
  for (let k = 0; k < hex.length; k++) diff |= hex.charCodeAt(k) ^ want.charCodeAt(k);
  return diff === 0;
}

export async function githubWebhook(request, env) {
  const raw = await request.text();
  if (!(await verifyWebhook(request, env, raw))) return json({ error: 'Not allowed.' }, 401);
  const ev = request.headers.get('x-github-event') || '';
  if (ev === 'ping') return json({ ok: true });
  if (ev === 'issues' || ev === 'issue_comment') await syncBugs(env, true);
  return json({ ok: true });
}

// ---------------------------------------------------------------- matching

/** Adds [id] to the open bugs its app keys were learned for, when every app key has one. Returns the bugs. */
async function autoMatch(env, id, sigs) {
  const keys = appKeys(sigs);
  if (!keys.length) return [];
  const bugs = new Set();
  for (const k of keys) {
    const row = await env.DB.prepare(`SELECT s.bug FROM bug_signatures s LEFT JOIN bugs b ON b.number = s.bug
      WHERE s.signature = ?1 AND (b.number IS NULL OR b.state = 'open')`).bind(k).first();
    if (!row) return [];
    bugs.add(row.bug);
  }
  const now = Date.now();
  await env.DB.batch([
    ...[...bugs].map((n) => env.DB.prepare('INSERT OR IGNORE INTO report_bugs (report_id, bug, auto, added_at) VALUES (?1, ?2, 1, ?3)').bind(id, n, now)),
    env.DB.prepare("UPDATE reports SET state = 'triaged', triaged_at = ?2, updated_at = ?2 WHERE id = ?1").bind(id, now),
  ]);
  return [...bugs];
}

/** For the queue: bugs whose learned keys match some of the report's keys. */
async function suggestions(env, sigs) {
  const out = [];
  for (const k of appKeys(sigs)) {
    const row = await env.DB.prepare('SELECT s.bug, b.title, b.status FROM bug_signatures s LEFT JOIN bugs b ON b.number = s.bug WHERE s.signature = ?1').bind(k).first();
    if (row && !out.some((x) => x.bug === row.bug)) out.push({ bug: row.bug, title: row.title || '', status: row.status || 'open', key: k });
  }
  return out;
}

// ---------------------------------------------------------------- device side

export async function tvReport(request, env, device) {
  const raw = await request.text();
  if (raw.length > 40_000) return json({ error: 'Too big.' }, 413);
  const b = parse(raw, null);
  if (!b || b.app !== 'avid-viewer') return json({ error: 'Unknown sender.' }, 400);
  const kind = KINDS.has(b.kind) ? b.kind : 'crash';
  const text = clip(b.crash, 16_500);
  const version = clip(b.version, 40);
  if (!text || !version) return json({ error: 'Missing fields.' }, 400);
  const now = Date.now();
  const relay = Boolean(b.relay) && /^AVR-[0-9a-f]{8}$/.test(String(b.id || ''));
  const ipHash = await sha256hex(ipOf(request) + new Date(now).toISOString().slice(0, 10));
  if (!device) {
    const n = (await env.DB.prepare('SELECT COUNT(*) AS n FROM reports WHERE device_id IS NULL AND ip_hash = ?1 AND created_at > ?2').bind(ipHash, now - 3600_000).first())?.n || 0;
    if (n >= (relay ? 200 : UNLINKED_PER_HOUR)) return json({ error: 'Too many reports. Try again in an hour.' }, 429);
  }
  const id = relay ? String(b.id) : 'AVR-' + [...crypto.getRandomValues(new Uint8Array(4))].map((x) => x.toString(16).padStart(2, '0')).join('');
  if (relay && await env.DB.prepare('SELECT 1 FROM reports WHERE id = ?1').bind(id).first()) return json({ ok: true, id, linked: Boolean(device) });
  const sigs = signaturesOf(kind, text);
  await env.DB.prepare(`INSERT INTO reports (id, kind, device_id, user_id, app_version, device_info, summary, body, signatures, state, source, ip_hash, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'new', ?10, ?11, ?12, ?12)`)
    .bind(id, kind, device?.id || null, device?.user_id || null, version, clip(b.device, 200), clip(b.summary, 300), text, JSON.stringify(sigs), relay ? 'relay' : 'app', ipHash, now).run();
  if (kind !== 'security') await autoMatch(env, id, sigs);
  if (device && kind === 'playback') await env.DB.prepare('UPDATE devices SET want_log = 0 WHERE id = ?1').bind(device.id).run();
  return json({ ok: true, id, linked: Boolean(device) });
}

export async function tvClaim(request, env, device) {
  if (!device) return json({ error: 'This device is not linked.' }, 401);
  const b = await body(request);
  const ids = (Array.isArray(b?.ids) ? b.ids : []).map(String).filter((x) => /^AVR-[0-9a-f]{8}$/.test(x)).slice(0, 100);
  for (const id of ids) {
    await env.DB.prepare('UPDATE reports SET device_id = ?2, user_id = ?3, updated_at = ?4 WHERE id = ?1 AND device_id IS NULL').bind(id, device.id, device.user_id, Date.now()).run();
  }
  return json({ ok: true, claimed: ids.length });
}

// ---------------------------------------------------------------- what the account sees

async function bugsFor(env, ids) {
  if (!ids.length) return new Map();
  const rows = (await env.DB.prepare(`SELECT rb.report_id, rb.bug, rb.added_at, b.number, b.title, b.state, b.status, b.fixed_in, b.fixed_at, b.public_note
    FROM report_bugs rb LEFT JOIN bugs b ON b.number = rb.bug WHERE rb.report_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all()).results;
  const m = new Map();
  for (const r of rows) { if (!m.has(r.report_id)) m.set(r.report_id, []); m.get(r.report_id).push(r); }
  return m;
}

/** What the account's Reports page says about a report: {key, label, fixedIn, fixedAt} (null: not shown). */
export function userStatus(rep, bugs) {
  if (rep.kind === 'security' || rep.state === 'ignored') return null;
  if (rep.state === 'not_app') return { key: 'not_app', label: 'Not an app problem' };
  const linked = bugs || [];
  if (rep.state === 'need_info') return { key: 'need_info', label: 'We need more details' };
  if (linked.length) {
    if (rep.reopened_at && rep.state === 'new') return { key: 'looking', label: 'Looking into it' };
    const known = linked.filter((b) => b.status);
    if (known.length && known.every((b) => b.status === 'fixed')) {
      const v = known.map((b) => b.fixed_in).filter(Boolean).sort((a, c) => vnum(c) - vnum(a))[0] || null;
      const at = Math.max(...known.map((b) => b.fixed_at || 0)) || null;
      return { key: 'fixed', label: v ? 'Fixed in ' + v : 'Fixed', fixedIn: v, fixedAt: at };
    }
    if (known.some((b) => b.status === 'need_info')) return { key: 'need_info', label: 'We need more details' };
    if (known.length && known.every((b) => b.status === 'closed')) return { key: 'closed', label: 'Closed' };
    return { key: 'fixing', label: 'Being fixed' };
  }
  if (rep.state === 'triaged' || rep.reopened_at) return { key: 'looking', label: 'Looking into it' };
  return { key: 'received', label: 'Received' };
}

function shown(rep, st, now) {
  if (!st) return false;
  return !(st.key === 'fixed' && st.fixedAt && now - st.fixedAt > KEEP_FIXED);
}

function headline(rep) {
  const s = (rep.summary || '').replace(/^(Error: |Playback log:? ?)/, '').trim();
  if (rep.kind === 'playback') return s ? 'Playback log: ' + s : 'Playback log';
  if (rep.kind === 'problem') return s || 'A problem you reported';
  return s || 'Crash report';
}

export async function accountReports(env, user) {
  await syncBugs(env).catch(() => {});
  const now = Date.now();
  const reps = (await env.DB.prepare(`SELECT r.id, r.kind, r.device_id, r.app_version, r.summary, r.state, r.created_at, r.updated_at, r.reopened_at,
      d.name AS device_name, d.model AS device_model, d.app_version AS device_version
    FROM reports r LEFT JOIN devices d ON d.id = r.device_id WHERE r.user_id = ?1 ORDER BY r.created_at DESC LIMIT 300`).bind(user.id).all()).results;
  const bugs = await bugsFor(env, reps.map((r) => r.id));
  const out = [];
  for (const r of reps) {
    const b = bugs.get(r.id) || [];
    const st = userStatus(r, b);
    if (!shown(r, st, now)) continue;
    const update = st.key === 'fixed' && st.fixedIn && r.device_version && vnum(r.device_version) < vnum(st.fixedIn);
    out.push({ id: r.id, kind: r.kind, title: headline(r), status: st, bugs: b.map((x) => x.bug),
      device: { id: r.device_id, name: r.device_name || 'A removed device', model: r.device_model || '', version: r.device_version || '' },
      appVersion: r.app_version, sentAt: r.created_at, updatedAt: r.updated_at, updateTo: update ? st.fixedIn : null });
  }
  return json({ reports: out, keepFixedDays: 30 });
}

async function ownReport(env, user, id) {
  return env.DB.prepare(`SELECT r.*, d.name AS device_name, d.model AS device_model, d.app_version AS device_version
    FROM reports r LEFT JOIN devices d ON d.id = r.device_id WHERE r.id = ?1 AND r.user_id = ?2`).bind(String(id || ''), user.id).first();
}

export async function accountReport(env, user, url) {
  const r = await ownReport(env, user, url.searchParams.get('id'));
  const b = r ? (await bugsFor(env, [r.id])).get(r.id) || [] : [];
  const st = r ? userStatus(r, b) : null;
  if (!r || !st) return json({ error: 'That report was not found.' }, 404);
  const notes = (await env.DB.prepare('SELECT text, at FROM report_notes WHERE report_id = ?1 ORDER BY at').bind(r.id).all()).results;
  const named = b.map((x) => ({ ...x, number: x.bug }));
  const steps = [{ key: 'received', label: 'Received', at: r.created_at }];
  if (named.length) steps.push({ key: 'filed', label: named.length === 1 ? 'Filed as bug ' + named[0].number : 'Filed as bugs ' + named.map((x) => x.number).join(', '), at: Math.min(...named.map((x) => x.added_at)) });
  else if (st.key === 'not_app') steps.push({ key: 'not_app', label: 'Not an app problem', at: r.triaged_at });
  else steps.push({ key: 'filed', label: 'Filed as a bug', at: null });
  steps.push({ key: 'fixed', label: st.fixedIn ? 'Fixed in ' + st.fixedIn : 'Fixed', at: st.key === 'fixed' ? st.fixedAt : null });
  steps.push({ key: 'confirmed', label: r.verified_at ? 'You confirmed it\u2019s fixed' : 'Confirmed fixed', at: r.verified_at || (named.length && named.every((x) => x.state === 'closed' && x.status === 'fixed') ? Math.max(...named.map((x) => x.fixed_at || 0)) : null) });
  return json({
    id: r.id, kind: r.kind, title: headline(r), status: st, steps,
    found: named.map((x) => ({ bug: x.number, title: x.title || '', note: x.public_note || '' })),
    updateTo: st.key === 'fixed' && st.fixedIn && r.device_version && vnum(r.device_version) < vnum(st.fixedIn) ? st.fixedIn : null,
    device: { name: r.device_name || 'A removed device', model: r.device_model || '', version: r.device_version || '', info: r.device_info || '' },
    appVersion: r.app_version, summary: r.summary || '', sentAt: r.created_at, body: r.body, notes,
    canStill: ['fixed', 'not_app', 'closed', 'fixing', 'need_info', 'looking'].includes(st.key),
  });
}

export async function accountReportNote(request, env, user, still) {
  const b = await body(request);
  const r = await ownReport(env, user, b?.id);
  if (!r) return json({ error: 'That report was not found.' }, 404);
  const text = String(b?.text || '').trim().slice(0, 2000);
  if (!still && !text) return json({ error: 'Write a note first.' }, 400);
  const now = Date.now();
  const ops = [];
  if (text || still) ops.push(env.DB.prepare('INSERT INTO report_notes (id, report_id, user_id, text, at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(randomToken(12), r.id, user.id, (still ? "It's still happening." + (text ? ' ' : '') : '') + text, now));
  if (still) {
    ops.push(env.DB.prepare("UPDATE reports SET state = 'new', reopened_at = ?2, updated_at = ?2 WHERE id = ?1").bind(r.id, now));
    if (r.device_id) ops.push(env.DB.prepare('UPDATE devices SET want_log = 1 WHERE id = ?1 AND user_id = ?2').bind(r.device_id, user.id));
  } else {
    ops.push(env.DB.prepare('UPDATE reports SET updated_at = ?2 WHERE id = ?1').bind(r.id, now));
  }
  await env.DB.batch(ops);
  return json({ ok: true });
}

/**
 * Nov 28, 2026 (owner): for /api/tv/me: problems this device's person wrote (Report a problem) whose bugs are all
 * fixed in a version this device now has, reported on an older one, not answered yet (90 days at most). The TV asks
 * "Is it fixed?" on its 2nd or 3rd opening on that version.
 */
export async function tvVerifyList(env, d) {
  const mine = d.app_version || '';
  if (!mine) return [];
  const rows = (await env.DB.prepare(`SELECT r.id, r.summary, r.app_version, r.created_at,
      GROUP_CONCAT(rb.bug) AS bugs, SUM(CASE WHEN b.status = 'fixed' AND b.fixed_in IS NOT NULL THEN 0 ELSE 1 END) AS open, MAX(b.fixed_in) AS fixed_in
    FROM reports r JOIN report_bugs rb ON rb.report_id = r.id LEFT JOIN bugs b ON b.number = rb.bug
    WHERE r.device_id = ?1 AND r.kind = 'problem' AND r.verify_answer IS NULL AND r.created_at > ?2
    GROUP BY r.id ORDER BY r.created_at DESC LIMIT 20`).bind(d.id, Date.now() - 90 * DAY).all()).results;
  const out = [];
  for (const r of rows) {
    if (r.open > 0 || !r.fixed_in) continue;
    // Every bug's fix version, the highest one counts.
    const fixedIn = String(r.fixed_in);
    const all = (await env.DB.prepare('SELECT b.fixed_in FROM report_bugs rb JOIN bugs b ON b.number = rb.bug WHERE rb.report_id = ?1').bind(r.id).all()).results.map((x) => x.fixed_in);
    const need = all.reduce((m, v) => (vnum(v) > vnum(m) ? v : m), fixedIn);
    if (vnum(mine) < vnum(need) || vnum(r.app_version) >= vnum(need)) continue;
    out.push({ id: r.id, text: String(r.summary || 'A problem you reported').slice(0, 200), fixedIn: need, bugs: String(r.bugs || '').split(',').map(Number).filter(Boolean), sentAt: r.created_at });
    if (out.length >= 3) break;
  }
  return out;
}

/** POST /api/tv/reports/verify {id, answer: fixed | still | later}: the TV's "Is it fixed?" answer for this device's report. */
export async function tvVerify(request, env, d) {
  if (!d) return json({ error: 'This device is not linked.' }, 401);
  const b = await body(request);
  const r = await env.DB.prepare('SELECT id, user_id, device_id FROM reports WHERE id = ?1 AND device_id = ?2').bind(String(b?.id || ''), d.id).first();
  if (!r) return json({ error: 'That report was not found.' }, 404);
  const answer = String(b?.answer || '');
  const v = clip(b?.version || '', 30);
  const now = Date.now();
  const ops = [];
  if (answer === 'fixed') {
    ops.push(env.DB.prepare("UPDATE reports SET verify_answer = 'fixed', verified_at = ?2, updated_at = ?2 WHERE id = ?1").bind(r.id, now));
    ops.push(env.DB.prepare('INSERT INTO report_notes (id, report_id, user_id, text, at) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(randomToken(12), r.id, r.user_id, 'Confirmed fixed on the TV' + (v ? ' (Avid Viewer ' + v + ')' : '') + '.', now));
  } else if (answer === 'still') {
    ops.push(env.DB.prepare("UPDATE reports SET verify_answer = 'still', state = 'new', reopened_at = ?2, updated_at = ?2 WHERE id = ?1").bind(r.id, now));
    ops.push(env.DB.prepare('INSERT INTO report_notes (id, report_id, user_id, text, at) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(randomToken(12), r.id, r.user_id, "It's still happening (answered on the TV" + (v ? ' after updating to ' + v : '') + ').', now));
    ops.push(env.DB.prepare('UPDATE devices SET want_log = 1 WHERE id = ?1').bind(d.id));
  } else if (answer === 'later') {
    ops.push(env.DB.prepare('UPDATE reports SET verify_asked_at = ?2 WHERE id = ?1').bind(r.id, now));
  } else return json({ error: 'Answer fixed, still or later.' }, 400);
  await env.DB.batch(ops);
  return json({ ok: true });
}

/** For /api/tv/me: whether this device should send a new playback log ("It's still happening"). */
export async function wantsLog(env, deviceId) {
  return Boolean((await env.DB.prepare('SELECT want_log FROM devices WHERE id = ?1').bind(deviceId).first())?.want_log);
}

// ---------------------------------------------------------------- admin

function adminRow(r, bugs, sugg) {
  return { id: r.id, kind: r.kind, summary: r.summary || '', title: headline(r), state: r.state, source: r.source, appVersion: r.app_version,
    deviceInfo: r.device_info || '', device: r.device_name || (r.device_id ? 'A removed device' : 'Not linked'), email: r.email || null,
    sentAt: r.created_at, reopenedAt: r.reopened_at, verifiedAt: r.verified_at || null, verifyAnswer: r.verify_answer || null, signatures: parse(r.signatures, []),
    bugs: (bugs || []).map((b) => ({ number: b.number ?? b.bug, title: b.title || '', auto: Boolean(b.auto), addedAt: b.added_at })), suggestions: sugg || [] };
}

export async function adminReports(env) {
  await syncBugs(env).catch(() => {});
  const now = Date.now();
  const sel = `SELECT r.*, d.name AS device_name, u.email FROM reports r LEFT JOIN devices d ON d.id = r.device_id LEFT JOIN users u ON u.id = r.user_id`;
  const fresh = (await env.DB.prepare(sel + " WHERE r.state = 'new' ORDER BY r.created_at DESC LIMIT 100").all()).results;
  const autoRows = (await env.DB.prepare(sel + ' WHERE r.id IN (SELECT report_id FROM report_bugs WHERE auto = 1 AND added_at > ?1) ORDER BY r.created_at DESC LIMIT 100').bind(now - DAY).all()).results;
  const linkRows = async (ids) => {
    if (!ids.length) return new Map();
    const rows = (await env.DB.prepare(`SELECT rb.report_id, rb.bug, rb.auto, rb.added_at, b.title FROM report_bugs rb LEFT JOIN bugs b ON b.number = rb.bug
      WHERE rb.report_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all()).results;
    const m = new Map(); for (const x of rows) { if (!m.has(x.report_id)) m.set(x.report_id, []); m.get(x.report_id).push(x); } return m;
  };
  const links = await linkRows([...fresh, ...autoRows].map((r) => r.id));
  const queue = [];
  for (const r of fresh) queue.push(adminRow(r, links.get(r.id), await suggestions(env, parse(r.signatures, []))));
  const bugs = (await env.DB.prepare(`SELECT b.number, b.title, b.state, b.status, b.fixed_in, b.fixed_at, b.public_note,
      (SELECT COUNT(*) FROM report_bugs rb WHERE rb.bug = b.number) AS reports,
      (SELECT COUNT(DISTINCT COALESCE(r.device_id, r.device_info)) FROM report_bugs rb JOIN reports r ON r.id = rb.report_id WHERE rb.bug = b.number) AS devices,
      (SELECT MAX(r.app_version) FROM report_bugs rb JOIN reports r ON r.id = rb.report_id WHERE rb.bug = b.number) AS latest
    FROM bugs b WHERE b.state = 'open' OR b.fixed_at > ?1 ORDER BY b.state = 'open' DESC, b.number DESC LIMIT 60`).bind(now - KEEP_FIXED).all()).results;
  // Nov 28, 2026 (owner): who reported each bug (admin only; GitHub never names anyone): accounts with their reports and devices.
  const byBug = new Map();
  if (bugs.length) {
    const who = (await env.DB.prepare(`SELECT rb.bug, r.user_id, u.email, COUNT(*) AS n, GROUP_CONCAT(DISTINCT d.name) AS devices, MIN(r.created_at) AS first, MAX(r.created_at) AS last
        FROM report_bugs rb JOIN reports r ON r.id = rb.report_id LEFT JOIN users u ON u.id = r.user_id LEFT JOIN devices d ON d.id = r.device_id
        WHERE rb.bug IN (${bugs.map(() => '?').join(',')}) GROUP BY rb.bug, r.user_id ORDER BY last DESC`).bind(...bugs.map((b) => b.number)).all()).results;
    for (const w of who) {
      if (!byBug.has(w.bug)) byBug.set(w.bug, []);
      byBug.get(w.bug).push({ userId: w.user_id || null, email: w.email || null, reports: w.n, devices: w.devices ? String(w.devices).split(',') : [], first: w.first, last: w.last });
    }
  }
  for (const b of bugs) b.reporters = byBug.get(b.number) || [];
  const counts = (await env.DB.prepare("SELECT state, COUNT(*) AS n FROM reports GROUP BY state").all()).results;
  return json({ queue, auto: autoRows.map((r) => adminRow(r, links.get(r.id), [])), bugs, counts,
    syncedAt: Number(await state(env, 'bugs_synced_at') || 0) || null, canFile: Boolean(env.GITHUB_TOKEN), webhook: Boolean(env.GITHUB_WEBHOOK_SECRET) });
}

export async function adminReport(env, url) {
  const r = await env.DB.prepare(`SELECT r.*, d.name AS device_name, u.email FROM reports r LEFT JOIN devices d ON d.id = r.device_id
    LEFT JOIN users u ON u.id = r.user_id WHERE r.id = ?1`).bind(String(url.searchParams.get('id') || '')).first();
  if (!r) return json({ error: 'Not found.' }, 404);
  const links = (await env.DB.prepare('SELECT rb.bug, rb.auto, rb.added_at, b.title FROM report_bugs rb LEFT JOIN bugs b ON b.number = rb.bug WHERE rb.report_id = ?1').bind(r.id).all()).results;
  const notes = (await env.DB.prepare('SELECT text, at FROM report_notes WHERE report_id = ?1 ORDER BY at').bind(r.id).all()).results;
  return json({ ...adminRow(r, links, await suggestions(env, parse(r.signatures, []))), userId: r.user_id || null, body: r.body, notes });
}

/**
 * Nov 28, 2026 (owner): an account's reports and the bugs they're on, newest first, for Admin › People › the account.
 * Reports stay in the account after a device is removed; hidden ones ('ignored') are listed too, marked.
 */
export async function adminUserReports(env, userId) {
  const rows = (await env.DB.prepare(`SELECT r.id, r.kind, r.state, r.summary, r.source, r.app_version, r.device_info, r.created_at, r.reopened_at, r.verified_at, r.verify_answer, d.name AS device_name
      FROM reports r LEFT JOIN devices d ON d.id = r.device_id WHERE r.user_id = ?1 ORDER BY r.created_at DESC LIMIT 200`).bind(userId).all()).results;
  if (!rows.length) return { reports: [], bugs: [] };
  const ids = rows.map((r) => r.id);
  const links = (await env.DB.prepare(`SELECT rb.report_id, rb.bug, rb.added_at, b.title, b.state, b.status, b.fixed_in, b.fixed_at FROM report_bugs rb LEFT JOIN bugs b ON b.number = rb.bug
      WHERE rb.report_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all()).results;
  const per = new Map(); const bugs = new Map();
  for (const l of links) {
    if (!per.has(l.report_id)) per.set(l.report_id, []);
    per.get(l.report_id).push(l.bug);
    const r = rows.find((x) => x.id === l.report_id);
    const b = bugs.get(l.bug) || { number: l.bug, title: l.title || '', state: l.state || 'open', status: l.status || 'open', fixedIn: l.fixed_in || null, fixedAt: l.fixed_at || null, reports: 0, first: r.created_at, last: r.created_at, devices: [] };
    b.reports++; b.first = Math.min(b.first, r.created_at); b.last = Math.max(b.last, r.created_at);
    const dn = r.device_name || r.device_info || ''; if (dn && !b.devices.includes(dn)) b.devices.push(dn);
    bugs.set(l.bug, b);
  }
  return {
    reports: rows.map((r) => ({ id: r.id, kind: r.kind, state: r.state, title: headline(r), source: r.source, appVersion: r.app_version,
      device: r.device_name || (r.device_info ? r.device_info + ' (removed or not linked)' : 'Not linked'), sentAt: r.created_at, reopenedAt: r.reopened_at,
      verifiedAt: r.verified_at || null, verifyAnswer: r.verify_answer || null, bugs: per.get(r.id) || [] })),
    bugs: [...bugs.values()].sort((a, b) => b.last - a.last),
  };
}

function issueBody(r) {
  return [
    (r.summary || headline(r)),
    '',
    `- ${r.device_info || 'Device not given'}, ${r.app_version} (${r.id})`,
    '',
    `Report: ${r.id} (Admin › Reports on avidviewer.app has the full text).`,
    '',
    'Reporter: beta tester (sent by the app).',
  ].join('\n');
}

export async function adminTriage(request, env, admin, audit) {
  const b = await body(request);
  const r = await env.DB.prepare('SELECT * FROM reports WHERE id = ?1').bind(String(b?.id || '')).first();
  if (!r) return json({ error: 'That report was not found.' }, 404);
  const now = Date.now();
  const sigs = parse(r.signatures, []);
  const action = String(b?.action || '');
  const learn = (n) => {
    // Learn the report's app keys for this bug: crash keys always; a playback log's only when it has one app key
    // (a log usually shows several problems, so its keys say little about which bug it belongs to).
    const keys = appKeys(sigs);
    if (r.kind === 'playback' && keys.length !== 1) return [];
    return keys.map((k) => env.DB.prepare('INSERT INTO bug_signatures (signature, bug, added_at) VALUES (?1, ?2, ?3) ON CONFLICT(signature) DO UPDATE SET bug = ?2, added_at = ?3').bind(k, n, now));
  };
  switch (action) {
    case 'add': {
      const nums = (Array.isArray(b?.bugs) ? b.bugs : [b?.bug]).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 5);
      if (!nums.length) return json({ error: 'Which bug? Give its number.' }, 400);
      await env.DB.batch([
        ...nums.map((n) => env.DB.prepare('INSERT INTO report_bugs (report_id, bug, auto, added_at) VALUES (?1, ?2, 0, ?3) ON CONFLICT(report_id, bug) DO UPDATE SET auto = 0').bind(r.id, n, now)),
        ...nums.flatMap(learn),
        env.DB.prepare("UPDATE reports SET state = 'triaged', triaged_at = ?2, updated_at = ?2, reopened_at = NULL WHERE id = ?1").bind(r.id, now),
      ]);
      await audit(env, admin, 'report_add', null, `${r.id} → #${nums.join(', #')}`);
      return json({ ok: true });
    }
    case 'file': {
      const title = String(b?.title || '').trim().slice(0, 200) || headline(r).slice(0, 120);
      if (!env.GITHUB_TOKEN) {
        // No token: GitHub's new-issue page, filled in. Once it's submitted, the next read of GitHub links the report
        // (the issue quotes its id).
        const q = new URLSearchParams({ title, body: issueBody(r), labels: 'bug,from-app' });
        await env.DB.prepare("UPDATE reports SET state = 'triaged', triaged_at = ?2, updated_at = ?2 WHERE id = ?1").bind(r.id, now).run();
        await audit(env, admin, 'report_file', null, `${r.id} (opened GitHub's new-issue page)`);
        return json({ ok: true, openUrl: `https://github.com/${REPO}/issues/new?` + q.toString() });
      }
      const res = await gh(env, '/issues', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, body: issueBody(r), labels: ['bug', 'from-app'] }) });
      if (!res.ok) return json({ error: 'GitHub refused it (' + res.status + ').' }, 502);
      const issue = await res.json();
      await env.DB.batch([
        env.DB.prepare('INSERT INTO bugs (number, title, state, status, updated_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(number) DO NOTHING').bind(issue.number, title, 'open', 'open', now),
        env.DB.prepare('INSERT OR IGNORE INTO report_bugs (report_id, bug, auto, added_at) VALUES (?1, ?2, 0, ?3)').bind(r.id, issue.number, now),
        ...learn(issue.number),
        env.DB.prepare("UPDATE reports SET state = 'triaged', triaged_at = ?2, updated_at = ?2, reopened_at = NULL WHERE id = ?1").bind(r.id, now),
      ]);
      await audit(env, admin, 'report_file', null, `${r.id} → #${issue.number}`);
      return json({ ok: true, number: issue.number, url: issue.html_url });
    }
    case 'not_app': case 'need_info': case 'ignore': {
      const st = action === 'ignore' ? 'ignored' : action;
      await env.DB.prepare('UPDATE reports SET state = ?2, triaged_at = ?3, updated_at = ?3, reopened_at = NULL WHERE id = ?1').bind(r.id, st, now).run();
      await audit(env, admin, 'report_' + action, null, r.id);
      return json({ ok: true });
    }
    case 'undo': case 'reopen': {
      // Undo an automatic match (or put a report back in the queue): its automatic links go, it's new again.
      await env.DB.batch([
        env.DB.prepare(action === 'undo' ? 'DELETE FROM report_bugs WHERE report_id = ?1 AND auto = 1' : 'DELETE FROM report_bugs WHERE report_id = ?1').bind(r.id),
        env.DB.prepare("UPDATE reports SET state = 'new', triaged_at = NULL, updated_at = ?2 WHERE id = ?1").bind(r.id, now),
      ]);
      await audit(env, admin, 'report_' + action, null, r.id);
      return json({ ok: true });
    }
  }
  return json({ error: 'Unknown action.' }, 400);
}

export async function adminBugNote(request, env, admin, audit) {
  const b = await body(request);
  const n = Number(b?.number);
  const note = String(b?.note || '').trim().slice(0, 1500);
  const r = await env.DB.prepare('UPDATE bugs SET public_note = ?2 WHERE number = ?1').bind(n, note || null).run();
  if (!r.meta?.changes) return json({ error: 'That bug was not found.' }, 404);
  await audit(env, admin, 'bug_note', null, '#' + n);
  return json({ ok: true });
}

export async function adminBugSync(env) {
  return json(await syncBugs(env, true));
}

// ---------------------------------------------------------------- Report a problem (the TV's QR code → /report/?c=)

const FORM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const FORM_TTL = DAY;
const FORM_USES = 3;

function formCode() {
  const out = []; const buf = new Uint8Array(1);
  while (out.length < 10) { crypto.getRandomValues(buf); if (buf[0] < 248) out.push(FORM_ALPHABET[buf[0] % 31]); }
  return out.join('');
}

/** The TV asks for a code for its Report a bug QR code (linked or not). */
export async function tvReportForm(request, env, device) {
  const b = parse(await request.text(), null);
  if (!b || b.app !== 'avid-viewer') return json({ error: 'Unknown sender.' }, 400);
  const now = Date.now();
  const ipHash = await sha256hex(ipOf(request) + new Date(now).toISOString().slice(0, 10));
  await env.DB.prepare('DELETE FROM report_forms WHERE expires_at < ?1').bind(now - DAY).run();
  if (!device) {
    const n = (await env.DB.prepare('SELECT COUNT(*) AS n FROM report_forms WHERE device_id IS NULL AND ip_hash = ?1 AND created_at > ?2').bind(ipHash, now - 3600_000).first())?.n || 0;
    if (n >= 30) return json({ error: 'Too many codes. Try again in an hour.' }, 429);
  }
  const code = formCode();
  const info = clip(b.device, 200);
  await env.DB.prepare(`INSERT INTO report_forms (code, device_id, user_id, app_version, device_info, device_name, crash, ip_hash, created_at, expires_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`)
    .bind(code, device?.id || null, device?.user_id || null, clip(b.version, 40), info, clip(device?.name || b.name || '', 60) || info.split(' · ')[0] || 'Your TV',
      clip(b.crash, 400) || null, ipHash, now, now + FORM_TTL).run();
  const origin = env.SITE_ORIGIN || 'https://avidviewer.app';
  return json({ code, url: `${origin}/report/?c=${code}`, expiresAt: now + FORM_TTL });
}

async function openForm(env, code) {
  const c = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (c.length !== 10) return null;
  return env.DB.prepare('SELECT * FROM report_forms WHERE code = ?1 AND expires_at > ?2').bind(c, Date.now()).first();
}

/** The page (no sign-in): which device the code is for. */
export async function reportFormInfo(env, url) {
  const f = await openForm(env, url.searchParams.get('c'));
  if (!f) return json({ error: "This code has expired. On the TV, open Settings › Updates & about › Report a bug again for a new QR code." }, 404);
  return json({ device: f.device_name, model: f.device_info, version: f.app_version, linked: Boolean(f.device_id), crash: f.crash || null, left: Math.max(0, FORM_USES - f.uses) });
}

/** The page sends a problem: it becomes a report of kind "problem" for the device that made the code. */
export async function reportFormSubmit(request, env) {
  const b = await body(request);
  if (!b) return json({ error: "That didn't come through. Please try again." }, 400);
  if (b.website) return json({ ok: true, id: 'AVR-00000000', linked: false }); // bots fill the hidden field
  const f = await openForm(env, b.c);
  if (!f) return json({ error: "This code has expired. On the TV, open Settings › Updates & about › Report a bug again for a new QR code." }, 404);
  if (f.uses >= FORM_USES) return json({ error: 'This code has been used three times. Scan the QR code on the TV again for a new one.' }, 429);
  const what = String(b.what || '').trim().slice(0, 4000);
  if (what.length < 5) return json({ error: 'Tell us what happened (a few words is enough).' }, 400);
  const steps = String(b.steps || '').trim().slice(0, 4000);
  const OFTEN = { once: 'Once', sometimes: 'Sometimes', always: 'Every time' };
  const often = OFTEN[b.often] || '';
  const where = String(b.where || '').trim().slice(0, 60);
  const now = Date.now();
  const id = 'AVR-' + [...crypto.getRandomValues(new Uint8Array(4))].map((x) => x.toString(16).padStart(2, '0')).join('');
  const text = [
    'Reported on avidviewer.app from the TV\'s Report a bug QR code.',
    '',
    'What happened:', what,
    steps ? '\nWhat they were doing:\n' + steps : '',
    where ? '\nWhere in the app: ' + where : '',
    often ? 'How often: ' + often : '',
    b.crash && f.crash ? '\nLast crash on this TV:\n' + f.crash : '',
    '',
    'App version: ' + (f.app_version || 'unknown'),
    'Device: ' + (f.device_info || 'unknown'),
  ].filter((x) => x !== '').join('\n');
  const summary = what.split('\n')[0].slice(0, 200);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO reports (id, kind, device_id, user_id, app_version, device_info, summary, body, signatures, state, source, ip_hash, created_at, updated_at)
      VALUES (?1, 'problem', ?2, ?3, ?4, ?5, ?6, ?7, '[]', 'new', 'form', ?8, ?9, ?9)`)
      .bind(id, f.device_id, f.user_id, f.app_version, f.device_info, summary, text, f.ip_hash, now),
    env.DB.prepare('UPDATE report_forms SET uses = uses + 1 WHERE code = ?1').bind(f.code),
  ]);
  return json({ ok: true, id, linked: Boolean(f.device_id) });
}
