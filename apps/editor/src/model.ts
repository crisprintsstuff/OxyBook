// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The editor's pure logic: the page tree, upload paths, and the shapes the editor API
 * answers with. No DOM here, so it is tested under node.
 */

export type Role = 'admin' | 'editor' | 'viewer';
export type FileOp = 'add' | 'modify' | 'delete' | 'rename';

export interface TreePage {
  /** Repository path, content root included (`docs/guide.md`). */
  path: string;
  /** Path under the content root (`guide.md`). */
  relPath: string;
  url: string;
  title: string;
  navTitle: string | null;
  hidden: boolean;
  blobSha: string;
  othersEditing: string[];
}

export interface DraftSummary {
  id: string;
  version: number;
  state: 'editing' | 'proposed' | 'conflicted' | 'merged' | 'closed';
  baseRef: string;
  baseSha: string;
  branch: string | null;
  prNumber: number | null;
  prUrl: string | null;
  /** The commit the last propose pushed; it changes when a propose lands. */
  pushedSha: string | null;
  proposeError: string | null;
  files: { path: string; op: FileOp; oldPath: string | null }[];
}

export interface TreeResponse {
  space: { name: string; contentRoot: string; ref: string; head: string | null };
  user: { id: string; name: string };
  role: Role;
  csrfToken: string;
  pages: TreePage[];
  draft: DraftSummary | null;
}

export interface PageResponse {
  path: string;
  source: string;
  baseBlobSha: string | null;
  fromDraft: boolean;
  op?: FileOp;
  othersEditing?: string[];
}

export interface DiffFile {
  path: string;
  oldPath: string | null;
  op: FileOp;
  binary: boolean;
  additions: number;
  deletions: number;
  patch: string;
}

/** A placeholder (`name`) or a broken link (`href`), as the renderer reports them. */
export interface PreviewWarning {
  reason: string;
  name?: string;
  href?: string;
  line: number | null;
}

/** One line of text for a preview warning. */
export function describeWarning(w: PreviewWarning): string {
  const where = w.line ? `line ${w.line}: ` : '';
  if (w.reason === 'broken-link') return `${where}broken link ${w.href ?? ''}`.trim();
  const what = w.reason.replace(/-/g, ' ');
  return `${where}${what}${w.name ? ` (${w.name})` : ''}`;
}

export interface PreviewResponse {
  parsed: boolean;
  error?: string;
  html: string;
  warnings: PreviewWarning[];
}

/** One row of the sidebar: a directory heading or a page. */
export type TreeRow =
  | { kind: 'dir'; name: string; depth: number; key: string }
  | {
      kind: 'page';
      path: string;
      label: string;
      depth: number;
      key: string;
      hidden: boolean;
      /** What the user's own draft does to this file, if anything. */
      mine: FileOp | null;
      othersEditing: string[];
      /** True for a page that exists only in the user's draft. */
      added: boolean;
    };

const PAGE_FILE = /\.mdx?$/i;

function stripRoot(path: string, contentRoot: string): string {
  return contentRoot && path.startsWith(`${contentRoot}/`)
    ? path.slice(contentRoot.length + 1)
    : path;
}

/**
 * The sidebar rows, sorted by path, with the user's drafted pages folded in: modified and
 * deleted pages are marked, and pages added in the draft appear even though no sync has
 * seen them. `filter` keeps pages whose title or path contains it (case-insensitive).
 */
export function buildTreeRows(input: {
  pages: TreePage[];
  draft: DraftSummary | null;
  contentRoot: string;
  filter?: string;
}): TreeRow[] {
  const mine = new Map<string, FileOp>();
  for (const file of input.draft?.files ?? []) mine.set(file.path, file.op);

  type Entry = {
    path: string;
    rel: string;
    label: string;
    hidden: boolean;
    othersEditing: string[];
    added: boolean;
  };
  const entries: Entry[] = input.pages.map((p) => ({
    path: p.path,
    rel: p.relPath,
    label: p.navTitle || p.title || p.relPath,
    hidden: p.hidden,
    othersEditing: p.othersEditing,
    added: false,
  }));
  const known = new Set(entries.map((e) => e.path));
  for (const file of input.draft?.files ?? []) {
    if ((file.op === 'add' || file.op === 'rename') && !known.has(file.path)) {
      if (!PAGE_FILE.test(file.path)) continue;
      const rel = stripRoot(file.path, input.contentRoot);
      entries.push({
        path: file.path,
        rel,
        label: rel.split('/').pop() ?? rel,
        hidden: false,
        othersEditing: [],
        added: true,
      });
    }
  }

  const needle = input.filter?.trim().toLowerCase() ?? '';
  const kept = needle
    ? entries.filter(
        (e) => e.label.toLowerCase().includes(needle) || e.rel.toLowerCase().includes(needle),
      )
    : entries;
  kept.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  const rows: TreeRow[] = [];
  const opened: string[] = [];
  for (const entry of kept) {
    const dirs = entry.rel.split('/').slice(0, -1);
    let shared = 0;
    while (shared < dirs.length && shared < opened.length && dirs[shared] === opened[shared])
      shared++;
    opened.length = shared;
    for (let depth = shared; depth < dirs.length; depth++) {
      const name = dirs[depth] as string;
      opened.push(name);
      rows.push({ kind: 'dir', name, depth, key: `dir:${dirs.slice(0, depth + 1).join('/')}` });
    }
    rows.push({
      kind: 'page',
      path: entry.path,
      label: entry.label,
      depth: dirs.length,
      key: `page:${entry.path}`,
      hidden: entry.hidden,
      mine: mine.get(entry.path) ?? null,
      othersEditing: entry.othersEditing,
      added: entry.added,
    });
  }
  return rows;
}

/**
 * Where an uploaded image goes (ARCHITECTURE §2: an `images/` directory next to the page)
 * and the relative reference to put in the page, so it also renders on GitHub.
 */
export function uploadTarget(
  pagePath: string,
  fileName: string,
): { path: string; reference: string } {
  const dir = pagePath.includes('/') ? pagePath.slice(0, pagePath.lastIndexOf('/')) : '';
  const dot = fileName.lastIndexOf('.');
  const ext = dot > 0 ? fileName.slice(dot).toLowerCase() : '';
  const stem = (dot > 0 ? fileName.slice(0, dot) : fileName)
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .toLowerCase();
  const name = `${stem || 'image'}${ext}`;
  return { path: dir ? `${dir}/images/${name}` : `images/${name}`, reference: `images/${name}` };
}

/** The alt text for an uploaded image: its file name without the extension. */
export function altText(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return (dot > 0 ? fileName.slice(0, dot) : fileName).replace(/[[\]\n]/g, ' ').trim();
}

/**
 * Turn the path a user typed for a new page into a repository path under the content
 * root, or say why it cannot be one.
 */
export function newPagePath(
  typed: string,
  contentRoot: string,
): { path: string } | { error: string } {
  let rel = typed.trim().replace(/^\/+/, '');
  if (!rel) return { error: 'Type a file name, such as guides/new-page.md.' };
  if (!PAGE_FILE.test(rel)) rel = `${rel}.md`;
  const parts = rel.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..' || p.startsWith('.')))
    return { error: 'A page path cannot have empty, hidden, or ".." segments.' };
  return { path: contentRoot ? `${contentRoot}/${rel}` : rel };
}

/** A starting body for a new page: a heading from the file name. */
export function newPageSource(path: string): string {
  const name = (path.split('/').pop() ?? path).replace(PAGE_FILE, '');
  const title = name.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  return `# ${title || 'New page'}\n`;
}

/** Split a unified diff into lines tagged for display. */
export function diffLines(
  patch: string,
): { kind: 'add' | 'del' | 'hunk' | 'meta' | 'ctx'; text: string }[] {
  const lines = patch.endsWith('\n') ? patch.slice(0, -1).split('\n') : patch.split('\n');
  return lines.map((text) => {
    if (text.startsWith('+++') || text.startsWith('---')) return { kind: 'meta', text };
    if (text.startsWith('@@')) return { kind: 'hunk', text };
    if (text.startsWith('+')) return { kind: 'add', text };
    if (text.startsWith('-')) return { kind: 'del', text };
    if (text.startsWith('\\')) return { kind: 'meta', text };
    return { kind: 'ctx', text };
  });
}

/** `/orgs/<org>/spaces/<space>/edit` → the org and space slugs. */
export function routeFromPath(pathname: string): { org: string; space: string } | null {
  const match = /^\/orgs\/([a-z0-9-]+)\/spaces\/([a-z0-9-]+)\/edit\/?$/.exec(pathname);
  return match?.[1] && match[2] ? { org: match[1], space: match[2] } : null;
}

/**
 * The relative link from one page to another, as authored in markdown (ARCHITECTURE §2.5:
 * internal links are relative file paths, so they also work on GitHub).
 */
export function relativeLink(fromPath: string, toPath: string): string {
  const from = fromPath.split('/').slice(0, -1);
  const to = toPath.split('/');
  let shared = 0;
  while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) shared++;
  const up = from.length - shared;
  return [...Array(up).fill('..'), ...to.slice(shared)].join('/');
}

/** A span of a conflicted file (packages/drafts merge3): merged on its own, or a conflict. */
export type ConflictRegion =
  | { kind: 'same'; text: string }
  | { kind: 'mine' | 'theirs' | 'both'; text: string; base: string }
  | { kind: 'conflict'; base: string; mine: string; theirs: string };

export type RegionChoice = 'mine' | 'theirs' | { text: string };

export interface FileConflict {
  path: string;
  oldPath: string | null;
  op: FileOp;
  code: string;
  why: string;
  kind: 'regions' | 'choice';
  regions: ConflictRegion[] | null;
  conflicts: number;
  choices: ('keep-mine' | 'take-theirs')[];
  mine: string | null;
  theirs: string | null;
}

export interface ConflictView {
  draftId: string;
  version: number;
  head: string;
  files: FileConflict[];
}

/** The merged file for one choice per conflict region (null while any is missing). */
export function resolvedText(
  regions: readonly ConflictRegion[],
  choices: readonly (RegionChoice | undefined)[],
): string | null {
  let out = '';
  let i = 0;
  for (const region of regions) {
    if (region.kind !== 'conflict') {
      out += region.text;
      continue;
    }
    const choice = choices[i++];
    if (choice === undefined) return null;
    out += choice === 'mine' ? region.mine : choice === 'theirs' ? region.theirs : choice.text;
  }
  return out;
}

/** A region's text without the blank lines that separate it from the block before. */
export function displayBlock(text: string): string {
  return text.replace(/^(\r?\n)+/, '');
}
