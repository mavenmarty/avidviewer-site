-- Avid Viewer accounts, step 1 (Nov 15, 2026): sign-in by email link and passkeys, sessions.
-- Devices, subscriptions and the admin audit log come in later migrations.
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,               -- random, never shown
  email         TEXT NOT NULL UNIQUE,           -- lower-case
  created_at    TEXT NOT NULL,
  last_sign_in  TEXT,
  role          TEXT NOT NULL DEFAULT 'user',   -- 'user' | 'admin'
  status        TEXT NOT NULL DEFAULT 'active', -- 'active' | 'suspended'
  watch_history INTEGER NOT NULL DEFAULT 1      -- decision 7: asked on first sign-in, changeable on /account/
);

-- One-time sign-in links. Only a SHA-256 of the token is stored; the token is in the emailed link.
CREATE TABLE IF NOT EXISTS sign_in_links (
  token_hash TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  created_at INTEGER NOT NULL,   -- epoch ms
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,
  ip_hash    TEXT
);
CREATE INDEX IF NOT EXISTS sign_in_links_email ON sign_in_links (email, created_at);
CREATE INDEX IF NOT EXISTS sign_in_links_ip ON sign_in_links (ip_hash, created_at);

-- Browser sessions (cookie av_session holds the token; only its SHA-256 is stored).
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  label      TEXT              -- e.g. "Chrome on Windows", from the User-Agent
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);

CREATE TABLE IF NOT EXISTS passkeys (
  id          TEXT PRIMARY KEY,  -- credential id, base64url
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key  TEXT NOT NULL,     -- base64url COSE key
  counter     INTEGER NOT NULL DEFAULT 0,
  transports  TEXT,              -- JSON array
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  last_used   INTEGER
);
CREATE INDEX IF NOT EXISTS passkeys_user ON passkeys (user_id);

-- WebAuthn challenges, kept for 5 minutes.
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id         TEXT PRIMARY KEY,
  user_id    TEXT,               -- set when registering a passkey
  challenge  TEXT NOT NULL,
  kind       TEXT NOT NULL,      -- 'register' | 'login'
  expires_at INTEGER NOT NULL
);
