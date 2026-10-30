#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzeFile,
  type FileCompat,
  formatPlaceholders,
  formatSummary,
  STARTING_ALLOWLIST,
  summarize,
} from './compat.js';
import { listMarkdownFiles } from './roundtrip.js';

const USAGE = `usage: oxybook-check <file-or-directory> [--json] [--allow Name,Name] [--quiet]

Reports what would not render as written: unknown MDX components, non-static props,
expressions, exports, and non-callout directives become placeholders with a warning.
Nothing in the files is executed. Exit code 0 even when placeholders are found.`;

export function main(argv: readonly string[]): number {
  const args = argv.slice(2);
  const target = args.find((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--allow');
  if (!target || args.includes('--help') || args.includes('-h')) {
    console.error(USAGE);
    return target ? 0 : 2;
  }
  const allowIndex = args.indexOf('--allow');
  const allowlist =
    allowIndex >= 0
      ? [...STARTING_ALLOWLIST, ...(args[allowIndex + 1] ?? '').split(',').filter(Boolean)]
      : STARTING_ALLOWLIST;
  const resolved = path.resolve(target);
  if (!existsSync(resolved)) {
    console.error(`oxybook-check: not found: ${target}`);
    return 2;
  }
  const root = statSync(resolved).isDirectory() ? resolved : path.dirname(resolved);
  const paths = statSync(resolved).isDirectory() ? listMarkdownFiles(resolved) : [resolved];
  const files: FileCompat[] = paths.map((file) =>
    analyzeFile(file, path.relative(root, file) || path.basename(file), { allowlist }),
  );
  const summary = summarize(files);
  if (args.includes('--json')) {
    console.log(JSON.stringify({ allowlist, summary, files }, null, 2));
    return 0;
  }
  if (!args.includes('--quiet')) {
    const warnings = formatPlaceholders(files);
    if (warnings) console.log(`${warnings}\n`);
  }
  console.log(formatSummary(target, summary));
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  // exitCode, not exit(): exit() can cut off a large --json write to a pipe.
  process.exitCode = main(process.argv);
}
