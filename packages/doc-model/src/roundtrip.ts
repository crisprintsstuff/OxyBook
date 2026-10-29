// SPDX-License-Identifier: AGPL-3.0-only

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { checkIdentity } from './identity.js';
import type { FileReport } from './types.js';

const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'cache']);

export function listMarkdownFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        visit(full);
      } else if (entry.isFile()) {
        const lower = entry.name.toLowerCase();
        if (lower.endsWith('.md') || lower.endsWith('.mdx')) files.push(full);
      }
    }
  };
  visit(root);
  files.sort();
  return files;
}

function decodeUtf8(buffer: Buffer): { ok: true; text: string } | { ok: false; error: string } {
  const text = buffer.toString('utf8');
  if (!buffer.equals(Buffer.from(text, 'utf8'))) {
    return { ok: false, error: 'file is not valid UTF-8' };
  }
  return { ok: true, text };
}

export function checkMarkdownFile(file: string, display = file): FileReport {
  let buffer: Buffer;
  try {
    buffer = readFileSync(file);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unreadable file';
    return { file: display, status: 'error', detail };
  }
  const decoded = decodeUtf8(buffer);
  if (!decoded.ok) return { file: display, status: 'unparseable', detail: decoded.error };
  try {
    const report = checkIdentity(decoded.text, { filename: file });
    return {
      file: display,
      status: report.status,
      ...(report.detail ? { detail: report.detail } : {}),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unexpected error';
    return { file: display, status: 'error', detail };
  }
}

export function roundtripPath(target: string): FileReport[] {
  const stat = statSync(target);
  if (stat.isFile()) return [checkMarkdownFile(target, path.basename(target))];
  return listMarkdownFiles(target).map((file) =>
    checkMarkdownFile(file, path.relative(target, file) || path.basename(file)),
  );
}

export function formatReport(reports: readonly FileReport[]): string {
  const lines = ['status        file'];
  for (const report of reports) {
    const status = report.status.toUpperCase().padEnd(13, ' ');
    const detail = report.detail ? `  ${report.detail.split('\n')[0]}` : '';
    lines.push(`${status} ${report.file}${detail}`);
  }
  const count = (status: FileReport['status']) =>
    reports.filter((report) => report.status === status).length;
  lines.push('');
  lines.push(
    `${count('pass')} pass, ${count('fail')} fail, ${count('unparseable')} unparseable, ${count('error')} error, ${reports.length} total`,
  );
  return lines.join('\n');
}

/** Non-zero when any file failed identity or crashed. Unparseable files are reported and do not fail. */
export function exitCodeFor(reports: readonly FileReport[]): number {
  return reports.some((report) => report.status === 'fail' || report.status === 'error') ? 1 : 0;
}
