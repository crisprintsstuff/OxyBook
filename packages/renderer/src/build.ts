// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import posixPath from 'node:path/posix';
import type { Placeholder } from '@oxybook/doc-model';
import * as pagefind from 'pagefind';
import { isExcluded, parseOxybookConfig } from './config.js';
import { applyVersionPrefix } from './links.js';
import { buildNavTree, type DirConfig, type NavItem, parseDirConfig } from './nav.js';
import { type RenderResult, renderPage } from './render.js';
import { render404Html, renderDocumentHtml, renderRedirectHtml } from './template.js';

const RENDERER_CACHE_VERSION = 'v0.1';
const MAX_BODY_CACHE_ENTRIES = 1000;
const renderedBodyCache = new Map<string, RenderResult>();

export function clearRenderedBodyCache(): void {
  renderedBodyCache.clear();
}

export interface BuildPageInput {
  /** Path relative to the content root, e.g. 'index.md', 'guides/install.md'. */
  path: string;
  /** Git blob SHA, used for the rendered-body cache key (ARCHITECTURE §5.1). */
  blobSha: string;
  /** Raw markdown or MDX source. */
  source: string;
  /** Site URL computed at sync time (for the ref without version prefix), e.g. '/', '/guides/install'. */
  url: string;
  title: string;
  navTitle?: string | null;
  hidden?: boolean;
}

export interface BuildAssetInput {
  /** Path relative to the content root, e.g. 'guides/images/stack.svg'. */
  path: string;
  bytes: Buffer;
}

export interface BuildVersionInput {
  spaceId: string;
  spaceSlug: string;
  spaceName: string;
  /** Version name, e.g. 'default' or '3.x'. */
  version: string;
  /** Whether this version is the default version served at `/` (default true). */
  isDefaultVersion?: boolean;
  commitSha: string;
  buildId: string;
  /** Root sites directory (`/srv/sites` in compose, `.oxybook-sites` on host). */
  sitesDir: string;
  /** Platform domain suffix (default `docs.localhost`). */
  sitesDomain?: string;
  /** Additional verified custom domains for this space. */
  customDomains?: readonly string[];
  /** Raw `oxybook.yml` content, if present at repository root. */
  oxybookYaml?: string;
  /** `_dir.yml` contents or parsed configs keyed by directory path relative to content root. */
  dirConfigs?:
    | ReadonlyMap<string, string | DirConfig>
    | Readonly<Record<string, string | DirConfig>>;
  pages: readonly BuildPageInput[];
  assets?: readonly BuildAssetInput[];
  /** Out-of-band rename redirects recorded by sync (`inferred_redirects`). */
  inferredRedirects?: readonly { from: string; to: string }[];
  /** How many recent builds/releases to retain per version (default 5). */
  keepBuilds?: number;
  /** Run Pagefind to generate `/pagefind/*` static search bundle (default true). */
  indexSearch?: boolean;
  log?: (line: string) => void;
}

export interface SiteBuildWarning {
  path: string;
  line: number | null;
  kind: Placeholder['reason'] | 'broken-link';
  detail: string;
}

export interface BuildVersionResult {
  buildDir: string;
  releaseDir: string;
  currentLink: string;
  hostLinks: string[];
  siteTitle: string;
  nav: NavItem[];
  pageCount: number;
  cachedPageCount: number;
  assetCount: number;
  redirectCount: number;
  indexedPageCount: number;
  warnings: SiteBuildWarning[];
  logLines: string[];
}

function sha256Hex(parts: readonly string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(part);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function urlToRelativeFile(siteUrl: string, versionPrefix: string | undefined): string {
  let stripped = siteUrl;
  if (versionPrefix) {
    const cleanVer = `/${versionPrefix.replace(/^\/+|\/+$/g, '')}`;
    if (stripped === cleanVer || stripped === `${cleanVer}/`) {
      stripped = '/';
    } else if (stripped.startsWith(`${cleanVer}/`)) {
      stripped = stripped.slice(cleanVer.length);
    }
  }
  const clean = stripped.replace(/^\/+|\/+$/g, '');
  if (!clean) return 'index.html';
  return `${clean}.html`;
}

function writeFileEnsuringDir(filePath: string, content: string | Buffer): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

/**
 * When both `foo.html` and a directory `foo/` exist in `buildDir` (for example `/guides`
 * from `guides/index.mdx` alongside `guides/install.html`), hardlink `foo.html` to
 * `foo/index.html` so Caddy's `try_files {path} {path}.html {path}/index.html` serves
 * both `/guides` and `/guides/` with zero byte duplication.
 */
function linkDirectoryIndexHtml(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      linkDirectoryIndexHtml(full);
    } else if (entry.isFile() && entry.name.endsWith('.html') && entry.name !== 'index.html') {
      const stem = entry.name.slice(0, -'.html'.length);
      const siblingDir = path.join(dir, stem);
      if (existsSync(siblingDir) && statSync(siblingDir).isDirectory()) {
        const indexTarget = path.join(siblingDir, 'index.html');
        if (!existsSync(indexTarget)) {
          linkSync(full, indexTarget);
        }
      }
    }
  }
}

/**
 * Recursively hardlink every file in `srcDir` into `destDir` (`cp -al` equivalent,
 * ARCHITECTURE §5.3). Preserves relative symlinks if any exist.
 */
export function hardlinkTree(srcDir: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      hardlinkTree(srcPath, destPath);
    } else if (entry.isSymbolicLink()) {
      const target = readlinkSync(srcPath);
      if (existsSync(destPath)) unlinkSync(destPath);
      symlinkSync(target, destPath);
    } else if (entry.isFile()) {
      if (existsSync(destPath)) unlinkSync(destPath);
      linkSync(srcPath, destPath);
    }
  }
}

/**
 * Atomically create or replace `linkPath` so it points to `target` (`symlink` to a
 * temporary sibling path, then `rename` over `linkPath`, ARCHITECTURE §5.3).
 */
export function atomicSymlink(target: string, linkPath: string, suffix: string): void {
  mkdirSync(path.dirname(linkPath), { recursive: true });
  const tmpPath = `${linkPath}.tmp-${suffix}-${process.pid}`;
  try {
    unlinkSync(tmpPath);
  } catch {
    // Ignore when absent.
  }
  symlinkSync(target, tmpPath);
  renameSync(tmpPath, linkPath);
}

let pagefindQueue: Promise<void> = Promise.resolve();

async function runPagefindIndex(
  pagesToIndex: readonly { url: string; html: string }[],
  outputDir: string,
): Promise<number> {
  const run = async (): Promise<number> => {
    const { index, errors: createErrors } = await pagefind.createIndex();
    if (createErrors.length > 0 || !index) {
      throw new Error(`pagefind createIndex failed: ${createErrors.join('; ')}`);
    }
    try {
      let count = 0;
      for (const page of pagesToIndex) {
        const res = await index.addHTMLFile({ url: page.url, content: page.html });
        if (res.errors.length > 0) {
          throw new Error(`pagefind addHTMLFile(${page.url}) failed: ${res.errors.join('; ')}`);
        }
        count++;
      }
      const writeRes = await index.writeFiles({ outputPath: outputDir });
      if (writeRes.errors.length > 0) {
        throw new Error(`pagefind writeFiles failed: ${writeRes.errors.join('; ')}`);
      }
      await index.deleteIndex();
      return count;
    } finally {
      await pagefind.close();
    }
  };

  const next = pagefindQueue.then(run, run);
  pagefindQueue = next.then(
    () => {},
    () => {},
  );
  return next;
}

function pruneDirectory(parentDir: string, keepCount: number, protectedNames: Set<string>): void {
  if (!existsSync(parentDir) || keepCount <= 0) return;
  const entries = readdirSync(parentDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const full = path.join(parentDir, entry.name);
      return { name: entry.name, full, mtimeMs: statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));

  let kept = 0;
  for (const entry of entries) {
    if (protectedNames.has(entry.name)) {
      kept++;
      continue;
    }
    if (kept < keepCount) {
      kept++;
      continue;
    }
    rmSync(entry.full, { recursive: true, force: true });
  }
}

/**
 * Build one version of a space into `/srv/sites/builds/<space>/<version>/<sha>-<buildId>/`,
 * index with Pagefind, assemble the hardlinked release directory, atomically swap
 * `spaces/<space>/current`, maintain `by-host/<hostname>`, and prune old builds
 * (ARCHITECTURE §5.3).
 */
export async function buildSiteVersion(input: BuildVersionInput): Promise<BuildVersionResult> {
  const logLines: string[] = [];
  const emit = (line: string) => {
    logLines.push(line);
    input.log?.(line);
  };

  const isDefault = input.isDefaultVersion ?? true;
  const versionPrefix = isDefault ? undefined : input.version;
  const config = input.oxybookYaml ? parseOxybookConfig(input.oxybookYaml) : parseOxybookConfig('');

  const parsedDirs = new Map<string, DirConfig>();
  if (input.dirConfigs) {
    const entries =
      input.dirConfigs instanceof Map
        ? input.dirConfigs.entries()
        : Object.entries(input.dirConfigs);
    for (const [rawDir, rawCfg] of entries) {
      const cleanDir = rawDir
        .replace(/^(?:\.\/|\/)+/, '')
        .replace(/(?:\/|^)_dir\.ya?ml$/i, '')
        .replace(/\/+$/, '');
      const key = cleanDir === '.' ? '' : cleanDir;
      parsedDirs.set(key, typeof rawCfg === 'string' ? parseDirConfig(rawCfg) : rawCfg);
    }
  }

  const rootDirConfig = parsedDirs.get('');
  const siteTitle = config.title ?? rootDirConfig?.title ?? input.spaceName;

  const activePages = input.pages
    .filter((p) => !isExcluded(p.path, config.exclude))
    .map((p) => ({
      ...p,
      url: applyVersionPrefix(p.url, versionPrefix),
    }));
  const activeAssets = (input.assets ?? []).filter((a) => !isExcluded(a.path, config.exclude));

  const nav = buildNavTree(activePages, parsedDirs);

  const pageMap = new Map<string, string>();
  for (const page of input.pages) {
    if (!isExcluded(page.path, config.exclude)) {
      pageMap.set(page.path.replace(/^\/+/, ''), page.url);
    }
  }
  const assetSet = new Set<string>(activeAssets.map((a) => a.path.replace(/^\/+/, '')));

  const linkTargetsHash = sha256Hex([
    ...[...pageMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `p:${k}=${v}`),
    ...[...assetSet].sort().map((a) => `a:${a}`),
  ]);
  const configHash = sha256Hex([
    JSON.stringify(config.components),
    String(config.strict),
    versionPrefix ?? '',
  ]);

  const shortSha = input.commitSha.slice(0, 12);
  const buildStamp = `${shortSha}-${input.buildId}`;
  const buildDir = path.join(input.sitesDir, 'builds', input.spaceId, input.version, buildStamp);
  mkdirSync(buildDir, { recursive: true });

  const warnings: SiteBuildWarning[] = [];
  const pagesToIndex: { url: string; html: string }[] = [];
  let cachedPageCount = 0;

  for (const page of activePages) {
    const cacheKey = sha256Hex([
      RENDERER_CACHE_VERSION,
      page.blobSha,
      page.path,
      configHash,
      linkTargetsHash,
    ]);
    let rendered = renderedBodyCache.get(cacheKey);
    if (rendered) {
      cachedPageCount++;
    } else {
      rendered = await renderPage(page.source, {
        filename: page.path,
        version: input.version,
        ...(versionPrefix ? { versionPrefix } : {}),
        components: config.components,
        strict: config.strict,
        pages: pageMap,
        assets: assetSet,
      });
      if (!config.strict) {
        if (renderedBodyCache.size >= MAX_BODY_CACHE_ENTRIES) {
          const oldest = renderedBodyCache.keys().next().value;
          if (oldest !== undefined) renderedBodyCache.delete(oldest);
        }
        renderedBodyCache.set(cacheKey, rendered);
      }
    }

    for (const ph of rendered.placeholders) {
      const warning: SiteBuildWarning = {
        path: page.path,
        line: ph.line,
        kind: ph.reason,
        detail: ph.name,
      };
      warnings.push(warning);
      emit(`warn ${page.path}:${ph.line ?? '?'} ${ph.reason} ${ph.name}`);
    }
    for (const bl of rendered.brokenLinks) {
      const warning: SiteBuildWarning = {
        path: page.path,
        line: bl.line,
        kind: 'broken-link',
        detail: `${bl.href} (${bl.resolvedPath})`,
      };
      warnings.push(warning);
      emit(`warn ${page.path}:${bl.line ?? '?'} broken-link ${bl.href}`);
    }

    const html = renderDocumentHtml({
      siteTitle,
      pageTitle: page.title || rendered.searchDoc.title,
      ...(rendered.searchDoc.description ? { description: rendered.searchDoc.description } : {}),
      currentUrl: page.url,
      bodyHtml: rendered.html,
      nav,
      headings: rendered.searchDoc.headings,
      ...(versionPrefix ? { versionPrefix } : {}),
      searchable: !page.hidden,
    });

    const relOutFile = urlToRelativeFile(page.url, versionPrefix);
    writeFileEnsuringDir(path.join(buildDir, relOutFile), html);

    if (!page.hidden) {
      pagesToIndex.push({ url: page.url, html });
    }
  }

  for (const asset of activeAssets) {
    const cleanRel = asset.path.replace(/^\/+/, '');
    writeFileEnsuringDir(path.join(buildDir, cleanRel), asset.bytes);
  }

  const liveUrls = new Set(activePages.map((p) => p.url));
  const redirectMap = new Map<string, string>();
  for (const r of input.inferredRedirects ?? []) {
    const from = applyVersionPrefix(r.from, versionPrefix);
    const to = r.to.startsWith('/') ? applyVersionPrefix(r.to, versionPrefix) : r.to;
    if (!liveUrls.has(from) && from !== to) {
      redirectMap.set(from, to);
    }
  }
  for (const r of config.redirects) {
    const from = applyVersionPrefix(r.from, versionPrefix);
    const to = r.to.startsWith('/') ? applyVersionPrefix(r.to, versionPrefix) : r.to;
    if (!liveUrls.has(from) && from !== to) {
      redirectMap.set(from, to);
    }
  }

  for (const [fromUrl, toUrl] of redirectMap) {
    const relOutFile = urlToRelativeFile(fromUrl, versionPrefix);
    const html = renderRedirectHtml({ fromUrl, toUrl, siteTitle });
    writeFileEnsuringDir(path.join(buildDir, relOutFile), html);
  }

  writeFileEnsuringDir(
    path.join(buildDir, '404.html'),
    render404Html({
      siteTitle,
      nav,
      ...(versionPrefix ? { versionPrefix } : {}),
    }),
  );

  linkDirectoryIndexHtml(buildDir);

  let indexedPageCount = 0;
  if (input.indexSearch !== false) {
    indexedPageCount = await runPagefindIndex(pagesToIndex, path.join(buildDir, 'pagefind'));
  }

  const spaceDir = path.join(input.sitesDir, 'spaces', input.spaceId);
  const releasesDir = path.join(spaceDir, 'releases');
  const releaseDir = path.join(releasesDir, buildStamp);
  mkdirSync(releaseDir, { recursive: true });

  const spaceBuildsRoot = path.join(input.sitesDir, 'builds', input.spaceId);
  if (isDefault) {
    hardlinkTree(buildDir, releaseDir);
    if (existsSync(spaceBuildsRoot)) {
      for (const entry of readdirSync(spaceBuildsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === input.version) continue;
        const otherVerDir = path.join(spaceBuildsRoot, entry.name);
        const latestOther = newestSubdir(otherVerDir);
        if (latestOther) {
          hardlinkTree(latestOther, path.join(releaseDir, entry.name));
        }
      }
    }
  } else {
    // Non-default version build: if a previous current release exists, hardlink it as base
    // and replace `<releaseDir>/<version>` with this new version build.
    const currentLinkPath = path.join(spaceDir, 'current');
    if (existsSync(currentLinkPath)) {
      hardlinkTree(currentLinkPath, releaseDir);
      rmSync(path.join(releaseDir, input.version), { recursive: true, force: true });
    }
    hardlinkTree(buildDir, path.join(releaseDir, input.version));
  }

  const currentLink = path.join(spaceDir, 'current');
  const relReleaseTarget = posixPath.join('releases', buildStamp);
  atomicSymlink(relReleaseTarget, currentLink, input.buildId);

  const sitesDomain = input.sitesDomain ?? 'docs.localhost';
  const hostnames = [`${input.spaceSlug}.${sitesDomain}`, ...(input.customDomains ?? [])];
  const byHostDir = path.join(input.sitesDir, 'by-host');
  const hostLinks: string[] = [];
  for (const hostname of hostnames) {
    const hostLink = path.join(byHostDir, hostname);
    const relSpaceTarget = posixPath.join('..', 'spaces', input.spaceId);
    atomicSymlink(relSpaceTarget, hostLink, input.buildId);
    hostLinks.push(hostLink);
  }

  const keepBuilds = input.keepBuilds ?? 5;
  pruneDirectory(
    path.join(input.sitesDir, 'builds', input.spaceId, input.version),
    keepBuilds,
    new Set([buildStamp]),
  );
  pruneDirectory(releasesDir, keepBuilds, new Set([buildStamp]));

  emit(
    `build ${input.spaceId} ${input.version} ${shortSha}: ${activePages.length} pages (${cachedPageCount} cached), ${activeAssets.length} assets, ${redirectMap.size} redirects, ${indexedPageCount} indexed, ${warnings.length} warnings -> ${hostnames[0]}`,
  );

  return {
    buildDir,
    releaseDir,
    currentLink,
    hostLinks,
    siteTitle,
    nav,
    pageCount: activePages.length,
    cachedPageCount,
    assetCount: activeAssets.length,
    redirectCount: redirectMap.size,
    indexedPageCount,
    warnings,
    logLines,
  };
}

function newestSubdir(parentDir: string): string | null {
  if (!existsSync(parentDir)) return null;
  const subdirs = readdirSync(parentDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const full = path.join(parentDir, d.name);
      return { full, mtimeMs: lstatSync(full).mtimeMs, name: d.name };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
  return subdirs[0]?.full ?? null;
}
