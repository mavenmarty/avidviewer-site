-- Beta channel (Nov 18, 2026). The owner offers a device on the Devices page; an admin chooses it; chosen devices get
-- the beta build the admin offered (a GitHub pre-release). Leaving keeps the beta build until a public version is newer.
ALTER TABLE devices ADD COLUMN beta_offer INTEGER NOT NULL DEFAULT 0;  -- 1: the owner offered this device
ALTER TABLE devices ADD COLUMN beta_at INTEGER;                       -- when an admin chose it (null: not in the beta)

-- The one beta build offered to chosen devices (row id 1), e.g. tag "beta-v1.20.0-2.360".
CREATE TABLE IF NOT EXISTS beta_release (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  tag         TEXT NOT NULL,
  name        TEXT NOT NULL,
  offered_at  INTEGER NOT NULL,
  offered_by  TEXT NOT NULL
);
