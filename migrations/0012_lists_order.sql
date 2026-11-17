-- Favorites, lists, order and names (Nov 17, 2026; app 1.16.0).
-- Favorites and lists belong to a profile and follow it to every device. Category and channel order and names belong to
-- a playlist (the whole account). Changes come from the website or any device; the most recent change wins.

-- {favorites:["<playlistId>:<channelId>"…], lists:[{id, name, hidden, keys:[…]}]}
CREATE TABLE IF NOT EXISTS profile_lists (
  profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT            -- device name, or "the website"
);

-- {groupOrder:[raw…], groupNames:{raw:name}, channelOrder:{raw:[channelId…]}, channelNames:{channelId:name}} (live TV)
CREATE TABLE IF NOT EXISTS playlist_order (
  playlist_id TEXT PRIMARY KEY REFERENCES account_playlists(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  data        TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT
);

-- Devices that already combined their favorites and lists for a profile with the account's (done once per device and profile).
CREATE TABLE IF NOT EXISTS device_list_merges (
  device_id  TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  merged_at  INTEGER NOT NULL,
  PRIMARY KEY (device_id, profile_id)
);
