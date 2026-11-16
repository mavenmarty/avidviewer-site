-- Accounts step 2 (Nov 15, 2026): TVs linked to an account.
-- A TV holds its own random token; only its SHA-256 is stored here. Removing a TV (or "Sign out of this TV")
-- sets revoked_at, and the TV stops being linked the next time it checks in.
CREATE TABLE IF NOT EXISTS devices (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,          -- shown on the Account page; the person can rename it
  model       TEXT,                   -- e.g. "Amazon AFTKRT"
  app_version TEXT,
  created_at  INTEGER NOT NULL,       -- epoch ms
  last_seen   INTEGER NOT NULL,
  revoked_at  INTEGER
);
CREATE INDEX IF NOT EXISTS devices_user ON devices (user_id);

-- Codes a TV shows (Settings › Account) for the person to approve on /link/, and link tokens carried by setup
-- codes made while signed in (kind 'setup': already approved, no TV yet). 10 minutes for TV codes, 30 for setup.
CREATE TABLE IF NOT EXISTS link_codes (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL,     -- 'tv' | 'setup'
  user_code        TEXT UNIQUE,       -- 'tv' only: the 8 characters shown on the TV
  secret_hash      TEXT NOT NULL UNIQUE, -- SHA-256 of the TV's device code ('tv') or the setup link token ('setup')
  status           TEXT NOT NULL,     -- 'pending' | 'approved' | 'used'
  user_id          TEXT REFERENCES users(id) ON DELETE CASCADE,
  device_name      TEXT,
  device_model     TEXT,
  app_version      TEXT,
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  last_poll        INTEGER,
  ip_hash          TEXT
);
CREATE INDEX IF NOT EXISTS link_codes_expires ON link_codes (expires_at);
CREATE INDEX IF NOT EXISTS link_codes_ip ON link_codes (ip_hash, created_at);
