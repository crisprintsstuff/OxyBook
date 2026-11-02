// SPDX-License-Identifier: AGPL-3.0-only

import {
  appendRedirect,
  ConfigEditError,
  hrefBetween,
  resolveHref,
  rewriteLinks,
  splitHref,
} from '@oxybook/doc-model';
import { type DraftFile, DraftInputError } from './drafts.js';

/**
 * Rename or move a page from the editor (ARCHITECTURE §2.5, docs/M3-PLAN.md slice 3): one
 * change set with the move, a redirect in `oxybook.yml`, and every inbound relative link
 * in the space patched in its destination span only. The moved page's own relative links
 * are re-pointed when its directory changes. Links inside raw blocks are reported, not
 * touched.
 */

/** A file as the draft sees it: the head's bytes, or the draft's when it has the file. */
export interface SpaceFile {
  path: string;
  bytes: Buffer;
  /** What a save of this file records as its base; null for a file only in the draft. */
  baseBlobSha: string | null;
  /** The draft row for this file, when there is one. */
  drafted: Pick<DraftFile, 'op' | 'oldPath'> | null;
}

export interface FileChange {
  op: DraftFile['op'];
  path: string;
  oldPath?: string;
  baseBlobSha?: string;
  bytes?: Buffer;
}

export interface RenamePlan {
  changes: FileChange[];
  /** Draft rows to drop (the old path of a page that only existed in the draft). */
  remove: string[];
  patched: { path: string; links: number }[];
  /** Raw blocks (JSX, HTML) that mention the old file name; not changed. */
  rawMentions: { path: string; line: number }[];
  redirect: { from: string; to: string } | null;
}

const PAGE = /\.mdx?$/i;

export function planRename(input: {
  from: string;
  to: string;
  files: SpaceFile[];
  config: { bytes: Buffer | null; baseBlobSha: string | null; drafted: boolean };
  /** Site URLs before and after; no redirect when they are equal or the page is new. */
  oldUrl: string | null;
  newUrl: string;
}): RenamePlan {
  const { from, to } = input;
  if (from === to) throw new DraftInputError('the new path is the same as the old one');
  if (!PAGE.test(to)) throw new DraftInputError('a page keeps a .md or .mdx extension');
  if (/\.mdx$/i.test(from) !== /\.mdx$/i.test(to))
    throw new DraftInputError(
      'renaming cannot change .md to .mdx or back; it changes how the page parses',
    );
  const byPath = new Map(input.files.map((f) => [f.path, f]));
  const moved = byPath.get(from);
  if (!moved) throw new DraftInputError(`${from} is not a page in this space`);
  if (byPath.has(to)) throw new DraftInputError(`${to} already exists`);

  const plan: RenamePlan = {
    changes: [],
    remove: [],
    patched: [],
    rawMentions: [],
    redirect: null,
  };
  const oldName = from.split('/').pop() as string;

  // The moved page: its own relative links follow it.
  let movedText = moved.bytes.toString('utf8');
  const own = rewriteLinks(movedText, { filename: from }, (raw) => {
    const { path, suffix } = splitHref(raw);
    const target = resolveHref(from, path);
    if (target === null || path === '') return null;
    const next = target === from ? to : target;
    if (resolveHref(to, path) === next) return null; // still right from the new place
    return hrefBetween(to, next) + suffix;
  });
  if (own) {
    movedText = own.text;
    if (own.changed.length) plan.patched.push({ path: to, links: own.changed.length });
  }
  const movedBytes = Buffer.from(movedText, 'utf8');
  if (moved.drafted?.op === 'add') {
    // A page that only exists in the draft: re-add it under the new path. No redirect.
    plan.remove.push(from);
    plan.changes.push({ op: 'add', path: to, bytes: movedBytes });
  } else {
    const origin = moved.drafted?.op === 'rename' ? (moved.drafted.oldPath as string) : from;
    if (moved.drafted?.op === 'rename') plan.remove.push(from);
    plan.changes.push({
      op: 'rename',
      path: to,
      oldPath: origin,
      baseBlobSha: moved.baseBlobSha as string,
      bytes: movedBytes,
    });
  }

  // Every other page: inbound links to the old path now point at the new one.
  for (const file of input.files) {
    if (file.path === from || !PAGE.test(file.path)) continue;
    const text = file.bytes.toString('utf8');
    const out = rewriteLinks(text, { filename: file.path }, (raw) => {
      const { path, suffix } = splitHref(raw);
      return path !== '' && resolveHref(file.path, path) === from
        ? hrefBetween(file.path, to) + suffix
        : null;
    });
    for (const block of out?.rawBlocks ?? []) {
      if (block.source.includes(oldName))
        plan.rawMentions.push({ path: file.path, line: block.line });
    }
    if (!out || out.changed.length === 0) continue;
    plan.patched.push({ path: file.path, links: out.changed.length });
    const bytes = Buffer.from(out.text, 'utf8');
    if (file.drafted)
      plan.changes.push({
        op: file.drafted.op === 'rename' ? 'rename' : file.drafted.op,
        path: file.path,
        ...(file.drafted.oldPath ? { oldPath: file.drafted.oldPath } : {}),
        ...(file.baseBlobSha ? { baseBlobSha: file.baseBlobSha } : {}),
        bytes,
      });
    else
      plan.changes.push({
        op: 'modify',
        path: file.path,
        baseBlobSha: file.baseBlobSha as string,
        bytes,
      });
  }

  // The redirect, for a page the site already serves at another URL.
  if (moved.drafted?.op !== 'add' && input.oldUrl && input.oldUrl !== input.newUrl) {
    let config: string;
    try {
      config = appendRedirect(
        input.config.bytes?.toString('utf8') ?? null,
        input.oldUrl,
        input.newUrl,
      );
    } catch (error) {
      if (error instanceof ConfigEditError) throw new DraftInputError(error.message);
      throw error;
    }
    plan.redirect = { from: input.oldUrl, to: input.newUrl };
    plan.changes.push(
      input.config.baseBlobSha
        ? {
            op: 'modify',
            path: 'oxybook.yml',
            baseBlobSha: input.config.baseBlobSha,
            bytes: Buffer.from(config),
          }
        : { op: 'add', path: 'oxybook.yml', bytes: Buffer.from(config) },
    );
  }
  return plan;
}
