// SPDX-License-Identifier: AGPL-3.0-only

import { execFile } from 'node:child_process';

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

/**
 * Auth for one git invocation. The installation token goes in as an HTTP header through
 * GIT_CONFIG_* environment variables: never in argv (visible in `ps`), never in the
 * mirror's config, never in a remote URL.
 */
export function authEnv(token: string | undefined): Record<string, string> {
  if (!token) return {};
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

/** Async so a fetch does not block the worker's event loop (health checks, other jobs). */
export function git(
  cwd: string,
  args: readonly string[],
  options: { env?: Record<string, string>; input?: string } = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      {
        cwd,
        encoding: 'buffer',
        maxBuffer: 512 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...options.env },
      },
      (error, stdout, stderr) => {
        if (error) {
          const text = stderr.toString('utf8').trim();
          reject(new GitError(text || error.message, args, text));
          return;
        }
        resolve(stdout);
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}
