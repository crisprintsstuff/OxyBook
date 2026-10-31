-- SPDX-License-Identifier: AGPL-3.0-only
--
-- Propose (ARCHITECTURE §4.3, §4.5; M2 slice 3). What OxyBook last pushed to a draft's
-- PR branch, so the next push can carry --force-with-lease=<ref>:<pushed_sha> and know
-- whether anyone else pushed since.

ALTER TABLE drafts
  ADD COLUMN pushed_sha text CHECK (pushed_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  -- The base the pushed commit was built on. If the draft's base moved since, the next
  -- propose rebuilds the branch on the new base instead of appending to it.
  ADD COLUMN pushed_base_sha text CHECK (pushed_base_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  ADD COLUMN pr_url text,
  -- Why the last propose did not go through, for the editor to show. Cleared on success.
  ADD COLUMN propose_error text,
  ADD CONSTRAINT drafts_pushed_together CHECK ((pushed_sha IS NULL) = (pushed_base_sha IS NULL)),
  ADD CONSTRAINT drafts_pushed_has_branch CHECK (pushed_sha IS NULL OR branch IS NOT NULL);

-- pull_request webhooks find the draft by repository branch and PR number.
CREATE INDEX drafts_branch ON drafts (branch) WHERE branch IS NOT NULL;
