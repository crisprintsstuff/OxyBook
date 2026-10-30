// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeSource, listMarkdownFiles } from '@oxybook/doc-model';
import {
  DEFAULT_ALLOWLIST,
  DEFAULT_DIRECTIVES,
  getSharedHighlighter,
  renderPageSync,
  STARTING_ALLOWLIST,
} from '../src/index.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const cacheRoot = path.join(repoRoot, 'corpus/cache');
const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'corpus/manifest.json'), 'utf8')) as {
  repos: { name: string; sha: string; paths: string[] }[];
};

describe('corpus rendering', () => {
  it('renders every corpus and fixture file and matches the Slice 1 compatibility report', {
    timeout: 600_000,
  }, async () => {
    const highlighter = await getSharedHighlighter();
    const fixtureRoot = path.join(repoRoot, 'corpus/fixtures');
    for (const file of listMarkdownFiles(fixtureRoot)) {
      const raw = readFileSync(file, 'utf8');
      const rel = `fixtures/${path.relative(fixtureRoot, file)}`;
      const expected = analyzeSource(raw, rel, { allowlist: STARTING_ALLOWLIST });
      const rendered = renderPageSync(raw, {
        filename: rel,
        allowlist: STARTING_ALLOWLIST,
        allowDirectives: [],
        highlighter,
      });
      assert.equal(rendered.parsed, expected.parsed, rel);
      assert.deepEqual(rendered.placeholders, expected.placeholders, rel);
    }

    let totalFiles = 0;
    let startingClean = 0;
    let m1Clean = 0;
    let m1WithCodeGroupClean = 0;
    const startingCounts = {
      'unknown-component': 0,
      'dynamic-props': 0,
      expression: 0,
      export: 0,
      directive: 0,
    };
    const m1DefaultCounts = {
      'unknown-component': 0,
      'dynamic-props': 0,
      expression: 0,
      export: 0,
      directive: 0,
    };

    for (const repo of manifest.repos) {
      const dest = path.join(cacheRoot, repo.name);
      assert.ok(
        existsSync(path.join(dest, '.git')),
        `${repo.name} is missing in corpus/cache; run pnpm test:corpus`,
      );
      const files = repo.paths.flatMap((docPath) => {
        const full = path.join(dest, docPath);
        return existsSync(full) ? listMarkdownFiles(full) : [];
      });
      for (const file of files) {
        totalFiles++;
        const raw = readFileSync(file, 'utf8');
        const rel = `${repo.name}/${path.relative(dest, file)}`;

        // 1. Exact match with Slice 1 STARTING_ALLOWLIST report per file.
        const expectedStart = analyzeSource(raw, rel, { allowlist: STARTING_ALLOWLIST });
        const renderedStart = renderPageSync(raw, {
          filename: rel,
          allowlist: STARTING_ALLOWLIST,
          allowDirectives: [],
          highlighter: null,
        });
        assert.equal(renderedStart.parsed, true, rel);
        assert.deepEqual(renderedStart.placeholders, expectedStart.placeholders, rel);
        if (renderedStart.placeholders.length === 0) startingClean++;
        for (const p of renderedStart.placeholders) {
          startingCounts[p.reason]++;
        }

        // 2. Exact match with Slice 1 M1 allowlist report per file.
        const expectedM1 = analyzeSource(raw, rel, { allowlist: DEFAULT_ALLOWLIST });
        const renderedM1 = renderPageSync(raw, {
          filename: rel,
          allowlist: DEFAULT_ALLOWLIST,
          allowDirectives: [],
          highlighter: null,
        });
        assert.deepEqual(renderedM1.placeholders, expectedM1.placeholders, rel);
        if (renderedM1.placeholders.length === 0) m1Clean++;

        // 3. Full render with Shiki highlighter, M1 allowlist, and ::: code-group.
        const renderedDefault = renderPageSync(raw, {
          filename: rel,
          allowlist: DEFAULT_ALLOWLIST,
          allowDirectives: DEFAULT_DIRECTIVES,
          highlighter,
        });
        assert.equal(renderedDefault.hast.type, 'root', rel);
        assert.equal(typeof renderedDefault.html, 'string', rel);
        if (renderedDefault.placeholders.length === 0) m1WithCodeGroupClean++;
        for (const p of renderedDefault.placeholders) {
          m1DefaultCounts[p.reason]++;
        }
      }
    }

    console.log(
      `corpus render summary: ${totalFiles} files, starting clean=${startingClean}/567, M1 clean=${m1Clean}/567, M1+code-group clean=${m1WithCodeGroupClean}/567`,
    );
    console.log('starting placeholders:', startingCounts);
    console.log('M1+code-group placeholders:', m1DefaultCounts);

    assert.equal(totalFiles, 567);
    assert.equal(startingClean, 286);
    assert.deepEqual(startingCounts, {
      'unknown-component': 2649,
      'dynamic-props': 1,
      expression: 27,
      export: 8,
      directive: 9,
    });
    assert.equal(m1Clean, 352);
    assert.equal(m1WithCodeGroupClean, 353);
    assert.deepEqual(m1DefaultCounts, {
      'unknown-component': 822,
      'dynamic-props': 33,
      expression: 27,
      export: 8,
      directive: 3,
    });
  });
});
