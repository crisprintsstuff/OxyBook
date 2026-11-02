-- SPDX-License-Identifier: AGPL-3.0-only
--
-- Published versions of a space (ARCHITECTURE §2.6, docs/M3-PLAN.md slice 5), from
-- `versions:` in oxybook.yml on the default ref. Rewritten on every sync of the default
-- ref. `ref` is a branch name (like spaces.default_ref) or a full `refs/tags/<name>`.
-- The default version is always the space's default ref; is_default marks its row.

CREATE TABLE space_versions (
  org_id uuid NOT NULL,
  space_id uuid NOT NULL,
  name text NOT NULL CHECK (name ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'),
  ref text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  position integer NOT NULL,
  PRIMARY KEY (space_id, name),
  UNIQUE (space_id, ref),
  FOREIGN KEY (org_id, space_id) REFERENCES spaces (org_id, id) ON DELETE CASCADE
);
