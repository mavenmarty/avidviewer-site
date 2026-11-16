-- One-time setup codes from /setup (Nov 15, 2026). The browser encrypts the playlists (or backup) with a key made
-- from the code; only the ciphertext and a SHA-256 fingerprint of the code are stored here. Rows expire after 30
-- minutes and are deleted on the next request after that.
CREATE TABLE IF NOT EXISTS setup_codes (
  id         TEXT PRIMARY KEY,   -- hex SHA-256 of the code (see public/setup.js)
  data       TEXT NOT NULL,      -- Base64(IV + AES-GCM ciphertext)
  created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL,   -- epoch ms
  fetches    INTEGER NOT NULL DEFAULT 0,
  ip_hash    TEXT                -- SHA-256 of the sender's IP + the day, for the hourly limit only
);
CREATE INDEX IF NOT EXISTS setup_codes_expires ON setup_codes (expires_at);
CREATE INDEX IF NOT EXISTS setup_codes_ip ON setup_codes (ip_hash, created_at);
