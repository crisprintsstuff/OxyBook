// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runGit } from './git.js';
import { assertAllowedPath, GuardError, type ProposeAuthor } from './propose.js';

const MAX_BYTES = 5_000_000;

/** One file operation of a draft (ARCHITECTURE §4.4, `draft_files.op`). */
export interface FileChange {
  op: 'add' | 'modify' | 'delete' | 'rename';
  /** Path from the repository root. For a rename, the new path. */
  path: string;
  /** For a rename only: the path at the base commit. */
  oldPath?: string;
  /** Exact bytes. Required except for a delete. */
  bytes?: Buffer;
}

export interface CommitFilesRequest {
  mirrorDir: string;
  /** Commit the changes apply to. */
  base: string;
  contentRoot: string;
  changes: readonly FileChange[];
  author: ProposeAuthor;
  message: string;
  /**
   * Parents of the new commit. Default `[base]`. The tree is always `base` plus the
   * changes; a follow-up commit on a PR branch passes the branch head instead.
   */
  parents?: readonly string[];
  /**
   * Add `Signed-off-by: <author>`. Only when the human ticked the affirmation in the
   * propose dialog (ARCHITECTURE §4.1): a sign-off is the human's statement, not the bot's.
   */
  signOff?: boolean;
}

export interface CommitFilesResult {
  commit: string;
  tree: string;
  base: string;
  changedPaths: string[];
}

interface TreeEntry {
  mode: string;
  blob: string;
}

function entryAt(mirrorDir: string, commit: string, repoPath: string): TreeEntry | null {
  const out = runGit(mirrorDir, ['ls-tree', '-z', commit, '--', repoPath]);
  const record = out.split('\0').find((line) => line.endsWith(`\t${repoPath}`));
  if (!record) return null;
  const [mode, type, blob] = record.slice(0, record.indexOf('\t')).split(' ');
  if (type !== 'blob' || !mode || !blob) return null;
  return { mode, blob };
}

/**
 * Drop one path from the temporary index. `update-index --force-remove` needs a work
 * tree, which a bare mirror does not have; an `--index-info` line with mode 0 does not.
 */
function removeFromIndex(mirrorDir: string, repoPath: string, env: Record<string, string>): void {
  const line = `0 ${'0'.repeat(40)}\t${repoPath}\n`;
  runGit(mirrorDir, ['update-index', '--index-info'], env, Buffer.from(line));
}

/** The commit message, with a DCO trailer when asked for. */
export function commitMessage(message: string, author: ProposeAuthor, signOff: boolean): string {
  const body = message.trimEnd();
  if (!signOff) return `${body}\n`;
  return `${body}\n\nSigned-off-by: ${author.name} <${author.email}>\n`;
}

/**
 * Build one commit on `base` from a set of file operations, with a temporary index and
 * no working tree (ARCHITECTURE §4.3 step 1–2). Nothing is pushed. Guards are enforced
 * here, not in the UI: every path inside the content root or exactly `oxybook.yml`, a
 * size limit, each path changed once, and each op consistent with the base tree.
 */
export function commitFiles(request: CommitFilesRequest): CommitFilesResult {
  if (request.changes.length === 0) throw new GuardError('refusing an empty commit: no changes');
  const touched = new Set<string>();
  const claim = (repoPath: string) => {
    if (touched.has(repoPath))
      throw new GuardError(`refusing ${repoPath}: changed twice in one commit`);
    touched.add(repoPath);
  };
  const normalized = request.changes.map((change) => {
    const target = assertAllowedPath(change.path, request.contentRoot);
    const old =
      change.op === 'rename'
        ? assertAllowedPath(change.oldPath ?? '', request.contentRoot)
        : undefined;
    if (change.op === 'rename' && old === target)
      throw new GuardError(`refusing rename of ${target} onto itself`);
    if (change.op !== 'delete') {
      if (!change.bytes) throw new GuardError(`refusing ${change.op} of ${target} without bytes`);
      if (change.bytes.byteLength > MAX_BYTES) {
        throw new GuardError(
          `refusing ${target}; ${change.bytes.byteLength} bytes exceeds ${MAX_BYTES}`,
        );
      }
    }
    claim(target);
    if (old) claim(old);
    return { ...change, path: target, ...(old ? { oldPath: old } : {}) };
  });

  const baseTree = runGit(request.mirrorDir, ['rev-parse', `${request.base}^{tree}`]).trim();
  const indexPath = path.join(request.mirrorDir, `oxybook-${randomBytes(6).toString('hex')}.index`);
  const env = { GIT_INDEX_FILE: indexPath };
  try {
    runGit(request.mirrorDir, ['read-tree', baseTree], env);
    for (const change of normalized) {
      const existing = entryAt(request.mirrorDir, request.base, change.path);
      if (change.op === 'add' && existing) {
        throw new GuardError(`refusing add of ${change.path}: it already exists at the base`);
      }
      if ((change.op === 'modify' || change.op === 'delete') && !existing) {
        throw new GuardError(
          `refusing ${change.op} of ${change.path}: it does not exist at the base`,
        );
      }
      if (change.op === 'rename') {
        if (!entryAt(request.mirrorDir, request.base, change.oldPath as string)) {
          throw new GuardError(
            `refusing rename of ${change.oldPath}: it does not exist at the base`,
          );
        }
        if (existing)
          throw new GuardError(`refusing rename onto ${change.path}: it already exists`);
        removeFromIndex(request.mirrorDir, change.oldPath as string, env);
      }
      if (change.op === 'delete') {
        removeFromIndex(request.mirrorDir, change.path, env);
        continue;
      }
      const blob = runGit(
        request.mirrorDir,
        ['hash-object', '-w', '--stdin'],
        env,
        change.bytes,
      ).trim();
      // Keep an executable bit the file already had; new files are 100644.
      const mode = existing?.mode === '100755' ? '100755' : '100644';
      runGit(
        request.mirrorDir,
        ['update-index', '--add', '--cacheinfo', `${mode},${blob},${change.path}`],
        env,
      );
    }
    const tree = runGit(request.mirrorDir, ['write-tree'], env).trim();
    if (tree === baseTree) throw new GuardError('refusing a commit that changes nothing');
    const parents = request.parents ?? [request.base];
    const ident = {
      GIT_AUTHOR_NAME: request.author.name,
      GIT_AUTHOR_EMAIL: request.author.email,
      GIT_COMMITTER_NAME: request.author.name,
      GIT_COMMITTER_EMAIL: request.author.email,
    };
    const commit = runGit(
      request.mirrorDir,
      [
        '-c',
        'commit.gpgsign=false',
        'commit-tree',
        tree,
        ...parents.flatMap((p) => ['-p', p]),
        '-F',
        '-',
      ],
      ident,
      Buffer.from(commitMessage(request.message, request.author, request.signOff === true)),
    ).trim();
    const changedPaths = runGit(request.mirrorDir, [
      'diff',
      // Both sides of a rename are touched paths; rename detection would hide the old one.
      '--no-renames',
      '--name-only',
      '-z',
      request.base,
      commit,
    ])
      .split('\0')
      .filter((line) => line.length > 0);
    return { commit, tree, base: request.base, changedPaths };
  } finally {
    rmSync(indexPath, { force: true });
  }
}

export type MergeOutcome =
  | { clean: true; bytes: Buffer }
  | { clean: false; bytes: Buffer; conflicts: number; reason: 'content' | 'binary' };

/**
 * Three-way merge of one file (ARCHITECTURE §4.5): base is what the draft started from,
 * ours is the draft, theirs is upstream. `bytes` holds the result, with conflict markers
 * when not clean. A file with a NUL byte is binary: identical sides merge, anything else
 * is a conflict without markers.
 */
export function mergeFile3(base: Buffer, ours: Buffer, theirs: Buffer): MergeOutcome {
  if (ours.equals(theirs)) return { clean: true, bytes: ours };
  if (base.equals(theirs)) return { clean: true, bytes: ours };
  if (base.equals(ours)) return { clean: true, bytes: theirs };
  if (base.includes(0) || ours.includes(0) || theirs.includes(0)) {
    return { clean: false, bytes: ours, conflicts: 1, reason: 'binary' };
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'oxybook-merge-'));
  try {
    const files = {
      ours: path.join(dir, 'ours'),
      base: path.join(dir, 'base'),
      theirs: path.join(dir, 'theirs'),
    };
    writeFileSync(files.ours, ours);
    writeFileSync(files.base, base);
    writeFileSync(files.theirs, theirs);
    const result = spawnSync(
      'git',
      [
        'merge-file',
        '-p',
        '-L',
        'draft',
        '-L',
        'base',
        '-L',
        'upstream',
        files.ours,
        files.base,
        files.theirs,
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    // Exit status is the number of conflicts; negative (>127 as unsigned) is an error.
    const status = result.status ?? 255;
    if (status > 127 || result.error) {
      throw new Error(
        `git merge-file failed: ${result.stderr?.toString() || result.error?.message}`,
      );
    }
    if (status === 0) return { clean: true, bytes: result.stdout };
    return { clean: false, bytes: result.stdout, conflicts: status, reason: 'content' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export type MergeCommitsOutcome =
  | { clean: true; commit: string; tree: string }
  | { clean: false; conflictedPaths: string[] };

/**
 * A merge commit of `theirs` (a PR branch someone else pushed to) and `ours`, without a
 * work tree (ARCHITECTURE §4.5 step 3): history on a branch someone else pushed to is
 * never rewritten. `git merge-tree --write-tree` prints a tree id even when it exits 1;
 * that tree holds conflict markers or resurrected files and is never committed.
 */
export function mergeCommits(input: {
  mirrorDir: string;
  theirs: string;
  ours: string;
  author: ProposeAuthor;
  message: string;
}): MergeCommitsOutcome {
  const result = spawnSync(
    'git',
    ['merge-tree', '--write-tree', '--name-only', '--no-messages', input.theirs, input.ours],
    { cwd: input.mirrorDir, encoding: 'utf8' },
  );
  if (result.status === 1) {
    const lines = result.stdout.split('\n').filter((line) => line.length > 0);
    return { clean: false, conflictedPaths: lines.slice(1) };
  }
  if (result.status !== 0) {
    throw new Error(`git merge-tree failed: ${result.stderr || result.error?.message}`);
  }
  const tree = result.stdout.split('\n')[0]?.trim() ?? '';
  const ident = {
    GIT_AUTHOR_NAME: input.author.name,
    GIT_AUTHOR_EMAIL: input.author.email,
    GIT_COMMITTER_NAME: input.author.name,
    GIT_COMMITTER_EMAIL: input.author.email,
  };
  const commit = runGit(
    input.mirrorDir,
    [
      '-c',
      'commit.gpgsign=false',
      'commit-tree',
      tree,
      '-p',
      input.theirs,
      '-p',
      input.ours,
      '-F',
      '-',
    ],
    ident,
    Buffer.from(`${input.message.trimEnd()}\n`),
  ).trim();
  return { clean: true, commit, tree };
}
