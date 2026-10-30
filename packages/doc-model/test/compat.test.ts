// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyzeSource, summarize } from '../src/compat.js';

const mdx = `---
title: Configure
---
import Tabs from '@theme/Tabs';
import { Steps } from '@astrojs/starlight/components';
export const meta = { a: 1 };

<Tabs groupId="os" count={2} flag>
  <TabItem value="a" label="A">Text</TabItem>
</Tabs>

<Card title={title} />

<Steps>
1. one
</Steps>

<div>intrinsic</div>

Port {3000} and {/* a comment */}.

:::note[Heads up]
<Badge text="new" />
:::
`;

describe('compatibility analysis', () => {
  it('counts components, props, imports, expressions, and placeholders in .mdx', () => {
    const result = analyzeSource(mdx, 'guides/configure.mdx');
    assert.equal(result.parsed, true);
    assert.deepEqual(result.components, {
      Tabs: 1,
      TabItem: 1,
      Card: 1,
      Steps: 1,
      div: 1,
      Badge: 1,
    });
    assert.deepEqual(result.imports, { '@theme/Tabs': 1, '@astrojs/starlight/components': 1 });
    assert.equal(result.exports, 1);
    assert.equal(result.expressions, 1);
    assert.equal(result.expressionComments, 1);
    assert.deepEqual(result.callouts, { note: 1 });
    assert.deepEqual(result.dynamicProps, { Card: 1 });
    assert.deepEqual(
      result.placeholders.map((p) => `${p.line}:${p.reason}:${p.name}`),
      [
        '6:export:export const meta = { a: 1 };',
        '12:dynamic-props:Card',
        '14:unknown-component:Steps',
        '20:expression:3000',
        '23:unknown-component:Badge',
      ],
      'JSON-literal props are static; {title} is not; lines are file lines',
    );
  });

  it('treats text directives as literal text and unknown containers as placeholders', () => {
    const md = [
      'Open localhost:8000 and keep a 4.5:1 contrast ratio.',
      '',
      '::: code-group',
      '```sh',
      'npm i',
      '```',
      ':::',
      '',
      '::youtube[Video]{#abc}',
      '',
      ':::tip Title',
      'Fine.',
      ':::',
      '',
    ].join('\n');
    const result = analyzeSource(md, 'a.md');
    assert.deepEqual(result.textDirectives, { ':8000': 1, ':1': 1 });
    assert.deepEqual(result.callouts, { tip: 1 });
    assert.deepEqual(
      result.placeholders.map((p) => `${p.line}:${p.reason}:${p.name}`),
      ['3:directive::::code-group', '9:directive:::youtube'],
    );
  });

  it('never parses .md as MDX and counts MkDocs admonitions outside code', () => {
    const md = [
      '!!! warning "Careful"',
      '    Indented body.',
      '',
      '=== "Tab"',
      '',
      '<Badge type="tip" /> and {braces} stay text in .md',
      '',
      '```',
      '!!! note "inside code"',
      '```',
      '',
    ].join('\n');
    const result = analyzeSource(md, 'b.md');
    assert.deepEqual(result.components, {});
    assert.equal(result.expressions, 0);
    assert.deepEqual(result.mkdocsAdmonitions, { warning: 1 });
    assert.equal(result.mkdocsTabs, 1);
    assert.deepEqual(result.htmlComponents, { Badge: 1 });
    assert.equal(result.placeholders.length, 0);
  });

  it('summarizes clean files and components by files affected', () => {
    const files = [
      analyzeSource('# fine\n', 'a.md'),
      analyzeSource('<Steps />\n<Steps />\n', 'b.mdx'),
      analyzeSource('<Steps />\n', 'c.mdx'),
      analyzeSource('<Tabs>\n', 'd.mdx'),
    ];
    const summary = summarize(files);
    assert.equal(summary.files, 4);
    assert.equal(summary.unparseable, 1);
    assert.equal(summary.clean, 1);
    assert.deepEqual(summary.unknownComponentFiles, { Steps: 2 });
    assert.equal(summary.placeholders['unknown-component'], 3);
  });
});
