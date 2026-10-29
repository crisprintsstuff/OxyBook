// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { insertIntoTextSpan, listPlainTextSpans, reformatBlock } from '../src/edit.js';
import { setFrontmatterScalar } from '../src/frontmatter.js';
import { checkIdentity } from '../src/identity.js';
import { parse } from '../src/parse.js';
import { changedRegion, isLineAligned, regionWithin } from '../src/range.js';
import { exitCodeFor, roundtripPath } from '../src/roundtrip.js';
import { serialize } from '../src/serialize.js';

const fixtures = fileURLToPath(new URL('../../../corpus/fixtures/', import.meta.url));
const packageRoot = fileURLToPath(new URL('..', import.meta.url));

function mustParse(source: string, filename: string) {
  const result = parse(source, { filename });
  if (!result.ok) throw new Error(result.error);
  return result.doc;
}

function assertIdentity(source: string, filename: string): void {
  const report = checkIdentity(source, { filename });
  assert.equal(report.status, 'pass', report.detail ?? report.status);
}

describe('identity', () => {
  it('round-trips an empty file, a BOM, and a missing trailing newline', () => {
    assertIdentity('', 'empty.md');
    assertIdentity('\uFEFF', 'bom.md');
    assertIdentity('\uFEFF# Title\n\nHello\n', 'bom.md');
    assertIdentity('# Title\n\nHello', 'none.md');
  });

  it('preserves CRLF, including inside frontmatter', () => {
    const source = '---\r\ntitle: Hello\r\n---\r\n\r\n# Title\r\n\r\nA paragraph.\r\n';
    assertIdentity(source, 'crlf.md');
    const doc = mustParse(source, 'crlf.md');
    assert.equal(doc.lineEnding, '\r\n');
    assert.equal(doc.bom, false);
  });

  it('does not parse .md as MDX', () => {
    const source =
      'import Foo from "./Foo"\n\n<Button onClick={() => alert(1)}>\n  click\n</Button>\n\n{name}\n';
    assertIdentity(source, 'component.md');
    const doc = mustParse(source, 'component.md');
    assert.ok(doc.blocks.every((block) => !block.type.startsWith('mdx')));
    const asMdx = mustParse(source, 'component.mdx');
    assert.equal(asMdx.blocks[0]?.rawKind, 'mdx-esm');
  });

  it('classifies unterminated MDX as unparseable', () => {
    const report = checkIdentity('# Title\n\n<Tabs>\n  <Tab>\n', { filename: 'broken.mdx' });
    assert.equal(report.status, 'unparseable');
  });

  it('keeps unparseable frontmatter as a raw region and still round-trips', () => {
    const source = '---\n: [\n---\n\n# Hi\n';
    assertIdentity(source, 'bad.md');
    const doc = mustParse(source, 'bad.md');
    assert.equal(doc.frontmatter?.parseable, false);
    assert.throws(() => setFrontmatterScalar(doc, 'title', 'x'), /read-only/);
  });

  it('round-trips every committed adversarial fixture', () => {
    const reports = roundtripPath(fixtures);
    const failed = reports.filter(
      (report) => report.status === 'fail' || report.status === 'error',
    );
    assert.deepEqual(failed, []);
    const unterminated = reports.find((report) => report.file.endsWith('unterminated.mdx'));
    assert.equal(unterminated?.status, 'unparseable');
    const crlf = readFileSync(path.join(fixtures, 'crlf.md'));
    assert.ok(crlf.includes(Buffer.from('\r\n')));
    const bom = readFileSync(path.join(fixtures, 'bom.md'));
    assert.equal(bom[0], 0xef);
    assert.equal(bom[1], 0xbb);
    assert.equal(bom[2], 0xbf);
  });
});

describe('frontmatter edits', () => {
  const source = [
    '---',
    '# page metadata',
    'title: "Hello" # keep me',
    "description: 'A docs page'",
    'shared: &primary',
    '  color: blue',
    'accent: *primary',
    'order: 1',
    'title2: &t Hello',
    '---',
    '',
    '# Hello',
    '',
    'Body.',
    '',
  ].join('\n');

  it('changes only the edited scalar', () => {
    const doc = mustParse(source, 'page.md');
    assert.equal(doc.frontmatter?.parseable, true);
    const next = setFrontmatterScalar(doc, 'title', 'Goodbye');
    const out = serialize(next);
    const region = changedRegion(source, out);
    assert.ok(region);
    assert.equal(source.slice(region.start, region.beforeEnd), 'Hello');
    assert.equal(out.slice(region.start, region.afterEnd), 'Goodbye');
    assert.match(out, /# page metadata/);
    assert.match(out, /# keep me/);
    assert.match(out, /description: 'A docs page'/);
    assert.match(out, /&primary/);
    assert.match(out, /\*primary/);
    assert.match(out, /title2: &t Hello/);
    assert.match(out, /order: 1/);
  });

  it('keeps an anchor on the scalar being edited', () => {
    const doc = mustParse(source, 'page.md');
    const out = serialize(setFrontmatterScalar(doc, 'title2', 'Hi'));
    assert.match(out, /title2: &t Hi\n/);
    assert.match(out, /title: "Hello"/);
  });

  it('edits a nested scalar and a CRLF document without rewriting other lines', () => {
    const doc = mustParse(source, 'page.md');
    const nested = serialize(setFrontmatterScalar(doc, ['shared', 'color'], 'red'));
    const nestedRegion = changedRegion(source, nested);
    assert.ok(nestedRegion);
    assert.equal(source.slice(nestedRegion.start, nestedRegion.beforeEnd), 'blue');

    const crlf = source.replace(/\n/g, '\r\n');
    const crlfDoc = mustParse(crlf, 'page.md');
    const edited = serialize(setFrontmatterScalar(crlfDoc, 'title', 'Goodbye'));
    assert.ok(edited.includes('\r\n'));
    assert.equal(edited.replace(/\r\n/g, '\n').includes('title: "Goodbye"'), true);
    const region = changedRegion(crlf, edited);
    assert.ok(region);
    assert.equal(crlf.slice(region.start, region.beforeEnd), 'Hello');
    assert.ok(!edited.includes('\n# page') || edited.includes('\r\n# page'));
  });
});

describe('single-block edits', () => {
  it('keeps a reference definition and an HTML comment when a paragraph changes', () => {
    const source =
      'See [the docs][docs].\n\n<!-- keep -->\n\n[docs]: https://example.com "title"\n';
    const doc = mustParse(source, 'refs.md');
    const spans = listPlainTextSpans(doc).filter((span) => span.value === 'See ');
    const span = spans[0];
    assert.ok(span);
    const block = doc.blocks.find((candidate) => candidate.id === span.blockId);
    assert.ok(block);
    const out = serialize(insertIntoTextSpan(doc, span, span.value.length, ' Xx'));
    assert.match(out, /See {2}Xx\[the docs\]\[docs\]\./);
    const region = changedRegion(source, out);
    assert.ok(region);
    assert.ok(regionWithin(region, block.start, block.end));
    assert.equal(out.includes('<!-- keep -->'), true);
    assert.equal(out.includes('[docs]: https://example.com "title"'), true);
  });

  it('does not rewrite JSX when a sibling list item changes', () => {
    const source = '- hello\n\n  <Badge>new</Badge>\n\n- there\n';
    const doc = mustParse(source, 'list.mdx');
    const spans = listPlainTextSpans(doc);
    assert.ok(spans.some((span) => span.value === 'hello'));
    assert.equal(
      spans.some((span) => span.value.includes('Badge') || span.value === 'new'),
      false,
    );
    const span = spans.find((candidate) => candidate.value === 'hello');
    assert.ok(span);
    const out = serialize(insertIntoTextSpan(doc, span, span.value.length, ' Xx'));
    assert.match(out, /- hello Xx/);
    assert.match(out, /<Badge>new<\/Badge>/);
    assert.match(out, /- there/);
  });

  it('reformats one heading without touching the following paragraph', () => {
    const source = 'Hi\n========\n\nOther paragraph.\n';
    const doc = mustParse(source, 'setext.md');
    const heading = doc.blocks[0];
    assert.equal(heading?.type, 'heading');
    assert.ok(heading);
    const out = serialize(reformatBlock(doc, heading.id));
    if (out !== source) {
      const region = changedRegion(source, out);
      assert.ok(region);
      assert.ok(regionWithin(region, heading.start, heading.end));
    }
    assert.ok(out.endsWith('\n\nOther paragraph.\n'));
    assert.equal(isLineAligned(source, heading.start, heading.end), true);
  });

  it('infers list and emphasis markers from the file', () => {
    const source = '* alpha\n* beta\n\nUse _this_ and __that__.\n\n~~~\ncode\n~~~\n';
    const doc = mustParse(source, 'style.md');
    assert.equal(doc.style.bullet, '*');
    assert.equal(doc.style.emphasis, '_');
    assert.equal(doc.style.strong, '_');
    assert.equal(doc.style.fence, '~');
  });
});

describe('range helper', () => {
  it('locates an insertion and rejects a change outside the block', () => {
    const before = 'aaa\nbbb\nccc\n';
    const after = 'aaa\nbbX\nccc\n';
    const region = changedRegion(before, after);
    assert.ok(region);
    assert.equal(regionWithin(region, 4, 7), true);
    assert.equal(regionWithin(region, 0, 3), false);
    assert.equal(changedRegion(before, before), null);
  });
});

describe('cli', () => {
  it('reports fixture files and exits 0 when the only problem is unparseable MDX', () => {
    const reports = roundtripPath(fixtures);
    assert.equal(exitCodeFor(reports), 0);
    assert.ok(reports.length >= 10);
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', path.join(packageRoot, 'src/cli.ts'), fixtures],
      { cwd: packageRoot, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /unterminated\.mdx/);
    assert.match(result.stdout, /pass/);
  });

  it('exits 2 when the path does not exist', () => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', path.join(packageRoot, 'src/cli.ts'), path.join(fixtures, 'missing')],
      { cwd: packageRoot, encoding: 'utf8' },
    );
    assert.equal(result.status, 2);
  });
});

describe('fixture bytes', () => {
  it('keeps a CRLF fixture and a mixed-ending fixture on disk', () => {
    const names = readdirSync(fixtures);
    assert.ok(names.includes('crlf.md'));
    assert.ok(names.includes('mixed-newlines.md'));
  });
});
