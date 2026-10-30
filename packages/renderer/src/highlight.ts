// SPDX-License-Identifier: AGPL-3.0-only

import type { Element } from 'hast';
import { type BundledLanguage, bundledLanguages, createHighlighter, type Highlighter } from 'shiki';

const PRELOADED_LANGS: BundledLanguage[] = [
  'astro',
  'bash',
  'c',
  'cpp',
  'css',
  'diff',
  'dockerfile',
  'go',
  'graphql',
  'html',
  'ini',
  'java',
  'javascript',
  'json',
  'jsonc',
  'jsx',
  'markdown',
  'mdx',
  'python',
  'ruby',
  'rust',
  'scss',
  'sql',
  'svelte',
  'toml',
  'tsx',
  'typescript',
  'vue',
  'xml',
  'yaml',
];

const LANG_ALIASES: Readonly<Record<string, string>> = {
  'mdx-code-block': 'mdx',
  cjs: 'javascript',
  mjs: 'javascript',
  cts: 'typescript',
  mts: 'typescript',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  terminal: 'bash',
  yml: 'yaml',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  md: 'markdown',
  docker: 'dockerfile',
  dosini: 'ini',
  plain: 'text',
  plaintext: 'text',
  txt: 'text',
  none: 'text',
};

let sharedHighlighterPromise: Promise<Highlighter> | null = null;
let sharedHighlighter: Highlighter | null = null;
const MAX_CACHE_ENTRIES = 2000;
const highlightCache = new Map<string, Element>();

export function normalizeLanguage(rawLang: string | null | undefined): string {
  if (!rawLang) return 'text';
  const token =
    rawLang
      .trim()
      .split(/[\s{[(:]/)[0]
      ?.toLowerCase() ?? '';
  if (!token) return 'text';
  return LANG_ALIASES[token] ?? token;
}

export async function getSharedHighlighter(): Promise<Highlighter> {
  if (sharedHighlighter) return sharedHighlighter;
  if (!sharedHighlighterPromise) {
    sharedHighlighterPromise = createHighlighter({
      themes: ['github-light', 'github-dark'],
      langs: PRELOADED_LANGS,
    }).then((instance) => {
      sharedHighlighter = instance;
      return instance;
    });
  }
  return sharedHighlighterPromise;
}

export async function ensureLanguagesLoaded(
  langs: Iterable<string>,
  highlighter?: Highlighter,
): Promise<Highlighter> {
  const hl = highlighter ?? (await getSharedHighlighter());
  const loaded = new Set(hl.getLoadedLanguages());
  for (const raw of langs) {
    const lang = normalizeLanguage(raw);
    if (lang === 'text' || loaded.has(lang)) continue;
    if (Object.hasOwn(bundledLanguages, lang)) {
      try {
        await hl.loadLanguage(lang as BundledLanguage);
        loaded.add(lang);
      } catch {
        // Fallback to plain text block when grammar fails to load.
      }
    }
  }
  return hl;
}

function plainCodeElement(code: string, lang: string): Element {
  return {
    type: 'element',
    tagName: 'pre',
    properties: {
      className: ['shiki', 'oxybook-code'],
      'data-language': lang,
    },
    children: [
      {
        type: 'element',
        tagName: 'code',
        properties: lang && lang !== 'text' ? { className: [`language-${lang}`] } : {},
        children: [{ type: 'text', value: code }],
      },
    ],
  };
}

export function highlightCodeToHast(
  code: string,
  rawLang: string | null | undefined,
  highlighter: Highlighter | null,
): Element {
  const lang = normalizeLanguage(rawLang);
  if (highlighter && lang !== 'text' && highlighter.getLoadedLanguages().includes(lang)) {
    const cacheKey = `${lang}\0${code}`;
    const cached = highlightCache.get(cacheKey);
    if (cached) {
      return structuredClone(cached);
    }
    try {
      const root = highlighter.codeToHast(code, {
        lang,
        themes: {
          light: 'github-light',
          dark: 'github-dark',
        },
        defaultColor: false,
      });
      const pre = root.children.find(
        (child): child is Element => child.type === 'element' && child.tagName === 'pre',
      );
      if (pre) {
        pre.properties = {
          ...pre.properties,
          'data-language': lang,
        };
        if (highlightCache.size >= MAX_CACHE_ENTRIES) {
          const oldest = highlightCache.keys().next().value;
          if (oldest !== undefined) highlightCache.delete(oldest);
        }
        highlightCache.set(cacheKey, structuredClone(pre));
        return pre;
      }
    } catch {
      // Fall back to plain pre/code if Shiki rejects a token sequence.
    }
  }
  return plainCodeElement(code, lang);
}
