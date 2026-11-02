// SPDX-License-Identifier: AGPL-3.0-only

import type { Database, Kysely } from '@oxybook/db';
import { parse as parseYaml } from 'yaml';

/**
 * Versions are git refs (ARCHITECTURE §2.6). `versions:` is read from oxybook.yml on the
 * default ref only, resolved against the remote, and stored in `space_versions` so the
 * webhook, reconciliation, the worker and the build agree on what is published.
 */

export interface VersionEntry {
  name: string;
  ref: string;
  default: boolean;
}

export interface SpaceVersion {
  name: string;
  /** A branch name, or `refs/tags/<name>`. */
  ref: string;
  isDefault: boolean;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Names a non-default version cannot take: the default's build directory and the search index. */
const RESERVED = new Set(['default', 'pagefind']);

/** `versions:` as written; malformed entries are left out (and reported by the caller). */
export function parseVersions(bytes: Buffer | null): {
  entries: VersionEntry[];
  problems: string[];
} {
  const problems: string[] = [];
  if (!bytes) return { entries: [], problems };
  let raw: unknown;
  try {
    const parsed = parseYaml(bytes.toString('utf8')) as unknown;
    raw =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).versions
        : undefined;
  } catch {
    return { entries: [], problems: ['oxybook.yml does not parse'] };
  }
  if (raw === undefined || raw === null) return { entries: [], problems };
  if (!Array.isArray(raw)) return { entries: [], problems: ['versions: is not a list'] };
  const entries: VersionEntry[] = [];
  for (const item of raw) {
    const r = (item ?? {}) as Record<string, unknown>;
    const name = typeof r.name === 'string' ? r.name : String(r.name ?? '');
    const ref = typeof r.ref === 'string' ? r.ref : '';
    if (!NAME.test(name) || !ref) {
      problems.push(
        `skipped version ${JSON.stringify(item)}: needs a name (letters, digits, . _ -) and a ref`,
      );
      continue;
    }
    if (entries.some((e) => e.name === name || e.ref === ref)) {
      problems.push(`skipped version ${name}: its name or ref is listed twice`);
      continue;
    }
    entries.push({ name, ref, default: r.default === true });
  }
  return { entries, problems };
}

/** The stored versions of a space, default first; empty when it lists none. */
export async function spaceVersions(
  db: Kysely<Database>,
  spaceId: string,
): Promise<SpaceVersion[]> {
  const rows = await db
    .selectFrom('space_versions')
    .select(['name', 'ref', 'is_default as isDefault'])
    .where('space_id', '=', spaceId)
    .orderBy('position')
    .execute();
  return rows;
}

/**
 * Rewrite `space_versions` from the default ref's oxybook.yml. The default version is the
 * space's default ref: the entry with that ref names it (or the one marked default, or the
 * first). Every other entry is resolved on the remote; an entry whose ref does not exist
 * there is left out and reported.
 */
export async function updateSpaceVersions(
  db: Kysely<Database>,
  input: {
    orgId: string;
    spaceId: string;
    defaultRef: string;
    config: Buffer | null;
    resolve: (ref: string) => Promise<string | null>;
    log?: (line: string) => void;
  },
): Promise<SpaceVersion[]> {
  const { entries, problems } = parseVersions(input.config);
  for (const problem of problems) input.log?.(`versions: ${problem}`);
  const versions: SpaceVersion[] = [];
  if (entries.length > 0) {
    const named =
      entries.find((e) => e.ref === input.defaultRef) ??
      entries.find((e) => e.default) ??
      entries[0];
    versions.push({ name: (named as VersionEntry).name, ref: input.defaultRef, isDefault: true });
    for (const entry of entries) {
      if (entry === named || entry.ref === input.defaultRef) continue;
      if (RESERVED.has(entry.name.toLowerCase())) {
        input.log?.(`versions: skipped ${entry.name}: the name is reserved`);
        continue;
      }
      const ref = await input.resolve(entry.ref);
      if (!ref) {
        input.log?.(
          `versions: skipped ${entry.name}: ${entry.ref} is not a branch or tag on the remote`,
        );
        continue;
      }
      if (versions.some((v) => v.ref === ref)) continue;
      versions.push({ name: entry.name, ref, isDefault: false });
    }
  }
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('space_versions').where('space_id', '=', input.spaceId).execute();
    if (versions.length)
      await trx
        .insertInto('space_versions')
        .values(
          versions.map((v, position) => ({
            org_id: input.orgId,
            space_id: input.spaceId,
            name: v.name,
            ref: v.ref,
            is_default: v.isDefault,
            position,
          })),
        )
        .execute();
  });
  return versions;
}
