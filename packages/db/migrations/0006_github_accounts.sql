-- SPDX-License-Identifier: AGPL-3.0-only
--
-- GitHub accounts linked to OxyBook users (ARCHITECTURE §4.1, §7; M2 slice 3b). The user
-- token lets a PR be authored by the person instead of the App. Tokens are AES-256-GCM
-- sealed under OXYBOOK_SECRET_KEY, like github_app's secrets (packages/db/src/github-app.ts).

CREATE TABLE github_accounts (
  user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  github_user_id bigint NOT NULL UNIQUE,
  login text NOT NULL,
  access_token_enc bytea NOT NULL,
  -- Null when the App does not expire user tokens.
  access_expires_at timestamptz,
  refresh_token_enc bytea,
  refresh_expires_at timestamptz,
  linked_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
