// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { runGit } from './git.js';

const MAX_BYTES = 5_000_000;

export class GuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuardError';
  }
}

export interface ProposeAuthor {
  name: string;
  email: string;
}

export interface ProposeRequest {
  /** Git remote. A local bare repo must be a file:// URL so --filter=blob:none is honored. */
  remote: string;
  /** Bare mirror directory. Created if missing. */
  mirrorDir: string;
  /** Branch name on the remote, without refs/heads/. */
  baseBranch: string;
  contentRoot: string;
  /** Path inside the repository, under contentRoot or exactly oxybook.yml. */
  repoPath: string;
  bytes: Buffer;
  author: ProposeAuthor;
  message: string;
  /** Full ref, refs/heads/oxybook/<user>/<slug>-<id>. */
  ref: string;
  /**
   * Value passed to --force-with-lease=<ref>:<expected>.
   * Empty string means the ref must not already exist.
   */
  expectedSha: string;
}

export interface ProposeResult {
  commit: string;
  tree: string;
  base: string;
  ref: string;
  remote: string;
  diff: string;
  changedPaths: string[];
  authorName: string;
  bare: boolean;
}

export function assertOxybookRef(ref: string): void {
  if (!/^refs\/heads\/oxybook\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(ref)) {
    throw new GuardError(
      `refusing to push ${ref}; target must be refs/heads/oxybook/<user>/<slug>-<id>`,
    );
  }
}

export function assertAllowedPath(repoPath: string, contentRoot: string): string {
  const normalized = repoPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (normalized === '' || normalized.split('/').includes('..')) {
    throw new GuardError(`refusing path ${repoPath}`);
  }
  if (normalized === 'oxybook.yml') return normalized;
  const root = contentRoot.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (normalized === root || normalized.startsWith(`${root}/`)) return normalized;
  throw new GuardError(
    `refusing path ${repoPath}; it is outside ${contentRoot} and is not oxybook.yml`,
  );
}

/** Local paths become file:// URLs so git does not ignore --filter. */
export function toGitRemote(remote: string): string {
  if (remote.includes('://')) return remote;
  const absolute = path.resolve(remote);
  return `file://${absolute}`;
}

export function ensureMirror(remote: string, mirrorDir: string, baseBranch: string): void {
  const url = toGitRemote(remote);
  if (!existsSync(path.join(mirrorDir, 'HEAD'))) {
    mkdirSync(path.dirname(path.resolve(mirrorDir)), { recursive: true });
    runGit(process.cwd(), [
      'clone',
      '--bare',
      '--filter=blob:none',
      '-b',
      baseBranch,
      url,
      mirrorDir,
    ]);
    return;
  }
  runGit(mirrorDir, ['fetch', 'origin', `refs/heads/${baseBranch}:refs/heads/${baseBranch}`]);
}

/**
 * Download one blob that a blobless clone left out.
 * `git cat-file -e` asks the promisor remote. `rev-list --missing=print` does not.
 * Returns false when the path does not exist at that commit.
 */
export function ensureBlob(mirrorDir: string, commit: string, repoPath: string): boolean {
  let sha: string;
  try {
    sha = runGit(mirrorDir, ['rev-parse', `${commit}:${repoPath}`]).trim();
  } catch {
    return false;
  }
  runGit(mirrorDir, ['cat-file', '-e', sha]);
  return true;
}

export function missingObjectLines(mirrorDir: string, commit: string): string[] {
  const output = runGit(mirrorDir, ['rev-list', '--objects', '--missing=print', commit]);
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('?'));
}

export function propose(request: ProposeRequest): ProposeResult {
  assertOxybookRef(request.ref);
  const repoPath = assertAllowedPath(request.repoPath, request.contentRoot);
  if (request.bytes.byteLength > MAX_BYTES) {
    throw new GuardError(
      `refusing ${repoPath}; ${request.bytes.byteLength} bytes exceeds ${MAX_BYTES}`,
    );
  }
  ensureMirror(request.remote, request.mirrorDir, request.baseBranch);
  const bare = runGit(request.mirrorDir, ['rev-parse', '--is-bare-repository']).trim() === 'true';
  const base = runGit(request.mirrorDir, ['rev-parse', `refs/heads/${request.baseBranch}`]).trim();
  ensureBlob(request.mirrorDir, base, repoPath);

  const indexPath = path.join(request.mirrorDir, 'oxybook.index');
  rmSync(indexPath, { force: true });
  const indexEnv = { GIT_INDEX_FILE: indexPath };
  const baseTree = runGit(request.mirrorDir, ['rev-parse', `${base}^{tree}`]).trim();
  runGit(request.mirrorDir, ['read-tree', baseTree], indexEnv);
  const blob = runGit(
    request.mirrorDir,
    ['hash-object', '-w', '--stdin'],
    indexEnv,
    request.bytes,
  ).trim();
  runGit(
    request.mirrorDir,
    ['update-index', '--add', '--cacheinfo', `100644,${blob},${repoPath}`],
    indexEnv,
  );
  const tree = runGit(request.mirrorDir, ['write-tree'], indexEnv).trim();
  rmSync(indexPath, { force: true });

  const commit = runGit(
    request.mirrorDir,
    [
      '-c',
      `user.name=${request.author.name}`,
      '-c',
      `user.email=${request.author.email}`,
      '-c',
      'commit.gpgsign=false',
      'commit-tree',
      tree,
      '-p',
      base,
      '-m',
      request.message,
    ],
    {
      GIT_AUTHOR_NAME: request.author.name,
      GIT_AUTHOR_EMAIL: request.author.email,
      GIT_COMMITTER_NAME: request.author.name,
      GIT_COMMITTER_EMAIL: request.author.email,
    },
  ).trim();

  const url = toGitRemote(request.remote);
  runGit(request.mirrorDir, [
    'push',
    url,
    `${commit}:${request.ref}`,
    `--force-with-lease=${request.ref}:${request.expectedSha}`,
  ]);

  const diff = runGit(request.mirrorDir, ['diff', '--no-color', base, commit]);
  const changedPaths = runGit(request.mirrorDir, ['diff', '--name-only', base, commit])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const authorName = runGit(request.mirrorDir, ['log', '-1', '--format=%an', commit]).trim();

  return {
    commit,
    tree,
    base,
    ref: request.ref,
    remote: url,
    diff,
    changedPaths,
    authorName,
    bare,
  };
}

export function formatProposeResult(result: ProposeResult): string {
  return [
    `commit ${result.commit}`,
    `ref ${result.ref}`,
    `base ${result.base}`,
    `author ${result.authorName}`,
    `bare ${result.bare}`,
    '--- diff ---',
    result.diff.trimEnd(),
    '',
  ].join('\n');
}
