-- Reports and bug status on the website (Nov 20, 2026; design canvas boards 37–41, note q24).
--
-- Devices send crash reports and playback logs here (POST /api/tv/reports) instead of the email relay; the relay
-- forwards what older versions send. A report belongs to a device once that device is linked (claimed after linking).
-- The account sees its devices' reports on Account › Reports; fixed ones leave that page 30 days after the fix.
-- Admin › Reports is the queue: add a report to a bug, file a new one, or close it. Bug status comes from GitHub
-- (the public repo, read every few minutes, or at once through the webhook). No emails are sent about reports.

CREATE TABLE IF NOT EXISTS reports (
  id          TEXT PRIMARY KEY,               -- "AVR-1a2b3c4d", shown to people and quoted in GitHub issues
  kind        TEXT NOT NULL,                  -- crash · playback · security
  device_id   TEXT,                           -- null until the sending device is linked (and claims it)
  user_id     TEXT,                           -- the device's account at the time
  app_version TEXT,
  device_info TEXT,                           -- "Amazon AFTKRT · Android 11 (API 30) · Fire OS 8"
  summary     TEXT,
  body        TEXT NOT NULL,                  -- the report as sent (addresses and logins already removed by the app)
  signatures  TEXT NOT NULL DEFAULT '[]',     -- JSON list of match keys (see reports.js signaturesOf)
  state       TEXT NOT NULL DEFAULT 'new',    -- new · triaged · need_info · not_app · ignored
  source      TEXT NOT NULL DEFAULT 'app',    -- app · relay (an older version, through the email relay)
  ip_hash     TEXT,                           -- for the per-network limit on reports from unlinked devices
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  triaged_at  INTEGER,
  reopened_at INTEGER                         -- "It's still happening"
);
CREATE INDEX IF NOT EXISTS reports_user ON reports (user_id, created_at);
CREATE INDEX IF NOT EXISTS reports_state ON reports (state, created_at);
CREATE INDEX IF NOT EXISTS reports_ip ON reports (ip_hash, created_at);

-- Which bugs (GitHub issue numbers) a report is on. auto = 1: added by itself (a certain match), can be undone.
CREATE TABLE IF NOT EXISTS report_bugs (
  report_id TEXT NOT NULL,
  bug       INTEGER NOT NULL,
  auto      INTEGER NOT NULL DEFAULT 0,
  added_at  INTEGER NOT NULL,
  PRIMARY KEY (report_id, bug)
);
CREATE INDEX IF NOT EXISTS report_bugs_bug ON report_bugs (bug);

-- GitHub issues, as last read. status: open · need_info · fixed · closed (not planned). fixed_in: from a
-- "fixed-in:1.21.1" label or the milestone. public_note: what the account's Reports page says about it ("What we found").
CREATE TABLE IF NOT EXISTS bugs (
  number      INTEGER PRIMARY KEY,
  title       TEXT NOT NULL,
  state       TEXT NOT NULL,                  -- GitHub's open · closed
  status      TEXT NOT NULL,
  fixed_in    TEXT,
  fixed_at    INTEGER,
  public_note TEXT,
  updated_at  INTEGER NOT NULL
);

-- Match keys learned from the admin's choices: a report with this key goes to this bug by itself while it's open.
CREATE TABLE IF NOT EXISTS bug_signatures (
  signature TEXT PRIMARY KEY,
  bug       INTEGER NOT NULL,
  added_at  INTEGER NOT NULL
);

-- Notes the account adds to a report ("Add a note", "It's still happening").
CREATE TABLE IF NOT EXISTS report_notes (
  id        TEXT PRIMARY KEY,
  report_id TEXT NOT NULL,
  user_id   TEXT,
  text      TEXT NOT NULL,
  at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS report_notes_report ON report_notes (report_id, at);

-- Small bits of site state (when GitHub was last read, its ETag).
CREATE TABLE IF NOT EXISTS site_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- A device asked to send a new playback log ("It's still happening" on one of its reports).
ALTER TABLE devices ADD COLUMN want_log INTEGER NOT NULL DEFAULT 0;

-- The open bugs of Nov 20 and the kinds of report they cover (keys as reports.js makes them).
INSERT OR IGNORE INTO bug_signatures (signature, bug, added_at) VALUES
  ('exit|not-responding|guide', 20, 1795180000000),
  ('exit|blocked|guide', 20, 1795180000000),
  ('playback|picture-stops', 30, 1795180000000),
  ('playback|decoder-behind', 31, 1795180000000),
  ('playback|decoding-failed', 32, 1795180000000),
  ('exit|system-other', 33, 1795180000000);
