-- Nov 28, 2026: a TV asks the person who wrote a report to say whether the fix works, on its 2nd or 3rd opening on the
-- fixed version. fixed: confirmed fixed (verified_at); still: back in the queue (as "It's still happening").
ALTER TABLE reports ADD COLUMN verify_answer TEXT;
ALTER TABLE reports ADD COLUMN verified_at INTEGER;
ALTER TABLE reports ADD COLUMN verify_asked_at INTEGER;
