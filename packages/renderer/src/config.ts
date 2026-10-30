// SPDX-License-Identifier: AGPL-3.0-only

import type { ThemeConfig, ThemeHeaderLink } from '@oxybook/theme-default';
import { parse as parseYaml } from 'yaml';

/**
 * A specifier in `oxybook.yml` `components:` can map either to a single built-in
 * component name (`"@theme/Tabs": Tabs`) or to a map of exported names to built-in
 * component names (`"@astrojs/starlight/components": { Aside: Callout, Steps: Steps }`),
 * per ARCHITECTURE §5.2 and docs/M1-NOTES.md.
 */
export type ComponentMapEntry = string | Readonly<Record<string, string>>;

export type ComponentMap = Readonly<Record<string, ComponentMapEntry>>;

export interface RedirectRule {
  from: string;
  to: string;
}

export interface VersionConfig {
  name: string;
  ref: string;
  default?: boolean;
}

export interface OxybookConfig {
  title?: string;
  strict: boolean;
  exclude: string[];
  components: Record<string, ComponentMapEntry>;
  redirects: RedirectRule[];
  versions: VersionConfig[];
  theme?: ThemeConfig;
}

export function emptyOxybookConfig(): OxybookConfig {
  return {
    strict: false,
    exclude: [],
    components: {},
    redirects: [],
    versions: [],
  };
}

function parseThemeConfig(rawTheme: Record<string, unknown>): ThemeConfig {
  const theme: {
    logo?: ThemeConfig['logo'];
    favicon?: string;
    accentColor?: string;
    headerLinks?: ThemeHeaderLink[];
    footer?: string;
    customCssUrl?: string;
  } = {};
  if (typeof rawTheme.logo === 'string' && rawTheme.logo.trim() !== '') {
    theme.logo = rawTheme.logo.trim();
  } else if (rawTheme.logo && typeof rawTheme.logo === 'object' && !Array.isArray(rawTheme.logo)) {
    const logoObj = rawTheme.logo as Record<string, unknown>;
    if (typeof logoObj.src === 'string' && logoObj.src.trim() !== '') {
      theme.logo = {
        src: logoObj.src.trim(),
        ...(typeof logoObj.alt === 'string' && logoObj.alt.trim() !== ''
          ? { alt: logoObj.alt.trim() }
          : {}),
      };
    }
  }
  if (typeof rawTheme.favicon === 'string' && rawTheme.favicon.trim() !== '') {
    theme.favicon = rawTheme.favicon.trim();
  }
  if (typeof rawTheme.accentColor === 'string' && rawTheme.accentColor.trim() !== '') {
    theme.accentColor = rawTheme.accentColor.trim();
  }
  if (typeof rawTheme.footer === 'string' && rawTheme.footer.trim() !== '') {
    theme.footer = rawTheme.footer.trim();
  }
  if (typeof rawTheme.customCssUrl === 'string' && rawTheme.customCssUrl.trim() !== '') {
    theme.customCssUrl = rawTheme.customCssUrl.trim();
  }
  if (Array.isArray(rawTheme.headerLinks)) {
    const links: ThemeHeaderLink[] = [];
    for (const item of rawTheme.headerLinks) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const entry = item as Record<string, unknown>;
        if (typeof entry.label === 'string' && typeof entry.href === 'string') {
          links.push({
            label: entry.label,
            href: entry.href,
            ...(typeof entry.external === 'boolean' ? { external: entry.external } : {}),
          });
        }
      }
    }
    if (links.length > 0) {
      theme.headerLinks = links;
    }
  }
  return theme;
}

/**
 * Parse `oxybook.yml` into a typed config object. Never executes anything.
 */
export function parseOxybookConfig(yamlSource: string): OxybookConfig {
  const config = emptyOxybookConfig();
  if (!yamlSource.trim()) return config;
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlSource);
  } catch {
    return config;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return config;
  }
  const raw = parsed as Record<string, unknown>;
  if (typeof raw.title === 'string' && raw.title.trim() !== '') {
    config.title = raw.title.trim();
  }
  if (typeof raw.strict === 'boolean') {
    config.strict = raw.strict;
  }
  if (Array.isArray(raw.exclude)) {
    config.exclude = raw.exclude.filter((item): item is string => typeof item === 'string');
  }
  if (raw.components && typeof raw.components === 'object' && !Array.isArray(raw.components)) {
    for (const [specifier, target] of Object.entries(raw.components as Record<string, unknown>)) {
      if (typeof target === 'string' && target.trim() !== '') {
        config.components[specifier] = target.trim();
      } else if (target && typeof target === 'object' && !Array.isArray(target)) {
        const named: Record<string, string> = {};
        for (const [exportName, mapped] of Object.entries(target as Record<string, unknown>)) {
          if (typeof mapped === 'string' && mapped.trim() !== '') {
            named[exportName] = mapped.trim();
          }
        }
        config.components[specifier] = named;
      }
    }
  }
  if (Array.isArray(raw.redirects)) {
    for (const item of raw.redirects) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const entry = item as Record<string, unknown>;
        if (typeof entry.from === 'string' && typeof entry.to === 'string') {
          config.redirects.push({ from: entry.from, to: entry.to });
        }
      }
    }
  }
  if (Array.isArray(raw.versions)) {
    for (const item of raw.versions) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const entry = item as Record<string, unknown>;
        if (typeof entry.name === 'string' && typeof entry.ref === 'string') {
          config.versions.push({
            name: entry.name,
            ref: entry.ref,
            ...(typeof entry.default === 'boolean' ? { default: entry.default } : {}),
          });
        }
      }
    }
  }
  if (raw.theme && typeof raw.theme === 'object' && !Array.isArray(raw.theme)) {
    config.theme = parseThemeConfig(raw.theme as Record<string, unknown>);
  }
  return config;
}

const IMPORT_STATEMENT = /\bimport\s+([\s\S]*?)\s+from\s*(['"])([^'"]+)\2/g;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * Static analysis of `import` statements in MDX ESM blocks: maps local JSX
 * identifiers to built-in component names according to `componentMap`.
 * Nothing in the ESM block is evaluated.
 */
export function resolveImports(
  esmBlocks: readonly string[],
  componentMap: ComponentMap | undefined,
): Map<string, string> {
  const localToTarget = new Map<string, string>();
  if (!componentMap || Object.keys(componentMap).length === 0) return localToTarget;

  for (const esm of esmBlocks) {
    for (const match of esm.matchAll(IMPORT_STATEMENT)) {
      const clause = match[1]?.trim() ?? '';
      const specifier = match[3] ?? '';
      if (!clause || !specifier || /^type\s+/.test(clause)) continue;
      const mapping = componentMap[specifier];
      if (!mapping) continue;

      const braces = /\{([\s\S]*?)\}/.exec(clause);
      if (braces?.[1] !== undefined) {
        for (const rawSpec of braces[1].split(',')) {
          const spec = rawSpec.trim();
          if (!spec || /^type\s+/.test(spec)) continue;
          const parts = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(spec);
          if (!parts?.[1]) continue;
          const imported = parts[1];
          const local = parts[2] ?? imported;
          if (typeof mapping === 'string') {
            localToTarget.set(local, mapping);
          } else {
            const target = mapping[imported];
            if (typeof target === 'string') {
              localToTarget.set(local, target);
            }
          }
        }
      }

      const defaultPart = clause
        .replace(/\{[\s\S]*?\}/, '')
        .replace(/,/g, '')
        .trim();
      if (defaultPart && IDENTIFIER.test(defaultPart)) {
        if (typeof mapping === 'string') {
          localToTarget.set(defaultPart, mapping);
        } else if (typeof mapping.default === 'string') {
          localToTarget.set(defaultPart, mapping.default);
        }
      }
    }
  }

  return localToTarget;
}

function globToRegExp(pattern: string): RegExp {
  let out = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] ?? '';
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i++;
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  out += '(?:/.*)?$';
  return new RegExp(out);
}

/**
 * Whether `relPath` (relative to the content root) is excluded by `oxybook.yml` `exclude:`
 * patterns (ARCHITECTURE §2.2). Supports exact paths, directory prefixes, and `*` / `**` globs.
 */
export function isExcluded(
  relPath: string,
  excludePatterns: readonly string[] | undefined,
): boolean {
  if (!excludePatterns || excludePatterns.length === 0) return false;
  const cleanRel = relPath.replace(/^\/+/, '');
  for (const raw of excludePatterns) {
    const pattern = raw
      .trim()
      .replace(/^(?:\.\/|\/)+/, '')
      .replace(/\/+$/, '');
    if (!pattern) continue;
    if (pattern.includes('*') || pattern.includes('?')) {
      if (globToRegExp(pattern).test(cleanRel)) return true;
    } else if (cleanRel === pattern || cleanRel.startsWith(`${pattern}/`)) {
      return true;
    }
  }
  return false;
}
