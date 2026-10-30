#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  InstallationTokenCache,
  type OpenedPullRequest,
  type OpenPullRequestInput,
  openPullRequest,
  pullRequestHead,
  renderPullRequestBody,
  signAppJwt,
} from '@oxybook/github';
import { runGit } from './git.js';
import { formatProposeResult, propose, toGitRemote } from './propose.js';

export interface GithubProposeTarget {
  owner: string;
  repo: string;
  installationId: number;
  draftUrl?: string;
}

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
  github?: GithubProposeTarget;
}

export interface ProposeCliDeps {
  installationToken?: (installationId: number) => Promise<string>;
  openPullRequest?: (
    input: OpenPullRequestInput,
    options?: { fetch?: typeof fetch; apiBase?: string },
  ) => Promise<OpenedPullRequest>;
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

function optional(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`missing ${flag}`);
  return value;
}

export function parseProcessArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): CliArgs {
  const rest = argv.slice(2).filter((arg) => arg !== '--');
  if (rest[0] === 'propose') rest.shift();
  const file = rest.find((arg) => !arg.startsWith('--'));
  if (!file) throw new Error('usage: oxybook-dev propose <file> --remote <url> [options]');
  const remote = take(rest, '--remote');
  const contentRoot = take(rest, '--content-root', 'docs');
  const repoPath = take(rest, '--path', `${contentRoot}/${path.basename(file)}`);
  const user = take(rest, '--user', 'dev');
  const slug = take(rest, '--slug', 'page');
  const draft = take(rest, '--draft', '1');
  const githubOwner = optional(rest, '--github-owner');
  let github: GithubProposeTarget | undefined;
  if (githubOwner !== undefined) {
    const repo = optional(rest, '--github-repo');
    const installationRaw =
      optional(rest, '--installation-id') ?? (env.GITHUB_APP_INSTALLATION_ID || undefined);
    const installationId = installationRaw === undefined ? Number.NaN : Number(installationRaw);
    if (!repo) throw new Error('missing --github-repo');
    if (!Number.isInteger(installationId) || installationId <= 0) {
      throw new Error(
        '--installation-id (or GITHUB_APP_INSTALLATION_ID) must be a positive integer',
      );
    }
    const draftUrl = optional(rest, '--draft-url');
    github = {
      owner: githubOwner,
      repo,
      installationId,
      ...(draftUrl ? { draftUrl } : {}),
    };
  }
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
    ...(github ? { github } : {}),
  };
}

/** Push URL with the installation token. Clone/fetch keep the token-free remote. */
export function authenticatedGithubPushUrl(
  remote: string,
  token: string,
  owner: string,
  repo: string,
): string {
  let url: URL;
  try {
    url = new URL(remote);
  } catch {
    throw new Error(`remote must be https://github.com/${owner}/${repo}.git`);
  }
  const pathName = url.pathname.replace(/\/$/, '');
  const allowed = [`/${owner}/${repo}`, `/${owner}/${repo}.git`];
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !allowed.includes(pathName)) {
    throw new Error(`remote must be https://github.com/${owner}/${repo}.git`);
  }
  url.username = 'x-access-token';
  url.password = token;
  return url.href;
}

export function expectedRemoteSha(remote: string, ref: string): string {
  const output = runGit(process.cwd(), ['ls-remote', toGitRemote(remote), ref]).trim();
  if (output === '') return '';
  return output.split(/\s+/)[0] ?? '';
}

async function defaultInstallationToken(installationId: number): Promise<string> {
  const appId = process.env.GITHUB_APP_ID;
  const keyFile = process.env.GITHUB_APP_PRIVATE_KEY_FILE;
  if (!appId || !keyFile) {
    throw new Error(
      'GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_FILE are required to open a pull request',
    );
  }
  const privateKeyPem = readFileSync(keyFile, 'utf8');
  const cache = new InstallationTokenCache({
    signJwt: () => signAppJwt({ appId, privateKeyPem }),
  });
  return cache.get(installationId);
}

function linkBack(args: CliArgs): string {
  const url = args.github?.draftUrl ?? process.env.OXYBOOK_PUBLIC_URL;
  if (!url) {
    throw new Error(
      'pass --draft-url or set OXYBOOK_PUBLIC_URL so the pull request body can link back',
    );
  }
  return url;
}

export async function runPropose(args: CliArgs, deps: ProposeCliDeps = {}): Promise<string> {
  const ref = `refs/heads/oxybook/${args.user}/${args.slug}-${args.draft}`;
  let pushRemote: string | undefined;
  let token: string | undefined;
  let draftLink: string | undefined;
  if (args.github) {
    draftLink = linkBack(args);
    token = await (deps.installationToken ?? defaultInstallationToken)(args.github.installationId);
    if (!deps.openPullRequest) {
      pushRemote = authenticatedGithubPushUrl(
        args.remote,
        token,
        args.github.owner,
        args.github.repo,
      );
    }
  }
  const result = propose({
    remote: args.remote,
    ...(pushRemote ? { pushRemote } : {}),
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
  if (!args.github || token === undefined || draftLink === undefined)
    return formatProposeResult(result);
  const opener = deps.openPullRequest ?? openPullRequest;
  const opened = await opener({
    owner: args.github.owner,
    repo: args.github.repo,
    title: args.message,
    head: pullRequestHead(result.ref, args.baseBranch),
    base: args.baseBranch,
    body: renderPullRequestBody({
      summary: args.message,
      changedPaths: result.changedPaths,
      linkBack: draftLink,
    }),
    token,
  });
  return formatProposeResult(result, opened.url);
}

function invokedDirectly(): boolean {
  if (!process.argv[1]) return false;
  const script = fileURLToPath(import.meta.url);
  return path.resolve(process.argv[1]) === script || process.argv[1].endsWith('cli.js');
}

if (invokedDirectly()) {
  runPropose(parseProcessArgs(process.argv))
    .then((text) => {
      process.stdout.write(text);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'oxybook-dev failed';
      console.error(message);
      process.exit(1);
    });
}
