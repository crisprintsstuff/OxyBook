// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  altText,
  buildTreeRows,
  type DraftSummary,
  describeRename,
  describeWarning,
  diffLines,
  displayBlock,
  newPagePath,
  newPageSource,
  relativeLink,
  resolvedText,
  routeFromPath,
  type TreePage,
  uploadTarget,
} from '../src/model.ts';

const page = (relPath: string, title: string, extra: Partial<TreePage> = {}): TreePage => ({
  path: `docs/${relPath}`,
  relPath,
  url: `/${relPath.replace(/\.mdx?$/, '')}`,
  title,
  navTitle: null,
  hidden: false,
  blobSha: 'a'.repeat(40),
  othersEditing: [],
  ...extra,
});

const draft = (files: DraftSummary['files']): DraftSummary => ({
  id: 'd1',
  version: 3,
  state: 'editing',
  baseRef: 'main',
  baseSha: 'b'.repeat(40),
  branch: null,
  prNumber: null,
  prUrl: null,
  pushedSha: null,
  proposeError: null,
  files,
});

describe('editor model', () => {
  it('builds the sidebar with directories, draft marks, added pages, and a filter', () => {
    const pages = [
      page('index.md', 'Home'),
      page('guides/install.md', 'Install', { othersEditing: ['Alex'] }),
      page('guides/deep/tuning.mdx', 'Tuning', { navTitle: 'Tune it' }),
      page('reference/cli.md', 'CLI', { hidden: true }),
    ];
    const rows = buildTreeRows({
      pages,
      contentRoot: 'docs',
      draft: draft([
        { path: 'docs/guides/install.md', op: 'modify', oldPath: null },
        { path: 'docs/guides/new.md', op: 'add', oldPath: null },
        { path: 'docs/guides/images/shot.png', op: 'add', oldPath: null },
      ]),
    });
    assert.deepEqual(
      rows.map((r) =>
        r.kind === 'dir'
          ? `${'  '.repeat(r.depth)}${r.name}/`
          : `${'  '.repeat(r.depth)}${r.label}${r.mine ? ` [${r.mine}]` : ''}${r.othersEditing.length ? ' (others)' : ''}${r.added ? ' (new)' : ''}${r.hidden ? ' (hidden)' : ''}`,
      ),
      [
        'guides/',
        '  deep/',
        '    Tune it',
        '  Install [modify] (others)',
        '  new.md [add] (new)',
        'Home',
        'reference/',
        '  CLI (hidden)',
      ],
    );
    const filtered = buildTreeRows({ pages, contentRoot: 'docs', draft: null, filter: 'TUN' });
    assert.deepEqual(
      filtered.map((r) => (r.kind === 'dir' ? `${r.name}/` : r.label)),
      ['guides/', 'deep/', 'Tune it'],
    );
  });

  it('puts uploads in images/ next to the page, with a relative reference', () => {
    assert.deepEqual(uploadTarget('docs/guides/install.md', 'Screen Shot 1.PNG'), {
      path: 'docs/guides/images/screen-shot-1.png',
      reference: 'images/screen-shot-1.png',
    });
    assert.deepEqual(uploadTarget('README.md', '..svg'), {
      path: 'images/image.svg',
      reference: 'images/image.svg',
    });
    assert.equal(altText('My [diagram].png'), 'My  diagram');
  });

  it('checks new page paths and gives them a heading', () => {
    assert.deepEqual(newPagePath(' /guides/setup ', 'docs'), { path: 'docs/guides/setup.md' });
    assert.deepEqual(newPagePath('a.mdx', ''), { path: 'a.mdx' });
    assert.ok('error' in newPagePath('../escape.md', 'docs'));
    assert.ok('error' in newPagePath('.github/x.md', 'docs'));
    assert.ok('error' in newPagePath('   ', 'docs'));
    assert.equal(newPageSource('docs/guides/getting-started.md'), '# Getting started\n');
  });

  it('tags diff lines and describes warnings', () => {
    assert.deepEqual(
      diffLines('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n same\n').map((l) => l.kind),
      ['meta', 'meta', 'hunk', 'del', 'add', 'ctx'],
    );
    assert.equal(
      describeWarning({ reason: 'broken-link', href: 'nope.md', line: 3 }),
      'line 3: broken link nope.md',
    );
    assert.equal(
      describeWarning({ reason: 'unknown-component', name: 'Foo', line: null }),
      'unknown component (Foo)',
    );
  });

  it('reads the org and space from the URL', () => {
    assert.deepEqual(routeFromPath('/orgs/cris/spaces/test/edit'), { org: 'cris', space: 'test' });
    assert.equal(routeFromPath('/orgs/cris/spaces/test'), null);
  });

  it('links pages with relative file paths', () => {
    assert.equal(relativeLink('docs/guides/install.md', 'docs/guides/setup.md'), 'setup.md');
    assert.equal(
      relativeLink('docs/guides/install.md', 'docs/reference/cli.md'),
      '../reference/cli.md',
    );
    assert.equal(relativeLink('docs/index.md', 'docs/guides/deep/a.mdx'), 'guides/deep/a.mdx');
    assert.equal(relativeLink('docs/guides/deep/a.md', 'docs/index.md'), '../../index.md');
    assert.equal(relativeLink('README.md', 'docs/a.md'), 'docs/a.md');
  });

  it('builds a resolved file from per-conflict choices', () => {
    const regions = [
      { kind: 'same' as const, text: 'alpha' },
      { kind: 'conflict' as const, base: '\n\nbeta', mine: '\n\nbeta m', theirs: '\n\nbeta t' },
      { kind: 'theirs' as const, text: '\n\ngamma t', base: '\n\ngamma' },
      { kind: 'conflict' as const, base: '\n\nd', mine: '\n\nd m', theirs: '\n\nd t' },
      { kind: 'same' as const, text: '\n' },
    ];
    assert.equal(resolvedText(regions, ['mine']), null);
    assert.equal(
      resolvedText(regions, ['theirs', { text: '\n\nd both' }]),
      'alpha\n\nbeta t\n\ngamma t\n\nd both\n',
    );
    assert.equal(displayBlock('\r\n\r\nbeta'), 'beta');
  });

  it('shows a moved page under its new path with its title, and describes the rename', () => {
    const rows = buildTreeRows({
      pages: [page('install.md', 'Install'), page('index.md', 'Home')],
      contentRoot: 'docs',
      draft: draft([{ path: 'docs/setup/install.md', op: 'rename', oldPath: 'docs/install.md' }]),
    });
    assert.deepEqual(
      rows.map((r) => (r.kind === 'dir' ? `${r.name}/` : `${r.label} ${r.mine ?? ''}`.trim())),
      ['Home', 'setup/', 'Install rename'],
    );
    assert.equal(
      describeRename({
        version: 2,
        path: 'docs/setup/install.md',
        redirect: { from: '/install', to: '/setup/install' },
        patched: [
          { path: 'docs/index.md', links: 2 },
          { path: 'docs/setup/install.md', links: 1 },
        ],
        rawMentions: [{ path: 'docs/a.mdx', line: 4 }],
      }),
      'Moved to docs/setup/install.md. Updated 3 links in 2 files. /install will redirect to /setup/install. Check by hand: raw HTML or JSX mentions the old name in docs/a.mdx:4.',
    );
  });
});
