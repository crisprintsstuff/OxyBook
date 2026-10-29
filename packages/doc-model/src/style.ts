// SPDX-License-Identifier: AGPL-3.0-only

import type { MdastNode, StyleProfile } from './types.js';

function mode<T extends string>(counts: Map<T, number>, fallback: T): T {
  let best = fallback;
  let bestCount = -1;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function sliceOf(body: string, node: MdastNode): string | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (typeof start !== 'number' || typeof end !== 'number') return null;
  return body.slice(start, end);
}

/**
 * Majority markers in the file. Used only when a dirty block is re-serialized
 * from scratch; unedited blocks keep their original bytes regardless.
 */
export function inferStyle(nodes: readonly MdastNode[], body: string): StyleProfile {
  const bullets = new Map<'-' | '*' | '+', number>();
  const emphasis = new Map<'*' | '_', number>();
  const strong = new Map<'*' | '_', number>();
  const fences = new Map<'`' | '~', number>();
  const delimiters = new Map<'.' | ')', number>();
  const rules = new Map<'-' | '*' | '_', number>();
  const indents = new Map<string, number>();
  let fenceLength = 3;
  let ruleRepetition = 3;
  let tabSeparated = false;
  let tablePad = true;
  let sawTable = false;

  const visit = (node: MdastNode): void => {
    const source = sliceOf(body, node);
    if (node.type === 'listItem' && source) {
      const bullet = /^(\s*)([-*+])([ \t])/.exec(source);
      const ordered = /^(\s*)\d+([.)])([ \t])/.exec(source);
      if (bullet?.[2] === '-' || bullet?.[2] === '*' || bullet?.[2] === '+') {
        bullets.set(bullet[2], (bullets.get(bullet[2]) ?? 0) + 1);
        if (bullet[1]) indents.set(bullet[1], (indents.get(bullet[1]) ?? 0) + 1);
        if (bullet[3] === '\t') tabSeparated = true;
      } else if (ordered?.[2] === '.' || ordered?.[2] === ')') {
        delimiters.set(ordered[2], (delimiters.get(ordered[2]) ?? 0) + 1);
        if (ordered[1]) indents.set(ordered[1], (indents.get(ordered[1]) ?? 0) + 1);
        if (ordered[3] === '\t') tabSeparated = true;
      }
    } else if (node.type === 'emphasis' && source) {
      if (source.startsWith('*')) emphasis.set('*', (emphasis.get('*') ?? 0) + 1);
      else if (source.startsWith('_')) emphasis.set('_', (emphasis.get('_') ?? 0) + 1);
    } else if (node.type === 'strong' && source) {
      if (source.startsWith('**')) strong.set('*', (strong.get('*') ?? 0) + 1);
      else if (source.startsWith('__')) strong.set('_', (strong.get('_') ?? 0) + 1);
    } else if (node.type === 'code' && source) {
      const fence = /^(```+|~~~+)/.exec(source);
      const marker = fence?.[1];
      if (marker?.[0] === '`' || marker?.[0] === '~') {
        fences.set(marker[0], (fences.get(marker[0]) ?? 0) + 1);
        fenceLength = marker.length;
      }
    } else if (node.type === 'thematicBreak' && source) {
      const marker = source.trim()[0];
      if (marker === '-' || marker === '*' || marker === '_') {
        rules.set(marker, (rules.get(marker) ?? 0) + 1);
        const run = source.trim().match(/^[^\s]/)?.[0];
        if (run) {
          const repeated = new RegExp(`^\\${run}+`).exec(source.trim());
          if (repeated) ruleRepetition = repeated[0].length;
        }
      }
    } else if (node.type === 'table' && source) {
      sawTable = true;
      tablePad = /\|[ \t]+\S/.test(source);
    }
    for (const child of node.children ?? []) visit(child);
  };
  for (const node of nodes) visit(node);

  return {
    bullet: mode(bullets, '-'),
    emphasis: mode(emphasis, '*'),
    strong: mode(strong, '*'),
    fence: mode(fences, '`'),
    fenceLength,
    orderedDelimiter: mode(delimiters, '.'),
    listItemIndent: tabSeparated ? 'tab' : 'one',
    listIndent: mode(indents, '  '),
    rule: mode(rules, '-'),
    ruleRepetition,
    tablePad: sawTable ? tablePad : true,
  };
}
