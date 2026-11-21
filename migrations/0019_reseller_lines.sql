-- Nov 21, 2026 (owner): Reseller lines. The owner is the reseller for these lines, so the panel API
-- (reseller key in the RESELLER_API_KEY secret) can confirm a line and renew it from the owner's credits.
-- Logins are never stored: the TV app sends a login only for the one panel call (check or renewal). The site keeps
-- the panel's own line id, the expiry date and whether the line is on.

-- A confirmed line in an account (one row per account and line, however many devices have it).
CREATE TABLE IF NOT EXISTS reseller_lines (
  user_id    TEXT NOT NULL,
  line_id    TEXT NOT NULL,     -- the panel's user_id for the line (not a login)
  name       TEXT,              -- the playlist's name on the device
  expires_at INTEGER,           -- ms
  enabled    INTEGER NOT NULL DEFAULT 1,
  checked_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, line_id)
);

-- Which device playlist is that line, so a renewal goes to a device that has it.
CREATE TABLE IF NOT EXISTS reseller_line_devices (
  device_id  TEXT NOT NULL,
  local_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  line_id    TEXT NOT NULL,
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, local_id)
);
CREATE INDEX IF NOT EXISTS reseller_line_devices_line ON reseller_line_devices (user_id, line_id);

-- Renewals. Admin-only until payments are live. A device that has the line carries it out at its next check-in:
-- pending -> running (claimed in one statement, so credits are never spent twice) -> done | failed | unknown.
-- 'unknown' = the panel didn't answer after the renewal was sent; it is never retried automatically.
CREATE TABLE IF NOT EXISTS reseller_renewals (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  line_id        TEXT NOT NULL,
  months         INTEGER NOT NULL,   -- 1, 3, 6 or 12 (the panel's "sub")
  status         TEXT NOT NULL,      -- pending | running | done | failed | unknown | cancelled | expired
  requested_by   TEXT,               -- admin email
  reason         TEXT,
  created_at     INTEGER NOT NULL,
  started_at     INTEGER,
  done_at        INTEGER,
  device_id      TEXT,
  message        TEXT,
  expires_before INTEGER,
  expires_after  INTEGER
);
CREATE INDEX IF NOT EXISTS reseller_renewals_user ON reseller_renewals (user_id, status);

-- Troubleshooting on the Account page (Nov 21, 2026, owner):
--   - each device's last channel load per playlist (any provider): channel count or what went wrong. No channel names.
--   - "Reload channels now" and "Check my subscription": asked on the website, picked up by the device at its next
--     check-in (/api/tv/me), then cleared.
CREATE TABLE IF NOT EXISTS device_load_status (
  device_id  TEXT NOT NULL,
  local_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  name       TEXT,
  ok         INTEGER NOT NULL,
  channels   INTEGER,
  problem    TEXT,              -- login | expired | unreachable | empty | other
  detail     TEXT,
  at         INTEGER NOT NULL,
  PRIMARY KEY (device_id, local_id)
);
CREATE INDEX IF NOT EXISTS device_load_status_user ON device_load_status (user_id);
ALTER TABLE devices ADD COLUMN reload_requested_at INTEGER;
ALTER TABLE devices ADD COLUMN check_requested_at INTEGER;
