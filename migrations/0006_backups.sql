-- Cloud backups (Nov 16, 2026). Each linked TV keeps exactly one backup: its most recent, replaced on every upload.
-- The data is the TV's .avbak file, encrypted on the TV with the backup PIN chosen at the first backup.
-- The PIN is kept too (pin_enc, AES-GCM with the BACKUP_PIN_KEY secret), so the person can look it up on their Account page.
-- A TV removed from the account keeps its last backup (so a replacement TV can restore it) until the person deletes it.
CREATE TABLE IF NOT EXISTS backups (
  device_id    TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_name  TEXT NOT NULL,      -- copied at upload, so it survives the TV being removed
  device_model TEXT,
  app_version  TEXT,
  created_at   INTEGER NOT NULL,   -- when the TV made the backup (epoch ms)
  uploaded_at  INTEGER NOT NULL,
  size         INTEGER NOT NULL,   -- bytes
  playlists    INTEGER,            -- how many playlists it holds (from the file's unencrypted header)
  pin_enc      TEXT,               -- base64(iv + ciphertext); null if the TV didn't send one
  data         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS backups_user ON backups (user_id);
