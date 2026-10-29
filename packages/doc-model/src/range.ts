// SPDX-License-Identifier: AGPL-3.0-only

export interface ChangeRegion {
  /** First index that differs, in the original string. */
  start: number;
  /** End (exclusive) of the changed region in the original string. */
  beforeEnd: number;
  /** End (exclusive) of the replacement in the edited string. */
  afterEnd: number;
}

/**
 * Longest common prefix and suffix. Returns null when the strings are equal.
 * The region describes the original string's changed span, which stays valid
 * even when the replacement is a different length.
 */
export function changedRegion(before: string, after: string): ChangeRegion | null {
  if (before === after) return null;
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before[start] === after[start]) start++;
  let suffix = 0;
  while (
    suffix < before.length - start &&
    suffix < after.length - start &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }
  return {
    start,
    beforeEnd: before.length - suffix,
    afterEnd: after.length - suffix,
  };
}

export function regionWithin(region: ChangeRegion, start: number, end: number): boolean {
  return region.start >= start && region.beforeEnd <= end;
}

export function lineAndColumn(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  const limit = Math.min(offset, source.length);
  for (let i = 0; i < limit; i++) {
    if (source[i] === '\n') {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

export function snippet(source: string, offset: number): string {
  const from = Math.max(0, offset - 24);
  const to = Math.min(source.length, offset + 24);
  return JSON.stringify(source.slice(from, to));
}

/** A top-level markdown block occupies whole lines when its range stops at a break. */
export function isLineAligned(source: string, start: number, end: number): boolean {
  const startOk = start === 0 || source[start - 1] === '\n' || source[start - 1] === '\uFEFF';
  const endOk = end === source.length || source[end] === '\n' || source[end] === '\r';
  return startOk && endOk;
}
