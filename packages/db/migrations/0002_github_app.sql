-- SPDX-License-Identifier: AGPL-3.0-only
--
-- The one GitHub App this instance uses (ARCHITECTURE §4.1), as created by the
-- App Manifest flow. Instance-level, so no org_id: one App serves every organisation.
--
-- Secret columns hold AES-256-GCM ciphertext (12-byte IV, 16-byte tag, ciphertext)
-- under a key derived from OXYBOOK_SECRET_KEY, so a database dump alone does not
-- yield the App's private key. apps/server/src/app-credentials.ts owns the format.

CREATE TABLE github_app (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  app_id bigint NOT NULL,
  slug text NOT NULL,
  client_id text NOT NULL,
  client_secret_enc bytea NOT NULL,
  webhook_secret_enc bytea NOT NULL,
  private_key_enc bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
