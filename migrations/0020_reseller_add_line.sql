-- Nov 21, 2026 (owner): Admin › People › an account › Add a line (a new line from the reseller panel, or one that
-- already exists there). The line's login is locked at once for the account's own key (only the account's passkey
-- opens it; the Playlists page keeps it in the account the next time it's unlocked) and then forgotten.
-- Accounts without locked logins get it locked for each linked device instead.
ALTER TABLE account_playlists ADD COLUMN sealed TEXT;   -- login locked for the account key, until the browser keeps it
