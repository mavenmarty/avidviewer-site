-- Nov 17, 2026 (app 1.15.1): the website shows every playlist on each device, including ones typed on the TV, and
-- logins reach the account without retyping.

-- The account's own key pair: made in the owner's browser when locked logins are set up. Devices lock their logins
-- for the public key; the private key is kept only wrapped with the vault key (so only a passkey opens it).
CREATE TABLE IF NOT EXISTS account_keys (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  pubkey     TEXT NOT NULL,
  wrapped    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Every playlist on a device, as the device last reported it: names and switches, the account playlist it is (if any),
-- and its login sealed for the account key (never readable by the site).
CREATE TABLE IF NOT EXISTS device_playlists (
  device_id  TEXT NOT NULL,
  local_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  live       INTEGER NOT NULL DEFAULT 1,
  vod        INTEGER NOT NULL DEFAULT 1,
  remote_id  TEXT,
  sealed     TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, local_id)
);
CREATE INDEX IF NOT EXISTS device_playlists_user ON device_playlists (user_id);

-- "Add to account": the device's own playlist that becomes this account playlist.
ALTER TABLE playlist_targets ADD COLUMN local_id TEXT;
