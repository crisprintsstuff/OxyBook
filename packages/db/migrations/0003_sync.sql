-- SPDX-License-Identifier: AGPL-3.0-only
--
-- Sync (ARCHITECTURE §4.2, M1 slice 4).

-- GitHub retries and redelivers. A delivery id seen before is acknowledged and ignored.
-- Instance-level, like github_app: a delivery is about the App, not one organisation.
CREATE TABLE webhook_deliveries (
  delivery_id text PRIMARY KEY,
  event text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_received ON webhook_deliveries (received_at);

-- A rename made outside OxyBook (`git mv` and a push), seen by sync with `git diff -M`.
-- Served as a redirect until someone commits it to oxybook.yml (§2.5).
CREATE TABLE inferred_redirects (
  org_id uuid NOT NULL,
  space_id uuid NOT NULL,
  ref text NOT NULL,
  from_url text NOT NULL,
  to_url text NOT NULL,
  from_path text NOT NULL,
  to_path text NOT NULL,
  commit_sha text NOT NULL CHECK (commit_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, ref, from_url),
  FOREIGN KEY (org_id, space_id) REFERENCES spaces (org_id, id) ON DELETE CASCADE
);
