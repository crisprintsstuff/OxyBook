// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { authenticatedGithubPushUrl, parseProcessArgs, runPropose } from '../src/cli.js';
import { StaleLeaseError } from '../src/git.js';
import {
  assertAllowedPath,
  assertOxybookRef,
  ensureBlob,
  ensureMirror,
  GuardError,
  missingObjectLines,
  propose,
} from '../src/propose.js';

function git(cwd: string, args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.com',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
    },
  );
}

function setupRemote(): { root: string; remote: string; src: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'oxybook-git-'));
  const src = path.join(root, 'src');
  const remote = path.join(root, 'remote.git');
  execFileSync('git', ['init', '-q', '-b', 'main', src]);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  git(remote, ['config', 'uploadpack.allowFilter', 'true']);
  git(remote, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  execFileSync('mkdir', ['-p', path.join(src, 'docs')]);
  writeFileSync(path.join(src, 'docs/a.md'), 'alpha\n');
  writeFileSync(path.join(src, 'docs/b.md'), 'beta\n');
  git(src, ['add', 'docs']);
  git(src, ['commit', '-m', 'base']);
  git(src, ['remote', 'add', 'origin', remote]);
  git(src, ['push', '-q', 'origin', 'main']);
  return { root, remote: `file://${remote}`, src };
}

describe('path and ref guards', () => {
  it('allows content-root paths and oxybook.yml, and refuses escapes', () => {
    assert.equal(assertAllowedPath('docs/a.md', 'docs'), 'docs/a.md');
    assert.equal(assertAllowedPath('oxybook.yml', 'docs'), 'oxybook.yml');
    assert.throws(() => assertAllowedPath('../secret', 'docs'), GuardError);
    assert.throws(() => assertAllowedPath('.github/workflows/ci.yml', 'docs'), GuardError);
    assert.throws(() => assertOxybookRef('refs/heads/main'), GuardError);
    assert.equal(assertOxybookRef('refs/heads/oxybook/ada/page-1'), undefined);
  });
});

describe('propose against a file:// remote', () => {
  it('fetches one blob, commits only the intended path, and refuses a stale lease', () => {
    const { root, remote, src } = setupRemote();
    try {
      const mirror = path.join(root, 'mirror');
      const edited = path.join(root, 'edited.md');
      writeFileSync(edited, 'alpha changed\n');
      ensureMirror(remote, mirror, 'main');
      const baseCommit = git(src, ['rev-parse', 'main']).trim();
      const aBlob = git(src, ['rev-parse', `${baseCommit}:docs/a.md`]).trim();
      const bBlob = git(src, ['rev-parse', `${baseCommit}:docs/b.md`]).trim();
      const missingBefore = missingObjectLines(mirror, baseCommit);
      assert.ok(missingBefore.includes(`?${aBlob}`));
      assert.ok(missingBefore.includes(`?${bBlob}`));
      assert.equal(ensureBlob(mirror, baseCommit, 'docs/a.md'), true);
      const missingAfter = missingObjectLines(mirror, baseCommit);
      assert.equal(missingAfter.includes(`?${aBlob}`), false);
      assert.ok(
        missingAfter.includes(`?${bBlob}`),
        `docs/b.md was fetched: ${missingAfter.join(' ')}`,
      );
      const ref = 'refs/heads/oxybook/ada/page-1';
      const result = propose({
        remote,
        mirrorDir: mirror,
        baseBranch: 'main',
        contentRoot: 'docs',
        repoPath: 'docs/a.md',
        bytes: readFileSync(edited),
        author: { name: 'Ada Lovelace', email: 'ada@example.com' },
        message: 'edit a',
        ref,
        expectedSha: '',
      });
      assert.equal(result.bare, true);
      assert.equal(result.authorName, 'Ada Lovelace');
      assert.deepEqual(result.changedPaths, ['docs/a.md']);
      assert.match(result.diff, /alpha changed/);
      assert.doesNotMatch(result.diff, /beta/);
      assert.equal(git(remote.replace('file://', ''), ['rev-parse', ref]).trim(), result.commit);

      git(src, ['fetch', '-q', 'origin', ref]);
      git(src, ['checkout', '-q', '--detach', 'FETCH_HEAD']);
      writeFileSync(path.join(src, 'docs/b.md'), 'beta sneak\n');
      git(src, ['add', 'docs/b.md']);
      git(src, ['commit', '-m', 'sneak']);
      git(src, ['push', '-q', 'origin', `HEAD:${ref}`]);
      const remoteAfterSneak = git(remote.replace('file://', ''), ['rev-parse', ref]).trim();

      assert.throws(
        () =>
          propose({
            remote,
            mirrorDir: mirror,
            baseBranch: 'main',
            contentRoot: 'docs',
            repoPath: 'docs/a.md',
            bytes: Buffer.from('alpha again\n'),
            author: { name: 'Ada Lovelace', email: 'ada@example.com' },
            message: 'edit a again',
            ref,
            expectedSha: result.commit,
          }),
        StaleLeaseError,
      );
      assert.equal(git(remote.replace('file://', ''), ['rev-parse', ref]).trim(), remoteAfterSneak);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prints the commit, ref, and diff from the CLI', () => {
    const { root, remote } = setupRemote();
    try {
      const edited = path.join(root, 'edited.md');
      const mirror = path.join(root, 'mirror');
      writeFileSync(edited, 'alpha from cli\n');
      const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
      const stdout = execFileSync(
        process.execPath,
        [
          '--import',
          'tsx',
          cli,
          edited,
          '--remote',
          remote,
          '--mirror',
          mirror,
          '--path',
          'docs/a.md',
          '--user',
          'ada',
          '--slug',
          'page',
          '--draft',
          '1',
          '--author-name',
          'Ada Lovelace',
          '--author-email',
          'ada@example.com',
        ],
        { encoding: 'utf8' },
      );
      assert.match(stdout, /^commit [0-9a-f]{40}\n/);
      assert.match(stdout, /ref refs\/heads\/oxybook\/ada\/page-1\n/);
      assert.match(stdout, /author Ada Lovelace\n/);
      assert.match(stdout, /alpha from cli/);
      assert.doesNotMatch(stdout, /docs\/b\.md/);
      writeFileSync(path.join(root, 'cli-output.txt'), stdout);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('opens a pull request after the push and leaves the base branch in place', async () => {
    const { root, remote, src } = setupRemote();
    try {
      const edited = path.join(root, 'edited.md');
      const mirror = path.join(root, 'mirror');
      writeFileSync(edited, 'alpha from cli\n');
      const baseBefore = git(src, ['rev-parse', 'main']).trim();
      const args = parseProcessArgs([
        'node',
        'cli.ts',
        'propose',
        edited,
        '--remote',
        remote,
        '--mirror',
        mirror,
        '--path',
        'docs/a.md',
        '--user',
        'ada',
        '--slug',
        'page',
        '--draft',
        '1',
        '--author-name',
        'Ada Lovelace',
        '--author-email',
        'ada@example.com',
        '--github-owner',
        'acme',
        '--github-repo',
        'docs',
        '--installation-id',
        '42',
        '--draft-url',
        'https://tunnel.example/drafts/1',
      ]);
      const stdout = await runPropose(args, {
        installationToken: async () => 'ghs_test',
        openPullRequest: async (input) => {
          assert.equal(input.token, 'ghs_test');
          assert.equal(input.owner, 'acme');
          assert.equal(input.repo, 'docs');
          assert.equal(input.head, 'oxybook/ada/page-1');
          assert.equal(input.base, 'main');
          assert.notEqual(input.head, input.base);
          assert.match(input.body, /Pages changed:\n- docs\/a\.md/);
          assert.match(input.body, /Link back: https:\/\/tunnel\.example\/drafts\/1/);
          return { number: 4, url: 'https://github.com/acme/docs/pull/4' };
        },
      });
      assert.match(stdout, /pr https:\/\/github.com\/acme\/docs\/pull\/4\n/);
      assert.doesNotMatch(stdout, /ghs_test/);
      assert.equal(git(src, ['rev-parse', 'main']).trim(), baseBefore);
      const bare = remote.replace('file://', '');
      assert.equal(git(bare, ['rev-parse', 'refs/heads/main']).trim(), baseBefore);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('parseProcessArgs', () => {
  it('accepts a leading -- and returns the same file and remote', () => {
    const file = '/tmp/scratch/test-page.md';
    const remote = 'file:///tmp/seedbare';
    const shared = [
      'propose',
      file,
      '--remote',
      remote,
      '--base',
      'main',
      '--path',
      'docs/test-page.md',
    ];
    const without = parseProcessArgs(['node', 'cli.ts', ...shared]);
    const withSeparator = parseProcessArgs(['node', 'cli.ts', '--', ...shared]);
    assert.equal(withSeparator.file, without.file);
    assert.equal(withSeparator.remote, without.remote);
    assert.equal(withSeparator.file, file);
    assert.equal(withSeparator.remote, remote);
  });
});

describe('github remote for the push', () => {
  it('puts the installation token in the push url and refuses a file remote', () => {
    assert.equal(
      authenticatedGithubPushUrl('https://github.com/acme/docs.git', 'ghs_test', 'acme', 'docs'),
      'https://x-access-token:ghs_test@github.com/acme/docs.git',
    );
    assert.throws(
      () => authenticatedGithubPushUrl('file:///tmp/remote.git', 'ghs_test', 'acme', 'docs'),
      /https:\/\/github.com\/acme\/docs\.git/,
    );
  });

  it('rejects a file remote before pushing when a pull request was requested', async () => {
    const args = parseProcessArgs([
      'node',
      'cli.ts',
      'propose',
      'docs/a.md',
      '--remote',
      'file:///tmp/remote.git',
      '--github-owner',
      'acme',
      '--github-repo',
      'docs',
      '--installation-id',
      '42',
      '--draft-url',
      'https://tunnel.example/',
    ]);
    await assert.rejects(
      () => runPropose(args, { installationToken: async () => 'ghs_secret' }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /https:\/\/github.com\/acme\/docs\.git/);
        assert.equal(error.message.includes('ghs_secret'), false);
        return true;
      },
    );
  });
});
