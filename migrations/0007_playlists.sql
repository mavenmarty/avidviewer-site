-- Playlist management on the website (Nov 16, 2026). A playlist belongs to the account and is sent to the devices the
-- person picks, limited to the profiles they pick on each device. The login is encrypted in the browser separately for
-- each device, with that device's own public key (devices.pubkey, ECDH P-256), so only that device can open it; the site
-- keeps the name and type, plus each device's sealed copy only until the device has picked it up.
ALTER TABLE devices ADD COLUMN pubkey TEXT;        -- base64 of the raw P-256 point (65 bytes), made on the device
ALTER TABLE devices ADD COLUMN profiles TEXT;      -- JSON [{id, name, kids}] as the device last reported them
ALTER TABLE devices ADD COLUMN reported_at INTEGER;

CREATE TABLE IF NOT EXISTS account_playlists (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL,      -- xtream | m3u
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  removing   INTEGER NOT NULL DEFAULT 0  -- 1 while devices are being told to remove it
);
CREATE INDEX IF NOT EXISTS account_playlists_user ON account_playlists (user_id);

-- One row per playlist and device: what the device should do next and how it went.
CREATE TABLE IF NOT EXISTS playlist_targets (
  playlist_id  TEXT NOT NULL REFERENCES account_playlists(id) ON DELETE CASCADE,
  device_id    TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  profiles     TEXT,             -- JSON [profileId…]; NULL = every profile on the device
  action       TEXT NOT NULL,    -- add | update | remove
  payload      TEXT,             -- sealed login for this device; cleared once the device has it
  version      INTEGER NOT NULL, -- grows with every change, so a late acknowledgement can't settle a newer one
  status       TEXT NOT NULL,    -- waiting | done | failed
  error        TEXT,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, device_id)
);
CREATE INDEX IF NOT EXISTS playlist_targets_device ON playlist_targets (device_id, status);
