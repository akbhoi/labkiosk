-- Release lines, major releases, and per-organization major upgrade grants.
--
-- * release_lines: the platform's support status of one line ("2.8" for 2.8.x).
--   No row means 'supported'. 'security_only': workstations already on the line
--   keep getting its security releases, but none is moved onto it.
--   'end_of_life': nothing on the line is offered any more, security releases
--   included. end_of_life_at, when set, is the announced date the line reaches
--   end of life by itself, whatever its status says until then.
-- * release_majors: whether a major release ("3" for 3.x) is open to every
--   organization. No row means open, so the majors already in use stay offered;
--   the Worker adds a closed row when it records the first release of a major
--   above one it already has.
-- * major_upgrade_grants: a closed major a super admin granted one organization,
--   and the organization administrator's confirmation. A workstation is moved to
--   a major above the one it runs only once the major is open or granted, and
--   an administrator of its organization has confirmed it.

CREATE TABLE IF NOT EXISTS release_lines (
  line TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'supported' CHECK (status IN ('supported', 'security_only', 'end_of_life')),
  end_of_life_at INTEGER,
  note TEXT,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS release_majors (
  major INTEGER PRIMARY KEY CHECK (major BETWEEN 0 AND 9999),
  open INTEGER NOT NULL DEFAULT 0 CHECK (open IN (0, 1)),
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS major_upgrade_grants (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  major INTEGER NOT NULL CHECK (major BETWEEN 0 AND 9999),
  granted_by TEXT,
  granted_at INTEGER,
  confirmed_by TEXT,
  confirmed_at INTEGER,
  PRIMARY KEY (tenant_id, major)
);
