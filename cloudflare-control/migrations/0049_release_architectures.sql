-- A release built for more than one architecture.
--
-- releases.architectures: the architectures a release's folder in the releases
-- bucket holds a signed build of, comma-separated: amd64's at
-- releases/<version>/, every other one's at releases/<version>/<architecture>/.
-- Every release before arm64 is amd64's alone. A workstation is offered only a
-- release built for its own architecture.

ALTER TABLE releases ADD COLUMN architectures TEXT NOT NULL DEFAULT 'amd64';
