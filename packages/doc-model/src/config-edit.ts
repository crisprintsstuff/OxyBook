// SPDX-License-Identifier: AGPL-3.0-only

import { isMap, isScalar, isSeq, parseDocument } from 'yaml';

/**
 * Byte-preserving edits to `oxybook.yml` (ARCHITECTURE §2.5): lines are inserted as text,
 * never re-serialized, so comments, order, quoting and every other byte stay as they were.
 * Anything the writer cannot edit that way is refused with a message, not rewritten.
 */

export class ConfigEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigEditError';
  }
}

function scalar(value: string): string {
  return /^[A-Za-z0-9_./~%+-]+$/.test(value) && !/^[-~]$/.test(value)
    ? value
    : JSON.stringify(value);
}

function redirectsOf(source: string): { from: string; to: string }[] {
  const doc = parseDocument(source);
  const list = doc.toJS()?.redirects;
  return Array.isArray(list)
    ? list.filter(
        (r): r is { from: string; to: string } =>
          r && typeof r.from === 'string' && typeof r.to === 'string',
      )
    : [];
}

/**
 * `oxybook.yml` with one more `redirects:` entry, `from` → `to` (site URLs). `source` is
 * the current file, or null when the repository has none.
 */
export function appendRedirect(source: string | null, from: string, to: string): string {
  const eol = source?.includes('\r\n') ? '\r\n' : '\n';
  const item = (indent: string) =>
    `${indent}- from: ${scalar(from)}${eol}${indent}  to: ${scalar(to)}${eol}`;
  if (source === null || source.trim() === '') {
    return `${source ?? ''}redirects:${eol}${item('  ')}`;
  }
  const doc = parseDocument(source);
  if (doc.errors.length > 0)
    throw new ConfigEditError(
      `oxybook.yml does not parse (${doc.errors[0]?.message}); fix it first`,
    );
  if (!isMap(doc.contents))
    throw new ConfigEditError('oxybook.yml is not a mapping at the top level');
  const pair = doc.contents.items.find((p) => isScalar(p.key) && p.key.value === 'redirects');
  let out: string;
  if (!pair) {
    const head = source.endsWith('\n') ? source : `${source}${eol}`;
    out = `${head}redirects:${eol}${item('  ')}`;
  } else if (pair.value === null || (isScalar(pair.value) && pair.value.value === null)) {
    // `redirects:` with nothing after it: the items go on the lines below the key.
    const keyRange = (pair.key as { range?: [number, number, number] }).range;
    if (!keyRange) throw new ConfigEditError('cannot locate redirects: in oxybook.yml');
    const lineEnd = source.indexOf('\n', keyRange[0]);
    const at = lineEnd < 0 ? source.length : lineEnd + 1;
    const prefix = lineEnd < 0 ? eol : '';
    out = source.slice(0, at) + prefix + item('  ') + source.slice(at);
  } else if (isSeq(pair.value) && !pair.value.flow && pair.value.items.length > 0) {
    const seq = pair.value;
    const range = seq.range as [number, number, number];
    const first = seq.items[0] as { range?: [number, number, number] };
    const firstStart = first.range?.[0] ?? range[0];
    const lineStart = source.lastIndexOf('\n', firstStart) + 1;
    const dash = source.indexOf('-', lineStart);
    const indent = source.slice(lineStart, dash);
    if (!/^[ \t]*$/.test(indent))
      throw new ConfigEditError('cannot read the redirects list layout');
    // After the last item's last line.
    const lineEnd = source.indexOf('\n', Math.max(range[1] - 1, lineStart));
    const at = lineEnd < 0 ? source.length : lineEnd + 1;
    const prefix = lineEnd < 0 ? eol : '';
    out = source.slice(0, at) + prefix + item(indent) + source.slice(at);
  } else {
    throw new ConfigEditError(
      'redirects: in oxybook.yml is not a block list OxyBook can append to; add the redirect by hand',
    );
  }
  const after = redirectsOf(out);
  const last = after[after.length - 1];
  if (
    parseDocument(out).errors.length > 0 ||
    after.length !== redirectsOf(source).length + 1 ||
    last?.from !== from ||
    last?.to !== to
  )
    throw new ConfigEditError('could not add the redirect to oxybook.yml without rewriting it');
  return out;
}
