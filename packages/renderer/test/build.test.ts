// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  buildNavTree,
  buildSiteVersion,
  clearRenderedBodyCache,
  isExcluded,
  parseDirConfig,
} from '../src/index.js';

describe('navigation and exclude rules', () => {
  it('orders directories and pages per _dir.yml, respects nav_title, and omits hidden pages', () => {
    const pages = [
      { path: 'index.md', url: '/', title: 'OxyBook test site' },
      {
        path: 'getting-started.md',
        url: '/getting-started',
        title: 'Getting started',
        navTitle: 'Start here',
      },
      { path: 'test-page-2.md', url: '/test-page-2', title: 'Test page 2' },
      { path: 'test-page.md', url: '/test-page', title: 'Test page' },
      { path: 'guides/index.mdx', url: '/guides', title: 'Guides overview' },
      { path: 'guides/configure.mdx', url: '/guides/configure', title: 'Configure' },
      { path: 'guides/install.md', url: '/guides/install', title: 'Install' },
      { path: 'reference/commands.md', url: '/reference/commands', title: 'CLI commands' },
      { path: 'reference/environment.md', url: '/reference/env', title: 'Environment variables' },
      {
        path: 'reference/internal-notes.md',
        url: '/reference/internal-notes',
        title: 'Internal notes',
        hidden: true,
      },
    ];

    const dirConfigs = {
      '': parseDirConfig(
        'title: OxyBook test site\norder:\n  - getting-started\n  - guides\n  - reference\n',
      ),
      guides: parseDirConfig('title: Guides\norder:\n  - install\n  - configure\n'),
      reference: parseDirConfig('title: Reference\n'),
    };

    const nav = buildNavTree(pages, dirConfigs);
    assert.deepEqual(
      nav.map((item) => ({
        name: item.name,
        title: item.title,
        url: item.url,
        children: item.children.map((c) => ({ name: c.name, title: c.title, url: c.url })),
      })),
      [
        { name: 'index', title: 'OxyBook test site', url: '/', children: [] },
        { name: 'getting-started', title: 'Start here', url: '/getting-started', children: [] },
        {
          name: 'guides',
          title: 'Guides',
          url: '/guides',
          children: [
            { name: 'install', title: 'Install', url: '/guides/install' },
            { name: 'configure', title: 'Configure', url: '/guides/configure' },
          ],
        },
        {
          name: 'reference',
          title: 'Reference',
          url: null,
          children: [
            { name: 'commands', title: 'CLI commands', url: '/reference/commands' },
            { name: 'environment', title: 'Environment variables', url: '/reference/env' },
          ],
        },
        { name: 'test-page', title: 'Test page', url: '/test-page', children: [] },
        { name: 'test-page-2', title: 'Test page 2', url: '/test-page-2', children: [] },
      ],
    );
  });

  it('matches exclude patterns for exact files, directories, and globs', () => {
    const patterns = ['drafts', 'internal/secret.md', '*.wip.md', 'legacy/**'];
    assert.equal(isExcluded('drafts/idea.md', patterns), true);
    assert.equal(isExcluded('internal/secret.md', patterns), true);
    assert.equal(isExcluded('internal/public.md', patterns), false);
    assert.equal(isExcluded('notes.wip.md', patterns), true);
    assert.equal(isExcluded('legacy/v0/guide.md', patterns), true);
    assert.equal(isExcluded('guides/install.md', patterns), false);
  });
});

describe('buildSiteVersion', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'oxybook-build-test-'));

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('writes the build dir, runs Pagefind, hardlinks release, swaps current and by-host symlinks, and prunes old builds', async () => {
    clearRenderedBodyCache();
    const sitesDir = path.join(tmp, 'sites');
    const pages = [
      {
        path: 'index.md',
        blobSha: '1'.repeat(40),
        source: '# Welcome to OxyBook\n\nRead the [Install guide](guides/install.md).\n',
        url: '/',
        title: 'OxyBook test site',
      },
      {
        path: 'getting-started.md',
        blobSha: '2'.repeat(40),
        source: '---\nnav_title: Start here\n---\n\n# Getting started\n\nQuick setup steps.\n',
        url: '/getting-started',
        title: 'Getting started',
        navTitle: 'Start here',
      },
      {
        path: 'guides/index.mdx',
        blobSha: '3'.repeat(40),
        source: '# Guides\n\n![Stack](images/stack.svg)\n',
        url: '/guides',
        title: 'Guides',
      },
      {
        path: 'guides/install.md',
        blobSha: '4'.repeat(40),
        source: '# Install\n\nRun `docker compose up`.\n',
        url: '/guides/install',
        title: 'Install',
      },
      {
        path: 'reference/internal-notes.md',
        blobSha: '5'.repeat(40),
        source: '---\nhidden: true\n---\n\n# Internal notes\n\nUnlisted page.\n',
        url: '/reference/internal-notes',
        title: 'Internal notes',
        hidden: true,
      },
      {
        path: 'drafts/skip.md',
        blobSha: '6'.repeat(40),
        source: '# Excluded draft\n',
        url: '/drafts/skip',
        title: 'Excluded draft',
      },
    ];

    const assets = [
      {
        path: 'guides/images/stack.svg',
        bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8'),
      },
    ];

    const oxybookYaml = [
      'title: OxyBook test site',
      'exclude:',
      '  - drafts',
      'redirects:',
      '  - from: /old-home',
      '    to: /getting-started',
    ].join('\n');

    const dirConfigs = {
      '': 'title: OxyBook test site\norder:\n  - getting-started\n  - guides\n',
      guides: 'title: Guides\norder:\n  - install\n',
    };

    const first = await buildSiteVersion({
      spaceId: 'space-1',
      spaceSlug: 'test',
      spaceName: 'Test',
      version: 'default',
      commitSha: 'a'.repeat(40),
      buildId: 'build-1',
      sitesDir,
      sitesDomain: 'docs.localhost',
      oxybookYaml,
      dirConfigs,
      pages,
      assets,
      inferredRedirects: [{ from: '/reference/cli', to: '/guides/install' }],
      keepBuilds: 2,
    });

    assert.equal(first.pageCount, 5, 'drafts/skip.md is excluded');
    assert.equal(first.cachedPageCount, 0);
    assert.equal(first.assetCount, 1);
    assert.equal(first.redirectCount, 2);
    assert.equal(first.indexedPageCount, 4, '4 non-hidden pages indexed by Pagefind');
    assert.deepEqual(first.warnings, []);

    const byHostCurrent = path.join(sitesDir, 'by-host', 'test.docs.localhost', 'current');
    assert.equal(
      readlinkSync(path.join(sitesDir, 'by-host', 'test.docs.localhost')),
      '../spaces/space-1',
    );
    assert.equal(
      readlinkSync(path.join(sitesDir, 'spaces', 'space-1', 'current')),
      `releases/${'a'.repeat(12)}-build-1`,
    );

    const homeHtml = readFileSync(path.join(byHostCurrent, 'index.html'), 'utf8');
    assert.match(homeHtml, /<title>OxyBook test site<\/title>/);
    assert.match(homeHtml, /Welcome to OxyBook/);
    assert.match(homeHtml, /href="\/guides\/install"/);
    assert.match(homeHtml, /<a href="\/" aria-current="page">OxyBook test site<\/a>/);
    assert.match(homeHtml, /<a href="\/getting-started">Start here<\/a>/);
    assert.ok(!homeHtml.includes('Internal notes'), 'hidden page omitted from sidebar');
    assert.ok(
      existsSync(path.join(byHostCurrent, 'reference/internal-notes.html')),
      'hidden page still built at its URL',
    );

    // Directory index page `/guides` has both `guides.html` and `guides/index.html` hardlinked.
    const guidesHtmlStat = statSync(path.join(byHostCurrent, 'guides.html'));
    const guidesIndexStat = statSync(path.join(byHostCurrent, 'guides', 'index.html'));
    assert.equal(guidesHtmlStat.ino, guidesIndexStat.ino);

    // Release tree is hardlinked from the build dir (same inode, zero copied file data).
    const buildHomeStat = statSync(path.join(first.buildDir, 'index.html'));
    const releaseHomeStat = statSync(path.join(first.releaseDir, 'index.html'));
    assert.equal(buildHomeStat.ino, releaseHomeStat.ino);
    assert.ok(releaseHomeStat.nlink >= 2);

    // Assets, redirects, 404.html, and Pagefind bundle exist in the served release.
    assert.ok(existsSync(path.join(byHostCurrent, 'guides/images/stack.svg')));
    assert.ok(existsSync(path.join(byHostCurrent, '404.html')));
    const redirectHtml = readFileSync(path.join(byHostCurrent, 'reference/cli.html'), 'utf8');
    assert.match(redirectHtml, /http-equiv="refresh" content="0; url=\/guides\/install"/);
    assert.ok(existsSync(path.join(byHostCurrent, 'pagefind/pagefind-entry.json')));
    assert.ok(existsSync(path.join(byHostCurrent, 'pagefind/pagefind-ui.js')));

    // Second and third builds hit the rendered-body cache and prune build-1 (keepBuilds: 2).
    const second = await buildSiteVersion({
      spaceId: 'space-1',
      spaceSlug: 'test',
      spaceName: 'Test',
      version: 'default',
      commitSha: 'b'.repeat(40),
      buildId: 'build-2',
      sitesDir,
      oxybookYaml,
      dirConfigs,
      pages,
      assets,
      keepBuilds: 2,
      indexSearch: false,
    });
    assert.equal(second.cachedPageCount, 5);

    const third = await buildSiteVersion({
      spaceId: 'space-1',
      spaceSlug: 'test',
      spaceName: 'Test',
      version: 'default',
      commitSha: 'c'.repeat(40),
      buildId: 'build-3',
      sitesDir,
      oxybookYaml,
      dirConfigs,
      pages,
      assets,
      keepBuilds: 2,
      indexSearch: false,
    });
    assert.equal(
      readlinkSync(path.join(sitesDir, 'spaces', 'space-1', 'current')),
      `releases/${'c'.repeat(12)}-build-3`,
    );
    const keptBuilds = readdirSync(path.join(sitesDir, 'builds', 'space-1', 'default'));
    const keptReleases = readdirSync(path.join(sitesDir, 'spaces', 'space-1', 'releases'));
    assert.equal(keptBuilds.length, 2);
    assert.equal(keptReleases.length, 2);
    assert.ok(keptReleases.includes(`${'c'.repeat(12)}-build-3`));
    assert.ok(existsSync(path.join(third.releaseDir, 'index.html')));
    assert.ok(lstatSync(path.join(sitesDir, 'spaces', 'space-1', 'current')).isSymbolicLink());
  });
});
