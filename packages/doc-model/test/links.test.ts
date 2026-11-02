// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  hrefBetween,
  isExternalHref,
  listMarkdownFiles,
  resolveHref,
  rewriteLinks,
  scanLinks,
  splitHref,
} from '../src/index.js';

const SOURCE = `---
title: Links
---

# Links [with brackets] here

See [the [install] page](install.md#top "Install it") and ![a diagram](images/d.svg).
An angled one: [x](<my page.md>), an escaped one: [y](a\\(b\\).md), and [ext](https://example.com/install.md).

[ref]: ./install.md 'Reference'

<div>
  <a href="install.md">raw HTML is kept as is</a>
</div>
`;

describe('link destinations', () => {
  it('finds inline links, images, angled and escaped destinations, and definitions', () => {
    const scan = scanLinks(SOURCE, { filename: 'docs/links.md' });
    assert.ok(scan);
    assert.deepEqual(
      scan.links.map((l) => [l.kind, l.raw, l.angled, SOURCE.slice(l.start, l.end)]),
      [
        ['link', 'install.md#top', false, 'install.md#top'],
        ['image', 'images/d.svg', false, 'images/d.svg'],
        ['link', 'my page.md', true, 'my page.md'],
        ['link', 'a\\(b\\).md', false, 'a\\(b\\).md'],
        ['link', 'https://example.com/install.md', false, 'https://example.com/install.md'],
        ['definition', './install.md', false, './install.md'],
      ],
    );
    assert.equal(scan.rawBlocks.length, 1);
    assert.match(scan.rawBlocks[0]?.source ?? '', /install\.md/);
  });

  it('rewrites only destination bytes, keeping fragments, titles, and raw blocks', () => {
    const out = rewriteLinks(SOURCE, { filename: 'docs/links.md' }, (raw) => {
      const { path, suffix } = splitHref(raw);
      return resolveHref('docs/links.md', path) === 'docs/install.md'
        ? `guides/setup.md${suffix}`
        : null;
    });
    assert.ok(out);
    assert.equal(out.changed.length, 2);
    assert.equal(
      out.text,
      SOURCE.replace('(install.md#top "Install it")', '(guides/setup.md#top "Install it")').replace(
        '[ref]: ./install.md',
        '[ref]: guides/setup.md',
      ),
    );
    // A destination with a space gets brackets.
    const spaced = rewriteLinks('[a](b.md)\n', { filename: 'x.md' }, () => 'new page.md');
    assert.equal(spaced?.text, '[a](<new page.md>)\n');
  });

  it('resolves and builds relative paths', () => {
    assert.equal(resolveHref('docs/guides/a.md', '../install.md#x'), 'docs/install.md');
    assert.equal(resolveHref('docs/a.md', './sub/b%20c.md'), 'docs/sub/b c.md');
    assert.equal(resolveHref('docs/a.md', '../../outside.md'), null);
    assert.equal(resolveHref('docs/a.md', 'https://x.org/a.md'), null);
    assert.equal(hrefBetween('docs/guides/a.md', 'docs/install.md'), '../install.md');
    assert.equal(hrefBetween('docs/a.md', 'docs/guides/b.md'), 'guides/b.md');
    assert.ok(isExternalHref('mailto:a@example.com'));
    assert.ok(isExternalHref('#section'));
    assert.ok(isExternalHref('/absolute'));
    assert.deepEqual(splitHref('a.md?x=1#y'), { path: 'a.md', suffix: '?x=1#y' });
  });

  it('round-trips every relative link in the committed fixtures, touching nothing else', () => {
    const root = fileURLToPath(new URL('../../../corpus/fixtures/', import.meta.url));
    for (const file of listMarkdownFiles(root)) {
      const source = readFileSync(file, 'utf8');
      const there = rewriteLinks(source, { filename: file }, (raw) =>
        isExternalHref(raw) ? null : `../zz/${raw}`,
      );
      if (!there) continue;
      const back = rewriteLinks(there.text, { filename: file }, (raw) =>
        raw.startsWith('../zz/') ? raw.slice(6) : null,
      );
      assert.equal(back?.text, source, file);
    }
  });
});
