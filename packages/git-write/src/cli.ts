#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGit } from './git.js';
import { formatProposeResult, propose, toGitRemote } from './propose.js';

export interface CliArgs {
  file: string;
  remote: string;
  baseBranch: string;
  contentRoot: string;
  repoPath: string;
  user: string;
  slug: string;
  draft: string;
  mirrorDir: string;
  message: string;
  authorName: string;
  authorEmail: string;
}

function take(argv: string[], flag: string, fallback?: string): string {
  const index = argv.indexOf(flag);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (value === undefined || value.startsWith('--')) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing ${flag}`);
  }
  return value;
}

export function parseProcessArgs(argv: readonly string[]): CliArgs {
  const rest = [...argv.slice(2)];
  const file = rest.find((arg) => !arg.startsWith('--'));
  if (!file) throw new Error('usage: oxybook-dev propose <file> --remote <url> [options]');
  const remote = take(rest, '--remote');
  const contentRoot = take(rest, '--content-root', 'docs');
  const repoPath = take(rest, '--path', `${contentRoot}/${path.basename(file)}`);
  const user = take(rest, '--user', 'dev');
  const slug = take(rest, '--slug', 'page');
  const draft = take(rest, '--draft', '1');
  return {
    file,
    remote,
    baseBranch: take(rest, '--base', 'main'),
    contentRoot,
    repoPath,
    user,
    slug,
    draft,
    mirrorDir: take(rest, '--mirror', path.join(process.cwd(), '.oxybook-mirror')),
    message: take(rest, '--message', `Update ${repoPath}`),
    authorName: take(rest, '--author-name', 'OxyBook Dev'),
    authorEmail: take(rest, '--author-email', 'dev@localhost'),
  };
}

export function expectedRemoteSha(remote: string, ref: string): string {
  const output = runGit(process.cwd(), ['ls-remote', toGitRemote(remote), ref]).trim();
  if (output === '') return '';
  return output.split(/\s+/)[0] ?? '';
}

export function runPropose(args: CliArgs): string {
  const ref = `refs/heads/oxybook/${args.user}/${args.slug}-${args.draft}`;
  const result = propose({
    remote: args.remote,
    mirrorDir: args.mirrorDir,
    baseBranch: args.baseBranch,
    contentRoot: args.contentRoot,
    repoPath: args.repoPath,
    bytes: readFileSync(args.file),
    author: { name: args.authorName, email: args.authorEmail },
    message: args.message,
    ref,
    expectedSha: expectedRemoteSha(args.remote, ref),
  });
  return formatProposeResult(result);
}

function invokedDirectly(): boolean {
  if (!process.argv[1]) return false;
  const script = fileURLToPath(import.meta.url);
  return path.resolve(process.argv[1]) === script || process.argv[1].endsWith('cli.js');
}

if (invokedDirectly()) {
  try {
    process.stdout.write(runPropose(parseProcessArgs(process.argv)));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'oxybook-dev failed';
    console.error(message);
    process.exit(1);
  }
}
