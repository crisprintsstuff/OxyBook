// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The corpus through the visual editor's ProseMirror path (M2 slice 4c). For every file
 * the bridge opens visually:
 *   1. loading it into ProseMirror and serializing with no edit gives the same bytes;
 *   2. typing into one paragraph changes only that paragraph's bytes.
 * Run `pnpm --filter @oxybook/doc-model test:corpus` first: it fetches the corpus.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { listMarkdownFiles } from '@oxybook/doc-model';
import { EditorState } from 'prosemirror-state';
import { openVisual, serializeVisual } from '../src/visual/bridge.ts';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'corpus/manifest.json'), 'utf8')) as {
  repos: { name: string; paths: string[] }[];
};

function corpus(): { name: string; file: string }[] {
  const out: { name: string; file: string }[] = [];
  const fixtures = path.join(repoRoot, 'corpus/fixtures');
  for (const file of listMarkdownFiles(fixtures))
    out.push({ name: `fixtures/${path.relative(fixtures, file)}`, file });
  for (const repo of manifest.repos) {
    const root = path.join(repoRoot, 'corpus/cache', repo.name);
    assert.ok(
      existsSync(root),
      `corpus/cache/${repo.name} is missing: run the doc-model corpus test first`,
    );
    for (const docPath of repo.paths) {
      const full = path.join(root, docPath);
      if (!existsSync(full)) continue;
      for (const file of listMarkdownFiles(full))
        out.push({ name: `${repo.name}/${path.relative(root, file)}`, file });
    }
  }
  return out;
}

describe('corpus through the visual editor', () => {
  it('round-trips every file and confines a paragraph edit to that paragraph', {
    timeout: 600_000,
  }, () => {
    const failures: string[] = [];
    let visual = 0;
    let edited = 0;
    for (const { name, file } of corpus()) {
      const bytes = readFileSync(file);
      const source = bytes.toString('utf8');
      if (!bytes.equals(Buffer.from(source, 'utf8'))) continue;
      const opened = openVisual(source, file);
      if (opened.mode === 'source-only') continue;
      visual++;
      const { session, doc } = opened;
      if (serializeVisual(session, doc) !== source) {
        failures.push(`${name}: unedited round-trip changed the bytes`);
        continue;
      }

      // Type at the end of the first top-level paragraph that has text.
      let target = -1;
      doc.forEach((node, _offset, index) => {
        if (target < 0 && node.type.name === 'paragraph' && node.textContent.trim() !== '')
          target = index;
      });
      if (target < 0) continue;
      let pos = 0;
      for (let i = 0; i < target; i++) pos += doc.child(i).nodeSize;
      const paragraph = doc.child(target);
      const state = EditorState.create({ doc });
      const after = state.apply(state.tr.insertText(' EDITED', pos + paragraph.nodeSize - 1)).doc;
      const out = serializeVisual(session, after);
      const block = session.model.sourceDoc.blocks[target];
      if (!block) {
        failures.push(`${name}: no source block ${target}`);
        continue;
      }
      edited++;
      const prefix = source.slice(0, block.start);
      const suffix = source.slice(block.end);
      if (!out.startsWith(prefix) || !out.endsWith(suffix)) {
        failures.push(`${name}: editing block ${target} changed bytes outside it`);
      } else if (!out.slice(prefix.length, out.length - suffix.length).includes('EDITED')) {
        failures.push(`${name}: the edit is missing from block ${target}`);
      }
    }
    console.log(`visual editor: ${visual} files round-trip, ${edited} paragraph edits confined`);
    assert.deepEqual(failures.slice(0, 30), []);
    assert.ok(visual > 500, `expected the whole corpus, saw ${visual} files`);
  });
});
