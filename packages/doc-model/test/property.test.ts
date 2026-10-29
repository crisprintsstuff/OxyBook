// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { insertIntoTextSpan, listPlainTextSpans } from '../src/edit.js';
import { checkIdentity } from '../src/identity.js';
import { parse } from '../src/parse.js';
import { changedRegion, isLineAligned, regionWithin } from '../src/range.js';
import { serialize } from '../src/serialize.js';

const fixtures = fileURLToPath(new URL('../../../corpus/fixtures/', import.meta.url));

const word = fc
  .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'), { minLength: 1, maxLength: 8 })
  .map((chars) => chars.join(''));

const sentence = fc.array(word, { minLength: 1, maxLength: 8 }).map((words) => words.join(' '));

const block = fc.oneof(
  sentence,
  sentence.map((text) => `*${text}*`),
  fc
    .integer({ min: 1, max: 6 })
    .chain((level) => sentence.map((text) => `${'#'.repeat(level)} ${text}`)),
  fc
    .constantFrom('-', '*', '+')
    .chain((marker) =>
      fc
        .array(sentence, { minLength: 1, maxLength: 4 })
        .map((items) => items.map((item) => `${marker} ${item}`).join('\n')),
    ),
  sentence.map((text) => `\`\`\`\n${text}\n\`\`\``),
  fc
    .array(sentence, { minLength: 1, maxLength: 3 })
    .map((lines) => lines.map((line) => `> ${line}`).join('\n')),
  fc.array(word, { minLength: 2, maxLength: 3 }).chain((header) =>
    fc
      .array(fc.array(word, { minLength: header.length, maxLength: header.length }), {
        minLength: 1,
        maxLength: 2,
      })
      .map((rows) => {
        const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
        return [line(header), `| ${header.map(() => '---').join(' | ')} |`, ...rows.map(line)].join(
          '\n',
        );
      }),
  ),
);

const document = fc
  .array(block, { minLength: 1, maxLength: 5 })
  .map((blocks) => `${blocks.join('\n\n')}\n`);

function confinedEdit(source: string, filename: string): void {
  const parsed = parse(source, { filename });
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.error);
  if (!parsed.ok) return;
  for (const block of parsed.doc.blocks) {
    assert.equal(isLineAligned(source, block.start, block.end), true, block.type);
  }
  const spans = listPlainTextSpans(parsed.doc);
  if (spans.length === 0) return;
  const span = spans[0];
  assert.ok(span);
  const block = parsed.doc.blocks.find((candidate) => candidate.id === span.blockId);
  assert.ok(block);
  const out = serialize(insertIntoTextSpan(parsed.doc, span, span.value.length, ' Xx'));
  assert.ok(out.includes(' Xx'));
  const region = changedRegion(source, out);
  assert.ok(region, 'edit produced no diff');
  assert.equal(regionWithin(region, block.start, block.end), true, `${filename} ${block.type}`);
}

describe('property: identity and confined edits', () => {
  it('round-trips generated documents, including CRLF and a BOM', () => {
    fc.assert(
      fc.property(document, (source) => {
        assert.equal(checkIdentity(source, { filename: 'gen.md' }).status, 'pass');
        const crlf = source.replace(/\n/g, '\r\n');
        assert.equal(checkIdentity(crlf, { filename: 'gen.md' }).status, 'pass');
        assert.equal(checkIdentity(`\uFEFF${source}`, { filename: 'gen.md' }).status, 'pass');
      }),
      { numRuns: 40, seed: 20261029 },
    );
  });

  it('keeps a random single-block edit inside that block', () => {
    fc.assert(
      fc.property(document, fc.integer({ min: 0, max: 10_000 }), (source, salt) => {
        const parsed = parse(source, { filename: 'gen.md' });
        assert.equal(parsed.ok, true);
        if (!parsed.ok) return;
        const spans = listPlainTextSpans(parsed.doc);
        fc.pre(spans.length > 0);
        const span = spans[salt % spans.length];
        assert.ok(span);
        const block = parsed.doc.blocks.find((candidate) => candidate.id === span.blockId);
        assert.ok(block);
        assert.equal(isLineAligned(source, block.start, block.end), true);
        const out = serialize(insertIntoTextSpan(parsed.doc, span, span.value.length, ' Xx'));
        const region = changedRegion(source, out);
        assert.ok(region);
        assert.equal(regionWithin(region, block.start, block.end), true);
      }),
      { numRuns: 40, seed: 20261029 },
    );
  });

  it('confines an edit on every parseable adversarial fixture', () => {
    for (const name of readdirSync(fixtures)) {
      if (!name.endsWith('.md') && !name.endsWith('.mdx')) continue;
      const source = readFileSync(path.join(fixtures, name), 'utf8');
      const report = checkIdentity(source, { filename: name });
      if (report.status !== 'pass') continue;
      confinedEdit(source, name);
    }
  });
});
