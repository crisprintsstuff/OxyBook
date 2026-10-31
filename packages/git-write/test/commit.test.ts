// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { commitFiles, mergeFile3 } from '../src/commit.js';
import { GuardError } from '../src/propose.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.com',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.com',
    },
  });
}

describe('commitFiles', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'oxybook-commit-'));
  const work = path.join(tmp, 'work');
  const mirror = path.join(tmp, 'mirror.git');
  let base = '';
  const author = { name: 'Writer', email: 'writer@example.com' };

  before(() => {
    git(tmp, 'init', '--quiet', '-b', 'main', work);
    mkdirSync(path.join(work, 'docs/guides'), { recursive: true });
    mkdirSync(path.join(work, '.github/workflows'), { recursive: true });
    writeFileSync(path.join(work, 'docs/a.md'), '# A\n');
    writeFileSync(path.join(work, 'docs/b.md'), '# B\n');
    writeFileSync(path.join(work, 'docs/old.md'), '# Old\n');
    writeFileSync(path.join(work, 'docs/run.sh'), '#!/bin/sh\n');
    writeFileSync(path.join(work, '.github/workflows/ci.yml'), 'on: push\n');
    git(work, 'add', '-A');
    git(work, 'update-index', '--chmod=+x', 'docs/run.sh');
    git(work, 'commit', '--quiet', '-m', 'base');
    git(tmp, 'clone', '--quiet', '--bare', work, mirror);
    base = git(mirror, 'rev-parse', 'main').trim();
  });

  after(() => rmSync(tmp, { recursive: true, force: true }));

  it('commits add, modify, delete, and rename together on the base', () => {
    const result = commitFiles({
      mirrorDir: mirror,
      base,
      contentRoot: 'docs',
      author,
      message: 'Update docs',
      changes: [
        { op: 'add', path: 'docs/guides/new.md', bytes: Buffer.from('# New\n') },
        { op: 'modify', path: 'docs/a.md', bytes: Buffer.from('# A, edited\n') },
        { op: 'delete', path: 'docs/b.md' },
        {
          op: 'rename',
          oldPath: 'docs/old.md',
          path: 'docs/renamed.md',
          bytes: Buffer.from('# Old\n'),
        },
        { op: 'modify', path: 'docs/run.sh', bytes: Buffer.from('#!/bin/sh\necho hi\n') },
      ],
    });
    assert.equal(git(mirror, 'rev-parse', `${result.commit}^`).trim(), base);
    assert.deepEqual(
      git(mirror, 'ls-tree', '-r', '--name-only', result.commit).trim().split('\n'),
      [
        '.github/workflows/ci.yml',
        'docs/a.md',
        'docs/guides/new.md',
        'docs/renamed.md',
        'docs/run.sh',
      ],
    );
    assert.equal(git(mirror, 'show', `${result.commit}:docs/a.md`), '# A, edited\n');
    assert.match(
      git(mirror, 'ls-tree', result.commit, 'docs/run.sh'),
      /^100755 /,
      'executable bit kept',
    );
    assert.deepEqual(result.changedPaths.sort(), [
      'docs/a.md',
      'docs/b.md',
      'docs/guides/new.md',
      'docs/old.md',
      'docs/renamed.md',
      'docs/run.sh',
    ]);
    assert.match(
      git(mirror, 'log', '-1', '--format=%an <%ae>', result.commit),
      /^Writer <writer@example.com>/,
    );
    assert.equal(git(mirror, 'log', '-1', '--format=%B', result.commit), 'Update docs\n\n');
    assert.equal(git(mirror, 'rev-parse', 'main').trim(), base, 'nothing moved a branch');
  });

  it('adds a DCO trailer only when asked', () => {
    const signed = commitFiles({
      mirrorDir: mirror,
      base,
      contentRoot: 'docs',
      author,
      message: 'Edit A\n',
      signOff: true,
      changes: [{ op: 'modify', path: 'docs/a.md', bytes: Buffer.from('# A2\n') }],
    });
    assert.equal(
      git(
        mirror,
        'log',
        '-1',
        '--format=%(trailers:key=Signed-off-by,valueonly)',
        signed.commit,
      ).trim(),
      'Writer <writer@example.com>',
    );
  });

  it('refuses what the guards forbid', () => {
    const attempt = (changes: Parameters<typeof commitFiles>[0]['changes']) => () =>
      commitFiles({ mirrorDir: mirror, base, contentRoot: 'docs', author, message: 'x', changes });
    const one = Buffer.from('x');
    const cases: [string, ReturnType<typeof attempt>, RegExp][] = [
      ['empty', attempt([]), /empty commit/],
      [
        'outside the content root',
        attempt([{ op: 'add', path: 'src/x.md', bytes: one }]),
        /outside docs/,
      ],
      [
        'a workflow file',
        attempt([{ op: 'modify', path: '.github/workflows/ci.yml', bytes: one }]),
        /hidden paths/,
      ],
      [
        'a hidden file inside the content root',
        attempt([{ op: 'add', path: 'docs/.env', bytes: one }]),
        /hidden paths/,
      ],
      [
        'path traversal',
        attempt([{ op: 'add', path: 'docs/../x.md', bytes: one }]),
        /refusing path/,
      ],
      [
        'the same path twice',
        attempt([
          { op: 'modify', path: 'docs/a.md', bytes: one },
          { op: 'delete', path: 'docs/a.md' },
        ]),
        /changed twice/,
      ],
      [
        'add over an existing file',
        attempt([{ op: 'add', path: 'docs/a.md', bytes: one }]),
        /already exists/,
      ],
      [
        'modify a missing file',
        attempt([{ op: 'modify', path: 'docs/nope.md', bytes: one }]),
        /does not exist/,
      ],
      [
        'rename onto an existing file',
        attempt([{ op: 'rename', oldPath: 'docs/old.md', path: 'docs/a.md', bytes: one }]),
        /already exists/,
      ],
      [
        'too large',
        attempt([{ op: 'add', path: 'docs/big.md', bytes: Buffer.alloc(5_000_001) }]),
        /exceeds/,
      ],
      [
        'no change',
        attempt([{ op: 'modify', path: 'docs/a.md', bytes: Buffer.from('# A\n') }]),
        /changes nothing/,
      ],
    ];
    for (const [label, run, message] of cases) {
      assert.throws(
        run,
        (error: unknown) => error instanceof GuardError && message.test(error.message),
        label,
      );
    }
    assert.ok(
      commitFiles({
        mirrorDir: mirror,
        base,
        contentRoot: 'docs',
        author,
        message: 'yml',
        changes: [{ op: 'add', path: 'oxybook.yml', bytes: Buffer.from('title: T\n') }],
      }).commit,
      'oxybook.yml is allowed',
    );
    const atRoot = (repoPath: string) => () =>
      commitFiles({
        mirrorDir: mirror,
        base,
        contentRoot: '',
        author,
        message: 'root',
        changes: [{ op: 'add', path: repoPath, bytes: Buffer.from('# Top\n') }],
      });
    assert.ok(atRoot('top.md')().commit, 'a space rooted at the repository can write pages');
    assert.throws(atRoot('.github/workflows/new.yml'), /hidden paths/, 'but never a workflow');
  });
});

describe('mergeFile3', () => {
  const base = Buffer.from(
    '# Title\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n',
  );

  it('merges edits to different paragraphs', () => {
    const ours = Buffer.from(
      base.toString().replace('First paragraph.', 'First paragraph, edited in the draft.'),
    );
    const theirs = Buffer.from(
      base.toString().replace('Third paragraph.', 'Third paragraph, edited upstream.'),
    );
    const result = mergeFile3(base, ours, theirs);
    assert.equal(result.clean, true);
    assert.equal(
      result.bytes.toString(),
      '# Title\n\nFirst paragraph, edited in the draft.\n\nSecond paragraph.\n\nThird paragraph, edited upstream.\n',
    );
  });

  it('reports a conflict on the same paragraph, with markers', () => {
    const ours = Buffer.from(base.toString().replace('Second paragraph.', 'Second, by the draft.'));
    const theirs = Buffer.from(base.toString().replace('Second paragraph.', 'Second, upstream.'));
    const result = mergeFile3(base, ours, theirs);
    assert.equal(result.clean, false);
    assert.ok(!result.clean && result.reason === 'content' && result.conflicts === 1);
    assert.match(
      result.bytes.toString(),
      /<<<<<<< draft\nSecond, by the draft.\n=======\nSecond, upstream.\n>>>>>>> upstream/,
    );
  });

  it('short-cuts identical sides and refuses to merge differing binaries', () => {
    const ours = Buffer.from('mine\n');
    assert.deepEqual(
      mergeFile3(base, ours, base),
      { clean: true, bytes: ours },
      'upstream unchanged',
    );
    assert.deepEqual(mergeFile3(base, base, ours), { clean: true, bytes: ours }, 'draft unchanged');
    assert.deepEqual(
      mergeFile3(base, ours, ours),
      { clean: true, bytes: ours },
      'same edit both sides',
    );
    const png = (n: number) => Buffer.from([0x89, 0x50, 0, n]);
    const binary = mergeFile3(png(1), png(2), png(3));
    assert.ok(!binary.clean && binary.reason === 'binary');
  });
});
