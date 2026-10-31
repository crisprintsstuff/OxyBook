// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { authEnv, git } from './git.js';

/** One blobless bare clone per repository (ARCHITECTURE §4.2). A cache: safe to delete. */
export function mirrorPath(mirrorsDir: string, owner: string, repo: string): string {
  const safe = (part: string) => part.replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(mirrorsDir, safe(owner.toLowerCase()), `${safe(repo.toLowerCase())}.git`);
}

/**
 * Fetch one branch into the mirror with --filter=blob:none and return its head.
 * Trees and commits arrive; blobs are fetched on demand by readBlobs().
 * The ref is force-updated: the remote is the truth, including after a force-push.
 */
export async function fetchRef(input: {
  mirrorDir: string;
  remoteUrl: string;
  ref: string;
  token?: string;
}): Promise<string> {
  const { mirrorDir, remoteUrl, ref } = input;
  if (!existsSync(path.join(mirrorDir, 'HEAD'))) {
    mkdirSync(mirrorDir, { recursive: true });
    await git(mirrorDir, ['init', '--bare', '--quiet']);
    await git(mirrorDir, ['remote', 'add', 'origin', remoteUrl]);
  } else {
    await git(mirrorDir, ['remote', 'set-url', 'origin', remoteUrl]);
  }
  await git(
    mirrorDir,
    [
      'fetch',
      '--quiet',
      '--no-tags',
      '--filter=blob:none',
      'origin',
      `+refs/heads/${ref}:refs/heads/${ref}`,
    ],
    { env: authEnv(input.token) },
  );
  return (await git(mirrorDir, ['rev-parse', `refs/heads/${ref}^{commit}`])).toString().trim();
}

/** The remote head of a branch without fetching, for reconciliation. Null when absent. */
export async function remoteHead(input: {
  remoteUrl: string;
  ref: string;
  token?: string;
  cwd?: string;
}): Promise<string | null> {
  const out = await git(
    input.cwd ?? process.cwd(),
    ['ls-remote', input.remoteUrl, `refs/heads/${input.ref}`],
    {
      env: authEnv(input.token),
    },
  );
  const line = out
    .toString('utf8')
    .split('\n')
    .find((entry) => entry.trim().length > 0);
  return line ? (line.split('\t')[0] ?? null) : null;
}

export interface TreeEntry {
  /** Path from the repository root. */
  path: string;
  blob: string;
}

/** Regular files under `root` at `commit`. Reads trees only; no blob is fetched. */
export async function listFiles(
  mirrorDir: string,
  commit: string,
  root: string,
): Promise<TreeEntry[]> {
  const args = ['ls-tree', '-r', '-z', '--full-tree', commit];
  if (root) args.push('--', root);
  const out = (await git(mirrorDir, args)).toString('utf8');
  const entries: TreeEntry[] = [];
  for (const record of out.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    const [mode, type, blob] = record.slice(0, tab).split(' ');
    // Skip symlinks (120000) and submodules (commit): neither is a page.
    if (type !== 'blob' || !blob || (mode !== '100644' && mode !== '100755')) continue;
    entries.push({ path: record.slice(tab + 1), blob });
  }
  return entries;
}

/** Blob bytes by id. Missing blobs are fetched from the promisor remote, with auth. */
export async function readBlobs(
  mirrorDir: string,
  blobs: readonly string[],
  token?: string,
): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  for (const blob of blobs) {
    if (result.has(blob)) continue;
    result.set(blob, await git(mirrorDir, ['cat-file', 'blob', blob], { env: authEnv(token) }));
  }
  return result;
}

export interface Rename {
  from: string;
  to: string;
}

/**
 * Renames between two commits, as `git diff -M` sees them. Empty when `from` is not in the
 * mirror (first sync, a deleted cache, or history rewritten away).
 */
export async function findRenames(
  mirrorDir: string,
  from: string,
  to: string,
  root: string,
  token?: string,
): Promise<Rename[]> {
  try {
    await git(mirrorDir, ['cat-file', '-e', `${from}^{commit}`]);
  } catch {
    return [];
  }
  // Inexact renames compare contents, so this may fetch blobs: it needs the token too.
  const args = ['diff', '--name-status', '-z', '-M', from, to];
  if (root) args.push('--', root);
  const out = (await git(mirrorDir, args, { env: authEnv(token) })).toString('utf8');
  const parts = out.split('\0');
  const renames: Rename[] = [];
  for (let i = 0; i < parts.length; ) {
    const status = parts[i] ?? '';
    if (!status) break;
    if (status.startsWith('R') || status.startsWith('C')) {
      const fromPath = parts[i + 1] ?? '';
      const toPath = parts[i + 2] ?? '';
      if (status.startsWith('R')) renames.push({ from: fromPath, to: toPath });
      i += 3;
    } else {
      i += 2;
    }
  }
  return renames;
}

/**
 * Blob reads for draft rebases and diff previews: by id, or by path at a commit. Paths
 * resolve against trees already in the mirror; missing blobs are fetched on demand.
 */
export function mirrorBlobSource(mirrorDir: string, token?: string) {
  return {
    async blob(sha: string): Promise<Buffer> {
      return git(mirrorDir, ['cat-file', 'blob', sha], { env: authEnv(token) });
    },
    async at(commit: string, repoPath: string): Promise<{ sha: string; bytes: Buffer } | null> {
      let sha: string;
      try {
        sha = (await git(mirrorDir, ['rev-parse', '--verify', '--quiet', `${commit}:${repoPath}`]))
          .toString()
          .trim();
      } catch {
        return null;
      }
      const type = (await git(mirrorDir, ['cat-file', '-t', sha], { env: authEnv(token) }))
        .toString()
        .trim();
      if (type !== 'blob') return null;
      return {
        sha,
        bytes: await git(mirrorDir, ['cat-file', 'blob', sha], { env: authEnv(token) }),
      };
    },
  };
}
