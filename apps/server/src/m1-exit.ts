// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  createDb,
  type Database,
  databaseUrlFromEnv,
  deriveSecretsKey,
  type Kysely,
  loadAppCredentials,
  migrateToLatest,
  saveAppCredentials,
  sql,
} from '@oxybook/db';
import { type AppCredentials, MemoryAppCredentials } from '@oxybook/github';
import { buildKey, type JobQueue, startJobs, syncKey } from '@oxybook/jobs';
import { type BuildEnvironment, runSpaceBuild } from '@oxybook/renderer';
import { authEnv, findStaleSpaces, runSpaceSync, storedAppTokens } from '@oxybook/sync';
import { handleDelivery } from './deliveries.js';
import { startAppServer } from './main.js';

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

export const SEED_SHA = '9f6835d1283b8ac01c0603767198e9632754c4fd';
export const PUSH_SHA = 'b604ea37c22c933f3f4dcf19be2d0e8c1ff34320';
export const RECONCILE_SHA = 'b8058130b7d5a9da6dc0646bf29e15fce32b3d58';

export interface M1ExitReport {
  startedAt: string;
  finishedAt: string;
  appSlug: string;
  appId: number;
  installationId: number;
  repo: string;
  caddyBaseUrl: string;
  step1Connect: {
    commitSha: string;
    spaceId: string;
    buildId: string;
    pageCount: number;
    indexedPageCount: number;
    warningCount: number;
  };
  step2WebhookPush: {
    deliveryId: string;
    commitSha: string;
    buildId: string;
    pageCount: number;
    indexedPageCount: number;
    redirectFrom: string;
    redirectTo: string;
    deletedUrlStatus: number;
  };
  step3Reconcile: {
    commitSha: string;
    buildId: string;
    pageCount: number;
    indexedPageCount: number;
  };
  step4AppStopped: {
    appStoppedVerified: boolean;
    exitSiteChecks: Record<string, number>;
    liveTestSiteChecks: Record<string, number>;
  };
}

async function git(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, {
    cwd,
    env: env ?? process.env,
    maxBuffer: 32 * 1024 * 1024,
  });
}

async function waitFor<T>(
  description: string,
  check: () => Promise<T | null | undefined | false>,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`timed out waiting for ${description} after ${timeoutMs}ms`);
}

async function startExitWorker(
  databaseUrl: string,
  schema: string,
  env: BuildEnvironment,
): Promise<{ jobs: JobQueue; stop(): Promise<void> }> {
  const jobs = await startJobs(databaseUrl, {
    schema,
    log: env.log ?? (() => {}),
  });
  const polling = { pollingIntervalSeconds: 0.5 };

  await jobs.work(
    'sync',
    async (job) => {
      const { spaceId, ref, reason } = job.data;
      env.log?.(`worker: sync ${job.id} space ${spaceId} ref ${ref} (${reason})`);
      await runSpaceSync(env, spaceId, ref);
      const buildJobId = await jobs.send(
        'build',
        { spaceId, version: 'default', ref, reason: 'sync' },
        { singletonKey: buildKey(spaceId, 'default') },
      );
      env.log?.(`worker: queued build ${buildJobId ?? 'already queued'}`);
    },
    polling,
  );

  await jobs.work(
    'build',
    async (job) => {
      const { spaceId, version, ref, reason } = job.data;
      env.log?.(`worker: build ${job.id} space ${spaceId} version ${version} (${reason})`);
      await runSpaceBuild(env, spaceId, { version, ref });
    },
    polling,
  );

  await jobs.work(
    'reconcile',
    async () => {
      for (const outcome of await findStaleSpaces(env)) {
        if (outcome.behind) {
          const id = await jobs.send(
            'sync',
            { spaceId: outcome.spaceId, ref: outcome.ref, reason: 'reconcile' },
            { singletonKey: syncKey(outcome.spaceId, outcome.ref) },
          );
          env.log?.(
            `worker: reconcile ${outcome.spaceId} stored=${outcome.stored?.slice(0, 12)} remote=${outcome.remote?.slice(0, 12)} -> sync ${id ?? 'already queued'}`,
          );
        }
      }
    },
    polling,
  );

  return {
    jobs,
    async stop() {
      await jobs.stop();
    },
  };
}

/**
 * Executes the full M1 exit sentence (docs/MVP.md, docs/M1-PLAN.md slice 9):
 * 1. Connect the test repository (`crisprintsstuff/oxybook-test`) via the UI/API
 *    with the §4.1 access check and verify the published site has working nav and search.
 * 2. Deliver a signed `push` webhook for `b604ea37c22c` (edit `getting-started.md`,
 *    rename `reference/cli.md` -> `reference/commands.md`, delete `placeholder.md`)
 *    and verify the published site updates with no manual step.
 * 3. Advance `main` to `b8058130b7d5` without a webhook, trigger reconciliation,
 *    and verify the update is caught and published on the site.
 * 4. Stop `app` (and `worker`) and verify Caddy continues serving the published site.
 */
export async function runM1Exit(
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = console.log,
): Promise<M1ExitReport> {
  const startedAt = new Date().toISOString();
  const databaseUrl = databaseUrlFromEnv(env);
  const secretKey = env.OXYBOOK_SECRET_KEY;
  if (!secretKey) {
    throw new Error('OXYBOOK_SECRET_KEY is required to run m1-exit');
  }
  const sitesDir = env.OXYBOOK_SITES_DIR ?? path.join(REPO_ROOT, '.oxybook-sites');
  const sitesDomain = env.OXYBOOK_SITES_DOMAIN ?? 'docs.localhost';
  const caddyPort = env.CADDY_PORT ?? '8080';

  const publicDb = createDb(databaseUrl, { max: 2 });
  const schema = `oxybook_m1_exit_${randomBytes(6).toString('hex')}`;
  let db: Kysely<Database> | null = null;
  let worker: { jobs: JobQueue; stop(): Promise<void> } | null = null;
  let app: { port: number; close(): Promise<void> } | null = null;
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'oxybook-m1-exit-'));
  let createdSpaceId: string | null = null;
  const exitSlug = 'm1-exit-site';
  const exitHost = `${exitSlug}.${sitesDomain}`;
  const exitBaseUrl = `http://${exitHost}:${caddyPort}`;
  const liveTestBaseUrl = `http://test.${sitesDomain}:${caddyPort}`;

  try {
    // 0. Load stored GitHub App credentials and existing installation id from public schema.
    const storedApp = await loadAppCredentials(publicDb, deriveSecretsKey(secretKey));
    if (!storedApp) {
      throw new Error('no GitHub App stored in public.github_app; complete /setup/github first');
    }
    const existingSpace = await publicDb
      .selectFrom('spaces')
      .select(['repo_owner', 'repo_name', 'github_installation_id'])
      .where('repo_owner', '=', 'crisprintsstuff')
      .where('repo_name', '=', 'oxybook-test')
      .executeTakeFirst();
    const installationId = existingSpace?.github_installation_id
      ? Number(existingSpace.github_installation_id)
      : Number(env.GITHUB_APP_INSTALLATION_ID ?? 176737174);

    log(
      `[0/4] Loaded GitHub App ${storedApp.slug} (${storedApp.id}), installation ${installationId} on crisprintsstuff/oxybook-test`,
    );

    // Mint a real installation token from GitHub and clone crisprintsstuff/oxybook-test into a staging bare repo.
    const realTokenFor = storedAppTokens(publicDb, secretKey);
    const githubToken = await realTokenFor(installationId);
    const stagingBareDir = path.join(tempRoot, 'remote', 'crisprintsstuff', 'oxybook-test.git');
    await git(
      tempRoot,
      [
        'clone',
        '--bare',
        '--quiet',
        'https://github.com/crisprintsstuff/oxybook-test.git',
        stagingBareDir,
      ],
      authEnv(githubToken),
    );
    await git(stagingBareDir, ['config', 'uploadpack.allowFilter', 'true']);
    await git(stagingBareDir, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
    // Point main at the initial seed commit (oxybook-test#3).
    await git(stagingBareDir, ['update-ref', 'refs/heads/main', SEED_SHA]);
    log(
      `[0/4] Cloned crisprintsstuff/oxybook-test with installation token; set main -> ${SEED_SHA.slice(0, 12)}`,
    );

    // Prepare isolated schema for the exit run.
    await sql.raw(`CREATE SCHEMA ${schema}`).execute(publicDb);
    const schemaDb = createDb(databaseUrl, { searchPath: schema, max: 4 });
    db = schemaDb;
    await migrateToLatest(schemaDb, { schema });
    await saveAppCredentials(schemaDb, deriveSecretsKey(secretKey), storedApp);

    const mirrorsDir = path.join(tempRoot, 'mirrors');
    const stagingGithubUrl = `file://${path.join(tempRoot, 'remote')}`;

    const buildEnv: BuildEnvironment = {
      db: schemaDb,
      tokenFor: async () => undefined,
      githubUrl: stagingGithubUrl,
      mirrorsDir,
      sitesDir,
      sitesDomain,
      log,
    };

    const activeWorker = await startExitWorker(databaseUrl, schema, buildEnv);
    worker = activeWorker;
    const store = new MemoryAppCredentials();
    store.set(storedApp as AppCredentials);

    // Mock GitHub API fetch for the space creation access check while delegating git to stagingGithubUrl.
    const mockGithubFetch: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/repos/crisprintsstuff/oxybook-test/installation')) {
        return new Response(
          JSON.stringify({
            id: installationId,
            account: { login: 'crisprintsstuff', type: 'User' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.endsWith(`/app/installations/${installationId}/access_tokens`)) {
        return new Response(
          JSON.stringify({
            token: 'ghs_m1_exit_token',
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.endsWith('/repos/crisprintsstuff/oxybook-test')) {
        return new Response(
          JSON.stringify({
            full_name: 'crisprintsstuff/oxybook-test',
            default_branch: 'main',
            private: false,
            permissions: { admin: true, maintain: true, push: true, pull: true },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('not found', { status: 404 });
    };

    const activeApp = await startAppServer({
      port: 0,
      host: '127.0.0.1',
      publicUrl: 'http://127.0.0.1',
      store,
      onDelivery: async (delivery) => {
        await handleDelivery(schemaDb, activeWorker.jobs, delivery);
      },
      ui: {
        db: schemaDb,
        secretKey,
        fetch: mockGithubFetch,
        sitesDomain,
        sitesPort: caddyPort,
        onSpaceSync: async ({ spaceId, ref }) => {
          const jobId = await activeWorker.jobs.send(
            'sync',
            { spaceId, ref, reason: 'manual' },
            { singletonKey: syncKey(spaceId, ref) },
          );
          return { jobId };
        },
      },
    });
    app = activeApp;
    const appBaseUrl = `http://127.0.0.1:${activeApp.port}`;

    // =========================================================================
    // STEP 1: Connect test repo via UI/API -> published site with nav & search
    // =========================================================================
    log(
      '[1/4] Step 1: Signing up user, creating org, and connecting crisprintsstuff/oxybook-test...',
    );
    const signupRes = await fetch(`${appBaseUrl}/api/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'exit-runner@example.com',
        name: 'M1 Exit Runner',
        password: 'correct-horse-battery-staple',
      }),
    });
    assert.equal(signupRes.status, 201, 'expected signup to return 201');
    const signupJson = (await signupRes.json()) as { csrfToken: string };
    const rawCookie = signupRes.headers.get('set-cookie') ?? '';
    const sessionCookie = rawCookie.split(';')[0] ?? '';
    assert.ok(sessionCookie.startsWith('oxybook_session='), 'expected oxybook_session cookie');

    const orgRes = await fetch(`${appBaseUrl}/api/orgs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: sessionCookie,
        'x-csrf-token': signupJson.csrfToken,
      },
      body: JSON.stringify({ slug: 'm1-exit-org', name: 'M1 Exit Org' }),
    });
    assert.equal(orgRes.status, 201, 'expected org creation to return 201');

    const spaceRes = await fetch(`${appBaseUrl}/api/orgs/m1-exit-org/spaces`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: sessionCookie,
        'x-csrf-token': signupJson.csrfToken,
      },
      body: JSON.stringify({
        slug: exitSlug,
        name: 'OxyBook test site',
        repo: 'crisprintsstuff/oxybook-test',
        content_root: 'docs',
        default_ref: 'main',
        sync_now: false,
      }),
    });
    assert.equal(spaceRes.status, 201, 'expected space creation to return 201');
    const spaceJson = (await spaceRes.json()) as { space: { id: string } };
    const spaceId = spaceJson.space.id;
    createdSpaceId = spaceId;

    const build1 = await waitFor('initial build at SEED_SHA', async () => {
      const row = await schemaDb
        .selectFrom('builds')
        .select(['id', 'commit_sha', 'status', 'warning_count', 'log'])
        .where('space_id', '=', spaceId)
        .where('commit_sha', '=', SEED_SHA)
        .where('status', '=', 'succeeded')
        .executeTakeFirst();
      return row ?? null;
    });

    const pages1 = await schemaDb
      .selectFrom('pages')
      .select(['url', 'path', 'hidden'])
      .where('space_id', '=', spaceId)
      .where('ref', '=', 'main')
      .execute();
    assert.equal(pages1.length, 11, 'expected 11 pages at initial seed commit');

    // Verify Caddy serves the initial published site with nav and Pagefind search
    const home1Res = await fetch(`${exitBaseUrl}/`);
    assert.equal(home1Res.status, 200, 'expected Caddy to return 200 on /');
    assert.match(home1Res.headers.get('server') ?? '', /caddy/i, 'expected Server: Caddy header');
    const home1Html = await home1Res.text();
    assert.ok(home1Html.includes('class="oxybook-sidebar"'), 'expected default theme sidebar');
    assert.ok(home1Html.includes('id="oxybook-search"'), 'expected Pagefind search container');
    // Verify _dir.yml ordering: Start here -> Guides -> Reference, and Internal notes hidden from nav
    const startIdx = home1Html.indexOf('Start here');
    const guidesIdx = home1Html.indexOf('Guides');
    const refIdx = home1Html.indexOf('Reference');
    assert.ok(
      startIdx > 0 && guidesIdx > startIdx && refIdx > guidesIdx,
      'expected _dir.yml nav order',
    );
    assert.ok(!home1Html.includes('Internal notes'), 'expected hidden page omitted from sidebar');

    // Verify /reference/cli and /placeholder exist at SEED_SHA
    const cli1Res = await fetch(`${exitBaseUrl}/reference/cli`);
    assert.equal(cli1Res.status, 200, 'expected /reference/cli to exist at SEED_SHA');
    const placeholder1Res = await fetch(`${exitBaseUrl}/placeholder`);
    assert.equal(placeholder1Res.status, 200, 'expected /placeholder to exist at SEED_SHA');

    // Verify Pagefind search index at SEED_SHA
    const pf1Res = await fetch(`${exitBaseUrl}/pagefind/pagefind-entry.json`);
    assert.equal(pf1Res.status, 200, 'expected Pagefind index at /pagefind/pagefind-entry.json');
    const pf1Json = (await pf1Res.json()) as { languages: Record<string, { page_count: number }> };
    const pf1Count = Object.values(pf1Json.languages)[0]?.page_count ?? 0;
    assert.equal(pf1Count, 10, 'expected 10 non-hidden pages indexed at SEED_SHA');
    log(
      `[1/4] Step 1 passed: build ${build1.id} at ${SEED_SHA.slice(0, 12)} (${pages1.length} pages, ${pf1Count} indexed in Pagefind, ${build1.warning_count} warnings) served by Caddy at ${exitBaseUrl}/`,
    );

    // =========================================================================
    // STEP 2: Push to default branch (edit, rename, delete) via webhook
    // =========================================================================
    log(
      `[2/4] Step 2: Advancing main to ${PUSH_SHA.slice(0, 12)} (edit + rename + delete) and delivering push webhook...`,
    );
    await git(stagingBareDir, ['update-ref', 'refs/heads/main', PUSH_SHA]);

    const deliveryId = `m1-exit-push-${randomBytes(8).toString('hex')}`;
    const webhookBody = Buffer.from(
      JSON.stringify({
        ref: 'refs/heads/main',
        before: SEED_SHA,
        after: PUSH_SHA,
        repository: {
          name: 'oxybook-test',
          full_name: 'crisprintsstuff/oxybook-test',
          owner: { login: 'crisprintsstuff' },
        },
        installation: { id: installationId },
      }),
      'utf8',
    );
    const sig = `sha256=${createHmac('sha256', storedApp.webhookSecret).update(webhookBody).digest('hex')}`;

    const hookRes = await fetch(`${appBaseUrl}/api/github/webhooks`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'push',
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': sig,
      },
      body: webhookBody,
    });
    assert.equal(hookRes.status, 204, 'expected push webhook delivery to return 204');

    // Wait for automatic webhook-triggered sync + build at PUSH_SHA (no manual step)
    const build2 = await waitFor('webhook-triggered build at PUSH_SHA', async () => {
      const row = await schemaDb
        .selectFrom('builds')
        .select(['id', 'commit_sha', 'status', 'warning_count'])
        .where('space_id', '=', spaceId)
        .where('commit_sha', '=', PUSH_SHA)
        .where('status', '=', 'succeeded')
        .executeTakeFirst();
      return row ?? null;
    });

    const pages2 = await schemaDb
      .selectFrom('pages')
      .select(['url', 'path'])
      .where('space_id', '=', spaceId)
      .where('ref', '=', 'main')
      .execute();
    assert.equal(pages2.length, 10, 'expected 10 pages after rename + delete at PUSH_SHA');

    const redirectRow = await schemaDb
      .selectFrom('inferred_redirects')
      .select(['from_url', 'to_url'])
      .where('space_id', '=', spaceId)
      .where('ref', '=', 'main')
      .executeTakeFirstOrThrow();
    assert.equal(redirectRow.from_url, '/reference/cli');
    assert.equal(redirectRow.to_url, '/reference/commands');

    // Verify edit, rename, redirect, delete, and search index on the site via Caddy
    const gs2Res = await fetch(`${exitBaseUrl}/getting-started`);
    assert.equal(gs2Res.status, 200);
    const gs2Html = await gs2Res.text();
    assert.ok(
      gs2Html.includes('It takes about five minutes.'),
      'expected edited getting-started.md text on published site',
    );

    const commands2Res = await fetch(`${exitBaseUrl}/reference/commands`);
    assert.equal(commands2Res.status, 200, 'expected renamed /reference/commands to return 200');

    const cliRedirectRes = await fetch(`${exitBaseUrl}/reference/cli`);
    assert.equal(cliRedirectRes.status, 200, 'expected static redirect page at /reference/cli');
    const cliRedirectHtml = await cliRedirectRes.text();
    assert.ok(
      cliRedirectHtml.includes('url=/reference/commands'),
      'expected /reference/cli to redirect to /reference/commands',
    );

    const placeholder2Res = await fetch(`${exitBaseUrl}/placeholder`);
    assert.equal(placeholder2Res.status, 404, 'expected deleted /placeholder to return 404');

    const pf2Res = await fetch(`${exitBaseUrl}/pagefind/pagefind-entry.json`);
    const pf2Json = (await pf2Res.json()) as { languages: Record<string, { page_count: number }> };
    const pf2Count = Object.values(pf2Json.languages)[0]?.page_count ?? 0;
    assert.equal(pf2Count, 9, 'expected 9 non-hidden pages indexed at PUSH_SHA');
    log(
      `[2/4] Step 2 passed: webhook ${deliveryId} synced & built ${build2.id} at ${PUSH_SHA.slice(0, 12)} (${pages2.length} pages, redirect ${redirectRow.from_url} -> ${redirectRow.to_url}, /placeholder -> 404)`,
    );

    // =========================================================================
    // STEP 3: Dropped webhook -> caught by reconciliation
    // =========================================================================
    log(
      `[3/4] Step 3: Advancing main to ${RECONCILE_SHA.slice(0, 12)} WITHOUT a webhook and triggering reconciliation...`,
    );
    await git(stagingBareDir, ['update-ref', 'refs/heads/main', RECONCILE_SHA]);

    await activeWorker.jobs.send('reconcile', { at: new Date().toISOString() });

    const build3 = await waitFor('reconciliation-triggered build at RECONCILE_SHA', async () => {
      const row = await schemaDb
        .selectFrom('builds')
        .select(['id', 'commit_sha', 'status'])
        .where('space_id', '=', spaceId)
        .where('commit_sha', '=', RECONCILE_SHA)
        .where('status', '=', 'succeeded')
        .executeTakeFirst();
      return row ?? null;
    });

    const testPage3Res = await fetch(`${exitBaseUrl}/test-page`);
    assert.equal(testPage3Res.status, 200);
    const testPage3Html = await testPage3Res.text();
    assert.ok(
      testPage3Html.includes(
        'This line arrived without a webhook; reconciliation should pick it up.',
      ),
      'expected reconciliation commit text on /test-page',
    );
    log(
      `[3/4] Step 3 passed: reconciliation caught dropped webhook and built ${build3.id} at ${RECONCILE_SHA.slice(0, 12)}`,
    );

    // =========================================================================
    // STEP 4: Stopping `app` does not take the published site down
    // =========================================================================
    log(
      '[4/4] Step 4: Stopping app and worker, then verifying Caddy continues serving the site...',
    );
    await activeApp.close();
    app = null;
    await activeWorker.stop();
    worker = null;

    let appStoppedVerified = false;
    try {
      await fetch(`${appBaseUrl}/healthz`);
    } catch {
      appStoppedVerified = true;
    }
    assert.ok(appStoppedVerified, 'expected app server to be closed');

    const checkRoutes: Array<[string, number]> = [
      ['/', 200],
      ['/getting-started', 200],
      ['/guides/configure', 200],
      ['/reference/commands', 200],
      ['/reference/cli', 200],
      ['/test-page', 200],
      ['/guides/images/stack.svg', 200],
      ['/pagefind/pagefind-entry.json', 200],
      ['/placeholder', 404],
    ];

    const exitSiteChecks: Record<string, number> = {};
    for (const [route, expectedStatus] of checkRoutes) {
      const res = await fetch(`${exitBaseUrl}${route}`);
      assert.equal(
        res.status,
        expectedStatus,
        `expected ${exitBaseUrl}${route} to return ${expectedStatus} with app stopped`,
      );
      assert.match(res.headers.get('server') ?? '', /caddy/i);
      exitSiteChecks[route] = res.status;
    }

    const liveTestSiteChecks: Record<string, number> = {};
    for (const [route, expectedStatus] of checkRoutes) {
      const res = await fetch(`${liveTestBaseUrl}${route}`);
      assert.equal(
        res.status,
        expectedStatus,
        `expected ${liveTestBaseUrl}${route} to return ${expectedStatus} with app stopped`,
      );
      assert.match(res.headers.get('server') ?? '', /caddy/i);
      liveTestSiteChecks[route] = res.status;
    }

    log(
      `[4/4] Step 4 passed: app is stopped and Caddy served all ${checkRoutes.length} routes on both ${exitBaseUrl} and ${liveTestBaseUrl}`,
    );

    return {
      startedAt,
      finishedAt: new Date().toISOString(),
      appSlug: storedApp.slug,
      appId: storedApp.id,
      installationId,
      repo: 'crisprintsstuff/oxybook-test',
      caddyBaseUrl: liveTestBaseUrl,
      step1Connect: {
        commitSha: SEED_SHA,
        spaceId,
        buildId: build1.id,
        pageCount: pages1.length,
        indexedPageCount: pf1Count,
        warningCount: build1.warning_count,
      },
      step2WebhookPush: {
        deliveryId,
        commitSha: PUSH_SHA,
        buildId: build2.id,
        pageCount: pages2.length,
        indexedPageCount: pf2Count,
        redirectFrom: redirectRow.from_url,
        redirectTo: redirectRow.to_url,
        deletedUrlStatus: placeholder2Res.status,
      },
      step3Reconcile: {
        commitSha: RECONCILE_SHA,
        buildId: build3.id,
        pageCount: pages2.length,
        indexedPageCount: pf2Count,
      },
      step4AppStopped: {
        appStoppedVerified,
        exitSiteChecks,
        liveTestSiteChecks,
      },
    };
  } finally {
    await app?.close().catch(() => {});
    await worker?.stop().catch(() => {});
    if (createdSpaceId) {
      rmSync(path.join(sitesDir, 'builds', createdSpaceId), { recursive: true, force: true });
      rmSync(path.join(sitesDir, 'spaces', createdSpaceId), { recursive: true, force: true });
    }
    rmSync(path.join(sitesDir, 'by-host', exitHost), { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
    await db?.destroy();
    await sql
      .raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
      .execute(publicDb)
      .catch(() => {});
    await publicDb.destroy();
  }
}
