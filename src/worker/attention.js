// "Needs your attention" (Nov 17, 2026): every account page lists what didn't go as expected or needs the owner, in plain
// words, with what to do. Built from the account's state each time, so an item goes away as soon as it's fixed.
//
//   GET  /api/account/attention          {items:[{level, tab, title, detail, actions:[{label, href? | retry?}]}]}
//   POST /api/account/playlists/retry    {playlistId, deviceId}  try a failed playlist again on that device
//   POST /api/account/attention/dismiss  {key, restore?}  hide an item until its state changes (or show it again)
// Each item's key names the item and its state, so a dismissed item comes back when something about it changes.
//
// level: "error" (something failed), "warn" (waiting on the owner or a device), "info" (worth knowing).

import { json, body } from './auth.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const STALE = 15 * MIN;          // a device with changes waiting that hasn't checked in for this long
const NO_CATALOG = 10 * MIN;     // a playlist on a device that still hasn't sent its categories
const OLD_BACKUP = 3 * DAY;
const STOP_SLOW = 2 * MIN;
export const AWAY = 7 * DAY;    // a device not seen for this long is Away: its waiting changes stop raising items
const MIN_APP = '1.15.0';

const ago = (t, now) => {
  const m = Math.round((now - t) / MIN);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
};
const list = (a) => (a.length <= 2 ? a.join(' and ') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]);
const older = (v, min) => {
  const a = String(v || '0').split('.').map(Number), b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== b[i]) return (a[i] || 0) < b[i]; }
  return false;
};

/** Plain words for what a device said when it couldn't add a playlist, and what to do about it. */
export function explain(error) {
  const e = String(error || '');
  if (/handshake|ssl|certificate|tls/i.test(e)) return 'The device couldn’t make a secure connection to the provider’s server. Check the server address: http:// or https://, exactly as your provider gave it.';
  if (/401|403|unauthori|invalid login|wrong (user|pass)|auth/i.test(e)) return 'The provider refused the username or password. Check the login, or ask your provider whether the account is active.';
  if (/timed? ?out|timeout/i.test(e)) return 'The provider’s server didn’t answer in time. It may be down or busy; try again later.';
  if (/resolve|unknown host|dns|not found/i.test(e)) return 'The server address couldn’t be found. Check it for typos.';
  if (/couldn.t open the login|missing/i.test(e)) return 'The device couldn’t open the login it was sent. Send it again (Try again).';
  return e || 'The device couldn’t add it.';
}

export async function attention(env, user) {
  const uid = user.id;
  const now = Date.now();
  const [devs, targets, profs, cats, backups] = await Promise.all([
    env.DB.prepare(`SELECT id, name, app_version, managed_at, last_seen, playing, playing_at, stop_at,
        (SELECT count(*) FROM device_profiles dp WHERE dp.device_id = devices.id) AS nprof FROM devices WHERE user_id = ?1 AND revoked_at IS NULL ORDER BY created_at`).bind(uid).all(),
    env.DB.prepare(`SELECT t.playlist_id, t.device_id, t.action, t.status, t.error, t.updated_at, p.name, p.removing, (p.vault IS NOT NULL) AS kept
        FROM playlist_targets t JOIN account_playlists p ON p.id = t.playlist_id WHERE t.user_id = ?1`).bind(uid).all(),
    env.DB.prepare('SELECT id, name, kids, pin FROM profiles WHERE user_id = ?1 ORDER BY sort').bind(uid).all(),
    env.DB.prepare('SELECT playlist_id FROM playlist_catalogs WHERE user_id = ?1').bind(uid).all(),
    env.DB.prepare('SELECT device_id, created_at FROM backups WHERE user_id = ?1').bind(uid).all().catch(() => ({ results: [] })),
  ]);
  const dev = new Map(devs.results.map((d) => [d.id, d]));
  const items = [];
  const add = (key, level, tab, title, detail, actions = [], kind) => items.push({ key, level, tab, title, detail, actions, ...(kind ? { kind } : {}) });
  const away = (d) => d.last_seen && now - d.last_seen > AWAY;

  // Playlists a device couldn't add.
  for (const t of targets.results.filter((x) => x.status === 'failed' && dev.has(x.device_id))) {
    add(`failed:${t.playlist_id}:${t.device_id}:${t.updated_at}`, 'error', 'playlists', `${t.name} couldn’t be added on ${dev.get(t.device_id).name}`,
      explain(t.error) + ` (${ago(t.updated_at, now)}; the device said: “${t.error}”)`,
      [{ label: 'Edit playlist', href: `/playlists/#edit=${t.playlist_id}` }, { label: 'Try again', retry: { playlistId: t.playlist_id, deviceId: t.device_id } }]);
  }
  // Devices waiting for a login.
  const waiting = new Map();
  for (const t of targets.results.filter((x) => x.status === 'needs_login' && dev.has(x.device_id))) {
    if (!waiting.has(t.device_id)) waiting.set(t.device_id, []);
    waiting.get(t.device_id).push(t);
  }
  for (const [d, ts] of waiting) {
    const kept = ts.every((t) => t.kept);
    add(`logins:${d}:${ts.map((t) => t.playlist_id).sort().join(',')}`, 'warn', 'playlists', `${dev.get(d).name} is waiting for the login to ${list(ts.map((t) => t.name))}`,
      kept ? 'The logins are kept in your account: unlock them with your passkey on the Playlists page to send them.'
        : 'Your account doesn’t have these logins yet. Unlock on the Playlists page (a device that has them sends them), or edit the playlist and type the login once.',
      [{ label: 'Send logins', href: '/playlists/' }], 'logins');
  }
  // Devices that need a newer app.
  for (const d of devs.results) {
    if (d.app_version ? older(d.app_version, MIN_APP) : !d.managed_at) {
      add(`update:${d.id}:${d.app_version || ''}`, 'warn', 'devices', `${d.name} needs an update`,
        `${d.app_version ? `It’s on Avid Viewer ${d.app_version}.` : 'It’s on an older Avid Viewer.'} Update it to ${MIN_APP} or later and open it once to use profiles and playlists from your account. If you can’t update it, dismiss this: it keeps working with what it has.`);
    }
  }
  // Changes waiting for a device that isn't checking in.
  for (const d of devs.results) {
    const n = targets.results.filter((t) => t.device_id === d.id && t.status === 'waiting').length;
    if (away(d)) {
      add(`away:${d.id}:${d.last_seen}`, 'info', 'devices', `${d.name} hasn’t checked in for ${Math.floor((now - d.last_seen) / DAY)} days`,
        (n ? `${n} change${n === 1 ? '' : 's'} wait for it and arrive when Avid Viewer is opened on it again. ` : 'Nothing is waiting for it. ') +
        'If you no longer use it, remove it: it’s signed out at its next check-in and its backup is kept 30 days.',
        [{ label: 'Remove device', removeDevice: d.id }]);
    } else if (n && now - (d.last_seen || 0) > STALE) {
      add(`waiting:${d.id}`, 'warn', 'devices', `${n} change${n === 1 ? '' : 's'} waiting for ${d.name}`,
        `It last checked in ${d.last_seen ? ago(d.last_seen, now) : 'never'}. Changes arrive within a minute of opening Avid Viewer on it.`);
    }
  }
  // A Stop stream that hasn't been confirmed.
  for (const d of devs.results) {
    if (d.stop_at && now - d.stop_at > STOP_SLOW) {
      add(`stop:${d.id}:${d.stop_at}`, 'warn', 'devices', `The stream on ${d.name} hasn’t confirmed it stopped`,
        `Stop stream was pressed ${ago(d.stop_at, now)}. The device may be offline; it stops when it next checks in.`);
    }
  }
  // Removals still waiting on a device.
  for (const t of targets.results.filter((x) => x.action === 'remove' && x.status === 'waiting' && dev.has(x.device_id) && now - x.updated_at > HOUR)) {
    if (away(dev.get(t.device_id))) continue;
    add(`removing:${t.playlist_id}:${t.device_id}`, 'info', 'playlists', `${t.name} is still on ${dev.get(t.device_id).name}`,
      `It was removed from your account ${ago(t.updated_at, now)}; the device removes it the next time Avid Viewer is open on it.`);
  }
  // Playlists on a device that haven't sent their categories.
  const withCat = new Set(cats.results.map((c) => c.playlist_id));
  const seen = new Set();
  for (const t of targets.results.filter((x) => x.status === 'done' && x.action !== 'remove' && !x.removing && !withCat.has(x.playlist_id) && dev.get(x.device_id)?.managed_at && now - x.updated_at > NO_CATALOG)) {
    if (seen.has(t.playlist_id)) continue;
    seen.add(t.playlist_id);
    add(`catalog:${t.playlist_id}`, 'info', 'profiles', `No categories or channels for ${t.name} yet`,
      `It’s on ${dev.get(t.device_id)?.name || 'a device'}, which sends them after it loads the playlist. Open Avid Viewer there; if the playlist doesn’t load on the device, it can’t send them.`);
  }
  // Devices with no profiles from the account.
  for (const d of devs.results.filter((x) => x.managed_at && !x.nprof && profs.results.length)) {
    add(`noprof:${d.id}`, 'info', 'devices', `${d.name} has no profiles from your account`,
      'It gets no playlists from your account until you tick at least one profile for it.', [{ label: 'Choose profiles', href: '/devices/' }]);
  }
  // Kids profile without PINs on the grown-ups.
  // A Kids profile isn't finished (or sent to devices) until every grown-up profile has a PIN.
  const kids = profs.results.filter((p) => p.kids);
  const missing = profs.results.filter((p) => !p.kids && !p.pin).map((p) => p.name);
  if (false && kids.length && missing.length) { // Nov 22, 2026: grown-up PINs are optional now
    add(`kids:${kids.map((k) => k.id).join(',')}:${missing.join(',')}`, 'warn', 'profiles', `${list(kids.map((k) => k.name))} isn’t set up yet`,
      `A Kids profile goes to your devices once every grown-up profile has a PIN, so a child can’t switch out of it. Still needed: ${list(missing)}.`,
      [{ label: 'Finish setting up', href: `/profiles/#finish=${kids[0].id}` }]);
  }
  // Pick up where you left off (1.17.0): TVs that can't share places until the owner unlocks once with the passkey.
  {
    const u = await env.DB.prepare('SELECT watch_history FROM users WHERE id = ?1').bind(uid).first();
    const waiting = (await env.DB.prepare(`SELECT name FROM devices WHERE user_id = ?1 AND revoked_at IS NULL AND pubkey IS NOT NULL AND managed_at IS NOT NULL
        AND id NOT IN (SELECT device_id FROM device_history_keys WHERE user_id = ?1)`).bind(uid).all()).results.map((d) => d.name);
    if (u?.watch_history && waiting.length) {
      add(`historykey:${waiting.join(',')}`, 'info', 'profiles', `${list(waiting)} can’t share where you stopped yet`,
        'Unlock once with your passkey so these TVs get the key that keeps what you watch private. Until then each TV keeps its own place.',
        [{ label: 'Unlock with passkey', href: '/profiles/#history' }]);
    }
  }
  // Backups.
  if (!(typeof env.BACKUP_PIN_KEY === 'string' && env.BACKUP_PIN_KEY.length)) {
    add('backupsoff', 'error', 'backups', 'Backups can’t be saved right now',
      'The website refuses backups until its BACKUP_PIN_KEY secret is added (Cloudflare › Workers › avidviewer › Settings › Variables and Secrets, as a Secret). Devices see “Backups aren’t turned on yet”.');
  }
  for (const b of backups.results) {
    const d = dev.get(b.device_id);
    if (d && now - b.created_at > OLD_BACKUP) {
      if (away(d)) continue;
      add(`backupold:${b.device_id}:${b.created_at}`, 'warn', 'backups', `${d.name}’s last backup was ${ago(b.created_at, now)}`,
        'Devices back up once a day when something changed. Check Back up every day in Avid Viewer › Settings › Updates & about on that device, or press Back up now.');
    }
  }
  const order = { error: 0, warn: 1, info: 2 };
  items.sort((a, b) => order[a.level] - order[b.level]);
  const gone = new Set((await env.DB.prepare('SELECT key FROM attention_dismissed WHERE user_id = ?1').bind(uid).all()).results.map((r) => r.key));
  // Dismissals of items that no longer exist are forgotten.
  const live = new Set(items.map((i) => i.key));
  const stale = [...gone].filter((k) => !live.has(k));
  if (stale.length) await env.DB.batch(stale.slice(0, 50).map((k) => env.DB.prepare('DELETE FROM attention_dismissed WHERE user_id = ?1 AND key = ?2').bind(uid, k)));
  return json({ items: items.filter((i) => !gone.has(i.key)), dismissed: items.filter((i) => gone.has(i.key)) });
}

/** Dismiss an item until its state changes, or show it again ({key, restore:true}). */
export async function attentionDismiss(request, env, user) {
  const b = await body(request);
  const key = typeof b?.key === 'string' ? b.key.slice(0, 400) : '';
  if (!key) return json({ error: 'Nothing to dismiss.' }, 400);
  if (b?.restore) await env.DB.prepare('DELETE FROM attention_dismissed WHERE user_id = ?1 AND key = ?2').bind(user.id, key).run();
  else await env.DB.prepare('INSERT OR REPLACE INTO attention_dismissed (user_id, key, dismissed_at) VALUES (?1, ?2, ?3)').bind(user.id, key, Date.now()).run();
  return json({ ok: true });
}

/** Try a failed playlist again: its login is locked for the device again in the browser (status needs_login). */
export async function playlistsRetry(request, env, user) {
  const b = await body(request);
  const r = await env.DB.prepare(`UPDATE playlist_targets SET status = 'needs_login', error = NULL, version = version + 1, updated_at = ?1
      WHERE playlist_id = ?2 AND device_id = ?3 AND user_id = ?4 AND status = 'failed'`)
    .bind(Date.now(), String(b?.playlistId || ''), String(b?.deviceId || ''), user.id).run();
  return json({ ok: true, retried: Boolean(r.meta?.changes) });
}
