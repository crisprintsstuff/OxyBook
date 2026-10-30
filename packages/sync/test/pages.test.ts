// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isPagePath, pageMeta, pageUrl, relativeToRoot } from '../src/pages.js';

describe('page rules', () => {
  it('knows which files are pages', () => {
    assert.equal(isPagePath('guides/install.md'), true);
    assert.equal(isPagePath('guides/index.mdx'), true);
    assert.equal(isPagePath('_partials/footer.md'), false);
    assert.equal(isPagePath('guides/_draft.md'), false);
    assert.equal(isPagePath('.github/x.md'), false);
    assert.equal(isPagePath('guides/_dir.yml'), false);
    assert.equal(isPagePath('images/a.png'), false);
    assert.equal(relativeToRoot('docs/a.md', 'docs'), 'a.md');
    assert.equal(relativeToRoot('docsx/a.md', 'docs'), null);
    assert.equal(relativeToRoot('a.md', ''), 'a.md');
  });

  it('derives URLs: index, README, case, slug', () => {
    const all = new Set([
      'index.md',
      'guides/index.mdx',
      'guides/Install.md',
      'ref/README.md',
      'other/README.md',
      'other/index.md',
    ]);
    assert.equal(pageUrl('index.md', all), '/');
    assert.equal(pageUrl('guides/index.mdx', all), '/guides');
    assert.equal(pageUrl('guides/Install.md', all), '/guides/Install');
    assert.equal(
      pageUrl('ref/README.md', all),
      '/ref',
      'README is the directory page without an index',
    );
    assert.equal(pageUrl('other/README.md', all), '/other/README', 'but not beside an index');
    assert.equal(pageUrl('reference/environment.md', all, 'env'), '/reference/env');
    assert.equal(pageUrl('reference/environment.md', all, '/environment/'), '/environment');
  });

  it('reads title, nav_title, hidden, slug, with fallbacks', () => {
    const meta = pageMeta(
      'a.md',
      Buffer.from(
        '---\ntitle: From frontmatter\nnav_title: Short\nhidden: true\nslug: x\n---\n\n# Heading\n\nBody\n',
      ),
    );
    assert.deepEqual(
      { title: meta.title, navTitle: meta.navTitle, hidden: meta.hidden, slug: meta.slug },
      { title: 'From frontmatter', navTitle: 'Short', hidden: true, slug: 'x' },
    );
    assert.equal(
      pageMeta('b.md', Buffer.from('Intro\n\n# The *first* H1\n')).title,
      'The first H1',
    );
    assert.equal(pageMeta('dir/c-page.mdx', Buffer.from('No heading here.\n')).title, 'c-page');
    assert.equal(pageMeta('d.md', Buffer.from('---\n: bad: yaml\n---\n# T\n')).title, 'T');
    assert.equal(
      pageMeta('e.mdx', Buffer.from('<Unclosed\n')).title,
      'e',
      'unparseable MDX still yields a title',
    );
  });
});
