-- Needs your attention: items the owner dismissed. Each key names the item and its state, so the item comes back
-- when that state changes (a new failure, another app version, a new absence).
CREATE TABLE IF NOT EXISTS attention_dismissed (
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key          TEXT NOT NULL,
  dismissed_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);
