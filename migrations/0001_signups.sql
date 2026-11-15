-- Launch-news sign-ups from the home page.
CREATE TABLE IF NOT EXISTS signups (
  email      TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  source     TEXT NOT NULL,
  country    TEXT
);
