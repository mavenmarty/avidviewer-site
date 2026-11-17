-- Pick up where you left off (Nov 17, 2026; app 1.17.0). Decisions 11–17 on the design canvas.
-- Everything a profile watched is locked on the TVs with the account's history key before it is sent: the website and
-- the admin panel store it without being able to read it. Only the TVs and the owner's passkey (in the browser) can.

-- The history key, wrapped with the vault key (made in the browser at the first passkey unlock).
ALTER TABLE account_keys ADD COLUMN history TEXT;

-- The history key locked for each device (ECDH with the device's key, like playlist logins).
CREATE TABLE IF NOT EXISTS device_history_keys (
  device_id  TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  sealed     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- One row per title or episode per profile. item = an HMAC of the title made on the TV (not readable here);
-- blob = AES-GCM under the history key: where it stopped, whether it was finished, which TV, the title. deleted = Remove.
CREATE TABLE IF NOT EXISTS profile_history (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  item       TEXT NOT NULL,
  blob       TEXT,
  deleted    INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,   -- when it changed (the TV's time of the stop, or the website's)
  seq        INTEGER NOT NULL,   -- when the server stored it, for "what's new since"
  PRIMARY KEY (profile_id, item)
);
CREATE INDEX IF NOT EXISTS profile_history_seq ON profile_history (profile_id, seq);

-- Discover settings per profile (My List, My services, how Discover opens, titles for grown-ups), locked the same way.
CREATE TABLE IF NOT EXISTS profile_discover (
  profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  blob       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Account-wide secrets locked with the history key (the TMDB key for Discover).
CREATE TABLE IF NOT EXISTS account_secrets (
  user_id    TEXT PRIMARY KEY,
  tmdb       TEXT,
  updated_at INTEGER NOT NULL
);

-- A profile whose places stay on each TV.
ALTER TABLE profiles ADD COLUMN history_off INTEGER NOT NULL DEFAULT 0;
