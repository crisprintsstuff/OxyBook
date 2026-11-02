// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Browser check of the editor (M2 slice 4b): sign in, open a page, edit it, see the
 * preview change, read the diff, and propose. Runs the real app server against a scratch
 * schema; the propose job is faked (the worker's push and PR are covered elsewhere).
 *
 *   DATABASE_URL=… node --import tsx e2e/editor.e2e.ts
 *
 * Needs Playwright with Chromium (`PLAYWRIGHT_MODULE` can point at it). Not part of CI.
 */

// biome-ignore-all lint/suspicious/noExplicitAny: Playwright is not a dependency here, so its types are not either.

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { createDb, migrateToLatest, sql } from '@oxybook/db';
import { createSession, SESSION_COOKIE_NAME, signUpUser } from '../src/auth.js';
import { startAppServer } from '../src/main.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright') as {
  chromium: { launch(): Promise<any> };
};

const PAGE = `---
title: Guide
weird: [1, {a: b}]   # a comment
---

# Guide

<Tabs>
  <TabItem label="One">Kept as is.</TabItem>
</Tabs>

Read the [install page](install.md).

<div align="center">raw html</div>
`;
const sha1 = (text: string) =>
  createHash('sha1')
    .update(`blob ${Buffer.byteLength(text)}\0${text}`)
    .digest('hex');

const schema = `oxybook_e2e_${randomBytes(5).toString('hex')}`;
const admin = createDb(url, { max: 1 });
await sql.raw(`CREATE SCHEMA ${schema}`).execute(admin);
const db = createDb(url, { max: 4, searchPath: schema });
const queued: unknown[] = [];
let app: { close(): Promise<void>; port: number } | undefined;
let browser: any;
try {
  await migrateToLatest(db, { schema });
  const user = await signUpUser(db, {
    email: 'e2e@example.com',
    name: 'Edie',
    password: 'password-1234',
  });
  const org = await db
    .insertInto('orgs')
    .values({ slug: 'cris', name: 'Cris' })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('org_members')
    .values({ org_id: org.id, user_id: user.id, role: 'owner' })
    .onConflict((oc) => oc.doNothing())
    .execute();
  const space = await db
    .insertInto('spaces')
    .values({
      org_id: org.id,
      slug: 'test',
      name: 'Test docs',
      content_root: 'docs',
      default_ref: 'main',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('space_members')
    .values({ org_id: org.id, space_id: space.id, user_id: user.id, role: 'editor' })
    .onConflict((oc) => oc.doNothing())
    .execute();
  await db
    .insertInto('ref_state')
    .values({ org_id: org.id, space_id: space.id, ref: 'main', head_sha: 'c'.repeat(40) })
    .execute();
  for (const [path, text, title, page] of [
    ['guide.mdx', PAGE, 'Guide', '/guide'],
    ['install.md', '# Install\n\nRun it.\n', 'Install', '/install'],
  ] as const) {
    await db
      .insertInto('blobs')
      .values({ org_id: org.id, sha: sha1(text), bytes: Buffer.from(text) })
      .onConflict((oc) => oc.doNothing())
      .execute();
    await db
      .insertInto('pages')
      .values({
        org_id: org.id,
        space_id: space.id,
        ref: 'main',
        path,
        blob_sha: sha1(text),
        title,
        url: page,
        nav_title: null,
      })
      .execute();
  }
  const session = await createSession(db, user.id);

  app = (await startAppServer({
    port: 0,
    host: '127.0.0.1',
    publicUrl: 'http://127.0.0.1',
    ui: {
      db,
      secretKey: 'e2e-secret-key-e2e-secret-key-e2e',
      jobs: {
        async send(queue: string, data: unknown) {
          queued.push({ queue, data });
          // Stand in for the worker: the draft is pushed and its PR opened.
          const draftId = (data as { draftId: string }).draftId;
          await db
            .updateTable('drafts')
            .set({
              state: 'proposed',
              pr_number: 8,
              pr_url: 'https://github.com/o/r/pull/8',
              pushed_sha: 'd'.repeat(40),
              pushed_base_sha: 'c'.repeat(40),
              branch: 'oxybook/edie/guide-1',
            })
            .where('id', '=', draftId)
            .execute();
          return 'job-1';
        },
      },
    },
  } as never)) as never;
  const base = `http://127.0.0.1:${app?.port}`;

  browser = await chromium.launch();
  const context = await browser.newContext({
    colorScheme: process.env.E2E_COLOR_SCHEME === 'dark' ? 'dark' : 'light',
  });
  await context.addCookies([{ name: SESSION_COOKIE_NAME, value: session.token, url: base }]);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push(e.message));
  page.on('console', (m: any) => m.type() === 'error' && errors.push(m.text()));

  await page.goto(`${base}/orgs/cris/spaces/test/edit`);
  await page.getByRole('button', { name: 'Guide' }).waitFor();

  // The page opens in the visual editor; JSX and raw HTML show as kept-as-is blocks.
  const editor = page.locator('.visual-editor .ProseMirror');
  await editor.waitFor();
  assert.match((await page.locator('.ob-raw').first().textContent()) ?? '', /<Tabs>/);
  assert.equal(await page.locator('.ob-raw, .ob-raw-inline').count(), 2);
  const preview = page.frameLocator('iframe[title="Page preview"]');
  await preview.locator('h1', { hasText: 'Guide' }).waitFor();

  // Edit one paragraph.
  await editor.locator('p', { hasText: 'Read the install page' }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Then come back.');
  await page.getByRole('status').filter({ hasText: 'Saved' }).waitFor({ timeout: 10_000 });
  await preview.locator('p', { hasText: 'Then come back.' }).waitFor();
  await page.screenshot({ path: process.env.E2E_SCREENSHOT ?? '/tmp/editor-e2e.png' });

  // The diff touches only that paragraph's line.
  await page.getByRole('button', { name: /Changes \(1\)/ }).click();
  const diff = page.locator('pre.diff');
  await diff.waitFor();
  const diffLines = async () =>
    (await diff.locator('div.diff-add, div.diff-del').allTextContents()).map((l) => l.trim());
  assert.deepEqual(await diffLines(), [
    '-Read the [install page](install.md).',
    '+Read the [install page](install.md). Then come back.',
  ]);
  await page.screenshot({
    path: (process.env.E2E_SCREENSHOT ?? '/tmp/editor-e2e.png').replace('.png', '-diff.png'),
  });
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();

  // Link to another page with the picker: a relative file path goes in.
  await editor.locator('p', { hasText: 'Then come back.' }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' See ');
  await page.getByRole('button', { name: 'Link', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^Install/ })
    .click();

  // Change the title in page settings; only that frontmatter scalar changes.
  await page.locator('.meta summary').click();
  const title = page.getByLabel('Title', { exact: true });
  await title.fill('Guide, revised');
  await title.press('Enter');
  await page.getByRole('status').filter({ hasText: 'Saved' }).waitFor({ timeout: 10_000 });
  const expected = PAGE.replace('title: Guide\n', 'title: "Guide, revised"\n').replace(
    '(install.md).',
    '(install.md). Then come back. See [Install](install.md)',
  );

  // Source mode shows the same bytes.
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await page.locator('.cm-content').waitFor();
  assert.match(
    (await page.locator('.cm-content').textContent()) ?? '',
    /Then come back\. See \[Install\]\(install\.md\)/,
  );
  await page.getByRole('button', { name: 'Visual', exact: true }).click();
  await editor.waitFor();
  await page.getByRole('status').filter({ hasText: 'Saved' }).waitFor({ timeout: 10_000 });
  await preview.locator('p', { hasText: 'See Install' }).waitFor({ timeout: 10_000 });
  await page.screenshot({
    path: (process.env.E2E_SCREENSHOT ?? '/tmp/editor-e2e.png').replace('.png', '-meta.png'),
  });

  // Propose.
  await page.getByRole('button', { name: 'Propose changes' }).click();
  await page.getByLabel('Pull request title').fill('Edit the guide');
  await page.getByLabel(/Signed-off-by/).check();
  await page.getByRole('dialog').getByRole('button', { name: 'Propose' }).click();
  await page
    .getByRole('dialog')
    .getByRole('link', { name: 'pull request #8' })
    .waitFor({ timeout: 15_000 });
  assert.deepEqual(
    (queued[0] as { data: { title: string; signOff: boolean } }).data.title,
    'Edit the guide',
  );
  assert.equal((queued[0] as { data: { signOff: boolean } }).data.signOff, true);

  // The saved draft holds exactly the edited bytes.
  const file = await db
    .selectFrom('draft_files')
    .select(['path', 'bytes'])
    .executeTakeFirstOrThrow();
  assert.equal(file.path, 'docs/guide.mdx');
  assert.equal(file.bytes?.toString('utf8'), expected);

  // Upstream edits the same paragraph; sync updates the read model and the rebase marks
  // the draft conflicted (both stood in for here). The editor resolves it block by block.
  const upstream = PAGE.replace(
    'Read the [install page](install.md).',
    'Read the [install guide](install.md) first.',
  );
  await db
    .insertInto('blobs')
    .values({ org_id: org.id, sha: sha1(upstream), bytes: Buffer.from(upstream) })
    .execute();
  await db
    .updateTable('pages')
    .set({ blob_sha: sha1(upstream) })
    .where('path', '=', 'guide.mdx')
    .execute();
  await db
    .updateTable('ref_state')
    .set({ head_sha: 'e'.repeat(40) })
    .execute();
  await db.updateTable('drafts').set({ state: 'conflicted' }).execute();
  await page.reload();
  await page.getByRole('button', { name: 'Resolve conflicts' }).click();
  const resolver = page.getByRole('dialog', { name: 'Resolve conflicts' });
  await resolver.locator('.conflict-region').waitFor();
  assert.equal(await resolver.locator('.conflict-region').count(), 1);
  assert.match((await resolver.locator('.sides').first().textContent()) ?? '', /install guide/);
  await resolver.getByRole('button', { name: 'Edit' }).click();
  await resolver
    .getByLabel('Resolved text for conflict 1')
    .fill('Read the [install guide](install.md) first. Then come back. See [Install](install.md)');
  await page.screenshot({
    path: (process.env.E2E_SCREENSHOT ?? '/tmp/editor-e2e.png').replace('.png', '-conflict.png'),
  });
  await resolver.getByRole('button', { name: 'Apply resolution' }).click();
  await page.getByText('Conflicts resolved.').waitFor();
  const resolved = await db
    .selectFrom('draft_files')
    .select(['bytes', 'base_blob_sha'])
    .executeTakeFirstOrThrow();
  // The title change merged on its own; the paragraph is the hand-written resolution.
  assert.equal(
    resolved.bytes?.toString('utf8'),
    expected.replace(
      'Read the [install page](install.md).',
      'Read the [install guide](install.md) first.',
    ),
  );
  assert.equal(resolved.base_blob_sha, sha1(upstream));
  const after = await db
    .selectFrom('drafts')
    .select(['state', 'base_sha'])
    .executeTakeFirstOrThrow();
  assert.deepEqual(after, { state: 'proposed', base_sha: 'e'.repeat(40) });
  assert.deepEqual(errors, []);
  console.log(
    'editor e2e: visual edit, link picker, page settings, source mode, diff, propose, conflict resolution: ok',
  );
} finally {
  await browser?.close();
  await app?.close();
  await db.destroy();
  await sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).execute(admin);
  await admin.destroy();
}
