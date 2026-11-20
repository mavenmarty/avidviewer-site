-- Nov 20, 2026: at most 4 linked devices per account. full_at: someone tried to approve this TV code on an account that
-- already had 4, so the TV's next poll can say so ("Remove one at avidviewer.app/devices"). Cleared when it's approved.
ALTER TABLE link_codes ADD COLUMN full_at INTEGER;
