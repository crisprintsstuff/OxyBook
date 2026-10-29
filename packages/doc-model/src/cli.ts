#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exitCodeFor, formatReport, roundtripPath } from './roundtrip.js';

export function main(argv: readonly string[]): number {
  const target = argv[2];
  if (!target || target === '--help' || target === '-h') {
    console.error('usage: oxybook-roundtrip <file-or-directory>');
    return target ? 0 : 2;
  }
  const resolved = path.resolve(target);
  if (!existsSync(resolved)) {
    console.error(`oxybook-roundtrip: not found: ${target}`);
    return 2;
  }
  const reports = roundtripPath(resolved);
  console.log(formatReport(reports));
  return exitCodeFor(reports);
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  process.exit(main(process.argv));
}
