-- Report a problem from the TV (Nov 20, 2026): Settings › Updates & about › Report a bug shows a QR code for
-- avidviewer.app/report/?c=<code>. The TV asks for the code (POST /api/tv/reports/form, linked or not), so the page
-- knows which device it's about without anyone signing in. A code lasts 24 hours and takes up to 3 problems.
CREATE TABLE IF NOT EXISTS report_forms (
  code        TEXT PRIMARY KEY,
  device_id   TEXT,              -- null: a device that isn't linked
  user_id     TEXT,
  app_version TEXT,
  device_info TEXT,
  device_name TEXT,              -- what the page calls the device ("Living room", else the model)
  crash       TEXT,              -- the last crash's first lines on that TV, if any (offered as context)
  ip_hash     TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  uses        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS report_forms_ip ON report_forms (ip_hash, created_at);
