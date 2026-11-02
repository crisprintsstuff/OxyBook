-- SPDX-License-Identifier: AGPL-3.0-only
--
-- The blob of `oxybook.yml` at the synced head, so the app can edit it in a draft (M3
-- slice 3: a rename appends a redirect) without a git mirror. Sync stores the bytes in
-- `blobs` alongside it, or writes 'none' when the ref has no oxybook.yml. NULL means not
-- recorded yet (synced before this migration): the app asks for one sync first.

ALTER TABLE ref_state ADD COLUMN config_blob_sha text
  CHECK (config_blob_sha IS NULL OR config_blob_sha = 'none'
         OR config_blob_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$');
