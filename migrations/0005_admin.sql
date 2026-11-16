-- Accounts step 3 (Nov 16, 2026): the admin view.
-- How each browser session was signed in: admin actions need a passkey sign-in ('passkey'), not just an email link.
ALTER TABLE sessions ADD COLUMN method TEXT NOT NULL DEFAULT 'link';

-- Every admin action, kept for good: who did what to which account, when and why.
CREATE TABLE IF NOT EXISTS admin_audit (
  id           TEXT PRIMARY KEY,
  at           INTEGER NOT NULL,   -- epoch ms
  admin_id     TEXT NOT NULL,
  admin_email  TEXT NOT NULL,
  action       TEXT NOT NULL,      -- e.g. 'suspend', 'unsuspend', 'delete', 'revoke_tv', 'resend_link', 'end_sessions', 'note'
  target_id    TEXT,               -- the account acted on (kept after the account is deleted)
  target_email TEXT,
  detail       TEXT,               -- e.g. the TV's name
  reason       TEXT
);
CREATE INDEX IF NOT EXISTS admin_audit_at ON admin_audit (at);
CREATE INDEX IF NOT EXISTS admin_audit_target ON admin_audit (target_id, at);

-- Private notes on an account, seen only in the admin view.
CREATE TABLE IF NOT EXISTS admin_notes (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at          INTEGER NOT NULL,
  admin_email TEXT NOT NULL,
  text        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_notes_user ON admin_notes (user_id, at);
