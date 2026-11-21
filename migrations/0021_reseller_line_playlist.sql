-- Nov 21, 2026 (owner): each reseller line knows its account playlist, so Admin shows which profiles have it and which
-- devices it's on (through the profiles), not only the devices that confirmed it themselves.
ALTER TABLE reseller_lines ADD COLUMN playlist_id TEXT;
-- Lines added before this: the account playlist of the same name.
UPDATE reseller_lines SET playlist_id = (SELECT p.id FROM account_playlists p WHERE p.user_id = reseller_lines.user_id
  AND p.name = reseller_lines.name AND p.removing = 0 ORDER BY p.created_at DESC LIMIT 1) WHERE playlist_id IS NULL;
