// SPDX-License-Identifier: AGPL-3.0-only

import { execFileSync } from 'node:child_process';

export class GitCommandError extends Error {
  readonly args: readonly string[];
  readonly stderr: string;
  readonly status: number | null;

  constructor(message: string, args: readonly string[], stderr: string, status: number | null) {
    super(message);
    this.name = 'GitCommandError';
    this.args = args;
    this.stderr = stderr;
    this.status = status;
  }
}

export class StaleLeaseError extends GitCommandError {
  constructor(args: readonly string[], stderr: string, status: number | null) {
    super('push refused by --force-with-lease (stale info)', args, stderr, status);
    this.name = 'StaleLeaseError';
  }
}

export function runGit(
  cwd: string,
  args: readonly string[],
  env: Record<string, string | undefined> = {},
  input?: Buffer,
): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    const failed = error as { status?: number; stderr?: string | Buffer; message?: string };
    const stderr = Buffer.isBuffer(failed.stderr)
      ? failed.stderr.toString('utf8')
      : (failed.stderr ?? '');
    if (stderr.includes('stale info')) {
      throw new StaleLeaseError(args, stderr, failed.status ?? null);
    }
    throw new GitCommandError(
      stderr.trim() || failed.message || 'git command failed',
      args,
      stderr,
      failed.status ?? null,
    );
  }
}
