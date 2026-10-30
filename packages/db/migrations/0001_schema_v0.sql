-- SPDX-License-Identifier: AGPL-3.0-only
--
-- Schema v0. Tables named in docs/ARCHITECTURE.md §4.2 (read model), §4.4 (drafts),
-- §7 (accounts, sessions, roles) and §8 (every tenant row carries org_id).
--
-- users and sessions are instance-level: one person can belong to more than one
-- organisation. Every row that belongs to an organisation carries org_id.
--
-- Migrations are forward-only. Never edit a migration that has shipped; add a new file.

CREATE TABLE orgs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  name text NOT NULL,
  -- argon2id encoded hash. Null for accounts that have only signed in with GitHub.
  password_hash text,
  email_verified_at timestamptz,
  github_user_id bigint UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower ON users (lower(email));

CREATE TABLE org_members (
  org_id uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

-- Server-side sessions behind an HttpOnly cookie. The cookie holds a random token;
-- this table holds only its SHA-256, so a database read does not yield live cookies.
CREATE TABLE sessions (
  token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);
CREATE INDEX sessions_expires ON sessions (expires_at);

-- One space = one repo + content root + default ref (ARCHITECTURE §2.1).
CREATE TABLE spaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name text NOT NULL,
  github_installation_id bigint,
  repo_owner text,
  repo_name text,
  content_root text NOT NULL DEFAULT '',
  default_ref text NOT NULL DEFAULT 'main',
  private boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug),
  -- Lets child tables reference (org_id, id) so a row cannot point across orgs.
  UNIQUE (org_id, id),
  CHECK ((repo_owner IS NULL) = (repo_name IS NULL)),
  CHECK (content_root !~ '^/' AND content_root !~ '(^|/)\.\.(/|$)')
);

CREATE TABLE space_members (
  org_id uuid NOT NULL,
  space_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, user_id),
  FOREIGN KEY (org_id, space_id) REFERENCES spaces (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, user_id) REFERENCES org_members (org_id, user_id) ON DELETE CASCADE
);

-- Read model (ARCHITECTURE §4.2). Content-addressed by git blob id, deduplicated
-- across refs and versions within an organisation. 40 hex for SHA-1 repos, 64 for SHA-256.
CREATE TABLE blobs (
  org_id uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  sha text NOT NULL CHECK (sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  bytes bytea NOT NULL,
  PRIMARY KEY (org_id, sha)
);

CREATE TABLE ref_state (
  org_id uuid NOT NULL,
  space_id uuid NOT NULL,
  ref text NOT NULL,
  head_sha text NOT NULL CHECK (head_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, ref),
  UNIQUE (org_id, space_id, ref),
  FOREIGN KEY (org_id, space_id) REFERENCES spaces (org_id, id) ON DELETE CASCADE
);

CREATE TABLE pages (
  org_id uuid NOT NULL,
  space_id uuid NOT NULL,
  ref text NOT NULL,
  path text NOT NULL CHECK (path ~ '\.mdx?$'),
  blob_sha text NOT NULL,
  title text NOT NULL,
  url text NOT NULL,
  nav_title text,
  hidden boolean NOT NULL DEFAULT false,
  tsv tsvector,
  PRIMARY KEY (space_id, ref, path),
  UNIQUE (space_id, ref, url),
  FOREIGN KEY (org_id, space_id, ref) REFERENCES ref_state (org_id, space_id, ref)
    ON DELETE CASCADE,
  FOREIGN KEY (org_id, blob_sha) REFERENCES blobs (org_id, sha)
);
CREATE INDEX pages_tsv ON pages USING gin (tsv);

-- Drafts (ARCHITECTURE §4.4): the one place OxyBook holds content that is not in git.
-- One open draft per (user, space, base ref).
CREATE TABLE drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  space_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  base_ref text NOT NULL,
  base_sha text NOT NULL CHECK (base_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  -- Set when the draft is first proposed. Writes only ever go to oxybook/*.
  branch text CHECK (branch IS NULL OR branch LIKE 'oxybook/%'),
  pr_number integer,
  state text NOT NULL DEFAULT 'editing'
    CHECK (state IN ('editing', 'proposed', 'conflicted', 'merged', 'closed')),
  -- Optimistic concurrency for autosave (If-Match).
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, space_id) REFERENCES spaces (org_id, id) ON DELETE CASCADE,
  CHECK (pr_number IS NULL OR branch IS NOT NULL)
);
CREATE UNIQUE INDEX drafts_one_open
  ON drafts (space_id, user_id, base_ref)
  WHERE state NOT IN ('merged', 'closed');

CREATE TABLE draft_files (
  org_id uuid NOT NULL,
  draft_id uuid NOT NULL,
  path text NOT NULL,
  op text NOT NULL CHECK (op IN ('add', 'modify', 'delete', 'rename')),
  old_path text,
  -- Blob the draft was based on; null for an added file. Drives the three-way merge (§4.5).
  base_blob_sha text CHECK (base_blob_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  -- Exact bytes. Null for a delete.
  bytes bytea,
  PRIMARY KEY (draft_id, path),
  FOREIGN KEY (org_id, draft_id) REFERENCES drafts (org_id, id) ON DELETE CASCADE,
  CHECK ((op = 'rename') = (old_path IS NOT NULL)),
  CHECK ((op = 'delete') = (bytes IS NULL)),
  CHECK ((op = 'add') = (base_blob_sha IS NULL))
);
-- "Alex has an open draft that touches this page" (§4.5).
CREATE INDEX draft_files_path ON draft_files (path);
