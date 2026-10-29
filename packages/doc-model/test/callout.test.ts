// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { insertIntoTextSpan, listPlainTextSpans } from '../src/edit.js';
import { checkIdentity } from '../src/identity.js';
import { parse } from '../src/parse.js';
import { changedRegion, regionWithin } from '../src/range.js';
import { serialize } from '../src/serialize.js';

const fixtures = fileURLToPath(new URL('../../../corpus/fixtures/', import.meta.url));

function docOf(source: string, filename = 'page.md') {
  const result = parse(source, { filename });
  if (!result.ok) throw new Error(result.error);
  return result.doc;
}

describe('titled container directives', () => {
  it('folds :::note Title into one callout and keeps the bytes', () => {
    const source = ':::note Title\n\nhello\n\n:::\n';
    assert.equal(checkIdentity(source, { filename: 'c.md' }).status, 'pass');
    const doc = docOf(source);
    assert.equal(doc.blocks.length, 1);
    const block = doc.blocks[0];
    assert.ok(block);
    assert.equal(block.type, 'callout');
    assert.equal(block.calloutName, 'note');
    assert.equal(block.calloutTitle, 'Title');
    assert.equal(block.calloutClosed, true);
    assert.equal(block.source, ':::note Title\n\nhello\n\n:::');
    const spans = listPlainTextSpans(doc);
    assert.deepEqual(
      spans.map((span) => span.value),
      ['hello'],
    );
    const span = spans[0];
    assert.ok(span);
    const out = serialize(insertIntoTextSpan(doc, span, span.value.length, ' Xx'));
    const region = changedRegion(source, out);
    assert.ok(region);
    assert.equal(regionWithin(region, block.start, block.end), true);
    assert.match(out, /:::note Title/);
    assert.match(out, /\n:::\n$/);
  });

  it('folds a bare :::tip and a bracket title', () => {
    const tip = 'Before\n\n:::tip\n\nbody\n\n:::\n';
    const tipDoc = docOf(tip);
    assert.equal(tipDoc.blocks.length, 2);
    assert.equal(tipDoc.blocks[1]?.type, 'callout');
    assert.equal(tipDoc.blocks[1]?.calloutName, 'tip');
    assert.equal(tipDoc.blocks[1]?.calloutTitle, null);
    assert.equal(checkIdentity(tip, { filename: 'c.md' }).status, 'pass');

    const spaced = '::: tip Title\n\nbody\n\n:::\n';
    const spacedDoc = docOf(spaced);
    assert.equal(spacedDoc.blocks[0]?.type, 'callout');
    assert.equal(spacedDoc.blocks[0]?.calloutName, 'tip');
    assert.equal(spacedDoc.blocks[0]?.calloutTitle, 'Title');
    assert.equal(checkIdentity(spaced, { filename: 'c.md' }).status, 'pass');

    const bracket = ':::note[A label]\n\nbody\n\n:::\n';
    const bracketDoc = docOf(bracket);
    assert.equal(bracketDoc.blocks.length, 1);
    assert.equal(bracketDoc.blocks[0]?.calloutTitle, 'A label');
    assert.equal(checkIdentity(bracket, { filename: 'c.md' }).status, 'pass');
  });

  it('keeps nested containers and blank lines inside the outer block', () => {
    const source = ':::note Outer\n\n:::tip Inner\n\nbody\n\n:::\n\n:::\n';
    assert.equal(checkIdentity(source, { filename: 'c.md' }).status, 'pass');
    const doc = docOf(source);
    assert.equal(doc.blocks.length, 1);
    const block = doc.blocks[0];
    assert.ok(block);
    assert.equal(block.calloutTitle, 'Outer');
    assert.match(block.source, /:::tip Inner/);
    assert.match(block.source, /\n\nbody\n\n/);
    const spans = listPlainTextSpans(doc).map((span) => span.value);
    assert.ok(spans.includes('body'));
    assert.equal(
      spans.some((value) => value.includes(':::')),
      false,
    );
  });

  it('treats an unclosed container as one raw block through EOF', () => {
    const source = 'Intro\n\n:::note Title\n\nhello\n';
    assert.equal(checkIdentity(source, { filename: 'c.md' }).status, 'pass');
    const doc = docOf(source);
    assert.equal(doc.blocks.length, 2);
    const block = doc.blocks[1];
    assert.ok(block);
    assert.equal(block.type, 'callout');
    assert.equal(block.calloutClosed, false);
    assert.equal(block.editable, false);
    assert.equal(block.rawKind, 'directive');
    assert.equal(block.end, source.length);
    assert.equal(doc.trailing, '');
    assert.match(block.source, /:::note Title/);
    assert.match(block.source, /hello\n$/);
  });

  it('does not invent a trailing newline when the closer is at EOF', () => {
    const source = ':::note Title\n\nhello\n\n:::';
    assert.equal(serialize(docOf(source)), source);
    const doc = docOf(source);
    assert.equal(doc.blocks.length, 1);
    assert.equal(doc.blocks[0]?.calloutClosed, true);
    assert.equal(doc.hasTrailingNewline, false);
    assert.equal(doc.trailing, '');
  });

  it('does not treat ::: inside a fence as a container', () => {
    const source = '```\n:::note Title\n:::\n```\n\nAfter\n';
    assert.equal(checkIdentity(source, { filename: 'c.md' }).status, 'pass');
    const doc = docOf(source);
    assert.equal(doc.blocks[0]?.type, 'code');
    assert.equal(doc.blocks[1]?.type, 'paragraph');
    assert.equal(
      doc.blocks.some((block) => block.type === 'callout'),
      false,
    );
  });

  it('round-trips the committed callout fixtures', () => {
    for (const name of [
      'callout-title.md',
      'callout-tip.md',
      'callout-nested.md',
      'callout-blank-lines.md',
      'callout-unclosed.md',
      'callout-eof.md',
      'docusaurus-callout.md',
      'directive-callout.md',
    ]) {
      const source = readFileSync(path.join(fixtures, name), 'utf8');
      const report = checkIdentity(source, { filename: name });
      assert.equal(report.status, 'pass', `${name}: ${report.detail ?? ''}`);
    }
    const eof = readFileSync(path.join(fixtures, 'callout-eof.md'), 'utf8');
    assert.equal(eof.endsWith('\n'), false);
    const unclosed = docOf(
      readFileSync(path.join(fixtures, 'callout-unclosed.md'), 'utf8'),
      'callout-unclosed.md',
    );
    assert.equal(unclosed.blocks.filter((block) => block.type === 'callout').length, 1);
    assert.equal(unclosed.blocks.find((block) => block.type === 'callout')?.calloutClosed, false);
  });
});
