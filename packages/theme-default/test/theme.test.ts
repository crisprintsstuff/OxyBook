// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import {
  buildThemeClientScript,
  buildThemeStyles,
  findPrevNextPages,
  flattenNavPages,
  render404Document,
  renderPageDocument,
  renderRedirectDocument,
  type ThemeNavItem,
} from '../src/index.js';

const SAMPLE_NAV: ThemeNavItem[] = [
  { name: 'index', title: 'Welcome', url: '/', children: [] },
  {
    name: 'guides',
    title: 'Guides',
    url: '/guides',
    children: [
      { name: 'install', title: 'Install', url: '/guides/install', children: [] },
      { name: 'configure', title: 'Configure', url: '/guides/configure', children: [] },
    ],
  },
  {
    name: 'reference',
    title: 'Reference',
    url: null,
    children: [{ name: 'cli', title: 'CLI', url: '/reference/cli', children: [] }],
  },
];

describe('@oxybook/theme-default layout and navigation', () => {
  it('flattens nav pages in reading order and finds prev/next pages', () => {
    const flat = flattenNavPages(SAMPLE_NAV);
    assert.deepEqual(
      flat.map((p) => p.url),
      ['/', '/guides', '/guides/install', '/guides/configure', '/reference/cli'],
    );

    assert.deepEqual(findPrevNextPages(SAMPLE_NAV, '/'), {
      prev: null,
      next: { title: 'Guides', url: '/guides' },
    });
    assert.deepEqual(findPrevNextPages(SAMPLE_NAV, '/guides/install'), {
      prev: { title: 'Guides', url: '/guides' },
      next: { title: 'Configure', url: '/guides/configure' },
    });
    assert.deepEqual(findPrevNextPages(SAMPLE_NAV, '/reference/cli'), {
      prev: { title: 'Configure', url: '/guides/configure' },
      next: null,
    });
    assert.deepEqual(findPrevNextPages(SAMPLE_NAV, '/unlisted'), {
      prev: null,
      next: null,
    });
  });

  it('renders a complete page document with header, active nav branch, TOC, pager, and Pagefind hooks', () => {
    const html = renderPageDocument({
      siteTitle: 'OxyBook Docs',
      pageTitle: 'Install',
      description: 'How to install OxyBook.',
      currentUrl: '/guides/install',
      bodyHtml:
        '<h1 id="install">Install</h1><p>Intro</p><h2 id="prereqs">Prerequisites</h2><h3 id="node">Node.js</h3><h4 id="ignored">Deep</h4>',
      nav: SAMPLE_NAV,
      headings: [
        { depth: 1, text: 'Install', id: 'install' },
        { depth: 2, text: 'Prerequisites', id: 'prereqs' },
        { depth: 3, text: 'Node.js', id: 'node' },
        { depth: 4, text: 'Deep', id: 'ignored' },
      ],
      versions: [
        { name: '2.x (latest)', url: '/', current: true },
        { name: '1.x', url: '/1.x/', current: false },
      ],
      theme: {
        accentColor: '#0f766e',
        favicon: '/favicon.svg',
        logo: { src: '/logo.svg', alt: 'OxyBook Logo' },
        headerLinks: [
          { label: 'Guides', href: '/guides' },
          { label: 'GitHub', href: 'https://github.com/crisprintsstuff/OxyBook' },
        ],
        footer: 'Released under Apache-2.0.',
      },
    });

    assert.match(html, /<title>Install — OxyBook Docs<\/title>/);
    assert.match(html, /<meta name="description" content="How to install OxyBook\.">/);
    assert.match(html, /<link rel="icon" href="\/favicon\.svg">/);
    assert.match(html, /--ob-accent:\s*#0f766e/);
    assert.match(html, /<img class="oxybook-site-logo" src="\/logo\.svg" alt="OxyBook Logo">/);
    assert.match(html, /data-version-switcher/);
    assert.match(html, /rel="noopener noreferrer" target="_blank">GitHub<\/a>/);

    // Active branch and current link in sidebar
    assert.match(html, /<li data-active-branch="true"><a href="\/guides">Guides<\/a>/);
    assert.match(html, /<a href="\/guides\/install" aria-current="page">Install<\/a>/);

    // Does not duplicate <h1> when bodyHtml already has <h1>
    assert.equal((html.match(/<h1\b/g) ?? []).length, 1);

    // Right-hand "On this page" TOC includes h2 and h3, excludes h1 and h4
    assert.match(html, /aria-label="On this page"/);
    assert.match(html, /<a href="#prereqs">Prerequisites<\/a>/);
    assert.match(html, /<a href="#node">Node\.js<\/a>/);
    assert.doesNotMatch(html, /<a href="#ignored">/);

    // Prev / Next pager
    assert.match(
      html,
      /<a class="oxybook-pager-link oxybook-pager-prev" href="\/guides" rel="prev">[\s\S]*?Guides<\/span><\/a>/,
    );
    assert.match(
      html,
      /<a class="oxybook-pager-link oxybook-pager-next" href="\/guides\/configure" rel="next">[\s\S]*?Configure<\/span><\/a>/,
    );

    // Footer & Pagefind
    assert.match(html, /Released under Apache-2\.0\./);
    assert.match(html, /<main class="oxybook-content" id="oxybook-main" data-pagefind-body>/);
    assert.match(html, /pagefind-ui\.js/);
  });

  it('synthesizes <h1> when missing and respects searchable: false', () => {
    const html = renderPageDocument({
      siteTitle: 'OxyBook Docs',
      pageTitle: 'Hidden Page',
      currentUrl: '/hidden',
      bodyHtml: '<p>Secret content</p>',
      nav: SAMPLE_NAV,
      searchable: false,
    });

    assert.match(html, /<h1>Hidden Page<\/h1>/);
    assert.doesNotMatch(html, /data-pagefind-body/);
    assert.doesNotMatch(html, /aria-label="On this page"/);
  });

  it('renders 404 and redirect documents cleanly', () => {
    const notFound = render404Document({
      siteTitle: 'OxyBook Docs',
      nav: SAMPLE_NAV,
      versionPrefix: '1.x',
    });
    assert.match(notFound, /<title>Page not found — OxyBook Docs<\/title>/);
    assert.match(notFound, /href="\/1\.x"/);
    assert.match(notFound, /\/1\.x\/pagefind\/pagefind-ui\.js/);

    const redirect = renderRedirectDocument({
      fromUrl: '/old',
      toUrl: '/guides/install',
      siteTitle: 'OxyBook Docs',
    });
    assert.match(redirect, /http-equiv="refresh" content="0; url=\/guides\/install"/);
    assert.match(redirect, /location\.replace\("\/guides\/install"\s*\+\s*location\.hash\)/);
  });

  it('sanitizes unsafe CSS characters in custom accentColor', () => {
    const css = buildThemeStyles({ accentColor: 'red; } body { visibility: hidden' });
    assert.doesNotMatch(css, /visibility:\s*hidden/);
  });
});

describe('@oxybook/theme-default client island behavior', () => {
  it('switches Tabs/TabItem, syncs data-tabs-group, initializes code-group tabs, and toggles mobile sidebar', () => {
    class FakeElement {
      tagName: string;
      type = '';
      attrs = new Map<string, string>();
      children: FakeElement[] = [];
      textContent = '';
      className = '';
      listeners = new Map<string, ((ev?: Record<string, unknown>) => void)[]>();
      classList: { add: (cls: string) => void };

      constructor(tagName: string, attrs: Record<string, string> = {}) {
        this.tagName = tagName.toUpperCase();
        for (const [k, v] of Object.entries(attrs)) {
          this.attrs.set(k, v);
          if (k === 'class') this.className = v;
        }
        this.classList = {
          add: (cls: string) => {
            const parts = new Set(this.className.split(/\s+/).filter(Boolean));
            parts.add(cls);
            this.className = [...parts].join(' ');
            this.attrs.set('class', this.className);
          },
        };
      }
      hasClass(cls: string): boolean {
        return this.className.split(/\s+/).includes(cls);
      }
      get hidden(): boolean {
        return this.attrs.has('hidden');
      }
      getAttribute(name: string): string | null {
        return this.attrs.get(name) ?? null;
      }
      setAttribute(name: string, val: string): void {
        this.attrs.set(name, val);
        if (name === 'class') this.className = val;
      }
      removeAttribute(name: string): void {
        this.attrs.delete(name);
      }
      appendChild(child: FakeElement): FakeElement {
        this.children.push(child);
        return child;
      }
      insertBefore(child: FakeElement, ref: FakeElement | null): FakeElement {
        const idx = ref ? this.children.indexOf(ref) : -1;
        if (idx >= 0) this.children.splice(idx, 0, child);
        else this.children.unshift(child);
        return child;
      }
      get firstChild(): FakeElement | null {
        return this.children[0] ?? null;
      }
      addEventListener(type: string, cb: (ev?: Record<string, unknown>) => void): void {
        const list = this.listeners.get(type) ?? [];
        list.push(cb);
        this.listeners.set(type, list);
      }
      click(): void {
        for (const cb of this.listeners.get('click') ?? []) cb({});
      }
      focus(): void {}
      querySelector(selector: string): FakeElement | null {
        if (selector === ':scope > .oxybook-tabs-list') {
          return this.children.find((c) => c.hasClass('oxybook-tabs-list')) ?? null;
        }
        return null;
      }
      querySelectorAll(selector: string): FakeElement[] {
        if (selector === ':scope > .oxybook-tabs-list > .oxybook-tab') {
          const list = this.children.find((c) => c.hasClass('oxybook-tabs-list'));
          return list ? list.children.filter((c) => c.hasClass('oxybook-tab')) : [];
        }
        if (selector === ':scope > .oxybook-tab-item, :scope > .oxybook-code-panel') {
          return this.children.filter(
            (c) => c.hasClass('oxybook-tab-item') || c.hasClass('oxybook-code-panel'),
          );
        }
        if (selector === ':scope > pre') {
          return this.children.filter((c) => c.tagName === 'PRE');
        }
        return [];
      }
    }

    function makeTabsBlock(group: string) {
      const container = new FakeElement('div', {
        class: 'oxybook-tabs',
        'data-tabs-group': group,
      });
      const list = container.appendChild(
        new FakeElement('div', { class: 'oxybook-tabs-list', role: 'tablist' }),
      );
      const btnPnpm = list.appendChild(
        new FakeElement('button', {
          class: 'oxybook-tab',
          role: 'tab',
          'data-tab-value': 'pnpm',
          'aria-selected': 'true',
        }),
      );
      const btnNpm = list.appendChild(
        new FakeElement('button', {
          class: 'oxybook-tab',
          role: 'tab',
          'data-tab-value': 'npm',
          'aria-selected': 'false',
        }),
      );
      const panelPnpm = container.appendChild(
        new FakeElement('div', {
          class: 'oxybook-tab-item',
          role: 'tabpanel',
          'data-tab-value': 'pnpm',
          'data-tab-label': 'pnpm',
        }),
      );
      const panelNpm = container.appendChild(
        new FakeElement('div', {
          class: 'oxybook-tab-item',
          role: 'tabpanel',
          'data-tab-value': 'npm',
          'data-tab-label': 'npm',
        }),
      );
      return { container, btnPnpm, btnNpm, panelPnpm, panelNpm };
    }

    const tabsA = makeTabsBlock('pkg');
    const tabsB = makeTabsBlock('pkg');

    const codeGroup = new FakeElement('div', { class: 'oxybook-code-group' });
    const pre1 = codeGroup.appendChild(new FakeElement('pre', { 'data-language': 'sh' }));
    const pre2 = codeGroup.appendChild(new FakeElement('pre', { 'data-title': 'oxybook.yml' }));

    const bodyEl = new FakeElement('body', { 'data-sidebar-open': 'false' });
    const toggleBtn = new FakeElement('button', {
      class: 'oxybook-mobile-toggle',
      'aria-expanded': 'false',
    });

    const storage = new Map<string, string>();
    const docListeners = new Map<string, ((ev?: Record<string, unknown>) => void)[]>();

    const documentStub = {
      readyState: 'complete',
      body: bodyEl,
      createElement: (tag: string) => new FakeElement(tag),
      getElementById: () => null,
      querySelector: (sel: string) => {
        if (sel === '.oxybook-mobile-toggle') return toggleBtn;
        return null;
      },
      querySelectorAll: (sel: string) => {
        if (sel === '.oxybook-tabs' || sel === '.oxybook-tabs[data-tabs-group]') {
          return [tabsA.container, tabsB.container];
        }
        if (sel === '.oxybook-code-group') return [codeGroup];
        return [];
      },
      addEventListener: (type: string, cb: (ev?: Record<string, unknown>) => void) => {
        const list = docListeners.get(type) ?? [];
        list.push(cb);
        docListeners.set(type, list);
      },
    };

    const script = buildThemeClientScript('/pagefind/');
    vm.runInNewContext(script, {
      window: {},
      document: documentStub,
      localStorage: {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => storage.set(k, v),
      },
    });

    // Initially tab 0 ("pnpm") is visible in both tab sets
    assert.equal(tabsA.panelPnpm.hidden, false);
    assert.equal(tabsA.panelNpm.hidden, true);
    assert.equal(tabsB.panelPnpm.hidden, false);
    assert.equal(tabsB.panelNpm.hidden, true);

    // Clicking "npm" in tabsA also switches tabsB via data-tabs-group="pkg"
    tabsA.btnNpm.click();

    assert.equal(tabsA.panelPnpm.hidden, true);
    assert.equal(tabsA.panelNpm.hidden, false);
    assert.equal(tabsB.panelPnpm.hidden, true);
    assert.equal(tabsB.panelNpm.hidden, false);
    assert.equal(storage.get('oxybook-tab:pkg'), 'npm');

    // Code group has 2 tab buttons ("sh" and "oxybook.yml") and switches visible <pre>
    const codeNav = codeGroup.firstChild;
    assert.ok(codeNav);
    assert.equal(codeNav.children.length, 2);
    assert.equal(codeNav.children[0]?.textContent, 'sh');
    assert.equal(codeNav.children[1]?.textContent, 'oxybook.yml');
    assert.equal(pre1.hidden, false);
    assert.equal(pre2.hidden, true);

    codeNav.children[1]?.click();
    assert.equal(pre1.hidden, true);
    assert.equal(pre2.hidden, false);

    // Mobile sidebar toggle opens on button click and closes on Escape
    toggleBtn.click();
    assert.equal(bodyEl.getAttribute('data-sidebar-open'), 'true');
    assert.equal(toggleBtn.getAttribute('aria-expanded'), 'true');

    for (const cb of docListeners.get('keydown') ?? []) {
      cb({ key: 'Escape' });
    }
    assert.equal(bodyEl.getAttribute('data-sidebar-open'), 'false');
  });
});
