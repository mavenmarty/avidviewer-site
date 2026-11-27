-- First-time setup on the website (Nov 26, 2026): /start/ walks a new account through its TV, playlist and passkey,
-- then the optional Make it yours steps. setup = JSON {started, passkeySkipped, done:{profiles,sees,area,discover}}
-- (null for accounts that never used /start/, so they get no setup reminders). The postal code is set on the website
-- and goes to every TV (most recent wins with the TV's own Settings › Location & weather).
ALTER TABLE users ADD COLUMN setup TEXT;
ALTER TABLE users ADD COLUMN postal_code TEXT;
ALTER TABLE users ADD COLUMN postal_at INTEGER;
