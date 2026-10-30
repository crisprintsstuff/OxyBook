// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  changedRegion,
  deleteEditorBlock,
  insertEditorBlock,
  listMarkdownFiles,
  markBlocksDirtyFromPmSteps,
  moveEditorBlock,
  openEditorDocument,
  regionWithin,
  serializeEditorState,
  updateEditorBlock,
  updateEditorFrontmatter,
} from '../src/index.js';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const FIXTURES_DIR = path.join(REPO_ROOT, 'corpus', 'fixtures');

describe('editor document model & dirty-block bridge (M2 slice 1)', () => {
  it('round-trips every parseable fixture with 100% identity and routes unparseable files to source-only mode', () => {
    const fixtureFiles = listMarkdownFiles(FIXTURES_DIR);
    assert.ok(fixtureFiles.length >= 28, 'expected committed fixtures');

    let visualCount = 0;
    let sourceOnlyCount = 0;

    for (const file of fixtureFiles) {
      const raw = readFileSync(file);
      let source: string;
      try {
        source = new TextDecoder('utf-8', { fatal: true }).decode(raw);
      } catch {
        continue;
      }
      const opened = openEditorDocument(source, { filename: file });
      if (opened.mode === 'source-only') {
        sourceOnlyCount++;
        assert.equal(opened.reason, 'unparseable');
        assert.equal(opened.source, source);
      } else {
        visualCount++;
        assert.equal(serializeEditorState(opened.state), source, `identity failed on ${file}`);
      }
    }

    assert.equal(visualCount, 27);
    assert.equal(sourceOnlyCount, 1);
  });

  it('edits one paragraph in an .mdx page with JSX, raw HTML, and unusual frontmatter and touches only that paragraph', () => {
    const mdxSource = [
      '---',
      '# Leading comment preserved byte-for-byte',
      "title: 'Configuring OxyBook'",
      'defaults: &def',
      '  owner: docs-team',
      'custom_meta:',
      '  <<: *def',
      '  sidebar_position: 4',
      '---',
      '',
      "import Tabs from '@theme/Tabs';",
      "import TabItem from '@theme/TabItem';",
      '',
      '# Configuring OxyBook',
      '',
      'First paragraph stays untouched with [reference link][cfg-ref] and inline `<Badge />`.',
      '',
      '<Tabs groupId="env">',
      '  <TabItem value="cli" label="CLI">',
      '    Run `oxybook sync`.',
      '  </TabItem>',
      '</Tabs>',
      '',
      '{/* MDX comment that must not move */}',
      '',
      '<div className="legacy-banner" data-x="1">Raw HTML block</div>',
      '',
      'Target paragraph before edit with <Badge variant="tip">v1</Badge> inline JSX.',
      '',
      ':::tip Custom Callout Title',
      'Keep the marker lines exact.',
      ':::',
      '',
      '[cfg-ref]: ./reference.md',
      '',
    ].join('\n');

    const opened = openEditorDocument(mdxSource, { filename: 'guides/configure.mdx' });
    assert.equal(opened.mode, 'visual');

    // Verify metadata panel inspection
    assert.equal(opened.frontmatter.exists, true);
    assert.equal(opened.frontmatter.parseable, true);
    assert.equal(opened.frontmatter.known.title, 'Configuring OxyBook');
    assert.deepEqual(
      opened.frontmatter.unknownKeys.map((u) => u.key),
      ['defaults', 'custom_meta'],
    );

    // Find the target paragraph ("Target paragraph before edit...")
    const targetIdx = opened.state.doc.content.findIndex(
      (b) =>
        b.type === 'paragraph' &&
        b.content.some(
          (inl) => inl.type === 'text' && inl.text.includes('Target paragraph before edit'),
        ),
    );
    assert.ok(targetIdx >= 0, 'expected to find target paragraph');

    const targetBlock = opened.state.doc.content[targetIdx];
    assert.ok(targetBlock && targetBlock.type === 'paragraph');
    const srcId = targetBlock.attrs.srcId;
    assert.ok(srcId);
    const originalEntry = opened.state.sideTable.get(srcId);
    assert.ok(originalEntry);

    // Verify the inline <Badge variant="tip">v1</Badge> inside the paragraph is a raw_inline node
    const rawInline = targetBlock.content.find((inl) => inl.type === 'raw_inline');
    assert.ok(rawInline && rawInline.type === 'raw_inline');
    assert.equal(rawInline.attrs.kind, 'mdx-jsx');
    assert.equal(rawInline.attrs.source, '<Badge variant="tip">v1</Badge>');
    assert.match(rawInline.attrs.label, /MDX component <Badge>/);

    // Edit the text before <Badge>, keeping <Badge> untouched
    const editedParagraph = {
      ...targetBlock,
      content: targetBlock.content.map((inl) =>
        inl.type === 'text' && inl.text.includes('Target paragraph before edit')
          ? { ...inl, text: 'Target paragraph AFTER edit with ' }
          : inl,
      ),
    };

    const nextState = updateEditorBlock(opened.state, targetIdx, editedParagraph);
    const serialized = serializeEditorState(nextState);

    const region = changedRegion(mdxSource, serialized);
    assert.ok(region, 'expected a diff region');
    assert.ok(
      regionWithin(region, originalEntry.originalBlock.start, originalEntry.originalBlock.end),
      'expected changed bytes to lie strictly within the edited paragraph block',
    );

    // Every other line in the file must be identical
    const beforeLines = mdxSource.split('\n');
    const afterLines = serialized.split('\n');
    assert.equal(beforeLines.length, afterLines.length);
    const diffLineIndices = beforeLines
      .map((line, idx) => (line !== afterLines[idx] ? idx : -1))
      .filter((idx) => idx >= 0);
    assert.deepEqual(diffLineIndices, [27]);
    assert.equal(
      afterLines[27],
      'Target paragraph AFTER edit with <Badge variant="tip">v1</Badge> inline JSX.',
    );
  });

  it('preserves setext headings, reference links, hard breaks, callout markers, alerts, lists, and tables when edited', () => {
    const source = [
      'Setext Heading',
      '==============',
      '',
      'Paragraph with [full ref][id1], [collapsed][], and [shortcut] plus backslash\\',
      'and two-space  ',
      'line breaks.',
      '',
      ':::note Important Callout',
      'Inside callout.',
      ':::',
      '',
      '> [!WARNING]',
      '> Watch out for sharp edges.',
      '',
      '- [x] Task one',
      '- [ ] Task two',
      '',
      '| Col A | Col B |',
      '| ----- | ----- |',
      '| val 1 | val 2 |',
      '',
      '[id1]: https://example.com/1',
      '[collapsed]: https://example.com/2',
      '[shortcut]: https://example.com/3',
      '',
    ].join('\n');

    const opened = openEditorDocument(source, { filename: 'doc.md' });
    assert.equal(opened.mode, 'visual');

    // 1. Edit the setext heading text; verify it stays setext (`===`)
    const headingBlock = opened.state.doc.content[0];
    assert.ok(headingBlock && headingBlock.type === 'heading');
    assert.equal(headingBlock.attrs.style, 'setext');
    let state = updateEditorBlock(opened.state, 0, {
      ...headingBlock,
      content: [{ type: 'text', text: 'Updated Setext Heading' }],
    });

    // 2. Edit the paragraph with reference links and hard breaks; verify reference links and break styles survive
    const paraBlock = state.doc.content[1];
    assert.ok(paraBlock && paraBlock.type === 'paragraph');
    state = markBlocksDirtyFromPmSteps(
      state,
      [{ srcId: paraBlock.attrs.srcId, from: 10, to: 50 }],
      [{ oldStart: 20, oldEnd: 25, newStart: 20, newEnd: 28 }],
    );

    // 3. Edit inside the `:::note Important Callout` block; verify `:::note Important Callout` marker line stays intact
    const calloutBlock = state.doc.content[2];
    assert.ok(calloutBlock && calloutBlock.type === 'callout');
    assert.equal(calloutBlock.attrs.openerLine, ':::note Important Callout');
    state = updateEditorBlock(state, 2, {
      ...calloutBlock,
      content: [
        {
          type: 'paragraph',
          attrs: { srcId: null },
          content: [{ type: 'text', text: 'Updated callout body.' }],
        },
      ],
    });

    // 4. Edit inside the `> [!WARNING]` GitHub alert
    const alertBlock = state.doc.content[3];
    assert.ok(alertBlock && alertBlock.type === 'alert');
    assert.equal(alertBlock.attrs.alertKind, 'WARNING');
    state = updateEditorBlock(state, 3, {
      ...alertBlock,
      content: [
        {
          type: 'paragraph',
          attrs: { srcId: null },
          content: [{ type: 'text', text: 'Updated alert body.' }],
        },
      ],
    });

    const out = serializeEditorState(state);
    assert.match(out, /^Updated Setext Heading\n======================\n/);
    assert.ok(out.includes('[full ref][id1]'));
    assert.ok(out.includes('[collapsed][]'));
    assert.ok(out.includes('[shortcut]'));
    assert.ok(out.includes('backslash\\\nand two-space  \nline breaks.'));
    assert.ok(out.includes(':::note Important Callout\nUpdated callout body.\n:::'));
    assert.ok(out.includes('> [!WARNING]\n> Updated alert body.'));
  });

  it('moves, inserts, and deletes blocks while keeping unedited blocks byte-exact', () => {
    const source = [
      '# Title',
      '',
      'Paragraph A with *custom* spacing.',
      '',
      '<CustomWidget prop="keep-exact" />',
      '',
      'Paragraph B.',
      '',
    ].join('\n');

    const opened = openEditorDocument(source, { filename: 'page.mdx' });
    assert.equal(opened.mode, 'visual');

    // Move `<CustomWidget prop="keep-exact" />` (index 2) before `Paragraph A` (index 1)
    let state = moveEditorBlock(opened.state, 2, 1);
    const afterMove = serializeEditorState(state);
    assert.equal(
      afterMove,
      [
        '# Title',
        '',
        '<CustomWidget prop="keep-exact" />',
        '',
        'Paragraph A with *custom* spacing.',
        '',
        'Paragraph B.',
        '',
      ].join('\n'),
    );

    // Delete `<CustomWidget />` (now at index 1) and insert a new paragraph at the end
    state = deleteEditorBlock(state, 1);
    state = insertEditorBlock(state, state.doc.content.length, {
      type: 'paragraph',
      attrs: { srcId: null },
      content: [{ type: 'text', text: 'Paragraph C.' }],
    });
    const afterDeleteInsert = serializeEditorState(state);
    assert.equal(
      afterDeleteInsert,
      [
        '# Title',
        '',
        'Paragraph A with *custom* spacing.',
        '',
        'Paragraph B.',
        '',
        'Paragraph C.',
        '',
      ].join('\n'),
    );
  });

  it('updates existing and new frontmatter keys without disturbing comments or unknown keys', () => {
    const source = [
      '---',
      '# comment at top',
      'title: "Old Title" # inline comment',
      'custom_field: [1, 2, 3]',
      'shared: &primary',
      '  color: blue',
      'accent: *primary',
      '---',
      '',
      '# Heading',
      '',
    ].join('\n');

    const opened = openEditorDocument(source, { filename: 'page.md' });
    assert.equal(opened.mode, 'visual');

    let state = updateEditorFrontmatter(opened.state, 'title', 'New Title');
    state = updateEditorFrontmatter(state, 'description', 'Added description');
    state = updateEditorFrontmatter(state, 'hidden', true);

    const out = serializeEditorState(state);
    assert.equal(
      out,
      [
        '---',
        '# comment at top',
        'title: "New Title" # inline comment',
        'custom_field: [1, 2, 3]',
        'shared: &primary',
        '  color: blue',
        'accent: *primary',
        'description: Added description',
        'hidden: true',
        '---',
        '',
        '# Heading',
        '',
      ].join('\n'),
    );
  });
});
