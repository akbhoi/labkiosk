-- Support status and end of life are set per major release (3 for every 3.x),
-- no longer per minor line (3.1).
--
-- * release_support: the platform's support status of one major release. No
--   row means 'supported'. 'security_only': workstations already on the major
--   keep getting its security releases, but none is moved onto it.
--   'end_of_life': nothing of the major is offered any more, security releases
--   included. end_of_life_at, when set, is the announced date the major reaches
--   end of life by itself, whatever its status says until then.
--   eol_reminder_days: the last end-of-life reminder sent for end_of_life_at
--   (60, 30, 7, or 0 once passed); a new date starts them over.
--
-- release_lines (0034, 0038) held the same per minor line. It never reached a
-- release, so its rows are not carried over: a status per minor line has no
-- single meaning for the major it belongs to.

CREATE TABLE IF NOT EXISTS release_support (
  major INTEGER PRIMARY KEY CHECK (major BETWEEN 0 AND 9999),
  status TEXT NOT NULL DEFAULT 'supported' CHECK (status IN ('supported', 'security_only', 'end_of_life')),
  end_of_life_at INTEGER,
  note TEXT,
  eol_reminder_days INTEGER,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

DROP TABLE IF EXISTS release_lines;
