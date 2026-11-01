// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { listMarkdownFiles, mergeUnits } from '@oxybook/doc-model';
import fc from 'fast-check';
import { conflictCount, mergeText, mergeUnitLists, resolveRegions } from '../src/merge3.js';

// The H2 spike's page (spikes/conflicts): three paragraphs.
const BASE = 'alpha\n\nbeta\n\ngamma\n';
const page = 'docs/page.md';

describe('block-level three-way merge', () => {
  it('same paragraph: one conflict region holding exactly that paragraph', () => {
    const regions = mergeText(
      BASE,
      BASE.replace('beta', 'beta draft'),
      BASE.replace('beta', 'beta upstream'),
      page,
    );
    assert.equal(conflictCount(regions), 1);
    const conflict = regions.find((r) => r.kind === 'conflict');
    assert.deepEqual(conflict, {
      kind: 'conflict',
      base: '\n\nbeta',
      mine: '\n\nbeta draft',
      theirs: '\n\nbeta upstream',
    });
    assert.equal(resolveRegions(regions, ['mine']), BASE.replace('beta', 'beta draft'));
    assert.equal(resolveRegions(regions, ['theirs']), BASE.replace('beta', 'beta upstream'));
    assert.equal(
      resolveRegions(regions, [{ text: '\n\nbeta both' }]),
      BASE.replace('beta', 'beta both'),
    );
  });

  it('different paragraphs merge cleanly, including adjacent ones git merge-file would refuse', () => {
    const different = mergeText(
      BASE,
      BASE.replace('beta', 'beta draft'),
      BASE.replace('gamma', 'gamma upstream'),
      page,
    );
    assert.equal(conflictCount(different), 0);
    assert.equal(resolveRegions(different, []), 'alpha\n\nbeta draft\n\ngamma upstream\n');
    // Adjacent lines: git merge-file conflicts here (no context line between the hunks).
    const tight = 'one\ntwo\n';
    const adjacent = mergeText(
      '# T\n\none\n\ntwo\n',
      '# T\n\nONE\n\ntwo\n',
      '# T\n\none\n\nTWO\n',
      page,
    );
    assert.equal(conflictCount(adjacent), 0);
    assert.equal(resolveRegions(adjacent, []), '# T\n\nONE\n\nTWO\n');
    assert.ok(tight);
  });

  it('a multi-line paragraph is one region, and the same change on both sides is not a conflict', () => {
    const base = '# Title\n\nline one\nline two\nline three\n\nend\n';
    const mine = base.replace('line one', 'LINE ONE');
    const theirs = base.replace('line three', 'LINE THREE');
    const regions = mergeText(base, mine, theirs, page);
    assert.equal(conflictCount(regions), 1);
    const conflict = regions.find((r) => r.kind === 'conflict');
    assert.equal(
      conflict?.kind === 'conflict' && conflict.mine,
      '\n\nLINE ONE\nline two\nline three',
    );
    const same = mergeText(base, mine, mine, page);
    assert.equal(conflictCount(same), 0);
    assert.equal(resolveRegions(same, []), mine);
  });

  it('raw blocks, frontmatter lines, CRLF, and BOM survive byte for byte', () => {
    const base =
      '﻿---\r\ntitle: A\r\ndescription: B\r\n---\r\n\r\n<Tabs>\r\n  <Tab>x</Tab>\r\n</Tabs>\r\n\r\npara\r\n';
    const mine = base.replace('title: A', 'title: A2');
    const theirs = base.replace('description: B', 'description: B2').replace('para', 'para 2');
    const regions = mergeText(base, mine, theirs, 'docs/page.mdx');
    assert.equal(conflictCount(regions), 0);
    assert.equal(
      resolveRegions(regions, []),
      base
        .replace('title: A', 'title: A2')
        .replace('description: B', 'description: B2')
        .replace('para', 'para 2'),
    );
  });

  it('insertions and deletions on both sides at different places merge', () => {
    const base = 'a\n\nb\n\nc\n\nd\n';
    const mine = 'a\n\nNEW\n\nb\n\nc\n\nd\n';
    const theirs = 'a\n\nb\n\nd\n';
    const regions = mergeText(base, mine, theirs, page);
    assert.equal(conflictCount(regions), 0);
    assert.equal(resolveRegions(regions, []), 'a\n\nNEW\n\nb\n\nd\n');
  });

  it('refuses the wrong number of choices', () => {
    const regions = mergeText(BASE, BASE.replace('beta', 'x'), BASE.replace('beta', 'y'), page);
    assert.throws(() => resolveRegions(regions, []), /no choice/);
    assert.throws(() => resolveRegions(regions, ['mine', 'theirs']), /2 choices for 1/);
  });

  it('never drops an edit without a choice (property, over the committed fixtures)', () => {
    const root = fileURLToPath(new URL('../../../corpus/fixtures/', import.meta.url));
    const files = listMarkdownFiles(root)
      .map((file) => ({
        file: path.relative(root, file),
        units: mergeUnits(readFileSync(file, 'utf8'), { filename: file }),
      }))
      .filter((f) => f.units.length >= 3);
    assert.ok(files.length > 10);
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: files.length - 1 }),
        fc.array(fc.nat(), { maxLength: 4 }),
        fc.array(fc.nat(), { maxLength: 4 }),
        (index, mineEdits, theirsEdits) => {
          const { units } = files[index] as { units: string[] };
          const edit = (picks: number[], tag: string) => {
            const out = [...units];
            for (const pick of picks) {
              const at = pick % out.length;
              out[at] = `${out[at]}<<${tag}${at}>>`;
            }
            return out;
          };
          const mine = edit(mineEdits, 'M');
          const theirs = edit(theirsEdits, 'T');
          const regions = mergeUnitLists(units, mine, theirs);
          const conflicts = conflictCount(regions);
          const allMine = resolveRegions(regions, Array(conflicts).fill('mine'));
          const allTheirs = resolveRegions(regions, Array(conflicts).fill('theirs'));
          const shown = regions
            .map((r) => (r.kind === 'conflict' ? r.mine + r.theirs : ''))
            .join('');
          const tags = (side: string[], tag: string) =>
            side.join('').match(new RegExp(`<<${tag}\\d+>>`, 'g')) ?? [];
          for (const tag of tags(mine, 'M')) {
            // Mine's edits are in the all-mine result, and either merged into all-theirs
            // or shown in a conflict region: never dropped without a choice.
            if (!allMine.includes(tag)) return false;
            if (!allTheirs.includes(tag) && !shown.includes(tag)) return false;
          }
          for (const tag of tags(theirs, 'T')) {
            if (!allTheirs.includes(tag)) return false;
            if (!allMine.includes(tag) && !shown.includes(tag)) return false;
          }
          return conflicts > 0 || allMine === allTheirs;
        },
      ),
      { numRuns: 400 },
    );
  });
});
