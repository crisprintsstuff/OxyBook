// SPDX-License-Identifier: AGPL-3.0-only

// H3 compatibility report over the pinned corpus (MVP.md, docs/M1-PLAN.md slice 1).
// Run `pnpm test:corpus` first: it fetches corpus/cache at the pinned SHAs.
// Prints markdown. Not a test: it never fails on what it finds.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzeFile,
  type FileCompat,
  formatSummary,
  ranked,
  STARTING_ALLOWLIST,
  summarize,
} from '../src/compat.js';
import { listMarkdownFiles } from '../src/roundtrip.js';

interface RepoPin {
  name: string;
  stack: string;
  sha: string;
  paths: string[];
}

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'corpus/manifest.json'), 'utf8')) as {
  repos: RepoPin[];
};

function analyzeTree(label: string, root: string, files: string[]): FileCompat[] {
  return files.map((file) => analyzeFile(file, `${label}/${path.relative(root, file)}`));
}

const byRepo = new Map<string, FileCompat[]>();
const fixtureRoot = path.join(repoRoot, 'corpus/fixtures');
byRepo.set('fixtures', analyzeTree('fixtures', fixtureRoot, listMarkdownFiles(fixtureRoot)));

for (const repo of manifest.repos) {
  const dest = path.join(repoRoot, 'corpus/cache', repo.name);
  const head = existsSync(path.join(dest, '.git'))
    ? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dest, encoding: 'utf8' }).trim()
    : null;
  if (head !== repo.sha) {
    console.error(
      `${repo.name}: cache is at ${head ?? 'nothing'}, expected ${repo.sha}. Run pnpm test:corpus.`,
    );
    process.exit(2);
  }
  const files = repo.paths.flatMap((docPath) => {
    const full = path.join(dest, docPath);
    return existsSync(full) ? listMarkdownFiles(full) : [];
  });
  byRepo.set(repo.name, analyzeTree(repo.name, dest, files));
}

const out: string[] = [];
out.push(`Starting allowlist: ${STARTING_ALLOWLIST.map((name) => `\`${name}\``).join(', ')}.`);
out.push('');
out.push(
  '| repo | stack | sha | files | .mdx | clean | clean % | unknown-component files | expression files | export files | directive files | `!!!` files |',
);
out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
const corpusOnly: FileCompat[] = [];
for (const [name, files] of byRepo) {
  const pin = manifest.repos.find((repo) => repo.name === name);
  const s = summarize(files);
  const parsed = s.files - s.unparseable;
  const pct = parsed === 0 ? 0 : Math.round((s.clean / parsed) * 1000) / 10;
  out.push(
    `| ${name} | ${pin?.stack ?? '-'} | ${pin ? pin.sha.slice(0, 12) : '-'} | ${s.files} | ${s.mdx} | ${s.clean} | ${pct} | ${s.filesWith['unknown-component']} | ${s.filesWith.expression} | ${s.filesWith.export} | ${s.filesWith.directive} | ${s.mkdocsAdmonitionFiles} |`,
  );
  if (pin) corpusOnly.push(...files);
}

// Which unknown components would remove the most placeholders, counted in files.
const repoOf = (file: FileCompat) => file.file.split('/')[0] ?? '';
const componentRepos = new Map<string, Set<string>>();
for (const file of corpusOnly) {
  for (const placeholder of file.placeholders) {
    if (placeholder.reason !== 'unknown-component') continue;
    const set = componentRepos.get(placeholder.name) ?? new Set<string>();
    set.add(repoOf(file));
    componentRepos.set(placeholder.name, set);
  }
}
const corpus = summarize(corpusOnly);
out.push('');
out.push('### Unknown components across the five repos, by files affected');
out.push('');
out.push('| component | files | uses | repos |');
out.push('| --- | --- | --- | --- |');
for (const [name, files] of ranked(corpus.unknownComponentFiles, 25)) {
  const repos = [...(componentRepos.get(name) ?? [])].sort().join(', ');
  out.push(`| \`${name}\` | ${files} | ${corpus.components[name] ?? 0} | ${repos} |`);
}
out.push('');
out.push(formatSummary('All five repos', corpus, 15));
for (const [name, files] of byRepo) {
  out.push('');
  out.push(formatSummary(name, summarize(files), 10));
}
console.log(out.join('\n'));
