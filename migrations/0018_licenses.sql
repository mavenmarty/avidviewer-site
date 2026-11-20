-- Nov 20, 2026 (owner): licenses per account, ahead of payments. Every account gets a 1-month trial: the existing ones
-- here, new ones when they're created. The owner grants or extends in Admin › People (7 days, 1, 3, 6 months, 1 year,
-- perpetual) and is emailed 3 days before a license runs out. Nothing is blocked when one ends (for now).
CREATE TABLE IF NOT EXISTS licenses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,          -- trial | paid | comp
  starts_at INTEGER NOT NULL,  -- ms
  ends_at INTEGER,             -- ms; NULL = perpetual
  source TEXT NOT NULL,        -- auto | admin | payment
  granted_by TEXT,             -- admin email, or NULL
  note TEXT,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  notified_at INTEGER          -- when the owner was told it ends in 3 days
);
CREATE INDEX IF NOT EXISTS licenses_user ON licenses (user_id);
CREATE INDEX IF NOT EXISTS licenses_ends ON licenses (ends_at);

-- Existing accounts: a 1-month trial from today.
INSERT INTO licenses (id, user_id, kind, starts_at, ends_at, source, note, created_at)
SELECT lower(hex(randomblob(12))), id, 'trial',
       CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
       CAST((julianday('now', '+1 month') - 2440587.5) * 86400000 AS INTEGER),
       'auto', 'Trial for existing accounts (Nov 20, 2026)',
       CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
FROM users WHERE id NOT IN (SELECT user_id FROM licenses);
