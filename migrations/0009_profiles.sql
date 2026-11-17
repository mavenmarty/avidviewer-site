-- Account profiles (Nov 16, 2026 design): playlists belong to the account, playlists go to profiles, profiles hide what
-- they shouldn't see, and profiles go to devices. A device gets a playlist when any of its profiles has it.

CREATE TABLE IF NOT EXISTS profiles (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  kids       INTEGER NOT NULL DEFAULT 0,
  parent     INTEGER NOT NULL DEFAULT 0, -- its PIN unlocks any profile on a device
  color      INTEGER NOT NULL DEFAULT 0, -- index into the app's profile colours
  pin        TEXT,                       -- "salt:sha256(salt:pin)", made in the browser; never the digits
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS profiles_user ON profiles (user_id);

CREATE TABLE IF NOT EXISTS profile_playlists (
  profile_id  TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  playlist_id TEXT NOT NULL REFERENCES account_playlists(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  PRIMARY KEY (profile_id, playlist_id)
);
CREATE INDEX IF NOT EXISTS profile_playlists_user ON profile_playlists (user_id);

-- What one profile hides in one playlist (grown-ups), or the categories it may see (Kids). JSON:
-- {hidden:{live:[],movie:[],series:[]}, channels:[], allowed:{live:[],movie:[],series:[]}} — raw category names and
-- the playlist's own channel ids, as a device reported them in playlist_catalogs.
CREATE TABLE IF NOT EXISTS profile_visibility (
  profile_id  TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  playlist_id TEXT NOT NULL REFERENCES account_playlists(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  data        TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (profile_id, playlist_id)
);

CREATE TABLE IF NOT EXISTS device_profiles (
  device_id  TEXT NOT NULL,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  PRIMARY KEY (device_id, profile_id)
);
CREATE INDEX IF NOT EXISTS device_profiles_user ON device_profiles (user_id);

-- A playlist's categories and channels (names and counts) as a device last downloaded it, for choosing what a profile
-- sees. Never what anyone watched.
CREATE TABLE IF NOT EXISTS playlist_catalogs (
  playlist_id TEXT PRIMARY KEY REFERENCES account_playlists(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  data        TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Logins kept in the account (decision q1): each playlist's login is encrypted in the browser with a random vault key;
-- the vault key is stored only wrapped with a key from a passkey (WebAuthn PRF), one row per passkey. The site can't
-- open either, so it can't read logins; the browser unlocks them to lock a copy for each new device.
CREATE TABLE IF NOT EXISTS vault_keys (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL,
  wrapped       TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (user_id, credential_id)
);
ALTER TABLE account_playlists ADD COLUMN vault TEXT;

ALTER TABLE devices ADD COLUMN managed_at INTEGER; -- set when the device (1.15.0+) merged its profiles into the account
-- Watching now: what's playing on the device (playlist and profile only), its last report, and a pending Stop.
ALTER TABLE devices ADD COLUMN playing TEXT;
ALTER TABLE devices ADD COLUMN playing_at INTEGER;
ALTER TABLE devices ADD COLUMN stop_at INTEGER;
