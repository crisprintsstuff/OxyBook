# Status

Future agents: append a dated entry under Changelog when something meaningful lands or a measured fact changes. Do not silently rewrite or delete older entries. Do update the current-state block and the milestone table so they match the latest entry. If you did not run it, write "unverified". Do not invent metrics.

Commit SHAs and CI run ids belong in dated Changelog entries, not in `## Current state`. A head SHA in the current-state block is stale as soon as the next PR merges. Name the current head only in changelog entries.

## Current state

- **Milestone:** M0 complete, M1 not started.
- **Last update:** 2026-10-30.
- **What works today:** `packages/doc-model` parses `.md` and `.mdx`, keeps original slices, and serializes an unedited file back to the same string. `:::name Title` (and `:::name`, `::: name Title`, `:::name[Title]`) is one callout block, not a run of paragraphs. On 2026-10-29, after that fold, `pnpm test:corpus` reported 594 pass, 0 fail, 1 unparseable (the planted unterminated `.mdx` fixture). App and worker processes answer `GET /healthz` in unit tests. A scratch-repo spike recorded `git merge-file` / `git merge-tree --write-tree` outcomes for concurrent edits. `packages/db` holds schema v0 as plain SQL migrations with Kysely types; `pnpm db:migrate` applied `0001_schema_v0` on PostgreSQL 16 and a second run reported up to date; the app's migrate-on-start did the same on PostgreSQL 17.11. No application code reads or writes those tables yet.
- **Dev server:** `pnpm dev` prints `app listening on 3000` and `worker listening on 3001`. `GET /healthz` on those ports returned 200 `{"ok":true,"service":"app"}` and 200 `{"ok":true,"service":"worker"}`. The processes were then stopped. The app script builds `@oxybook/github` and `@oxybook/db` (since 2026-10-30) and runs `tsx watch`.
- **CI:** `check` was green on `main` before the 2026-10-30 schema change. The workflow is `.github/workflows/ci.yml`. It starts a `postgres:17` service, sets `DATABASE_URL`, and runs `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm db:migrate`, and `pnpm test:corpus`. On 2026-10-30 that workflow ran green on the schema branch, and the postgres service log shows the `packages/db` tests executed (their expected constraint violations are in it). See the changelog. The corpus step fetches the pinned repos, so the job needs network. The current head and its result are on the repo's Actions tab.
- **Docker:** `docker compose up -d --build` built `localhost/oxybook:dev` (engine 29.1.3, Compose 2.40.3). postgres, caddy, mailpit, app, and worker all reported healthy. From inside the containers, `GET /healthz` returned 200 `{"ok":true,"service":"app"}` on port 3000 and 200 `{"ok":true,"service":"worker"}` on port 3001. The image's git is 2.39.5. The stack was then removed with `docker compose down --remove-orphans -v`.
- **Git write path:** `oxybook-dev propose` was run against a local `file://` bare remote. The diff touched only `docs/a.md`. A stale `--force-with-lease` was refused. An unsigned `git push` to `ruleset-probe-test` was rejected by ruleset `26114519` (`GH013`, commits must have verified signatures). A fast-forward `PATCH /git/refs/heads/ruleset-probe-test` of a Git Database API commit returned HTTP 200; GitHub had signed that commit (`verification.verified: true`, `reason: "valid"`). The measured head was `c915f0780c13f25cdf01870fcda216b721c576cf`. Details are in `docs/M0-GITHUB-SPIKE.md`. The same command has since opened a pull request on GitHub. See "Live pull request".
- **Live pull request:** [crisprintsstuff/oxybook-test#1](https://github.com/crisprintsstuff/oxybook-test/pull/1) was merged on 2026-10-29 (see the 2026-10-30 entry). It was opened on the public repo [crisprintsstuff/oxybook-test](https://github.com/crisprintsstuff/oxybook-test) (default branch `main`). Title `Update docs/test-page.md`. Head branch `oxybook/dev/page-1`. Author is the GitHub App bot `oxybook-dev-cb[bot]`, App id 5530818, installation id 176643684. `GET /repos/crisprintsstuff/oxybook-test/pulls/1/files` returned exactly one entry: `docs/test-page.md`, added, +3/-0. The body contained `Pages changed: docs/test-page.md` and `Link back: https://oxybook.boznetwork.com`. The command was `pnpm oxybook-dev propose <file> --remote https://github.com/crisprintsstuff/oxybook-test.git --github-owner crisprintsstuff --github-repo oxybook-test --installation-id 176643684 --base main --path docs/test-page.md`, with `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_FILE` set. It exited 0 and printed the commit, the ref, the base, the author, `pr <url>`, and the diff. The App was created by hand at `https://github.com/settings/apps/new`, not through `/setup/github`. The run was Node v22.23.1, not 24. pnpm printed an Unsupported engine warning and the command succeeded. That is a known deviation, not evidence that Node 22 is supported.
- **Signed-commit note:** The note `docs/MVP.md` asks for exists: `docs/M0-GITHUB-SPIKE.md`. It concludes that `required_signatures` rejects an unsigned `git push` (`GH013`) and accepts a GitHub-signed Git Database API fast-forward (HTTP 200, `verification.verified: true`, `reason: "valid"`). That measurement was on this repo. It was not repeated on `oxybook-test`, and `oxybook-test` has no ruleset.
- **Database:** `packages/db/migrations/0001_schema_v0.sql` creates `orgs`, `users`, `org_members`, `sessions`, `spaces`, `space_members`, `blobs`, `ref_state`, `pages`, `drafts`, and `draft_files`. Pending files run in one transaction under Kysely's advisory lock; a failing file rolls back every pending file (tested). `apps/server` applies migrations before listening when `OXYBOOK_MIGRATE_ON_START=true`. That was first run from `apps/server/dist/main.js` on the host against the compose `postgres:17` container. On the owner's machine, the rebuilt container image applied `0001_schema_v0` to an empty database and then served. See the 2026-10-30 entries.
- **What does not:** There is no editor, renderer, or published site. Nothing uses the database beyond migrations. The manifest flow (`/setup/github`) is unverified: the App above was created by hand. Webhook delivery from GitHub to `/api/github/webhooks` is unverified. The Git Database API fallback against a ruleset that requires signed commits is unverified on `oxybook-test`. The manifest `callback_urls` entry is `${publicUrl}/api/github/oauth/callback`, and no route serves that path. The callback the server serves is `GET /setup/github/callback`. There is no environment variable for the installation id. The CLI takes `--installation-id`. `pnpm test:integration` and `pnpm test:e2e` are not implemented. See "M0 exit, met".

## Milestones

From `docs/MVP.md`. "In progress" means some of the milestone's work is in the tree and the exit criterion is not met.

| Milestone | Status |
| --- | --- |
| M0 — Foundations and risk spikes | complete |
| M1 — Read path and published site | not started |
| M2 — Editor and write path | not started |
| M3 — Conflicts, versions, renames | not started |
| M4 — Production readiness, v1.0 | not started |

## M0 exit, met

`docs/MVP.md` says M0 is done when corpus identity is 100% on parseable files and runs in CI; the CLI opens a real PR against a test repo whose diff contains only the intended change; a written note records the signed-commit ruleset behaviour (ARCHITECTURE §4.3).

1. **Corpus identity in CI.** Met. `.github/workflows/ci.yml` runs `pnpm test:corpus`. The measured result recorded above is 594 pass, 0 fail, 1 unparseable.
2. **Real pull request.** Met. [oxybook-test#1](https://github.com/crisprintsstuff/oxybook-test/pull/1). `GET /repos/crisprintsstuff/oxybook-test/pulls/1/files` returned exactly one entry, `docs/test-page.md`, added, +3/-0.
3. **Written note.** Met. `docs/M0-GITHUB-SPIKE.md` records the signed-commit behaviour.

Still unverified. These are not the exit sentence, and they are not done:

- **Manifest-created App.** Unverified. The App that opened the pull request was created by hand at `https://github.com/settings/apps/new`. `/setup/github` has not been proven end to end.
- **Webhook delivery** from GitHub to `/api/github/webhooks` in production. Unverified.
- **Git Database API fallback** on a repo whose ruleset requires signed commits. Unverified on `oxybook-test`. That repo has no ruleset. The earlier measurement was on this repo. See `docs/M0-GITHUB-SPIKE.md`.
- **Database schema v0 and migrations** (Kysely + SQL migrations). Done 2026-10-30 in `packages/db`, measured on a local PostgreSQL 16 and the compose `postgres:17` image. CI runs the tests against a `postgres:17` service. The rebuilt image migrates an empty database at start and also starts against an already-migrated one.
- **OAuth callback path.** The manifest `callback_urls` value is `/api/github/oauth/callback`. No route serves it. The served callback is `GET /setup/github/callback`.
- **Installation id.** No environment variable. The CLI flag is `--installation-id`.
- **`pnpm test:integration` and `pnpm test:e2e`.** Not implemented.
- **Editor, renderer, and published site.** Not started.

## M1 next

Not started. No M1 code is in the tree. From `docs/MVP.md`:

- Accounts (email/password, sessions), organisations, spaces, Admin role.
- GitHub App install flow in the UI; repo connection with access check; webhook sync + reconciliation; read model in PostgreSQL.
- Renderer: mdast→hast handlers, allowlisted components (Callout, Tabs/TabItem, Card, CodeGroup to start; final list from the H3 report), Shiki, link rewriting and broken-link warnings, import mapping.
- Build job, release assembly with hardlinks, atomic swap; `by-host` symlinks; Caddy serving `<space>.docs.localhost` in dev.
- Default theme v0, sidebar from tree + `_dir.yml`, Pagefind.
- `oxybook check` compatibility CLI; corpus rendering report.

**Done when:** connecting a test repo yields a published site with working nav and search; a push to the default branch (including a rename and a delete) is reflected on the site with no manual step; a dropped webhook is caught by reconciliation; stopping `app` does not take the published site down.

## Changelog

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
