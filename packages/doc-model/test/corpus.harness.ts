// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkIdentity } from '../src/identity.js';
import { listMarkdownFiles } from '../src/roundtrip.js';

interface RepoPin {
  name: string;
  stack: string;
  url: string;
  sha: string;
  paths: string[];
}

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const cacheRoot = path.join(repoRoot, 'corpus/cache');
const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'corpus/manifest.json'), 'utf8')) as {
  repos: RepoPin[];
};

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

function headSha(cwd: string): string | null {
  if (!existsSync(path.join(cwd, '.git'))) return null;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function ensureRepo(repo: RepoPin): string {
  const dest = path.join(cacheRoot, repo.name);
  if (headSha(dest) === repo.sha) return dest;
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  git(dest, ['init']);
  git(dest, ['remote', 'add', 'origin', repo.url]);
  git(dest, ['sparse-checkout', 'init', '--cone']);
  git(dest, ['sparse-checkout', 'set', ...repo.paths]);
  git(dest, ['fetch', '--depth', '1', '--filter=blob:none', 'origin', repo.sha]);
  git(dest, ['checkout', '--detach', 'FETCH_HEAD']);
  const checked = headSha(dest);
  if (checked !== repo.sha) {
    throw new Error(`${repo.name}: checked out ${checked}, expected ${repo.sha}`);
  }
  return dest;
}

interface Row {
  repo: string;
  file: string;
  status: 'pass' | 'fail' | 'unparseable' | 'error';
  detail: string;
}

function checkTree(repo: string, root: string, files: string[]): Row[] {
  const rows: Row[] = [];
  for (const file of files) {
    const text = readFileSync(file);
    const decoded = text.toString('utf8');
    if (!text.equals(Buffer.from(decoded, 'utf8'))) {
      rows.push({
        repo,
        file: path.relative(root, file),
        status: 'unparseable',
        detail: 'not valid UTF-8',
      });
      continue;
    }
    try {
      const report = checkIdentity(decoded, { filename: file });
      rows.push({
        repo,
        file: path.relative(root, file),
        status: report.status,
        detail: report.detail ?? '',
      });
    } catch (error) {
      rows.push({
        repo,
        file: path.relative(root, file),
        status: 'error',
        detail: error instanceof Error ? error.message : 'unexpected error',
      });
    }
  }
  return rows;
}

function markdownTable(rows: readonly Row[]): string {
  const lines = ['| repo | file | status | detail |', '| --- | --- | --- | --- |'];
  for (const row of rows) {
    const detail = row.detail.split('\n')[0]?.replaceAll('|', '\\|') ?? '';
    lines.push(`| ${row.repo} | ${row.file} | ${row.status} | ${detail} |`);
  }
  return lines.join('\n');
}

describe('corpus identity', () => {
  it('round-trips pinned documentation repositories', { timeout: 600_000 }, () => {
    mkdirSync(cacheRoot, { recursive: true });
    const rows: Row[] = [];
    const fixtureRoot = path.join(repoRoot, 'corpus/fixtures');
    rows.push(...checkTree('fixtures', fixtureRoot, listMarkdownFiles(fixtureRoot)));

    for (const repo of manifest.repos) {
      process.stderr.write(`fetching ${repo.name}@${repo.sha.slice(0, 12)}\n`);
      const dest = ensureRepo(repo);
      const files = repo.paths.flatMap((docPath) => {
        const full = path.join(dest, docPath);
        return existsSync(full) ? listMarkdownFiles(full) : [];
      });
      assert.ok(files.length > 0, `${repo.name} produced no markdown files`);
      rows.push(...checkTree(repo.name, dest, files));
    }

    const summary = new Map<
      string,
      { pass: number; fail: number; unparseable: number; error: number }
    >();
    for (const row of rows) {
      const bucket = summary.get(row.repo) ?? { pass: 0, fail: 0, unparseable: 0, error: 0 };
      bucket[row.status]++;
      summary.set(row.repo, bucket);
    }

    console.log(markdownTable(rows));
    console.log('\n## summary');
    for (const [repo, counts] of summary) {
      console.log(
        `${repo}: ${counts.pass} pass, ${counts.fail} fail, ${counts.unparseable} unparseable, ${counts.error} error`,
      );
    }

    const failures = rows.filter((row) => row.status === 'fail' || row.status === 'error');
    assert.deepEqual(
      failures.map((row) => `${row.repo}/${row.file}: ${row.detail}`),
      [],
    );
    for (const repo of manifest.repos) {
      const counts = summary.get(repo.name);
      assert.ok(counts && counts.pass > 0, `${repo.name} had no passing files`);
    }
  });
});
