// SPDX-License-Identifier: AGPL-3.0-only

import { mergeUnits } from '@oxybook/doc-model';
import { diffArrays } from 'diff';

/**
 * Block-level three-way merge (ARCHITECTURE §4.5). The three versions are split into the
 * same kind of merge units (`mergeUnits`: frontmatter lines, top-level blocks, trailing
 * bytes), and the merge runs over units, not characters: a unit neither side changed is
 * copied as it was, a unit only one side changed takes that side, and units both sides
 * changed differently form a conflict region of whole blocks. Joining the chosen text of
 * every region reproduces a file byte for byte.
 */

export type MergeRegion =
  | { kind: 'same'; text: string }
  /** Only one side changed this span, or both made the same change; `text` is the result. */
  | { kind: 'mine' | 'theirs' | 'both'; text: string; base: string }
  | { kind: 'conflict'; base: string; mine: string; theirs: string };

/** How to settle one conflict region: a side, or text written by hand. */
export type RegionChoice = 'mine' | 'theirs' | { text: string };

/** Base index → index in the other sequence, for items the diff keeps in common. */
function matches(base: string[], other: string[]): Map<number, number> {
  const map = new Map<number, number>();
  let i = 0;
  let j = 0;
  for (const part of diffArrays(base, other)) {
    const n = part.value.length;
    if (part.added) j += n;
    else if (part.removed) i += n;
    else {
      for (let k = 0; k < n; k++) map.set(i + k, j + k);
      i += n;
      j += n;
    }
  }
  return map;
}

const join = (units: string[]) => units.join('');

/** Merge three unit sequences into regions. */
export function mergeUnitLists(base: string[], mine: string[], theirs: string[]): MergeRegion[] {
  const inMine = matches(base, mine);
  const inTheirs = matches(base, theirs);
  const regions: MergeRegion[] = [];
  const pushSame = (text: string) => {
    if (text === '') return;
    const last = regions[regions.length - 1];
    if (last?.kind === 'same') last.text += text;
    else regions.push({ kind: 'same', text });
  };
  let b = 0;
  let m = 0;
  let t = 0;
  const settle = (bEnd: number, mEnd: number, tEnd: number) => {
    const n = bEnd - b;
    // Block-for-block replacements on both sides (the same number of units everywhere):
    // merge unit by unit, so edits to neighbouring blocks do not collide.
    if (n > 0 && mEnd - m === n && tEnd - t === n) {
      for (let i = 0; i < n; i++)
        classify(base[b + i] as string, mine[m + i] as string, theirs[t + i] as string);
      return;
    }
    classify(join(base.slice(b, bEnd)), join(mine.slice(m, mEnd)), join(theirs.slice(t, tEnd)));
  };
  const classify = (baseText: string, mineText: string, theirsText: string) => {
    if (mineText === baseText && theirsText === baseText) pushSame(baseText);
    else if (mineText === baseText)
      regions.push({ kind: 'theirs', text: theirsText, base: baseText });
    else if (theirsText === baseText)
      regions.push({ kind: 'mine', text: mineText, base: baseText });
    else if (mineText === theirsText)
      regions.push({ kind: 'both', text: mineText, base: baseText });
    else regions.push({ kind: 'conflict', base: baseText, mine: mineText, theirs: theirsText });
  };
  for (let k = 0; k < base.length; k++) {
    const mk = inMine.get(k);
    const tk = inTheirs.get(k);
    // A stable unit: unchanged on both sides, after everything already consumed.
    if (mk === undefined || tk === undefined || mk < m || tk < t || k < b) continue;
    settle(k, mk, tk);
    pushSame(base[k] as string);
    b = k + 1;
    m = mk + 1;
    t = tk + 1;
  }
  settle(base.length, mine.length, theirs.length);
  return regions;
}

/** Merge three versions of a file; `filename` decides how it splits into units. */
export function mergeText(
  base: string,
  mine: string,
  theirs: string,
  filename: string,
): MergeRegion[] {
  return mergeUnitLists(
    mergeUnits(base, { filename }),
    mergeUnits(mine, { filename }),
    mergeUnits(theirs, { filename }),
  );
}

export function conflictCount(regions: readonly MergeRegion[]): number {
  return regions.filter((r) => r.kind === 'conflict').length;
}

/**
 * The file for a set of choices, one per conflict region in order. Non-conflicting
 * regions always take their merged text.
 */
export function resolveRegions(
  regions: readonly MergeRegion[],
  choices: readonly RegionChoice[],
): string {
  let conflict = 0;
  let out = '';
  for (const region of regions) {
    if (region.kind === 'same') out += region.text;
    else if (region.kind !== 'conflict') out += region.text;
    else {
      const choice = choices[conflict++];
      if (choice === undefined) throw new Error(`no choice for conflict ${conflict}`);
      out += choice === 'mine' ? region.mine : choice === 'theirs' ? region.theirs : choice.text;
    }
  }
  if (conflict !== choices.length)
    throw new Error(`${choices.length} choices for ${conflict} conflicts`);
  return out;
}
