-- Nov 22, 2026: passkey set-ups that failed in the browser (error name and message only), so the owner can see why
-- someone couldn't create one (Admin › People › an account). Kept 30 days.
CREATE TABLE passkey_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  browser TEXT,
  step TEXT,
  error TEXT,
  message TEXT
);
CREATE INDEX passkey_failures_user ON passkey_failures (user_id, at);
