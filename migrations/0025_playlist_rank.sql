-- Nov 28, 2026 (owner): the account's playlist order for live channels (1 = primary). Decides which playlist's copy of
-- a channel plays first and where its name and guide come from. NULL: after the ranked ones, by name.
ALTER TABLE account_playlists ADD COLUMN live_rank INTEGER;
