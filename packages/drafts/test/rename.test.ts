// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planRename, type SpaceFile } from '../src/index.js';

const file = (path: string, text: string, drafted: SpaceFile['drafted'] = null): SpaceFile => ({
  path,
  bytes: Buffer.from(text),
  baseBlobSha: drafted?.op === 'add' ? null : `${'0'.repeat(39)}${path.length % 10}`,
  drafted,
});

const INSTALL =
  '# Install\n\nBack to [home](../index.md), see [other](other.md), or [this](#steps).\n';
const INDEX = '# Home\n\nStart with [installing](guides/install.md#top "Install").\n';
const OTHER = '# Other\n\nSee [install](./install.md) and [ext](https://example.com/install.md).\n';
const CLI =
  '# CLI\n\n[setup]\n\n[setup]: ../guides/install.md\n\n<a href="../guides/install.md">raw</a>\n';
const CONFIG = '# site\nredirects:\n  - from: /a\n    to: /b\n';

describe('planRename', () => {
  const files = [
    file('docs/guides/install.md', INSTALL),
    file('docs/index.md', INDEX),
    file('docs/guides/other.md', OTHER),
    file('docs/ref/cli.md', CLI),
  ];
  const config = { bytes: Buffer.from(CONFIG), baseBlobSha: 'c'.repeat(40), drafted: false };

  it('moves the page, patches inbound and outbound links, and adds the redirect', () => {
    const plan = planRename({
      from: 'docs/guides/install.md',
      to: 'docs/setup/install.md',
      files,
      config,
      oldUrl: '/guides/install',
      newUrl: '/setup/install',
    });
    const byPath = new Map(plan.changes.map((c) => [c.path, c]));
    const moved = byPath.get('docs/setup/install.md');
    assert.equal(moved?.op, 'rename');
    assert.equal(moved?.oldPath, 'docs/guides/install.md');
    // ../index.md still resolves from the new directory; other.md does not.
    assert.equal(moved?.bytes?.toString(), INSTALL.replace('(other.md)', '(../guides/other.md)'));
    assert.equal(
      byPath.get('docs/index.md')?.bytes?.toString(),
      INDEX.replace('guides/install.md#top', 'setup/install.md#top'),
    );
    assert.equal(
      byPath.get('docs/guides/other.md')?.bytes?.toString(),
      OTHER.replace('(./install.md)', '(../setup/install.md)'),
    );
    assert.equal(
      byPath.get('docs/ref/cli.md')?.bytes?.toString(),
      CLI.replace('[setup]: ../guides/install.md', '[setup]: ../setup/install.md'),
    );
    assert.equal(byPath.get('docs/ref/cli.md')?.op, 'modify');
    assert.equal(
      byPath.get('oxybook.yml')?.bytes?.toString(),
      `${CONFIG}  - from: /guides/install\n    to: /setup/install\n`,
    );
    assert.deepEqual(plan.redirect, { from: '/guides/install', to: '/setup/install' });
    assert.deepEqual(plan.rawMentions, [{ path: 'docs/ref/cli.md', line: 7 }]);
    assert.deepEqual(plan.remove, []);
  });

  it('a page only in the draft is re-added without a redirect', () => {
    const plan = planRename({
      from: 'docs/new.md',
      to: 'docs/renamed.md',
      files: [file('docs/new.md', '# New\n', { op: 'add', oldPath: null })],
      config: { bytes: null, baseBlobSha: null, drafted: false },
      oldUrl: null,
      newUrl: '/renamed',
    });
    assert.deepEqual(plan.remove, ['docs/new.md']);
    assert.deepEqual(
      plan.changes.map((c) => [c.op, c.path]),
      [['add', 'docs/renamed.md']],
    );
    assert.equal(plan.redirect, null);
  });

  it('creates oxybook.yml when the repository has none', () => {
    const plan = planRename({
      from: 'docs/index.md',
      to: 'docs/home.md',
      files: [file('docs/index.md', INDEX)],
      config: { bytes: null, baseBlobSha: null, drafted: false },
      oldUrl: '/',
      newUrl: '/home',
    });
    const config = plan.changes.find((c) => c.path === 'oxybook.yml');
    assert.equal(config?.op, 'add');
    assert.equal(config?.bytes?.toString(), 'redirects:\n  - from: /\n    to: /home\n');
  });

  it('refuses a taken path, an extension change, and a no-op', () => {
    const base = { files, config, oldUrl: '/guides/install', newUrl: '/x' };
    assert.throws(
      () => planRename({ ...base, from: 'docs/guides/install.md', to: 'docs/index.md' }),
      /already exists/,
    );
    assert.throws(
      () => planRename({ ...base, from: 'docs/guides/install.md', to: 'docs/install.mdx' }),
      /\.md to \.mdx/,
    );
    assert.throws(
      () => planRename({ ...base, from: 'docs/guides/install.md', to: 'docs/guides/install.md' }),
      /same/,
    );
    assert.throws(
      () => planRename({ ...base, from: 'docs/nope.md', to: 'docs/x.md' }),
      /not a page/,
    );
  });
});
