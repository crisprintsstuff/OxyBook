-- SPDX-License-Identifier: AGPL-3.0-only
--
-- Builds (ARCHITECTURE §5.3, M1 slice 6).

CREATE TABLE builds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  space_id uuid NOT NULL,
  version text NOT NULL,
  ref text NOT NULL,
  commit_sha text NOT NULL CHECK (commit_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  warning_count integer NOT NULL DEFAULT 0,
  log text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  FOREIGN KEY (org_id, space_id) REFERENCES spaces (org_id, id) ON DELETE CASCADE
);
CREATE INDEX builds_space_version ON builds (space_id, version, created_at DESC);
