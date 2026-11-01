// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openEditorDocument } from '@oxybook/doc-model';
import { editMarker, FIXTURE_SOURCE, MARKER_PREFIX, patchChanges } from '../src/m2-exit.js';

describe('m2:exit helpers', () => {
  it('the fixture opens visually with JSX, raw HTML, and unusual frontmatter', () => {
    const opened = openEditorDocument(FIXTURE_SOURCE, { filename: 'docs/m2-exit.mdx' });
    assert.equal(opened.mode, 'visual');
    if (opened.mode !== 'visual') return;
    const kinds = opened.state.doc.content.map((b) =>
      b.type === 'raw_block' ? b.attrs.kind : b.type,
    );
    assert.ok(kinds.includes('mdx-jsx'), `JSX blocks in ${kinds.join(', ')}`);
    assert.ok(opened.frontmatter.unknownKeys.some((k) => k.key === 'notes'));
  });

  it('edits only the marker paragraph, run after run', () => {
    const first = editMarker(FIXTURE_SOURCE, 'docs/m2-exit.mdx', 'run-1');
    assert.deepEqual(first.removed, [`${MARKER_PREFIX} none yet.`]);
    assert.deepEqual(first.added, [`${MARKER_PREFIX} run-1.`]);
    assert.equal(
      first.text,
      FIXTURE_SOURCE.replace(`${MARKER_PREFIX} none yet.`, `${MARKER_PREFIX} run-1.`),
    );
    const second = editMarker(first.text, 'docs/m2-exit.mdx', 'run-2');
    assert.deepEqual(second.removed, [`${MARKER_PREFIX} run-1.`]);
    assert.equal(second.text, first.text.replace('run-1.', 'run-2.'));
    assert.throws(() => editMarker('# no marker\n', 'docs/x.md', 'r'), /no paragraph/);
  });

  it('reads the removed and added lines of a GitHub patch', () => {
    assert.deepEqual(
      patchChanges(
        '@@ -18,7 +18,7 @@ heading\n context\n-old line\n+new line\n context\n\\ No newline at end of file',
      ),
      { removed: ['old line'], added: ['new line'] },
    );
  });
});
