// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const recorded = fileURLToPath(new URL('./recorded/', import.meta.url));

const BASE = 'alpha\n\nbeta\n\ngamma\n';

function git(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const stdout = execFileSync(
    'git',
    [
      '-c',
      'user.name=OxyBook Spike',
      '-c',
      'user.email=spike@example.com',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return { status: 0, stdout, stderr: '' };
}

function gitAllow(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(
      'git',
      [
        '-c',
        'user.name=OxyBook Spike',
        '-c',
        'user.email=spike@example.com',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failed.status ?? 1,
      stdout: failed.stdout ?? '',
      stderr: failed.stderr ?? '',
    };
  }
}

function commit(cwd: string, message: string): string {
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']).stdout.trim();
}

function write(cwd: string, file: string, text: string): void {
  const full = path.join(cwd, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, text);
}

function blob(cwd: string, spec: string): string {
  return git(cwd, ['cat-file', '-p', spec]).stdout;
}

function treeOid(stdout: string): string {
  const line = stdout.split('\n')[0]?.trim() ?? '';
  if (!/^[0-9a-f]{40}$/.test(line))
    throw new Error(`merge-tree did not start with a tree id:\n${stdout}`);
  return line;
}

function setup(): { dir: string; base: string; draft: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'oxybook-h2-'));
  git(dir, ['init', '-b', 'main']);
  write(dir, 'docs/page.md', BASE);
  const base = commit(dir, 'base');
  git(dir, ['checkout', '-b', 'draft']);
  write(dir, 'docs/page.md', BASE.replace('beta', 'beta draft'));
  const draft = commit(dir, 'draft');
  return { dir, base, draft };
}

function branchFrom(dir: string, name: string, base: string, mutate: () => void): void {
  git(dir, ['checkout', '-b', name, base]);
  mutate();
  commit(dir, name);
  git(dir, ['checkout', 'draft']);
}

describe('H2 conflict spike', () => {
  it('records merge-file and merge-tree outcomes for the concurrent-edit scenarios', () => {
    const { dir, base, draft } = setup();
    try {
      branchFrom(dir, 'upstream-same', base, () => {
        write(dir, 'docs/page.md', BASE.replace('beta', 'beta upstream'));
      });
      branchFrom(dir, 'upstream-other', base, () => {
        write(dir, 'docs/page.md', BASE.replace('gamma', 'gamma upstream'));
      });
      branchFrom(dir, 'upstream-rename', base, () => {
        git(dir, ['mv', 'docs/page.md', 'docs/guide.md']);
      });
      branchFrom(dir, 'upstream-delete', base, () => {
        git(dir, ['rm', 'docs/page.md']);
      });

      const ours = path.join(dir, 'ours.md');
      const baseFile = path.join(dir, 'base.md');
      const theirs = path.join(dir, 'theirs.md');
      writeFileSync(ours, blob(dir, `${draft}:docs/page.md`));
      writeFileSync(baseFile, blob(dir, `${base}:docs/page.md`));
      writeFileSync(theirs, blob(dir, 'upstream-same:docs/page.md'));
      const same = gitAllow(dir, [
        'merge-file',
        '-p',
        '-L',
        'draft',
        '-L',
        'base',
        '-L',
        'upstream',
        ours,
        baseFile,
        theirs,
      ]);
      assert.equal(same.status, 1);
      assert.equal(
        same.stdout,
        readFileSync(path.join(recorded, 'same-paragraph.merge-file.txt'), 'utf8'),
      );
      assert.match(same.stdout, /<<<<<<< draft/);
      assert.match(same.stdout, /beta draft/);
      assert.match(same.stdout, /beta upstream/);
      assert.doesNotMatch(same.stdout, /\|\|\|\|\|\|\|/);

      writeFileSync(theirs, blob(dir, 'upstream-other:docs/page.md'));
      const different = gitAllow(dir, [
        'merge-file',
        '-p',
        '-L',
        'draft',
        '-L',
        'base',
        '-L',
        'upstream',
        ours,
        baseFile,
        theirs,
      ]);
      assert.equal(different.status, 0);
      assert.equal(
        different.stdout,
        readFileSync(path.join(recorded, 'different-paragraph.md'), 'utf8'),
      );
      assert.match(different.stdout, /beta draft/);
      assert.match(different.stdout, /gamma upstream/);

      const conflictTree = gitAllow(dir, [
        '-c',
        'merge.conflictStyle=diff3',
        'merge-tree',
        '--write-tree',
        '--messages',
        'draft',
        'upstream-same',
      ]);
      assert.equal(conflictTree.status, 1);
      assert.match(conflictTree.stdout, /CONFLICT \(content\)/);
      const conflictOid = treeOid(conflictTree.stdout);
      const conflictBlob = git(dir, ['cat-file', '-p', `${conflictOid}:docs/page.md`]).stdout;
      assert.match(conflictBlob, /<<<<<<< /);
      assert.match(conflictBlob, /\|\|\|\|\|\|\| /);
      assert.match(conflictBlob, /beta draft/);
      assert.match(conflictBlob, /beta upstream/);
      assert.match(conflictBlob, /=======\nbeta upstream/);

      const clean = gitAllow(dir, [
        'merge-tree',
        '--write-tree',
        '--messages',
        'draft',
        'upstream-other',
      ]);
      assert.equal(clean.status, 0);
      assert.doesNotMatch(clean.stdout, /CONFLICT/);
      const cleanBlob = git(dir, [
        'cat-file',
        '-p',
        `${treeOid(clean.stdout)}:docs/page.md`,
      ]).stdout;
      assert.equal(cleanBlob, different.stdout);

      const renamed = gitAllow(dir, ['merge-tree', '--write-tree', 'draft', 'upstream-rename']);
      assert.equal(renamed.status, 0);
      const renameTree = treeOid(renamed.stdout);
      const renamePaths = git(dir, ['ls-tree', '-r', '--name-only', renameTree])
        .stdout.trim()
        .split('\n');
      assert.deepEqual(renamePaths, ['docs/guide.md']);
      const renamedBlob = git(dir, ['cat-file', '-p', `${renameTree}:docs/guide.md`]).stdout;
      assert.equal(renamedBlob, readFileSync(path.join(recorded, 'rename-guide.md'), 'utf8'));
      assert.match(renamedBlob, /beta draft/);

      const deleted = gitAllow(dir, [
        'merge-tree',
        '--write-tree',
        '--messages',
        'draft',
        'upstream-delete',
      ]);
      assert.equal(deleted.status, 1);
      assert.match(deleted.stdout, /CONFLICT \(modify\/delete\)/);
      const deleteTree = treeOid(deleted.stdout);
      const deletePaths = git(dir, ['ls-tree', '-r', '--name-only', deleteTree]).stdout.trim();
      assert.equal(deletePaths, 'docs/page.md');
      const deleteBlob = git(dir, ['cat-file', '-p', `${deleteTree}:docs/page.md`]).stdout;
      assert.equal(deleteBlob, readFileSync(path.join(recorded, 'delete-left.md'), 'utf8'));
      assert.doesNotMatch(deleteBlob, /<<<<<<<</);

      const remote = mkdtempSync(path.join(tmpdir(), 'oxybook-h2-remote-'));
      try {
        git(remote, ['init', '--bare', '-b', 'main']);
        git(dir, ['remote', 'add', 'origin', remote]);
        git(dir, ['push', 'origin', `${base}:refs/heads/main`]);
        git(dir, ['push', 'origin', `${draft}:refs/heads/oxybook/demo`]);
        const other = mkdtempSync(path.join(tmpdir(), 'oxybook-h2-other-'));
        try {
          git(other, ['clone', '--branch', 'oxybook/demo', remote, '.']);
          write(
            other,
            'docs/page.md',
            BASE.replace('beta', 'beta draft').replace('alpha', 'alpha from pr'),
          );
          git(other, [
            '-c',
            'user.name=Someone Else',
            '-c',
            'user.email=someone@example.com',
            'commit',
            '-am',
            'someone',
          ]);
          git(other, ['push', 'origin', 'oxybook/demo']);
        } finally {
          rmSync(other, { recursive: true, force: true });
        }
        git(dir, ['checkout', '--detach', draft]);
        write(dir, 'docs/page.md', `${BASE.replace('beta', 'beta draft')}followup\n`);
        const local = commit(dir, 'followup');
        const leased = gitAllow(dir, [
          'push',
          `--force-with-lease=refs/heads/oxybook/demo:${draft}`,
          'origin',
          `HEAD:refs/heads/oxybook/demo`,
        ]);
        assert.notEqual(leased.status, 0);
        assert.match(`${leased.stderr}\n${leased.stdout}`, /stale info|rejected/);
        const remoteTip = git(remote, ['rev-parse', 'oxybook/demo']).stdout.trim();
        assert.notEqual(remoteTip, local);
        git(dir, ['fetch', 'origin', 'oxybook/demo']);
        const fetched = git(dir, ['rev-parse', 'FETCH_HEAD']).stdout.trim();
        assert.equal(fetched, remoteTip);
        const mergedTree = gitAllow(dir, ['merge-tree', '--write-tree', local, fetched]);
        assert.equal(mergedTree.status, 0, mergedTree.stderr);
        const mergedOid = treeOid(mergedTree.stdout);
        const mergedBlob = git(dir, ['cat-file', '-p', `${mergedOid}:docs/page.md`]).stdout;
        assert.match(mergedBlob, /followup/);
        assert.match(mergedBlob, /alpha from pr/);
        const mergeCommit = git(dir, [
          'commit-tree',
          mergedOid,
          '-p',
          fetched,
          '-p',
          local,
          '-m',
          'merge PR branch update',
        ]).stdout.trim();
        const parents = git(dir, ['rev-parse', `${mergeCommit}^1`, `${mergeCommit}^2`])
          .stdout.trim()
          .split('\n');
        assert.deepEqual(parents, [fetched, local]);
        git(dir, ['push', 'origin', `${mergeCommit}:refs/heads/oxybook/demo`]);
        assert.equal(git(remote, ['rev-parse', 'oxybook/demo']).stdout.trim(), mergeCommit);
        git(dir, ['merge-base', '--is-ancestor', fetched, mergeCommit]);
        git(dir, ['merge-base', '--is-ancestor', local, mergeCommit]);
      } finally {
        rmSync(remote, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
