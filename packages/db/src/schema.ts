// SPDX-License-Identifier: AGPL-3.0-only

import type { ColumnType, Generated } from 'kysely';

/** Matches migrations/0001_schema_v0.sql. Keep the two in step. */
export interface Database {
  orgs: OrgsTable;
  users: UsersTable;
  org_members: OrgMembersTable;
  sessions: SessionsTable;
  spaces: SpacesTable;
  space_members: SpaceMembersTable;
  blobs: BlobsTable;
  ref_state: RefStateTable;
  pages: PagesTable;
  drafts: DraftsTable;
  draft_files: DraftFilesTable;
}

type CreatedAt = ColumnType<Date, Date | string | undefined, never>;
type Timestamp = ColumnType<Date, Date | string, Date | string>;

export interface OrgsTable {
  id: Generated<string>;
  slug: string;
  name: string;
  created_at: CreatedAt;
}

export interface UsersTable {
  id: Generated<string>;
  email: string;
  name: string;
  password_hash: string | null;
  email_verified_at: Timestamp | null;
  /** bigint arrives from pg as a string. */
  github_user_id: ColumnType<string | null, string | number | null, string | number | null>;
  created_at: CreatedAt;
}

export type OrgRole = 'owner' | 'member';

export interface OrgMembersTable {
  org_id: string;
  user_id: string;
  role: OrgRole;
  created_at: CreatedAt;
}

export interface SessionsTable {
  token_hash: Buffer;
  user_id: string;
  created_at: CreatedAt;
  expires_at: Timestamp;
}

export interface SpacesTable {
  id: Generated<string>;
  org_id: string;
  slug: string;
  name: string;
  github_installation_id: ColumnType<
    string | null,
    string | number | null | undefined,
    string | number | null
  >;
  repo_owner: string | null;
  repo_name: string | null;
  content_root: Generated<string>;
  default_ref: Generated<string>;
  private: Generated<boolean>;
  created_at: CreatedAt;
}

export type SpaceRole = 'admin' | 'editor' | 'viewer';

export interface SpaceMembersTable {
  org_id: string;
  space_id: string;
  user_id: string;
  role: SpaceRole;
  created_at: CreatedAt;
}

export interface BlobsTable {
  org_id: string;
  sha: string;
  bytes: Buffer;
}

export interface RefStateTable {
  org_id: string;
  space_id: string;
  ref: string;
  head_sha: string;
  synced_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface PagesTable {
  org_id: string;
  space_id: string;
  ref: string;
  path: string;
  blob_sha: string;
  title: string;
  url: string;
  nav_title: string | null;
  hidden: Generated<boolean>;
  /** Write with sql`to_tsvector(...)`. Read back as text. */
  tsv: string | null;
}

export type DraftState = 'editing' | 'proposed' | 'conflicted' | 'merged' | 'closed';

export interface DraftsTable {
  id: Generated<string>;
  org_id: string;
  space_id: string;
  user_id: string;
  base_ref: string;
  base_sha: string;
  branch: string | null;
  pr_number: number | null;
  state: Generated<DraftState>;
  version: Generated<number>;
  created_at: CreatedAt;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export type DraftFileOp = 'add' | 'modify' | 'delete' | 'rename';

export interface DraftFilesTable {
  org_id: string;
  draft_id: string;
  path: string;
  op: DraftFileOp;
  old_path: string | null;
  base_blob_sha: string | null;
  bytes: Buffer | null;
}
