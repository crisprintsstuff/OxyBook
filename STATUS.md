# Status

Future agents: append a dated entry under Changelog when something meaningful lands or a measured fact changes. Do not silently rewrite or delete older entries. Do update the current-state block and the milestone table so they match the latest entry. If you did not run it, write "unverified". Do not invent metrics.

Commit SHAs and CI run ids belong in dated Changelog entries, not in `## Current state`. A head SHA in the current-state block is stale as soon as the next PR merges. Name the current head only in changelog entries.

## Current state

- **Milestone:** M0 complete. M1 in progress: slices 1–4 of `docs/M1-PLAN.md` are done (H3 compatibility report, spaces without UI, job queue, sync). The exit is not met.
- **Last update:** 2026-10-30.
- **What works today:** `packages/doc-model` parses `.md` and `.mdx`, keeps original slices, and serializes an unedited file back to the same string. `:::name Title` (and `:::name`, `::: name Title`, `:::name[Title]`) is one callout block, not a run of paragraphs. On 2026-10-29, after that fold, `pnpm test:corpus` reported 594 pass, 0 fail, 1 unparseable (the planted unterminated `.mdx` fixture). App and worker processes answer `GET /healthz` in unit tests. A scratch-repo spike recorded `git merge-file` / `git merge-tree --write-tree` outcomes for concurrent edits. `packages/db` holds schema v0 as plain SQL migrations with Kysely types; `pnpm db:migrate` applied `0001_schema_v0` on PostgreSQL 16 and a second run reported up to date; the app's migrate-on-start did the same on PostgreSQL 17.11. No application code reads or writes those tables yet.
- **Dev server:** `pnpm dev` prints `app listening on 3000` and `worker listening on 3001`. `GET /healthz` on those ports returned 200 `{"ok":true,"service":"app"}` and 200 `{"ok":true,"service":"worker"}`. The processes were then stopped. The app script builds `@oxybook/github` and `@oxybook/db` (since 2026-10-30) and runs `tsx watch`.
- **CI:** `check` was green on `main` before the 2026-10-30 schema change. The workflow is `.github/workflows/ci.yml`. It starts a `postgres:17` service, sets `DATABASE_URL`, and runs `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm db:migrate`, and `pnpm test:corpus`. On 2026-10-30 that workflow ran green on the schema branch, and the postgres service log shows the `packages/db` tests executed (their expected constraint violations are in it). See the changelog. The corpus step fetches the pinned repos, so the job needs network. The current head and its result are on the repo's Actions tab.
- **Docker:** `docker compose up -d --build` built `localhost/oxybook:dev` (engine 29.1.3, Compose 2.40.3). postgres, caddy, mailpit, app, and worker all reported healthy. From inside the containers, `GET /healthz` returned 200 `{"ok":true,"service":"app"}` on port 3000 and 200 `{"ok":true,"service":"worker"}` on port 3001. The image's git is 2.39.5. The stack was then removed with `docker compose down --remove-orphans -v`.
- **Git write path:** `oxybook-dev propose` was run against a local `file://` bare remote. The diff touched only `docs/a.md`. A stale `--force-with-lease` was refused. An unsigned `git push` to `ruleset-probe-test` was rejected by ruleset `26114519` (`GH013`, commits must have verified signatures). A fast-forward `PATCH /git/refs/heads/ruleset-probe-test` of a Git Database API commit returned HTTP 200; GitHub had signed that commit (`verification.verified: true`, `reason: "valid"`). The measured head was `c915f0780c13f25cdf01870fcda216b721c576cf`. Details are in `docs/M0-GITHUB-SPIKE.md`. The same command has since opened a pull request on GitHub. See "Live pull request".
- **Live pull requests:** [crisprintsstuff/oxybook-test#2](https://github.com/crisprintsstuff/oxybook-test/pull/2), opened 2026-10-30 by the manifest-created App `oxybook-cris[bot]`, is open with one added file, `docs/test-page-2.md` (+3/-0). [crisprintsstuff/oxybook-test#1](https://github.com/crisprintsstuff/oxybook-test/pull/1) was merged on 2026-10-29 (see the 2026-10-30 entry). It was opened on the public repo [crisprintsstuff/oxybook-test](https://github.com/crisprintsstuff/oxybook-test) (default branch `main`). Title `Update docs/test-page.md`. Head branch `oxybook/dev/page-1`. Author is the GitHub App bot `oxybook-dev-cb[bot]`, App id 5530818, installation id 176643684. `GET /repos/crisprintsstuff/oxybook-test/pulls/1/files` returned exactly one entry: `docs/test-page.md`, added, +3/-0. The body contained `Pages changed: docs/test-page.md` and `Link back: https://oxybook.boznetwork.com`. The command was `pnpm oxybook-dev propose <file> --remote https://github.com/crisprintsstuff/oxybook-test.git --github-owner crisprintsstuff --github-repo oxybook-test --installation-id 176643684 --base main --path docs/test-page.md`, with `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_FILE` set. It exited 0 and printed the commit, the ref, the base, the author, `pr <url>`, and the diff. The App was created by hand at `https://github.com/settings/apps/new`, not through `/setup/github`. The run was Node v22.23.1, not 24. pnpm printed an Unsupported engine warning and the command succeeded. That is a known deviation, not evidence that Node 22 is supported.
- **Signed-commit note:** The note `docs/MVP.md` asks for exists: `docs/M0-GITHUB-SPIKE.md`. It concludes that `required_signatures` rejects an unsigned `git push` (`GH013`) and accepts a GitHub-signed Git Database API fast-forward (HTTP 200, `verification.verified: true`, `reason: "valid"`). That measurement was on this repo. It was not repeated on `oxybook-test`, and `oxybook-test` has no ruleset.
- **M1 test repo:** [crisprintsstuff/oxybook-test](https://github.com/crisprintsstuff/oxybook-test) is the M1 test space and the repo for later live tests (owner's decision, 2026-10-30). [oxybook-test#3](https://github.com/crisprintsstuff/oxybook-test/pull/3) seeded `docs/` with 11 pages, `_dir.yml` files, `oxybook.yml`, an image asset, `_partials/`, and an MDX page with imports, components, an expression, and one intentionally broken link. All 11 pass `oxybook-roundtrip`.
- **Compatibility report:** `pnpm oxybook-check <dir>` reports, with `file:line` warnings, what would render as a placeholder. `pnpm compat:corpus` runs it over the pinned corpus. Results and the recommended component list are in `docs/M1-NOTES.md`. With the starting allowlist, 286 of 567 corpus files (50.4%) have no placeholder, and adding Starlight's built-ins raises that to 352 (62.1%).
- **Spaces and jobs:** `pnpm oxybook-admin` creates orgs and spaces (`org create`, `space create <org>/<space> --repo owner/repo`, `space list`). Without `--installation-id`, it asks GitHub as the stored App which installation covers the repo. `packages/jobs` wraps pg-boss (schema `pgboss`). The worker works jobs when `DATABASE_URL` is set. `pnpm oxybook-admin job ping` sends a job and waits for a worker to complete it. The only queue is `ping`; sync is slice 4. On the owner's machine, `space create cris/test` found installation 176737174 as `oxybook-cris`, and `job ping` completed through the running worker. See the 2026-10-30 entries.
- **Sync:** `packages/sync` keeps a blobless mirror per repo and brings `blobs`, `pages`, and `ref_state` in line with a space's default branch in one transaction. It records renames in `inferred_redirects`. Triggers: a verified `push` webhook (deduplicated in `webhook_deliveries`) queues a `sync` job, a `reconcile` job every 5 minutes compares `git ls-remote` heads with `ref_state`, and `oxybook-admin sync <org>/<space> [--now]` runs one by hand. `oxybook-admin pages <org>/<space>` lists what is stored. On the owner's machine it synced `oxybook-test` with the stored App's token, synced a push from its webhook, and caught a push with the webhook off. See the 2026-10-30 entries.
- **Database:** `packages/db/migrations/0001_schema_v0.sql` creates `orgs`, `users`, `org_members`, `sessions`, `spaces`, `space_members`, `blobs`, `ref_state`, `pages`, `drafts`, and `draft_files`. Pending files run in one transaction under Kysely's advisory lock; a failing file rolls back every pending file (tested). `apps/server` applies migrations before listening when `OXYBOOK_MIGRATE_ON_START=true`. That was first run from `apps/server/dist/main.js` on the host against the compose `postgres:17` container. On the owner's machine, the rebuilt container image applied `0001_schema_v0` to an empty database and then served. See the 2026-10-30 entries.
- **GitHub App credentials:** With `DATABASE_URL` and `OXYBOOK_SECRET_KEY` set, the manifest callback stores the App in the `github_app` table, encrypted, and the server loads it at start. `/setup/github` returns 409 once an App is stored. `GET /api/github/oauth/callback` answers 501 until Sign in with GitHub (M2). The webhook route logs `webhook verified|rejected event=<e> delivery=<id>`. `oxybook-dev propose` reads `GITHUB_APP_INSTALLATION_ID` when `--installation-id` is absent. On 2026-10-30 the owner created App `oxybook-cris` (App id 5535294) from `/setup/github`. It was stored in the database, and GitHub's `ping` and `installation` webhooks were logged as verified. See the 2026-10-30 entries.
- **What does not:** There is no editor, renderer, or published site. Nothing uses the database beyond migrations. Webhook payloads are verified and logged, and nothing acts on them yet. The Git Database API fallback against a ruleset that requires signed commits is unverified on `oxybook-test`. `pnpm test:integration` and `pnpm test:e2e` are not implemented. See "M0 exit, met".

## Milestones

From `docs/MVP.md`. "In progress" means some of the milestone's work is in the tree and the exit criterion is not met.

| Milestone | Status |
| --- | --- |
| M0 — Foundations and risk spikes | complete |
| M1 — Read path and published site | in progress |
| M2 — Editor and write path | not started |
| M3 — Conflicts, versions, renames | not started |
| M4 — Production readiness, v1.0 | not started |

## M0 exit, met

`docs/MVP.md` says M0 is done when corpus identity is 100% on parseable files and runs in CI; the CLI opens a real PR against a test repo whose diff contains only the intended change; a written note records the signed-commit ruleset behaviour (ARCHITECTURE §4.3).

1. **Corpus identity in CI.** Met. `.github/workflows/ci.yml` runs `pnpm test:corpus`. The measured result recorded above is 594 pass, 0 fail, 1 unparseable.
2. **Real pull request.** Met. [oxybook-test#1](https://github.com/crisprintsstuff/oxybook-test/pull/1). `GET /repos/crisprintsstuff/oxybook-test/pulls/1/files` returned exactly one entry, `docs/test-page.md`, added, +3/-0.
3. **Written note.** Met. `docs/M0-GITHUB-SPIKE.md` records the signed-commit behaviour.

Still unverified. These are not the exit sentence, and they are not done:

- **Manifest-created App.** Verified 2026-10-30: `oxybook-cris` was created from `/setup/github`, stored, installed on `oxybook-test`, and opened [oxybook-test#2](https://github.com/crisprintsstuff/oxybook-test/pull/2).
- **Webhook delivery** from GitHub to `/api/github/webhooks`. Verified 2026-10-30 for `ping`, `installation`, `push`, and `pull_request` through the owner's Cloudflare tunnel. Nothing acts on a delivery yet.
- **Git Database API fallback** on a repo whose ruleset requires signed commits. Unverified on `oxybook-test`. That repo has no ruleset. The earlier measurement was on this repo. See `docs/M0-GITHUB-SPIKE.md`.
- **Database schema v0 and migrations** (Kysely + SQL migrations). Done 2026-10-30 in `packages/db`, measured on a local PostgreSQL 16 and the compose `postgres:17` image. CI runs the tests against a `postgres:17` service. The rebuilt image migrates an empty database at start and also starts against an already-migrated one.
- **OAuth callback path.** Closed 2026-10-30: `/api/github/oauth/callback` answers 501 `Sign in with GitHub is not implemented yet`. Sign in with GitHub is M2.
- **Installation id.** Closed 2026-10-30: `GITHUB_APP_INSTALLATION_ID`, read by the CLI. The flag wins.
- **`pnpm test:integration` and `pnpm test:e2e`.** Not implemented.
- **Editor, renderer, and published site.** Not started.

## M1 next

In progress. `docs/M1-PLAN.md` puts the scope below in order. Slices 1–4 are done: the H3 compatibility report (`docs/M1-NOTES.md`), spaces without UI, the job queue, and sync. Slice 4's exit check passed on the owner's machine on 2026-10-30. A push with an edit, a rename, and a delete synced with no manual step, and a push made with the webhook switched off was caught by reconciliation. Next is slice 5, renderer v0. The manifest-created App and the test repo are in place. From `docs/MVP.md`:

- Accounts (email/password, sessions), organisations, spaces, Admin role.
- GitHub App install flow in the UI; repo connection with access check; webhook sync + reconciliation; read model in PostgreSQL.
- Renderer: mdast→hast handlers, allowlisted components (Callout, Tabs/TabItem, Card, CodeGroup to start; final list from the H3 report), Shiki, link rewriting and broken-link warnings, import mapping.
- Build job, release assembly with hardlinks, atomic swap; `by-host` symlinks; Caddy serving `<space>.docs.localhost` in dev.
- Default theme v0, sidebar from tree + `_dir.yml`, Pagefind.
- `oxybook check` compatibility CLI; corpus rendering report.

**Done when:** connecting a test repo yields a published site with working nav and search; a push to the default branch (including a rename and a delete) is reflected on the site with no manual step; a dropped webhook is caught by reconciliation; stopping `app` does not take the published site down.

## Changelog

### 2026-10-30 — Sync on the owner's machine: token, push webhook, reconciliation

Run by the repo owner with `pnpm dev` on the host after #20 (`main` at `d8d100ceaa33cd1bd88c2f8c8dd7c497c7f587f0`). Node v22.23.1, compose `postgres`, tunnel `oxybook.boznetwork.com` → `localhost:3100`.

1. **Token path.** `pnpm oxybook-admin sync cris/test` queued a job. The worker logged `job sync 5afb1a27-… (manual)` and `sync 16a7dd2c-… main none..9f6835d1283b: +11 ~0 -0`. So an installation token minted from the stored `oxybook-cris` App fetched the repo.
2. **Push, no manual step.** The owner merged [oxybook-test#4](https://github.com/crisprintsstuff/oxybook-test/pull/4) (merge commit `b604ea37c22c933f3f4dcf19be2d0e8c1ff34320`, 02:26:37Z). It edits `getting-started.md`, renames `reference/cli.md` to `reference/commands.md` (with the two inbound links updated), and deletes `placeholder.md`. Without anyone running a command, the worker logged `job sync fe847144-… (push 5608407c-d409-11f1-9dfa-4fbc000cc3aa)` and `sync … 9f6835d1283b..b604ea37c22c: +1 ~3 -2 renamed 1 unchanged 6`. `oxybook-admin pages cris/test` then listed 10 pages, synced at 02:26:41.337Z: `/reference/commands` present, `/reference/cli` and `/placeholder` absent. That matches the 10 page files in GitHub's tree at `b604ea3`. `inferred_redirects` held one row: `/reference/cli` → `/reference/commands` at `b604ea37c22c`. The `pull_request` delivery for the same merge was logged as `nothing to do`.
3. **Dropped webhook.** The owner set the App's webhook inactive and merged [oxybook-test#5](https://github.com/crisprintsstuff/oxybook-test/pull/5) (`b8058130b7d5a9da6dc0646bf29e15fce32b3d58`, 02:29:37Z, one line in `test-page.md`). No delivery arrived. The scheduled `reconcile` logged `stored b604ea37c22c, remote b8058130b7d5; sync 16e2af25-…`, then `job sync … (reconcile)` and `sync … b604ea37c22c..b8058130b7d5: +0 ~1 -0 renamed 0 unchanged 9`. The webhook was then set active again.

Together these meet the sync half of M1's exit sentence on the test repo: a push to the default branch, including a rename and a delete, is reflected with no manual step, and a dropped webhook is caught by reconciliation. The published-site half (nav, search, `app` stopped) is slices 5–7.

Also in this change, from friction during the run:
- `pnpm install` printed `Failed to create bin` for `oxybook-roundtrip` and `oxybook-check`, because `doc-model` declared bins pointing at an unbuilt `dist/`. Nothing used them, so they are removed. A forced reinstall printed the warning 4 times before the change and 0 times after.
- `oxybook-admin` rebuilt the shared packages, and both watchers restarted on the rewritten `dist/` files, which could cut a running sync short. The watchers now exclude `packages/*/dist/**`. With `pnpm dev` running, a `build:libs` caused 0 restarts. After a pull, restart `pnpm dev` (LIVE-INSTALL.md).
- Host processes (`pnpm dev`, `oxybook-admin`, `db:migrate`) now read the repo's `.env` with Node's `--env-file-if-exists`. Shell variables still win. `.env.example` gains `DATABASE_URL` for the host. Compose ignores it inside containers. Checked here: with `DATABASE_URL` only in `.env`, `oxybook-admin space list` worked, and without `.env` it said `DATABASE_URL is not set`.
- `LIVE-INSTALL.md` now says how to free a port held by a leftover server. The `pkill -f "tsx watch src/main.ts"` given to the owner earlier could not match the watcher's real command line.

### 2026-10-30 — M1 slice 4: sync

- **Migration `0003_sync`.** `webhook_deliveries` (delivery id, event, received at) and `inferred_redirects` (space, ref, from URL to URL, paths, commit).
- **`packages/sync`.**
  - `fetchRef` keeps one blobless bare mirror per repo and force-updates `refs/heads/<ref>`.
  - `listFiles` reads trees only. `readBlobs` fetches missing blobs on demand. `findRenames` runs `git diff -M`. `remoteHead` runs `git ls-remote`.
  - The installation token goes to git as an `http.extraHeader` through `GIT_CONFIG_*` environment variables. It is never in argv, the mirror config, or a URL.
  - Page rules from ARCHITECTURE §2.2–2.5: `.md`/`.mdx`, no `_`/`.` segments, extension removed, `index` collapsed, `README.md` as the directory page only without an `index.*`, case kept, `slug` relative or absolute. Title comes from frontmatter, then the first H1, then the filename; `nav_title` and `hidden` are read too.
  - `syncSpace` compares the whole tree at the new head with the stored rows, instead of applying only `git diff from..to`. That corrects itself after a lost webhook, a deleted mirror, or a force-push. The correction is recorded in `docs/M1-NOTES.md`. Bytes come from `blobs` when cached. Rows are deleted before insert, because two pages can swap URLs. A page whose URL is taken is skipped with a log line. Each page gets a `tsv` (title weighted A).
- **Jobs.** New queues `sync` (`stately`, singletonKey `<space>:<ref>`, 3 retries with backoff) and `reconcile` (`singleton`, scheduled every 5 minutes; `OXYBOOK_RECONCILE_CRON`, `off` disables it). `send` now returns null when the policy suppressed a job.
- **Worker.** It handles `sync` (`runSpaceSync`: loads the space, mints an installation token from the stored App, mirrors under `OXYBOOK_MIRRORS_DIR` or `./.oxybook-mirrors`) and `reconcile` (`findStaleSpaces`, then queues a sync for each space that is behind).
- **App.** A verified webhook is recorded in `webhook_deliveries`. A repeat is ignored. A `push` to a space's default branch (repo matched case-insensitively) queues a sync. A handler error answers 500, so GitHub can redeliver.
- **CLI.** `oxybook-admin sync <org>/<space> [--now]` and `oxybook-admin pages <org>/<space>`.
- **Moved.** The stored-App code (`seal`/`open`, `loadAppCredentials`, `saveAppCredentials`) moved from `apps/server` to `packages/db` so the worker can read it.
- **Scripts.** Root `dev` runs `build:libs` once and then the two watchers, so they no longer build the same packages at once. Root `test` and `typecheck` run packages one at a time for the same reason.

Measured, Node v22.22.0, local PostgreSQL 16. `pnpm lint`, `pnpm typecheck`, and `pnpm test` exited 0, with 84 tests passing. New tests:
- `packages/sync`, against a local bare remote with partial clone enabled:
  - the first sync stores exactly the page files;
  - an edit, a rename, a delete, and an add are applied, `pages` equals the page files in `git ls-tree` at each head, and the redirect `/guides/install` → `/guides/setup` is recorded;
  - a repeat sync and a sync after deleting the mirror are no-ops;
  - a force-push is followed;
  - a URL clash is skipped.
- Page rules and frontmatter fallbacks.
- `apps/server`: push to the default branch queues one sync per delivery and the redelivery is ignored; other branches, tags, deletions, unknown repos, and other events are ignored.
- `apps/worker`: a `sync` job syncs the branch, and after a push with no webhook, a `reconcile` job queued a sync that stored the new page and moved `ref_state` to the remote head.

Live, from this session, without a token (the repo is public): `syncSpace` on `https://github.com/crisprintsstuff/oxybook-test.git` stored 11 pages at `9f6835d1283b8ac01c0603767198e9632754c4fd`. That matched `GET /repos/crisprintsstuff/oxybook-test/git/trees/main?recursive=1` filtered to page files under `docs/`. `/reference/env` (slug), `nav_title` "Start here", `hidden` on `internal-notes`, and `/guides` from `index.mdx` all came out as the rules say.

Not measured: the installation token path (worker on the owner's machine with the stored App), a webhook-triggered sync end to end, and the container image.

CI on the first push of this change: one `check` run passed and one failed on the same commit (`a5203b7`/`73e066a`, run 40990492750). Cause: test files in `apps/server` ran in parallel, and Kysely's migrator scans every schema while another file dropped its throwaway schema (`schema "oxybook_test_…" does not exist`). Reproduced locally: 21 of 40 migrations failed under concurrent schema drops. Database test files now run one at a time (`--test-concurrency=1`). Details are in `docs/M1-NOTES.md`.

### 2026-10-30 — Space `cris/test` created; the queue round-trips on the owner's machine

Run by the repo owner on their machine against the compose `postgres` service, with `pnpm dev` running after #18 (`main` at `748b0b3f58025ad9eec5c0d8859d20919091a5ce`). Node v22.23.1.

- `pnpm oxybook-admin org create cris --name "Cris"` succeeded after `pnpm install`. Before `pnpm install`, the command exited 1 with no message: the build of `@oxybook/jobs` failed on the missing `pg-boss`, and its output was discarded. The follow-up change prints the build log and a hint instead.
- `pnpm oxybook-admin space create cris/test --repo crisprintsstuff/oxybook-test --name "OxyBook test site"`, without `--installation-id`, printed `space cris/test 16a7dd2c-6696-48a6-a212-fed416f37e6f -> crisprintsstuff/oxybook-test (installation 176737174)`. So the lookup as the stored App (`GET /repos/crisprintsstuff/oxybook-test/installation` with an App JWT for `oxybook-cris`) worked against real GitHub.
- `pnpm oxybook-admin job ping` printed `sent ping d2defb48-eb30-4bdf-8394-93e5c4203c96` and `ping d2defb48-eb30-4bdf-8394-93e5c4203c96 completed`. A worker completed it within 15s. The worker's own log line was not recorded.

The previous entry says the lookup against real GitHub and runs on the owner's machine were not measured. That was true when it was written.

### 2026-10-30 — M1 slices 2 and 3: spaces without UI, job queue

- **Slice 2.** `apps/server/src/admin.ts` and `pnpm oxybook-admin`: `org create`, `space create <org>/<space> --repo <owner/repo> [--installation-id] [--content-root docs] [--default-ref main]`, `space list`. `docs/`, `./docs`, and `docs` are stored as `docs`. Without `--installation-id`, the CLI signs an App JWT from the stored App (needs `OXYBOOK_SECRET_KEY`) and calls `GET /repos/{owner}/{repo}/installation`. A 404 becomes `<app> is not installed on owner/repo` with the install link. New `findRepoInstallation` in `packages/github`.
- **Slice 3.** `packages/jobs` wraps pg-boss 12.38.0. Queue names and payload types live in one place, each handler call gets one job, the connection timeout is 10s, and app and worker can both create a queue at start without a race. The worker starts it when `DATABASE_URL` is set and handles `ping`. `pnpm oxybook-admin job ping` sends one and waits up to 15s for `completed`. The `Dockerfile` and the server and worker dev scripts build `@oxybook/jobs`. The worker dev script now runs `tsx watch`, because it imports a workspace package.

Measured, Node v22.22.0, local PostgreSQL 16. `pnpm lint`, `pnpm typecheck`, and `pnpm test` exited 0, with 73 tests passing. New tests:
- `packages/jobs`: 20 jobs sent to two workers ran exactly once each, by id, and a job whose handler threw on the first try was retried and completed.
- `apps/worker`: a ping sent from a second queue client completed and logged.
- `apps/server`: org and space create, list, duplicate and unknown-org errors, and installation lookup as a stored App against a fake GitHub (found, 404, no App, no key).
- `packages/github`: `findRepoInstallation`.

Smoke run on an empty database: `pnpm db:migrate`, then `oxybook-admin org create cris`, then `space create cris/test --repo crisprintsstuff/oxybook-test --installation-id 176737174` (stored with root `docs` and ref `main`). A repeated `org create cris` printed `already exists: ... orgs_slug_key`. `space list` printed the row. `space create` without an id and without `OXYBOOK_SECRET_KEY` refused with that reason. With a worker running, `job ping` printed `sent ping <id>` and `ping <id> completed`, and the worker logged `job ping <id> from oxybook-admin done`.

Not measured: the installation lookup against real GitHub, and any of this on the owner's machine or in the container image.

### 2026-10-30 — `push` and `pull_request` webhooks arrive

Merging [oxybook-test#3](https://github.com/crisprintsstuff/oxybook-test/pull/3) (`9f6835d1283b8ac01c0603767198e9632754c4fd`) sent two deliveries to the owner's `pnpm dev` server through `oxybook.boznetwork.com`. The server logged both:

```
webhook verified event=push delivery=bba98dc0-d402-11f1-8d39-50d5d15b54e6
webhook verified event=pull_request delivery=bb4fac60-d402-11f1-8272-0fab7a2d3175
```

All four event types the App receives (`ping`, `installation`, `push`, `pull_request`) have now been delivered and verified with the stored webhook secret. The server only logs them. Deduplicating by delivery id and enqueuing a sync are M1 slices 3 and 4. The entry below says the `push` delivery was not checked; it was checked after that entry was written.

### 2026-10-30 — M1 slice 1: compatibility report; test repo seeded

The owner chose `crisprintsstuff/oxybook-test` as the M1 test repo. [oxybook-test#3](https://github.com/crisprintsstuff/oxybook-test/pull/3) merged as `9f6835d1283b8ac01c0603767198e9632754c4fd`. It adds a docs tree that exercises nav, frontmatter keys, links, callouts, assets, and MDX components. `pnpm oxybook-roundtrip` on its `docs/` reported 11 pass, 0 fail. The merge was a push to `main`. Whether the owner's server logged a `push` webhook for it was not checked.

`packages/doc-model` gains `compat.ts`, the `oxybook-check` CLI (`pnpm oxybook-check <dir> [--json] [--allow Name,...]`), and `pnpm compat:corpus`. Nothing is executed. The counts cover unknown and allowlisted JSX components, non-static props (JSON literals count as static), imports by specifier, exports, expressions (comments are counted separately), callouts, GitHub alerts, non-callout directives, text directives, MkDocs `!!!` admonitions and pymdownx tabs outside code, and capitalised tags in `.md` HTML.

Measured on the pinned corpus (Node v22.22.0; `pnpm test:corpus` still 100% identity on parseable files): 567 files, 379 `.mdx`, 0 unparseable. 286 (50.4%) have no placeholder with the starting allowlist (`Callout`, `Tabs`, `TabItem`, `Card`, `CodeGroup`). Per repo: Docusaurus 71/89, Starlight 78/338, VitePress 34/36, MkDocs 18/19, MkDocs Material 85/85. Unknown components cover 269 files. The top ones by files are `Fragment` 95, `Preview` 88, `Steps` 63, `FileTree` 58, `CardGrid` 48, and `LinkCard` 39, all from Starlight. Adding Starlight's built-ins and `Fragment` as a pass-through gives 352/567 (62.1%). Full tables, findings, and caveats are in `docs/M1-NOTES.md`.

Findings that change plans:

- `CodeGroup` and `Callout` never appear as JSX in the corpus. Callouts arrive as `:::` containers and as Starlight's `<Aside>`, and code groups as VitePress `::: code-group`.
- Import mapping needs named imports from one module (`@astrojs/starlight/components`, 241 files). ARCHITECTURE §5.2 only maps one specifier to one component. The correction is recorded in `docs/M1-NOTES.md`.
- remark-directive reads `localhost:8000`, `4.5:1`, and similar as text directives (10 in 7 files). The renderer must print them back as text.
- MkDocs Material uses `!!!` admonitions in 39 of 85 files. They stay raw text in v1, per MVP.md.

Tests: `pnpm lint`, `pnpm typecheck`, and `pnpm test` exited 0. `packages/doc-model` ran 31 tests, all passing; 4 of them are new compat tests. Also fixed in passing: `oxybook-check --json` truncated piped output at 64 KB because the CLI called `process.exit()`. It now sets `process.exitCode`.

### 2026-10-30 — Manifest-created App opens a pull request; webhooks arrive

Run by the repo owner on their machine, not in an agent session. `main` was at `74befc218a38d21bcc6c366966e0d65eab9da752` (#14). Node v22.23.1, with the same Unsupported engine warning. `pnpm dev` ran on the host with `PORT=3100` and `HEALTH_PORT=3101`, because Grafana holds 3000. `.env` set `OXYBOOK_PUBLIC_URL=https://oxybook.boznetwork.com` and a generated `OXYBOOK_SECRET_KEY`. `DATABASE_URL` pointed at the compose `postgres` service. The owner's Cloudflare tunnel routes `oxybook.boznetwork.com` to `localhost:3100`.

Server log, in order: `migrated 0001_schema_v0`, `migrated 0002_github_app`, `github app credentials: none stored yet`, `app listening on 3100`. After the browser went through `/setup/github` and GitHub's create page: `github app 5535294 (oxybook-cris) stored in the database`. GitHub then delivered `webhook verified event=ping delivery=02b66b4a-d401-11f1-9340-c19752c9da6b`. Installing on `oxybook-test` (installation id 176737174) delivered `webhook verified event=installation delivery=14595290-d401-11f1-911f-32ef1a4ac8bb`. Before this test the hand-made App's webhook was switched off, so no rejected deliveries were expected.

`oxybook-dev propose /tmp/test-page-2.md ... --path docs/test-page-2.md --draft 2 --draft-url https://oxybook.boznetwork.com/` ran with `GITHUB_APP_ID=5535294`, `GITHUB_APP_INSTALLATION_ID=176737174`, and a second private key generated on the App's settings page. GitHub does not let the key from the manifest exchange be downloaded again, and the CLI does not read the database. It printed commit `2e58f1b9a21b9f0a3df6df9887660bb0f4697b7a`, ref `refs/heads/oxybook/dev/page-2`, base `17d8d47a5b4e8d7feef3ff97054415558d44debc`, and `pr https://github.com/crisprintsstuff/oxybook-test/pull/2`.

Checked from this session: `GET /repos/crisprintsstuff/oxybook-test/pulls/2` returned open, not merged, user `oxybook-cris[bot]` (type Bot), head `oxybook/dev/page-2`, base `main`. `GET .../pulls/2/files` returned exactly one entry, `docs/test-page-2.md`, added, +3/-0. The commit is unsigned (`verification.verified: false`). `oxybook-test` has no ruleset requiring signatures.

On the way: with the compose `postgres` container stopped, `pnpm dev` hung before `app listening` and printed nothing. pg's default connection timeout is zero, and something on the owner's machine still accepted TCP on `127.0.0.1:5432`. Starting `postgres` fixed it. The follow-up change sets a 10s connection timeout and names the host when migrate-on-start fails.

The entries below call the manifest flow and webhook delivery unverified. That was true when they were written.

### 2026-10-30 — M0 loose ends: App credentials stored, OAuth path, installation id

Before this change the manifest flow could create an App and then lose it. The private key and webhook secret lived in process memory, the callback response leaves them out, and a restart dropped them. The flow could not be proven end to end in that state.

- Migration `0002_github_app.sql` adds the one-row `github_app` table. The client secret, webhook secret, and private key are AES-256-GCM sealed under a key derived from `OXYBOOK_SECRET_KEY` (HKDF-SHA256). The server stores the App after the manifest exchange when `DATABASE_URL` and `OXYBOOK_SECRET_KEY` are set, and loads it at start. Otherwise it says `memory only`. A failed save after a successful exchange returns 500 `created on GitHub but not saved`. `/setup/github` returns 409 when an App is stored. The success body now carries `persisted` and `install_url`.
- `GET /api/github/oauth/callback` answers 501 instead of 404.
- The webhook route logs one line per delivery with the event name and `X-GitHub-Delivery`. It still does nothing else with the payload.
- `oxybook-dev propose` reads `GITHUB_APP_INSTALLATION_ID` when `--installation-id` is absent. Added to `.env.example`.
- `docs/LIVE-INSTALL.md` follows the new path. `docs/M1-PLAN.md` is new.

Measured, Node v22.22.0, local PostgreSQL 16: `pnpm lint`, `pnpm typecheck`, and `pnpm test` exited 0. `apps/server` 10 pass, `packages/git-write` 8 pass, `packages/db` 3 pass. The new tests cover seal/open with a wrong key, save/load/refuse-second-App in a throwaway schema, persist success and failure, 409, 501, the webhook log lines, and the env fallback.

Smoke run of `apps/server/dist/main.js` on an empty database with `OXYBOOK_MIGRATE_ON_START=true` and a test `OXYBOOK_SECRET_KEY`. Start printed `migrated 0001_schema_v0`, `migrated 0002_github_app`, then `none stored yet`. `/setup/github` returned 200 and the OAuth path returned 501. After a test App row was saved, a restart printed `github app 42 (smoke-app) loaded from the database`. `/setup/github` then returned 409. A webhook signed with the stored secret returned 204 and logged `webhook verified event=ping delivery=smoke-1`. The sealed key column did not contain the plaintext.

Not measured: anything against GitHub. The manifest flow and webhook delivery are still owner steps in `docs/LIVE-INSTALL.md`. The container image was not rebuilt. In compose, `OXYBOOK_SECRET_KEY` defaults to `dev-only-insecure-change-me`, so a compose-run App is stored under that key. Changing the key later makes the server refuse to start until the `github_app` row is removed.

### 2026-10-30 — Rebuilt image migrates an empty database

Run by the repo owner on their machine, not in an agent session, on `main` after #12. `docker compose down -v` removed the volumes, including `pgdata`. Then `docker compose up -d --build` ran. `docker compose logs app` began with `migrated 0001_schema_v0` and then `app listening on 3000`. Migrate-on-start from inside the container image is now verified, both on an empty database and, per the entry below, on an already-migrated one. The entry below lists the empty-database case as unverified. That was true when it was written.

### 2026-10-30 — Rebuilt image starts against the migrated database

Run by the repo owner on their machine after #11 merged (`main` at `64219631946a841d529661eea32f89dd6bff99e7`), not in an agent session. `docker compose up -d --build` built `localhost/oxybook:dev`. postgres and app reported Healthy. mailpit, caddy, and worker reported Started. The `pgdata` volume already existed, so this was not a fresh database.

`docker compose logs app` showed `app listening on 3000` and no `migrated` line. `select name from kysely_migration` returned `0001_schema_v0`. So the image ran migrate-on-start, found nothing pending, and started. The app does not listen if a migration fails. When `0001_schema_v0` was first applied to that volume was not recorded.

Still unverified: the image applying a migration to an empty database. Testing that needs `docker compose down -v` first, which deletes the local `pgdata` volume. The entry below says the image path was unverified. That was true when it was written.

### 2026-10-30 — Database schema v0 and `pnpm db:migrate`

The last M0 work item in `docs/MVP.md` that was not started. Base was `main` at `13d331d20d3fc36200616470f04da69c147d3b9b`.

`packages/db` (AGPL-3.0-only) holds `migrations/0001_schema_v0.sql`, a Kysely `Database` type for it, `createDb`, and `migrateToLatest`, which feeds the SQL files to Kysely's `Migrator` in filename order. Migrations are forward-only. Tables: `orgs`, `users`, `org_members`, `sessions`, `spaces`, `space_members`, `blobs`, `ref_state`, `pages`, `drafts`, `draft_files`, from ARCHITECTURE §4.2, §4.4, §7 and §8. Where those sections disagree (blob dedup scope, `org_id` on users) the choice is recorded in `docs/M0-NOTES.md`.

`pnpm db:migrate` is a root script. `apps/server` applies migrations before it listens when `OXYBOOK_MIGRATE_ON_START=true`, which `docker-compose.yml` already set and nothing read until now. The `Dockerfile` builds `@oxybook/db`.

Measured, Node v22.22.0 (the same Unsupported engine warning as before; not evidence Node 22 is supported):

- `pnpm lint`, `pnpm typecheck`, and `pnpm test` exited 0. With `DATABASE_URL` set, `packages/db` ran 3 tests against a local PostgreSQL 16 cluster: 3 pass. They apply 0001 into a throwaway schema and check that a second run is a no-op, store a page and a draft, read back BOM + CRLF bytes from `blobs` unchanged, hit the page through `tsv`, and reject a case-insensitive duplicate email, a second open draft for the same user/space/ref, a draft branch outside `oxybook/*`, a delete with bytes, a `content_root` of `../etc`, and a `ref_state` row whose `org_id` does not own the space. The third test gives the migrator a good file and a broken one and checks that the good file's table is absent afterwards.
- Against the compose `postgres` service (`PostgreSQL 17.11`): the same 3 tests passed. `node apps/server/dist/main.js` with `OXYBOOK_MIGRATE_ON_START=true` printed `migrated 0001_schema_v0` then `app listening on 3999`, and `GET /healthz` returned 200 `{"ok":true,"service":"app"}`. A second start printed only `app listening on 3999`. `kysely_migration` held `0001_schema_v0`, and 11 tables were in `public`. The stack was removed with `docker compose down --remove-orphans -v`.
- Without `DATABASE_URL`, the `packages/db` suite reports `# SKIP DATABASE_URL is not set` and passes.

Not measured: `docker compose up --build` did not finish here. Docker Hub returned 429 Too Many Requests for `axllent/mailpit:latest`, and the image build could not resolve `deb.debian.org`. So migrate-on-start from inside the image is unverified. `.github/workflows/ci.yml` now starts a `postgres:17` service, sets `DATABASE_URL`, and runs `pnpm db:migrate`.

CI: push run 40982597587 on `8443b2ba6f5c354eb994160190c3620c4d45e4e5` (branch `claude/cool-carson-tr367e`) succeeded, `check` 00:54:31Z–00:55:21Z. Every step passed, including `pnpm db:migrate`. The service log shows `PostgreSQL 17.11` and the constraint errors the `packages/db` tests provoke on purpose (`users_email_lower`, `drafts_one_open`, `drafts_branch_check`, `draft_files_check1`, `spaces_content_root_check`, `ref_state_org_id_space_id_fkey`, `no_such_type`), so those tests ran rather than skipped. The corpus summary was 594 pass, 0 fail, 1 unparseable.

Also corrected: [oxybook-test#1](https://github.com/crisprintsstuff/oxybook-test/pull/1) is merged, not open. `GET /repos/crisprintsstuff/oxybook-test/pulls/1` returned `merged: true`, `merged_at: 2026-10-29T18:38:25Z`, merge commit `17d8d47a5b4e8d7feef3ff97054415558d44debc`. The 2026-10-29 entry below says open; that was true when it was written.

### 2026-10-29 — M0 complete: a real pull request

Test repo [crisprintsstuff/oxybook-test](https://github.com/crisprintsstuff/oxybook-test), public, default branch `main`.

[Pull request 1](https://github.com/crisprintsstuff/oxybook-test/pull/1) is open, not merged. Title `Update docs/test-page.md`. Head branch `oxybook/dev/page-1` at commit `4fa776d44aaa8342dd3c506ee47c54289b019991`. Base `main` (`02d62aba`). Author is the GitHub App bot, login `oxybook-dev-cb[bot]`, App id 5530818, installation id 176643684.

The diff is exactly one file, `docs/test-page.md`, added, +3/-0. `GET /repos/crisprintsstuff/oxybook-test/pulls/1/files` returned exactly 1 entry. That is the M0 exit requirement that the diff contain only the intended change.

The pull request body contained `Pages changed: docs/test-page.md` and `Link back: https://oxybook.boznetwork.com`.

The command was `pnpm oxybook-dev propose <file> --remote https://github.com/crisprintsstuff/oxybook-test.git --github-owner crisprintsstuff --github-repo oxybook-test --installation-id 176643684 --base main --path docs/test-page.md`, with `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_FILE` set. It exited 0 and printed the commit, the ref, the base, the author, `pr <url>`, and the diff.

The App was created by hand at `https://github.com/settings/apps/new`, not through `/setup/github`, because the manifest flow was rejected. That fix is PR #9, merged as `86ccb01aa93c8a65c4b5db40093c1476ddf3da6a`. The manifest flow itself is still not proven end to end.

The run was Node v22.23.1, not 24. pnpm printed an Unsupported engine warning. The command succeeded anyway. That is a known deviation, not evidence that Node 22 is supported.

Still unverified: webhook delivery from GitHub to `/api/github/webhooks` in production; the manifest-created App path; the Git Database API fallback against a repo whose ruleset requires signed commits (measured earlier on this repo, not on `oxybook-test`, and `oxybook-test` has no ruleset); the editor, the renderer, the database, and a published site.

The entry below that says no GitHub pull request had been opened was true when it was written.

### 2026-10-29 — `pnpm oxybook-dev -- propose` was opening a file named propose

pnpm forwards the `--`, so `process.argv` began with `--` and the parser treated the word `propose` as the file. That run failed with `ENOENT` opening `propose`. A leading `--` is now ignored. The command that worked without it is `pnpm oxybook-dev propose <file> --remote <url>`. `AGENTS.md` and `docs/LIVE-INSTALL.md` show that form.

### 2026-10-29 — Install attempt: manifest events and the dev server

A live attempt to create the App from `/setup/github` was rejected by GitHub: "Default events unsupported: installation and installation_repositories." `default_events` is now `push` and `pull_request` only. This change did not submit the new manifest to GitHub.

`pnpm dev` ran `node --watch src/main.ts` and exited with `ERR_MODULE_NOT_FOUND` for `apps/server/src/github-routes.js`. The server dev script now builds `@oxybook/github` and runs `tsx watch src/main.ts`. After that change, `pnpm dev` printed `app listening on 3000` and `worker listening on 3001`. `GET http://127.0.0.1:3000/healthz` returned 200 `{"ok":true,"service":"app"}`. `GET http://127.0.0.1:3001/healthz` returned 200 `{"ok":true,"service":"worker"}`. The processes were then stopped.

`pnpm db:migrate`, `pnpm test:integration`, and `pnpm test:e2e` are not scripts. `CONTRIBUTING.md` no longer tells anyone to run them.

Left as gaps, not fixed: the manifest `callback_urls` value is `/api/github/oauth/callback` and no route serves it. The served callback is `GET /setup/github/callback`. There is no environment variable for the installation id. The CLI flag is `--installation-id`.

### 2026-10-29 — Pull request POST is unit-tested; the live install is not done

`oxybook-dev propose` can `POST /repos/{owner}/{repo}/pulls` after it pushes an `oxybook/*` branch. The request uses the installation token from `InstallationTokenCache`. The body lists the pages changed and a link back. The base branch is not the push target and is not the pull request head. Tests use a fake `fetch`. Nothing in this change called `api.github.com`, and no GitHub pull request was opened. A live App install has not happened. `docs/LIVE-INSTALL.md` is the owner checklist. The M0 exit blocker stays open until that pull request exists on a test repo.

### 2026-10-29 — Current state no longer pins a head SHA

The entry below pinned `main` at `4837c97c7e546e80b31b265d67e24c70ae910939`. That head has since moved. This entry supersedes that pin by taking the head SHA, the run ids, and the history sentence out of `## Current state`. Commit SHAs and CI run ids stay in changelog entries. `main` at the time of writing is `84482b02fb533c41f305eb8fc36a68936bf6d9ac`. `check` on that push was green, 2026-10-29T15:14:35Z–15:15:02Z. The entry below is left as written.

### 2026-10-29 — Status handoff matches `main` after the probe was removed

`main` is `4837c97c7e546e80b31b265d67e24c70ae910939`. Push run 40898410005 succeeded (`check`, 2026-10-29T15:07:55Z–15:08:27Z, 32s). The current-state CI line had still named `99fe76f` and `d942fb2`. Those runs stay in the history sentence. `.github/workflows/ci.yml` runs `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm test:corpus`. The corpus step fetches the pinned repos, so the job needs network.

The note `docs/MVP.md` asks for is `docs/M0-GITHUB-SPIKE.md`. Corpus identity in CI and that note meet two of the three exit checks. The remaining exit blocker is a real pull request against a test repo. Database schema v0 is listed as M0 work in `docs/MVP.md` and is not part of that exit sentence. It is still not started.

Ruleset `ruleset-probe` (id `26114519`) and branch `ruleset-probe-test` were removed on 2026-10-29 after the measurement was recorded, the ruleset first and then the branch, because the ruleset's `deletion` rule blocks removing a matching branch while it is active. `GET /repos/crisprintsstuff/OxyBook/rulesets` returned an empty list. `GET /repos/crisprintsstuff/OxyBook/branches/ruleset-probe-test` returned HTTP 404. Removing them changed nothing about the measurement. The entry below still says they were left in place. That was true when it was written.

### 2026-10-29 — ARCHITECTURE §4.3 answered: required signatures do reject the push

Recorded in PR #4. PR #3 merged as `90f4fd72815994f6e0bace84c392cefca13628ed`. The entry below still says the ruleset question was unverified. That was true when it was written. It is not true after the probe on ruleset `26114519`.

An unsigned `git push` of `2b6d07cee53df072a7437659dbf1278e5d01de02` to `ruleset-probe-test` is rejected with `GH013` (commits must have verified signatures). That push was the repo owner's, not re-run here. `PATCH /git/refs/heads/ruleset-probe-test` with `force: false` and commit `c915f0780c13f25cdf01870fcda216b721c576cf` returned HTTP 200. GitHub signed that Git Database API commit (`verified: true`, `reason: "valid"`) for `cursor[bot]`. The head moved from `d284359f4d12f13bb17db60c7cd8fd0e9cf5027c` to `c915f0780c13f25cdf01870fcda216b721c576cf`. The ruleset and the branch were left in place. Full status codes and the permissions split (anonymous GET 200, this installation token GET 200 via `metadata=read`, POST create 403) are in `docs/M0-GITHUB-SPIKE.md`.

### 2026-10-29 — GitHub App spike: local write path verified, ruleset still blocked

`packages/github` signs app JWTs, caches installation tokens in memory, and checks `X-Hub-Signature-256` with `timingSafeEqual`. The manifest route and callback are unit-tested against a mocked GitHub. `oxybook-dev propose` pushes to `refs/heads/oxybook/<user>/<slug>-<id>` on a `file://` remote; the diff in that run contained only `docs/a.md`, and a stale `--force-with-lease` was refused. Recorded in `docs/M0-GITHUB-SPIKE.md`.

Not live: installing a GitHub App, receiving a webhook from GitHub, and opening a GitHub pull request. Signed-commit rulesets stay unverified: creating one on `crisprintsstuff/OxyBook` returned HTTP 403 `Resource not accessible by integration`, and the ruleset list was empty afterwards.

### 2026-10-29 — PR #1 merged; CI head corrected; image health checked

PR #1 merged as `d942fb2747b9f1cb1d708af884ebfdb6a376a858`.

`check` on `99fe76f` succeeded twice: push run 40836564769, job 07:37:00Z–07:37:31Z (31s), and pull_request run 40836572202, job 07:37:03Z–07:37:29Z (26s). Merge push run 40836670051 on `d942fb2` succeeded, job 07:37:57Z–07:38:20Z (23s). The changelog entry below that names `d9e725c` was already behind those SHAs when `main` moved; it is left as written.

Docker was not installed here at the start of this check. After installing docker.io 29.1.3 and starting `dockerd` by hand (the service manager would not), `docker compose up -d --build` produced `localhost/oxybook:dev`. Inside the containers, app `GET http://127.0.0.1:3000/healthz` returned `200 {"ok":true,"service":"app"}` and worker `GET http://127.0.0.1:3001/healthz` returned `200 {"ok":true,"service":"worker"}`. postgres, caddy, mailpit, app, and worker all reported healthy. The stack was removed with `docker compose down --remove-orphans -v`.

### 2026-10-29 — `check` is green on `d9e725c`

Run 40836479834 completed successfully after the callout fold. Lint, typecheck, unit tests, and `pnpm test:corpus` all passed. The earlier red runs were the billing block described below, not a test failure.

### 2026-10-29 — Callout containers are one block; CI failure is billing

`:::name`, `:::name Title`, `::: name Title`, and `:::name[Title]` at column 0 fold into one `callout` after remark parse. The block owns the bytes through the matching `:::`, including nested containers and blank lines. Marker lines are not editable spans. An unclosed container is one raw block through EOF. Fences and HTML are not scanned. Re-measured corpus: 594 pass, 0 fail, 1 unparseable.

CI `check` on `8ac0dff` (runs 40835691209 and 40835716025) never started a step. Annotation: "The job was not started because recent account payments have failed or your spending limit needs to be increased." `pnpm@10.33.4` exists and `pnpm install --frozen-lockfile` succeeds against the committed lockfile. The workflow was not changed to skip tests.

### 2026-10-29 — M0 slice: round-trip library and scaffolding

`packages/doc-model` is in the tree with an identity check, `oxybook-roundtrip`, property tests, adversarial fixtures, and a corpus harness pinned to five public doc trees (Docusaurus, Starlight, VitePress, MkDocs, Material for MkDocs). Measured result: 588/588 parseable files identical; 1 unparseable fixture by design. Details, including where `docs/ARCHITECTURE.md` was thin, are in `docs/M0-NOTES.md`.

Also in this change: app and worker TypeScript skeletons that only serve `/healthz`; a multi-stage `Dockerfile` and a compose `build` for that image (container start unverified); an H2 spike under `spikes/conflicts/` (script, recorded bytes, design note). Not in this change: database schema, GitHub App, editor, renderer. M0's exit in `docs/MVP.md` is not met.

### 2026-10-29 — Founding design documents

Commit `305b60ce491b9058d1324abd879dd61ba2d813f1` added `docs/ARCHITECTURE.md`, `docs/MVP.md`, `LICENSING.md`, `CONTRIBUTING.md`, `docker-compose.yml`, and the licence texts. No application code.

## Decisions made

Settled. Do not re-open these without a written reason that the invariant or the licence split changed.

| Decision | Why |
| --- | --- |
| The customer's git repository is the source of truth | Every cache must be rebuildable from git. OxyBook does not keep a second copy of page content except unproposed drafts. |
| GitHub first | v1 ships one provider. The sync layer can grow a second later. GitLab, Bitbucket, and Forgejo are non-goals for v1. |
| TipTap on ProseMirror | Strict schema and step maps are what make "which block changed" tractable. TipTap's markdown extension is not the serializer. |
| Static publishing | A built site is files behind the edge proxy, so readers do not depend on the app process. |
| AGPL-3.0 for the product, Apache-2.0 for SDK, themes, components, and deploy files | The hosted product copylefts improvements. Themes and components ship inside customer sites and must not infect those sites. |
| DCO, not a CLA | Contributors keep copyright. Inbound equals outbound. A sign-off is the human's statement. |
| No paid tier | No `ee/` tree, no licence that forbids production use, no feature gated on a subscription. SSO, when it exists, ships in the AGPL tree. |

## Open questions

From the design docs. Not a wishlist.

- **Signed commits on `oxybook/*` (ARCHITECTURE §4.3).** Answered for this probe. `required_signatures` rejects an unsigned `git push` (`GH013`). A Git Database API commit made by the installation token in this environment is signed by GitHub and the fast-forward ref update returned HTTP 200. Not answered: the same API call with a user token, and a ruleset read on a private repo. See `docs/M0-GITHUB-SPIKE.md`.
- **Which built-in components ship in M1 (MVP.md H3).** Callout, Tabs, Card, and CodeGroup are a starting guess. The real list waits on a compatibility count over the corpus (unknown components, imports, expressions, directives). That count has not been run. Identity passing does not answer it.
- **Material for MkDocs `!!! note` and other pymdown extensions (MVP.md H3).** v1 leaves them as raw blocks. Native support is explicitly post-v1 and depends on the same unrun report.
