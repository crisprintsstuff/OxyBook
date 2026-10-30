// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeSource, listMarkdownFiles } from '@oxybook/doc-model';
import {
  DEFAULT_ALLOWLIST,
  getSharedHighlighter,
  parseOxybookConfig,
  renderPage,
  renderPageSync,
  STARTING_ALLOWLIST,
  StrictBuildError,
} from '../src/index.js';

const srcDir = fileURLToPath(new URL('../src', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

describe('renderer v0', () => {
  it('renders markdown, headings with ids, callouts, GitHub alerts, and text directives', async () => {
    const md = [
      '---',
      'title: Getting started',
      'description: Quick start guide.',
      '---',
      '',
      '# Getting started',
      '',
      'Open localhost:8000 with a 4.5:1 ratio.',
      '',
      '## First steps',
      '',
      '## First steps',
      '',
      ':::note Keep in mind',
      'Edits leave as a pull request.',
      ':::',
      '',
      ':::details More info',
      'Hidden until clicked.',
      ':::',
      '',
      '> [!TIP]',
      '> Relative links stay valid on GitHub.',
      '',
    ].join('\n');

    const result = await renderPage(md, { filename: 'getting-started.md' });
    assert.equal(result.parsed, true);
    assert.deepEqual(result.placeholders, []);
    assert.deepEqual(result.brokenLinks, []);
    assert.match(result.html, /<h1 id="getting-started">Getting started<\/h1>/);
    assert.match(result.html, /<h2 id="first-steps">First steps<\/h2>/);
    assert.match(result.html, /<h2 id="first-steps-1">First steps<\/h2>/);
    assert.match(result.html, /Open localhost:8000 with a 4\.5:1 ratio\./);
    assert.ok(!result.html.includes('oxybook-placeholder'));
    assert.match(
      result.html,
      /<aside class="oxybook-callout oxybook-callout-note" data-callout="note"><p class="oxybook-callout-title">Keep in mind<\/p>/,
    );
    assert.match(
      result.html,
      /<details class="oxybook-callout oxybook-callout-details" data-callout="details"><summary class="oxybook-callout-title">More info<\/summary>/,
    );
    assert.match(
      result.html,
      /<aside class="oxybook-callout oxybook-callout-tip" data-callout="tip"><p class="oxybook-callout-title">Tip<\/p><div class="oxybook-callout-body"><p>Relative links stay valid on GitHub\.<\/p><\/div><\/aside>/,
    );
    assert.equal(result.searchDoc.url, '/getting-started');
    assert.equal(result.searchDoc.title, 'Getting started');
    assert.equal(result.searchDoc.description, 'Quick start guide.');
    assert.deepEqual(result.searchDoc.headings, [
      { depth: 1, text: 'Getting started', id: 'getting-started' },
      { depth: 2, text: 'First steps', id: 'first-steps' },
      { depth: 2, text: 'First steps', id: 'first-steps-1' },
    ]);
  });

  it('highlights fenced code blocks and <Code> components with Shiki at build time', async () => {
    const mdx = [
      '```ts',
      'const port: number = 3000;',
      '```',
      '',
      '```unknown-lang-xyz',
      'plain fallback',
      '```',
      '',
      '<Code code="export const a = 1;" lang="js" />',
      '',
    ].join('\n');

    const result = await renderPage(mdx, { filename: 'code.mdx' });
    assert.equal(result.parsed, true);
    assert.deepEqual(result.placeholders, []);
    assert.match(result.html, /<pre class="shiki[^"]*"[^>]*data-language="ts"/);
    assert.match(result.html, /--shiki-light:/);
    assert.match(result.html, /--shiki-dark:/);
    assert.match(result.html, /<pre class="shiki[^"]*"[^>]*data-language="js"/);
    assert.match(
      result.html,
      /<pre class="shiki oxybook-code" data-language="unknown-lang-xyz"><code class="language-unknown-lang-xyz">plain fallback<\/code><\/pre>/,
    );
  });

  it('renders allowlisted M1 components with static props and replaces others with placeholders', async () => {
    const mdx = [
      '---',
      'title: Components',
      '---',
      'import { Steps } from "@astrojs/starlight/components";',
      'export const meta = { a: 1 };',
      '',
      '<Tabs groupId="os" count={2} flag>',
      '  <TabItem value="compose" label="Docker Compose">',
      '    Use `.env`.',
      '  </TabItem>',
      '</Tabs>',
      '',
      '<CardGrid stagger>',
      '  <Card title="Install" icon="rocket">Body</Card>',
      '  <LinkCard title="CLI" href="../reference/commands.md" description="All flags" />',
      '</CardGrid>',
      '',
      '<Aside type="caution" title="Watch out">Careful.</Aside>',
      '<Badge text="v1" variant="tip" />',
      '<Steps>',
      '1. First',
      '</Steps>',
      '<FileTree>',
      '- docs/',
      '</FileTree>',
      '<Fragment>Inside fragment</Fragment>',
      '<Icon name="star" label="Star" />',
      '<LinkButton href="./install.md" variant="primary">Go</LinkButton>',
      '',
      '::: code-group',
      '```sh',
      'pnpm i',
      '```',
      ':::',
      '',
      '<Card title={dynamicTitle} />',
      '<Card {...spreadProps} />',
      '<CustomWidget />',
      'Port {3000} and {/* dropped comment */}.',
      '::youtube[Video]{#abc}',
      '',
    ].join('\n');

    const result = await renderPage(mdx, { filename: 'guides/components.mdx' });
    assert.equal(result.parsed, true);

    assert.match(result.html, /class="oxybook-tabs" data-tabs-group="os"/);
    assert.match(result.html, /role="tab" class="oxybook-tab" data-tab-value="compose"/);
    assert.match(result.html, /class="oxybook-card-grid" data-stagger="true"/);
    assert.match(result.html, /class="oxybook-card" data-icon="rocket"/);
    assert.match(result.html, /class="oxybook-link-card" href="\/reference\/commands"/);
    assert.match(result.html, /class="oxybook-callout oxybook-callout-caution"/);
    assert.match(result.html, /class="oxybook-badge" data-badge-variant="tip">v1<\/span>/);
    assert.match(result.html, /class="oxybook-steps"/);
    assert.match(result.html, /class="oxybook-file-tree"/);
    assert.match(result.html, /Inside fragment/);
    assert.match(result.html, /class="oxybook-icon" data-icon="star" aria-label="Star"/);
    assert.match(
      result.html,
      /class="oxybook-link-button" href="\/guides\/install" data-variant="primary"/,
    );
    assert.match(result.html, /class="oxybook-code-group"/);
    assert.ok(!result.html.includes('dropped comment'));

    assert.deepEqual(
      result.placeholders.map((p) => `${p.line}:${p.reason}:${p.name}`),
      [
        '5:export:export const meta = { a: 1 };',
        '36:dynamic-props:Card',
        '37:dynamic-props:Card',
        '38:unknown-component:CustomWidget',
        '39:expression:3000',
        '40:directive:::youtube',
      ],
    );
  });

  it('applies oxybook.yml import mapping for both default and named imports', async () => {
    const config = parseOxybookConfig(
      [
        'title: Test site',
        'components:',
        '  "@theme/Admonition": Callout',
        '  "@custom/ui":',
        '    MyTabs: Tabs',
        '    MyTab: TabItem',
      ].join('\n'),
    );

    const mdx = [
      'import NoteBox from "@theme/Admonition";',
      'import {',
      '  MyTabs as PlatformTabs,',
      '  MyTab,',
      '} from "@custom/ui";',
      '',
      '<NoteBox type="tip" title="Mapped">',
      '  Hello from mapped Callout.',
      '</NoteBox>',
      '',
      '<PlatformTabs groupId="pkg">',
      '  <MyTab value="pnpm" label="pnpm">Fast</MyTab>',
      '</PlatformTabs>',
      '',
    ].join('\n');

    const result = await renderPage(mdx, {
      filename: 'mapped.mdx',
      components: config.components,
    });
    assert.deepEqual(result.placeholders, []);
    assert.match(result.html, /class="oxybook-callout oxybook-callout-tip"/);
    assert.match(result.html, /Hello from mapped Callout\./);
    assert.match(result.html, /class="oxybook-tabs" data-tabs-group="pkg"/);
    assert.match(result.html, /data-tab-value="pnpm" data-tab-label="pnpm"/);
  });

  it('rewrites relative links and assets, reports broken links, and enforces strict mode', async () => {
    const oxybookYml = [
      'title: OxyBook test site',
      'components:',
      '  "@theme/Tabs": Tabs',
      '  "@theme/TabItem": TabItem',
    ].join('\n');
    const config = parseOxybookConfig(oxybookYml);

    const pages = new Map<string, string>([
      ['index.md', '/'],
      ['getting-started.md', '/getting-started'],
      ['guides/index.mdx', '/guides'],
      ['guides/install.md', '/guides/install'],
      ['guides/configure.mdx', '/guides/configure'],
      ['reference/commands.md', '/reference/commands'],
      ['reference/environment.md', '/reference/env'],
    ]);
    const assets = new Set<string>(['guides/images/stack.svg']);

    const configureMdx = [
      '---',
      'title: Configure',
      '---',
      "import Tabs from '@theme/Tabs';",
      "import TabItem from '@theme/TabItem';",
      '',
      '# Configure',
      '',
      '<Tabs>',
      '  <TabItem value="compose" label="Docker Compose">',
      '    Set values in `.env`.',
      '  </TabItem>',
      '</Tabs>',
      '',
      'The default port is {3000}.',
      '',
      '<VersionBadge since="0.1" />',
      '',
      '{/* VersionBadge is not a built-in component; it should render as a placeholder with a warning. */}',
      '',
      'See the [CLI reference](../reference/commands.md#flags), [env](../reference/environment.md), ![Stack](images/stack.svg), and the [settings that do not exist yet](../reference/settings.md).',
      '',
    ].join('\n');

    const result = await renderPage(configureMdx, {
      filename: 'guides/configure.mdx',
      components: config.components,
      pages,
      assets,
    });

    assert.match(result.html, /href="\/reference\/commands#flags"/);
    assert.match(result.html, /href="\/reference\/env"/);
    assert.match(result.html, /src="\/guides\/images\/stack\.svg"/);
    assert.match(result.html, /href="\/reference\/settings"/);

    assert.deepEqual(
      result.placeholders.map((p) => `${p.line}:${p.reason}:${p.name}`),
      ['15:expression:3000', '17:unknown-component:VersionBadge'],
    );
    assert.deepEqual(result.brokenLinks, [
      {
        reason: 'broken-link',
        href: '../reference/settings.md',
        resolvedPath: 'reference/settings.md',
        line: 21,
      },
    ]);

    const versioned = await renderPage(configureMdx, {
      filename: 'guides/configure.mdx',
      components: config.components,
      pages,
      assets,
      version: '2.x',
      versionPrefix: '/2.x',
    });
    assert.equal(versioned.searchDoc.url, '/2.x/guides/configure');
    assert.match(versioned.html, /href="\/2\.x\/reference\/commands#flags"/);
    assert.match(versioned.html, /src="\/2\.x\/guides\/images\/stack\.svg"/);

    await assert.rejects(
      () =>
        renderPage(configureMdx, {
          filename: 'guides/configure.mdx',
          components: config.components,
          pages,
          assets,
          strict: true,
        }),
      (err: unknown) =>
        err instanceof StrictBuildError &&
        err.brokenLinks.length === 1 &&
        err.brokenLinks[0]?.href === '../reference/settings.md',
    );
  });

  it('never parses .md as MDX and renders unparseable .mdx without throwing', async () => {
    const md = [
      'import Foo from "./Foo"',
      '',
      '<Button onClick={() => alert(1)}>',
      '  click',
      '</Button>',
      '',
      '{name}',
      '',
    ].join('\n');

    const mdResult = await renderPage(md, { filename: 'plain.md' });
    assert.equal(mdResult.parsed, true);
    assert.deepEqual(mdResult.placeholders, []);
    assert.match(mdResult.html, /import Foo from "\.\/Foo"/);
    assert.match(mdResult.html, /\{name\}/);

    const brokenMdx = '# Title\n\n<Tabs>\n  <Tab>\n';
    const brokenResult = await renderPage(brokenMdx, { filename: 'unterminated.mdx' });
    assert.equal(brokenResult.parsed, false);
    assert.match(brokenResult.html, /class="oxybook-unparseable"/);
    assert.equal(brokenResult.warnings[0]?.reason, 'unparseable');
  });

  it('never evaluates customer code and has no eval/Function/dynamic-import path', async () => {
    // 1. Source inspection: no eval, Function constructor, vm module, or dynamic import() in src/.
    const files = readdirSync(srcDir).filter((f) => f.endsWith('.ts'));
    assert.ok(files.length >= 4);
    for (const file of files) {
      const code = readFileSync(path.join(srcDir, file), 'utf8');
      assert.equal(
        /\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(|\bnode:vm\b|(?<!['".])\bimport\s*\(/.test(
          code,
        ),
        false,
        `forbidden dynamic code execution primitive in ${file}`,
      );
    }

    // 2. Runtime execution guard: poison globalThis['eval'] and globalThis.Function.
    const highlighter = await getSharedHighlighter();
    const g = globalThis as Record<string, unknown>;
    const evalProp = 'eval';
    g.__oxybookExploit = false;
    const origEval = g[evalProp];
    const origFunction = globalThis.Function;

    g[evalProp] = () => {
      g.__oxybookExploit = true;
      throw new Error('eval must never be called');
    };
    globalThis.Function = new Proxy(origFunction, {
      apply() {
        g.__oxybookExploit = true;
        throw new Error('Function() must never be called');
      },
      construct() {
        g.__oxybookExploit = true;
        throw new Error('new Function() must never be called');
      },
    });

    try {
      const hostileMdx = [
        'import { x } from "data:text/javascript,globalThis.__oxybookExploit=true";',
        'export const pwn = (globalThis.__oxybookExploit = true);',
        '',
        '{globalThis.__oxybookExploit = true}',
        '',
        '<Card title={globalThis.__oxybookExploit = true} onClick={() => (globalThis.__oxybookExploit = true)} {...(globalThis.__oxybookExploit = true)}>',
        '  <Unknown evil={process.exit(1)} />',
        '</Card>',
        '',
      ].join('\n');

      const res = renderPageSync(hostileMdx, {
        filename: 'hostile.mdx',
        highlighter,
      });
      assert.equal(g.__oxybookExploit, false);
      assert.equal(res.parsed, true);
      assert.equal(res.placeholders.length, 4);
    } finally {
      g[evalProp] = origEval;
      globalThis.Function = origFunction;
      delete g.__oxybookExploit;
    }
  });

  it('renders every committed fixture and matches the Slice 1 warning counts', async () => {
    const highlighter = await getSharedHighlighter();
    const fixtureRoot = path.join(repoRoot, 'corpus/fixtures');
    const fixtureFiles = listMarkdownFiles(fixtureRoot);

    for (const file of fixtureFiles) {
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
      assert.ok(rendered.html.length > 0 || raw.trim() === '' || rel.includes('only-frontmatter'));

      const expectedM1 = analyzeSource(raw, rel, { allowlist: DEFAULT_ALLOWLIST });
      const renderedM1 = renderPageSync(raw, {
        filename: rel,
        allowlist: DEFAULT_ALLOWLIST,
        allowDirectives: [],
        highlighter,
      });
      assert.deepEqual(renderedM1.placeholders, expectedM1.placeholders, rel);
    }
  });
});
