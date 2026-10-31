# Status

Future agents: append a dated entry under Changelog when something meaningful lands or a measured fact changes. Do not silently rewrite or delete older entries. Do update the current-state block and the milestone table so they match the latest entry. If you did not run it, write "unverified". Do not invent metrics.

Commit SHAs and CI run ids belong in dated Changelog entries, not in `## Current state`. A head SHA in the current-state block is stale as soon as the next PR merges. Name the current head only in changelog entries.

## Current state

- **Milestone:** M0 and M1 complete. M2 in progress: slices 1–2 of `docs/M2-PLAN.md` are done (the editor document bridge, which CI now checks over all 595 corpus and fixture files, and drafts with `If-Match` concurrency, diff preview, multi-file commits, and 3-way rebase). Slice 3 is half done: the propose job, `pull_request` webhooks, and editor/viewer enforcement on propose are in, measured locally. Sign in with GitHub and user-authored PRs (3b) remain, as does a live propose against `oxybook-test`.
- **Last update:** 2026-10-30.
- **Round-trip and editor document bridge (`packages/doc-model`):** parses `.md` and `.mdx`, keeps original slices, and serializes an unedited file back to the same string. `:::name Title` is one callout block. `openEditorDocument`, `sourceDocToEditorState`, `serializeEditorState`, `markBlocksDirtyFromPmSteps`, `updateEditorBlock`, `moveEditorBlock`, `deleteEditorBlock`, `insertEditorBlock`, `inspectFrontmatter`, and `updateEditorFrontmatter` bridge `SourceDoc` to the ProseMirror/TipTap block/inline schema (`paragraph`, `heading`, `code_block`, `blockquote`, `alert`, `callout`, `bullet_list`, `ordered_list`, `task_list`, `table`, `horizontal_rule`, `raw_block`, `raw_inline`, plus `strong`/`em`/`strike`/`code`/`link` marks with reference-link and hard-break preservation), enforce the load-time identity check (`source-only` fallback on unparseable or identity failure), and re-serialize only dirty blocks while keeping unedited and moved blocks byte-exact. `pnpm test:corpus` reports 594 pass, 0 fail, 1 unparseable (the planted fixture). It runs in CI.
- **Compatibility report:** `pnpm oxybook-check <dir>` lists what would render as a placeholder, with `file:line`. `pnpm compat:corpus` runs it over the corpus. Over the corpus, 50.4% of files are clean with the starting allowlist and 62.1% with Starlight's built-ins. The recommended component list and the design corrections are in `docs/M1-NOTES.md`.
- **Database (`packages/db`):** migrations `0001_schema_v0`, `0002_github_app`, `0003_sync`, and `0004_builds` (forward-only SQL, run by Kysely in one transaction). `pnpm db:migrate`. The app migrates on start with `OXYBOOK_MIGRATE_ON_START=true`. Verified on PostgreSQL 16 and 17, in CI, and from the container image on the owner's machine.
- **GitHub App:** created from `/setup/github` (manifest flow) and stored encrypted in `github_app` under `OXYBOOK_SECRET_KEY`. `/setup/github` refuses a second App (409). `/api/github/oauth/callback` answers 501 until M2. Webhooks are verified with the stored secret. `ping`, `installation`, `push`, and `pull_request` have all been delivered live. The owner's App is `oxybook-cris`, installed on `oxybook-test`.
- **Accounts, UI, spaces, and jobs (`apps/server`, `packages/github`, `packages/jobs`):** email/password signup and login with Argon2id (`@node-rs/argon2`, 19 MiB memory cost), opaque 256-bit random session tokens hashed with SHA-256 into `sessions.token_hash` (`HttpOnly; SameSite=Lax` cookie `oxybook_session`), HMAC-SHA256 CSRF protection on state-changing routes, organisations (`owner`/`member`; the database allows no other org role), spaces, and space roles (`admin`/`editor`/`viewer`). The first user on an instance automatically adopts any pre-existing memberless CLI orgs and spaces as `owner`/`admin`. The web UI (`/signup`, `/login`, `/` dashboard, `/orgs/:org/spaces/:space`) shows GitHub App installation status, discovers repositories installed on the stored App (`GET /app/installations` + `GET /installation/repositories`), verifies installation read access (`checkInstallationRepoAccess`) and optional user write access (`checkUserRepoAccess`, ARCHITECTURE §4.1), creates spaces, triggers sync + build jobs, and manages space members. `pnpm oxybook-admin` (`org create`, `space create <org>/<space> --repo owner/repo`, `space list`, `sync <org>/<space> [--now]`, `build <org>/<space> [--now]`, `pages <org>/<space>`, `job ping`, `m1-exit`) and `pnpm m1:exit` remain available for CLI administration and exit verification. `oxybook-admin draft save|show|propose` drives the write path until the editor exists. Jobs run on pg-boss (schema `pgboss`) through five queues: `ping`, `sync` (one queued per space and ref), `build` (one queued per space and version), `propose` (one per draft), and `reconcile` (every 5 minutes).
- **Sync (`packages/sync`):** a blobless mirror per repo. Each sync compares the whole content-root tree at the branch head with `pages` (applying `exclude:` from `oxybook.yml`), in one transaction, records renames in `inferred_redirects`, and queues a `build` job. A verified `push` to a space's default branch queues a sync (deduplicated in `webhook_deliveries`). `reconcile` catches pushes whose webhook was lost. Measured on the owner's machine with `oxybook-test`: a push with an edit, a rename, and a delete synced with no manual step, and a push with the webhook off was caught by reconciliation.
- **Renderer, default theme, and build (`packages/renderer`, `packages/theme-default`):** `@oxybook/renderer` (`AGPL-3.0-only`) renders `.md` and `.mdx` to hast and HTML via `doc-model` and `mdast-util-to-hast`, with Shiki syntax highlighting (`github-light`/`github-dark` CSS variables), the M1 allowlist (`Callout`, `Tabs`, `TabItem`, `Card`, `CodeGroup`, `Aside`, `Badge`, `CardGrid`, `Code`, `FileTree`, `Icon`, `LinkButton`, `LinkCard`, `Steps`, `Fragment`, plus `::: code-group`), static props only, visible placeholders and build warnings for everything else, relative link and asset rewriting with broken-link warnings (`strict: true` throws `StrictBuildError`), `oxybook.yml` import mapping (default and named imports), and search-document output. `@oxybook/theme-default` (`Apache-2.0`, zero AGPL dependencies) wraps rendered pages in the default documentation theme: sticky header (site title/logo, version switcher, header links, mobile menu toggle), collapsible sidebar with `_dir.yml` ordering and `data-active-branch` / `aria-current="page"`, right-hand "On this page" table of contents (`h2`/`h3`), previous/next page links in reading order, optional `oxybook.yml` `theme:` customization (`logo`, `favicon`, `accentColor`, `headerLinks`, `footer`, `customCssUrl`), and client-side island hydration for `<Tabs>`/`<TabItem>` (`data-tabs-group` + `localStorage`), `::: code-group` tab bars, and Pagefind search UI (`/` and `Ctrl+K`/`Cmd+K`). `buildSiteVersion` and `runSpaceBuild` cache rendered page bodies, copy assets, generate static redirect HTML and `404.html`, index non-hidden pages with Pagefind (`/pagefind/*`), write `builds/<space>/<version>/<sha>-<buildId>/`, assemble a hardlinked release (`spaces/<space>/releases/<sha>-<buildId>/`), atomically swap `spaces/<space>/current`, maintain `by-host/<hostname>` symlinks, record the build in `builds`, and prune old builds. Measured on the owner's machine with `cris/test`: Caddy serves `http://test.docs.localhost:8180/` (plus all 10 pages, `/guides/images/stack.svg`, `/reference/cli` redirect, `/pagefind/pagefind-entry.json`, and 404 on deleted `/placeholder`) with `app` stopped.
- **Drafts (`packages/drafts`, M2 slice 2):** one open draft per (user, space, ref), based on the synced head. Every save names the version it saw (`If-Match`), and a stale one gets `DraftVersionConflict` (409). Paths go through the same guard as commits, and an image upload is a draft file. `draftDiff` gives a unified diff per file (binary files are flagged). `openDraftsTouching` answers "who else has a draft on this page". When a sync moves the head, the worker runs `rebaseDrafts`: untouched files take the new base, drafted files merge with `git merge-file`, changes that already landed are dropped, and any conflict marks the draft `conflicted` with its files left as they were. A save that races the rebase wins, and the rebase retries. There is no HTTP API for drafts yet; the editor (slice 4) is its first caller.
- **Propose (`proposeDraft` in `packages/drafts`, `propose` job in `apps/worker`, M2 slice 3a):**
  1. Fetches the base. If the base moved, it rebases the draft first, and a conflict stops it.
  2. Builds the whole draft as one commit on the base. Commits carry the user's name and a per-instance noreply address.
  3. Pushes to `oxybook/<user>/<page>-<draft>`, always with `--force-with-lease=<ref>:<expected>`:
     - a new branch;
     - a commit appended when only OxyBook pushed and the base is the same;
     - the branch rebuilt on the new base when only OxyBook pushed and the base moved;
     - a merge commit (`git merge-tree`) when someone else pushed. Their history is never rewritten, and a conflicting push marks the draft `conflicted` with nothing pushed.
  4. Opens the PR once, with the installation token, so the PR is App-authored.

  Only the draft's author proposes, and only with the `editor` or `admin` role (an org owner counts as admin). A `pull_request` webhook on an `oxybook/*` branch moves the draft that opened it: `merged`, `closed`, or back to `proposed` on reopen. The draft is matched by repository, branch, and PR number. Migration `0005_propose` adds `pushed_sha`, `pushed_base_sha`, `pr_url`, and `propose_error`. User mistakes are recorded in `propose_error` and not retried; a moved base or branch is retried.
- **Write path (`packages/git-write`):** `commitFiles` builds one commit from any mix of add, modify, delete, and rename, using a temporary index on the bare mirror. Its guards: content root or `oxybook.yml` only, never a hidden path (`.github/workflows` included), a size limit, and one op per path consistent with the base. It adds a DCO trailer only when asked. `mergeFile3` wraps `git merge-file`. Nothing pushes these commits yet (slice 3). The M0 `oxybook-dev propose` CLI pushes a single file to `oxybook/*` with `--force-with-lease` and opens a pull request. It opened oxybook-test#1 (hand-made App) and #2 (manifest-created App), each with a diff of exactly one file. Signed-commit ruleset behaviour is in `docs/M0-GITHUB-SPIKE.md`.
- **Running it:** on the owner's machine, `pnpm dev` runs app and worker on the host (`PORT=3100`, `HEALTH_PORT=3101`, because Grafana holds 3000), with compose `postgres` and `caddy` (`CADDY_PORT=8180`, because qBittorrent holds 8080) and a Cloudflare tunnel `oxybook.boznetwork.com` → `localhost:3100`. Host processes read the repo `.env`. The container image (`docker compose up --build`) also starts and migrates. Steps are in `docs/LIVE-INSTALL.md`.
- **CI:** `.github/workflows/ci.yml` starts `postgres:17` and runs lint, typecheck, test, `db:migrate`, and `test:corpus`. Database test files run one at a time (see M1-NOTES.md, sharp edge). Results are on the Actions tab.
- **What does not exist:** Sign in with GitHub and user-authored PRs (all PRs are App-authored), an HTTP API for drafts, the editor (`apps/editor`), the conflict-resolution view. Viewers are refused at propose; other routes that will need the role check arrive with the editor. A propose against GitHub (not a local remote) has not been run. The Git Database API fallback for signed-commit rulesets is unverified on `oxybook-test`. `pnpm test:integration` and `pnpm test:e2e` do not exist. The supported Node is 24; the owner's machine runs 22.23.1 with an engine warning.

## Handoff

For the next session, human or agent.

- **Resume here:**
  1. **Live propose on `oxybook-test`:** after `git pull && pnpm install` and a `pnpm dev` restart:
     - `pnpm oxybook-admin draft save cris/test docs/test-page.md --user <your email> --file <local file>`
     - `pnpm oxybook-admin draft show cris/test --user <your email>`
     - `pnpm oxybook-admin draft propose cris/test --user <your email> --title "..."`

     Expect a PR from `oxybook-cris[bot]` whose diff is only that file. Merging it should mark the draft `merged` and rebuild the site.
  2. **M2 slice 3b:** Sign in with GitHub (OAuth with the App's client id and secret, already stored in `github_app`), account linking, and user-authored PRs when the user's token has write access.
- **Owner's live setup:** App `oxybook-cris` (App id 5535294, installation 176737174 on `crisprintsstuff/oxybook-test`), space `cris/test` (content root `docs`, ref `main`), `.env` holding `OXYBOOK_SECRET_KEY`, `OXYBOOK_PUBLIC_URL=https://oxybook.boznetwork.com`, `PORT=3100`, `HEALTH_PORT=3101`, `CADDY_PORT=8180`, `OXYBOOK_SITES_VOLUME=./.oxybook-sites`, and `DATABASE_URL`. Compose `postgres` and `caddy` are running (`http://test.docs.localhost:8180/`).
- **After every pull:** `git pull && pnpm install`, then restart `pnpm dev` (LIVE-INSTALL.md). Pulled code does not reload on its own.
- **Working conventions in this repo:** a branch, then a PR; CI must be green on both the push and the pull_request run before merging. A dated changelog entry goes below for anything measured; write "unverified" when it was not run.

## Milestones

From `docs/MVP.md`. "In progress" means some of the milestone's work is in the tree and the exit criterion is not met.

| Milestone | Status |
| --- | --- |
| M0 — Foundations and risk spikes | complete |
| M1 — Read path and published site | complete |
| M2 — Editor and write path | in progress |
| M3 — Conflicts, versions, renames | not started |
| M4 — Production readiness, v1.0 | not started |

## M0 exit, met

`docs/MVP.md` says M0 is done when corpus identity is 100% on parseable files and runs in CI; the CLI opens a real PR against a test repo whose diff contains only the intended change; a written note records the signed-commit ruleset behaviour (ARCHITECTURE §4.3).

1. **Corpus identity in CI.** Met. `.github/workflows/ci.yml` runs `pnpm test:corpus`. The measured result recorded above is 594 pass, 0 fail, 1 unparseable.
2. **Real pull request.** Met. [oxybook-test#1](https://github.com/crisprintsstuff/oxybook-test/pull/1). `GET /repos/crisprintsstuff/oxybook-test/pulls/1/files` returned exactly one entry, `docs/test-page.md`, added, +3/-0.
3. **Written note.** Met. `docs/M0-GITHUB-SPIKE.md` records the signed-commit behaviour.

Still unverified. These are not the exit sentence, and they are not done:

- **Manifest-created App.** Verified 2026-10-30: `oxybook-cris` was created from `/setup/github`, stored, installed on `oxybook-test`, and opened [oxybook-test#2](https://github.com/crisprintsstuff/oxybook-test/pull/2).
- **Webhook delivery** from GitHub to `/api/github/webhooks`. Verified 2026-10-30 for `ping`, `installation`, `push`, and `pull_request` through the owner's Cloudflare tunnel. A verified `push` to a space's default branch queues `sync`, which chains `build` (M1).
- **Git Database API fallback** on a repo whose ruleset requires signed commits. Unverified on `oxybook-test`. That repo has no ruleset. The earlier measurement was on this repo. See `docs/M0-GITHUB-SPIKE.md`.
- **Database schema v0 and migrations** (Kysely + SQL migrations). Done 2026-10-30 in `packages/db`, measured on a local PostgreSQL 16 and the compose `postgres:17` image. CI runs the tests against a `postgres:17` service. The rebuilt image migrates an empty database at start and also starts against an already-migrated one.
- **OAuth callback path.** Closed 2026-10-30: `/api/github/oauth/callback` answers 501 `Sign in with GitHub is not implemented yet`. Sign in with GitHub is M2.
- **Installation id.** Closed 2026-10-30: `GITHUB_APP_INSTALLATION_ID`, read by the CLI. The flag wins.
- **`pnpm test:integration` and `pnpm test:e2e`.** Not implemented.
- **Editor.** Not started (`packages/renderer`, `packages/theme-default`, and static site build/serve are done; `apps/editor` is M2).

## M1 exit, met

`docs/MVP.md` says M1 is done when connecting a test repo yields a published site with working nav and search; a push to the default branch (including a rename and a delete) is reflected on the site with no manual step; a dropped webhook is caught by reconciliation; stopping `app` does not take the published site down. Verified both live across [oxybook-test#3](https://github.com/crisprintsstuff/oxybook-test/pull/3), [oxybook-test#4](https://github.com/crisprintsstuff/oxybook-test/pull/4), and [oxybook-test#5](https://github.com/crisprintsstuff/oxybook-test/pull/5) and reproducibly via `pnpm m1:exit` (`apps/server/src/m1-exit.ts`):

1. **Connecting a test repo yields a published site with working nav and search.** Met. Signing up (`/signup` / `/api/auth/signup`), creating an org, and connecting `crisprintsstuff/oxybook-test` (`content_root=docs`, `default_ref=main`) passes the §4.1 installation access check (`oxybook-cris`, installation `176737174`), syncs the initial tree (`9f6835d1283b8ac01c0603767198e9632754c4fd`, 11 pages), and builds the static site (`98992de4-b38b-42ce-9585-0ba29fa6416f`, 10 non-hidden pages indexed in Pagefind) with `@oxybook/theme-default` (`_dir.yml` sidebar ordering, `<Tabs>` island hydration, and `/pagefind/pagefind-entry.json`).
2. **A push to the default branch (including a rename and a delete) is reflected on the site with no manual step.** Met. Pushing `b604ea37c22c933f3f4dcf19be2d0e8c1ff34320` ([oxybook-test#4](https://github.com/crisprintsstuff/oxybook-test/pull/4)) and delivering the signed `push` webhook triggers `sync` (`+1 ~3 -2 renamed 1 unchanged 6`) and chains `build` (`49ab9851-1bc1-44a8-80b4-057ba8780158`, 10 pages, 9 indexed) with no manual command: `/getting-started` updates, `/reference/commands` is live, `/reference/cli` serves a static redirect to `/reference/commands` (`inferred_redirects`), and deleted `/placeholder` returns HTTP 404.
3. **A dropped webhook is caught by reconciliation.** Met. Advancing `main` to `b8058130b7d5a9da6dc0646bf29e15fce32b3d58` ([oxybook-test#5](https://github.com/crisprintsstuff/oxybook-test/pull/5)) without a webhook is detected by `reconcile` (`stored b604ea37c22c, remote b8058130b7d5`), which queues `sync` (`+0 ~1 -0`) and chains `build` (`e72b3fcf-25a8-41e2-82d1-f2e5d3a95fc9`, 9 of 10 pages cached), updating `/test-page` on the published site.
4. **Stopping `app` does not take the published site down.** Met. With `app` and `worker` stopped (`ECONNREFUSED` on `app`'s `/healthz`), Caddy (`Server: Caddy` on port `8180`) continues serving `/`, `/getting-started`, `/guides/configure`, `/reference/commands`, `/reference/cli` (redirect), `/test-page`, `/guides/images/stack.svg`, `/pagefind/pagefind-entry.json` (all `200`), and `/placeholder` (`404`) on `http://test.docs.localhost:8180`.

## M2 next

In progress. `docs/M2-PLAN.md` puts the scope below in order. Slice 1 (`packages/doc-model` editor document model and dirty-block bridge) is done. Slice 2 (drafts, `If-Match` concurrency, diff preview, multi-file commits, and 3-way rebase) is done. Next is slice 3. Scope from `docs/MVP.md`:

- Editor SPA (`apps/editor`): page tree, TipTap editor for the ARCHITECTURE §3.2 constructs, raw block/inline NodeViews, source mode (CodeMirror 6), metadata panel, image upload, link picker inserting relative paths, in-editor preview through the renderer. *Editor document schema, raw nodes, and metadata panel model are in `packages/doc-model` (slice 1); the browser SPA is slice 4.*
- Dirty-block tracking via step maps; serializer integration. *Done in `packages/doc-model` (`editor-doc.ts`, slice 1).*
- Drafts with autosave and optimistic concurrency; diff preview; propose / update PR; app-authored vs user-authored PRs; DCO trailer option; path and branch guards in the worker. *Drafts, autosave concurrency, diff preview, the DCO option, and path guards are done (slice 2). Propose/update PR and app- vs user-authored PRs are slice 3.*
- Editor and Viewer roles; Sign in with GitHub. *Slice 3.*
- Clean-merge handling when the base moved; conflicting drafts routed to GitHub/source mode. *Done (slice 2): `rebaseDrafts` runs after every sync that moves the head; the conflict view is slice 4.*

**Done when:** an end-to-end test edits one paragraph in an `.mdx` page containing JSX components, raw HTML and unusual frontmatter, and the resulting PR diff touches only that paragraph's lines; a non-GitHub user can propose a change that a GitHub user then merges, and the site updates.

## Changelog

### 2026-10-31 — M2 slice 3a: propose job, pull_request webhooks, editor/viewer on propose

Agent session. Base was `main` at `05987d5` (#25). Node v22.22.0, local PostgreSQL 16.

- **`packages/git-write`.** `commitFiles` takes the new commit's parents (the tree is still base plus changes). `mergeCommits` makes a merge commit with `git merge-tree --write-tree`, and on exit 1 reports the conflicted paths without committing the tree it printed.
- **`packages/sync`.** `pushBranch` pushes only `oxybook/<user>/<slug>` branches, always with `--force-with-lease=<ref>:<expected>`, with the token in `GIT_CONFIG_*`. A refused lease is `LeaseRejected`. `spaceGit` gives the write path a space's mirror, fetch, remote head, push, and blobs.
- **`packages/drafts`.**
  - `proposeDraft` implements the four push modes (new, append, rebuild, merge); see Current state.
  - Also: `applyPullRequestEvent`, `spaceRoleOf`, `assertCanPropose`, `draftBranch`, and `findOpenDraft`.
  - Migration `0005_propose` adds the pushed-commit columns and `propose_error`.
- **Worker.** A `propose` queue (stately, one per draft, 3 retries). User mistakes (400, 403, 409, guards) go to `propose_error` without a retry. A moved base or branch is retried.
- **App.** `pull_request` deliveries for `oxybook/*` branches: `closed` with `merged`, `closed`, or `reopened` moves the matching draft. Everything else is ignored.
- **CLI.** `oxybook-admin draft save|show|propose`.

Measured: `pnpm lint`, `pnpm typecheck`, and `pnpm test` exited 0, with 139 tests (127 before). New tests:
- **Propose against a local bare remote with PostgreSQL, 8 cases:**
  - branch naming;
  - viewer and non-author refused;
  - the first propose pushes a branch whose diff against `main` is only the drafted file, with the noreply author and the DCO trailer, and opens one PR;
  - a follow-up appends a commit on the first, and a repeat is `unchanged`;
  - after an upstream push to another file, the branch is rebuilt on the new `main`;
  - after a developer pushes to the PR branch, a merge commit keeps their commit as the first parent and the file holds both edits;
  - a same-paragraph developer push gives `conflicted` with nothing pushed;
  - PR events: another PR number is ignored, closed, then reopened, then merged, after which the next edit opens a new draft.
- **Merge commits (git-write):** clean and conflicting.
- **App webhooks:** a `pull_request` closed/reopened/merged sequence, a non-OxyBook branch ignored, and a duplicate delivery ignored.
- **Worker end to end:** an editor's draft goes through the `propose` job to a pushed `oxybook/eda-editor/index-…` branch with only `docs/index.md` changed, and a recorded `POST /repos/acme/docs/pulls`.

Not measured: a propose against real GitHub (the owner's run is in Handoff), Sign in with GitHub, user-authored PRs.

Corrected: Current state said organisations have `owner`/`admin`/`member` roles. `0001_schema_v0` allows only `owner` and `member`.

### 2026-10-31 — M2 slice 2: drafts, If-Match concurrency, diff preview, multi-file commits, 3-way rebase

Agent session. Base was `main` at `f2cfaf2`. Node v22.22.0, local PostgreSQL 16.

- **CI gap closed (#24).** `pnpm test:corpus` runs every corpus and fixture file through the editor bridge: 594 visual and byte-identical, 1 source-only. A deliberately broken serializer made it fail on Docusaurus pages that the 28-fixture test never sees.
- **`packages/git-write`.**
  - `commitFiles` builds one commit from several file operations with a temporary index on a bare mirror. Removals use `update-index --index-info` mode 0, because `--force-remove` needs a work tree. It enforces guards, keeps an existing executable bit, adds a DCO trailer only when asked, and reports both sides of a rename as touched.
  - `mergeFile3` wraps `git merge-file` and reports clean, content conflict, or binary conflict.
  - Fixed in passing: `assertAllowedPath` refused every path for a space whose content root is the repository root. Root spaces can now write their pages, and hidden paths (`.github/workflows`, `.git`, `.env`) are refused for every space.
  - The unused `oxybook-dev` bin pointing at an unbuilt `dist/` is removed, so depending on git-write adds no `pnpm install` warnings.
- **`packages/drafts` (new, AGPL).**
  - Services: `openDraft`, `saveDraftFile`/`removeDraftFile`/`discardDraft` (all `If-Match`), `listDraftFiles`, `openDraftsTouching`, `draftDiff` (the `diff` package, 9.0.0), and `rebaseDrafts`.
  - `openDraft`'s `ON CONFLICT` names `drafts_one_open`'s predicate literally, so two tabs opening at once get one draft.
- **Worker.** After a sync that moves the head, open drafts on that space and ref are rebased through a mirror-backed `BlobSource` (`spaceBlobSource` in `packages/sync`). It retries up to 3 times when a save races it, and logs `draft <id> rebased|conflicted onto <head>`.

Measured: `pnpm lint`, `pnpm typecheck`, and `pnpm test` exited 0, with 127 tests (112 before). New tests:
- `packages/git-write`: one commit with add, modify, delete, rename, and an executable file, checked against `ls-tree`; DCO trailer on request; 12 guard cases, including a root content root and workflow files.
- `mergeFile3`: clean, conflict with markers, and binary.
- `packages/drafts` (PostgreSQL):
  - one draft per user, space, and ref, including two concurrent opens;
  - a stale save refused with 409 and no change;
  - input validation that does not bump the version;
  - an image upload; discard is final;
  - "touching this page" covers the old path of a rename;
  - the unified diff for modify, add, delete, and binary;
  - rebase: a clean merge, an untouched upstream file, a change that already landed (dropped), and same-paragraph and deleted-upstream conflicts (draft left as it was);
  - a save injected mid-rebase survives, and the rebase retries.
- `apps/worker`, against a real git remote: a draft edits paragraph 1, a push edits paragraph 3, and the sync job leaves the draft holding both edits at the new head with the new base blob.

Not done in this slice: the HTTP endpoints the editor will call (slice 4), pushing a draft's commit and opening a PR (slice 3), and the conflict-resolution view (slice 4).

### 2026-10-31 — Independent check of M1 slices 5–9 and M2 slice 1

Run in an agent session, not on the owner's machine. `main` at `feef209` (M2 slice 1). Node v22.22.0, local PostgreSQL 16.

- CI `check` was green on all six commits from `a8d4cee` (renderer v0) through `feef209`.
- `pnpm install --frozen-lockfile`, `pnpm lint`, and `pnpm typecheck` exited 0. `pnpm test` exited 0 with 112 tests in 11 suites, matching the M2 slice 1 entry.
- `pnpm test:corpus`: identity 594 pass, 0 fail, 1 unparseable (fixtures 27/28, docusaurus 89, starlight 338, vitepress 36, mkdocs 19, mkdocs-material 85). The corpus render summary was `starting clean=286/567, M1 clean=352/567, M1+code-group clean=353/567`, matching `docs/M1-NOTES.md`.
- The M2 slice 1 claim that the editor bridge round-trips the whole corpus was re-measured with a throwaway script (not committed): `openEditorDocument` then `serializeEditorState` on every file under `corpus/fixtures` and the five pinned corpus trees gave 594 byte-identical, 0 different, and 1 `source-only` (`unterminated.mdx`, `unparseable`). That matches the claim.
- Gap: CI does not run that check. `packages/doc-model/test/editor-doc.test.ts` covers the 28 committed fixtures, and `pnpm test:corpus` checks `parse`/`serialize` identity and rendering, not the editor bridge. A bridge regression that only shows on corpus files would pass CI.
- Corrected one stale line under "M0 exit, met". Webhook delivery said "Nothing acts on a delivery yet". A verified push now queues sync and build.

Not re-run here: anything on the owner's machine (the M1 exit run, Caddy serving `test.docs.localhost:8180`, the live webhooks).

### 2026-10-30 — M2 slice 1: editor document model and dirty-block bridge (`packages/doc-model`)

Base was `main` at `5cae0d84f7b78dfd89f361d07ebdb7628f316faa` (CI run `41012269453` green).

- **`packages/doc-model/src/editor-doc.ts` and `packages/doc-model/src/frontmatter.ts`.**
  - `openEditorDocument`: runs `parse` and the mandatory load-time identity check (`serialize(parse(src)) === src`, ARCHITECTURE §3.4) with SHA-256 `fileHash`. Unparseable or identity-failing files return `{ mode: 'source-only', reason, detail, source, fileHash }`; valid files return `{ mode: 'visual', state, frontmatter, fileHash }`.
  - `sourceDocToEditorState` and `serializeEditorState`: maps top-level `SourceDoc` blocks to ProseMirror/TipTap block nodes (`paragraph`, `heading` with ATX/setext preservation, `code_block` fenced/indented, `blockquote`, `alert` for GitHub `> [!NOTE]` alerts, `callout` for `:::name Title` containers keeping exact marker lines, `bullet_list`, `ordered_list`, `task_list`, `table`, `horizontal_rule`, and atomic `raw_block`) and inline nodes (`text` with `strong`/`em`/`strike`/`code`/`link` marks preserving `referenceType`/`identifier`, `hard_break` preserving `\\` vs two-space breaks, `image`, and atomic `raw_inline`), backed by `sideTable` (`srcId` → `{ source, gapBefore, initialNodeJson, originalBlock }`).
  - `markBlocksDirtyFromPmSteps`, `markBlocksDirtyByRange`, `updateEditorBlock`, `moveEditorBlock`, `deleteEditorBlock`, and `insertEditorBlock`: tracks dirty blocks from ProseMirror step map ranges or block edits. Unedited blocks (including moved blocks whose `srcId` travels with the node) emit `gapBefore + source` verbatim; dirty blocks re-serialize using the file's `StyleProfile` while emitting nested `raw_block` and `raw_inline` `attrs.source` verbatim.
  - `inspectFrontmatter` and `updateFrontmatterField` / `updateEditorFrontmatter`: extracts known keys (`title`, `description`, `slug`, `nav_title`, `hidden`) and read-only `unknownKeys` for the metadata panel (ARCHITECTURE §2.4). Updating an existing scalar splices only that scalar's byte range (even when unrelated flow collections like `[1, 2, 3]` exist in the YAML); adding a new known key inserts it before the closing `---` without modifying existing lines or comments.
- **Plan (`docs/M2-PLAN.md`).** Orders M2 into 5 slices (editor document bridge, drafts + 3-way merge, propose worker + `pull_request` webhooks + Sign in with GitHub + roles, Editor SPA, and `pnpm m2:exit`).

Measured on the owner's machine (Node v22.23.1):
- `openEditorDocument` + `serializeEditorState` round-tripped all 27 parseable adversarial fixtures and all 567 cached corpus files (594/594) with 100% byte-for-byte identity, and routed `unterminated.mdx` to `source-only` mode.
- Editing one paragraph in an `.mdx` file containing YAML comments/anchors/unknown keys, `import` statements, `<Tabs>`/`<TabItem>`, `{/* MDX comments */}`, raw HTML `<div className="legacy-banner">`, inline `<Badge variant="tip">v1</Badge>`, `:::tip Custom Callout Title`, and reference links changed only line 28 (within the edited paragraph's original byte range).
- `pnpm lint`, `pnpm typecheck`, `pnpm build`, and `pnpm test` exited 0 (36 tests in `packages/doc-model`, 112 tests total across the workspace).

### 2026-10-30 — M1 slice 9: M1 exit run (`pnpm m1:exit`); M1 complete

Base was `main` at `a965c7c619eaa2e3a27ad27c47ed32d68c476e1c` (CI run `41002333583` green).

- **`apps/server/src/m1-exit.ts`, `oxybook-admin m1-exit`, and `pnpm m1:exit`.**
  - Automated end-to-end verification script for the M1 exit sentence in `docs/MVP.md` and `docs/M1-PLAN.md` slice 9.
  - Mints a live installation token from the stored GitHub App (`oxybook-cris`, App ID `5535294`, installation `176737174`), clones `crisprintsstuff/oxybook-test` into a staging bare repository, creates a throwaway PostgreSQL schema (`oxybook_m1_exit_<id>`), starts `app` and `worker` (`sync`, `build`, `reconcile`), and runs the four exit steps against `.oxybook-sites` and the live Caddy container (`CADDY_PORT=8180`), cleaning up the temporary schema, site directories, and staging repo in `finally`.

Measured on the owner's machine (Node v22.23.1, Compose `postgres` and `caddy`, `pnpm m1:exit` in 5.25s from `04:37:20.466Z` to `04:37:25.720Z`):
1. **Step 1 (Connect repo → published site with nav & search):** Signed up via `POST /api/auth/signup` (`201`), created org `m1-exit-org` (`201`), and connected `crisprintsstuff/oxybook-test` (`POST /api/orgs/m1-exit-org/spaces`, `201`, space `97b230c0-91c1-4c67-ae51-17ff86ad19b5`). Worker ran `sync` at `9f6835d1283b8ac01c0603767198e9632754c4fd` (`+11 ~0 -0`) and `build` (`98992de4-b38b-42ce-9585-0ba29fa6416f`: 11 pages, 1 asset, 0 redirects, 10 indexed in Pagefind, 3 warnings). Verified through Caddy (`http://m1-exit-site.docs.localhost:8180/`): `200 OK` (`Server: Caddy`), `_dir.yml` sidebar ordering (`Start here` → `Guides` → `Reference`, `Internal notes` hidden from sidebar), `/reference/cli` (`200`), `/placeholder` (`200`), and `/pagefind/pagefind-entry.json` (`200`, `page_count: 10`).
2. **Step 2 (Push with edit, rename, and delete → reflected with no manual step):** Advanced `main` to `b604ea37c22c933f3f4dcf19be2d0e8c1ff34320` ([oxybook-test#4](https://github.com/crisprintsstuff/oxybook-test/pull/4)) and delivered signed `push` webhook `m1-exit-push-efca728fc642299d` to `POST /api/github/webhooks` (`204`). With no manual step, worker ran `sync` (`9f6835d1283b..b604ea37c22c: +1 ~3 -2 renamed 1 unchanged 6`) and `build` (`49ab9851-1bc1-44a8-80b4-057ba8780158`: 10 pages, 1 asset, 1 redirect, 9 indexed). Verified through Caddy: `/getting-started` contained the edited text (`It takes about five minutes.`), `/reference/commands` returned `200`, `/reference/cli` served the static redirect to `/reference/commands`, `/placeholder` returned `404`, and `/pagefind/pagefind-entry.json` reported `page_count: 9`.
3. **Step 3 (Dropped webhook → caught by reconciliation):** Advanced `main` to `b8058130b7d5a9da6dc0646bf29e15fce32b3d58` ([oxybook-test#5](https://github.com/crisprintsstuff/oxybook-test/pull/5)) without a webhook and triggered `reconcile`. Worker logged `stored=b604ea37c22c remote=b8058130b7d5 -> sync cf3c2b47-d034-4141-8dda-2ed404c54629`, synced `+0 ~1 -0`, and built `e72b3fcf-25a8-41e2-82d1-f2e5d3a95fc9` (`10 pages (9 cached), 1 assets, 1 redirects, 9 indexed`). Verified through Caddy: `/test-page` returned `200` with `This line arrived without a webhook; reconciliation should pick it up.`
4. **Step 4 (Stopping `app` does not take the published site down):** Closed `app` and `worker`, verified `fetch` to `app`'s `/healthz` threw `ECONNREFUSED`, and verified Caddy (`Server: Caddy`) served all 9 routes (`/`, `/getting-started`, `/guides/configure`, `/reference/commands`, `/reference/cli`, `/test-page`, `/guides/images/stack.svg`, `/pagefind/pagefind-entry.json` → `200`, `/placeholder` → `404`) on both `http://m1-exit-site.docs.localhost:8180` and `http://test.docs.localhost:8180`.

### 2026-10-30 — M1 slice 8: accounts and install in the UI (`apps/server`, `packages/github`)

Base was `main` at `4ec4769b5a865ef15bb144f18465e48cfb4e8625` (CI run `41000508791` green).

- **GitHub access checks and repository discovery (`packages/github`).**
  - `checkUserRepoAccess` (`installations.ts`): calls `GET /repos/{owner}/{repo}` with a user GitHub token and verifies `permissions.admin || permissions.maintain || permissions.push` (ARCHITECTURE §4.1).
  - `checkInstallationRepoAccess` (`installations.ts`): calls `GET /repos/{owner}/{repo}` with an installation token to verify repository read access and return `default_branch`.
  - `listInstalledRepositories` (`installations.ts`): lists all installations for the stored GitHub App (`GET /app/installations`) and all repositories accessible to each installation (`GET /installation/repositories`) so the UI can populate a one-click repository selector.
- **Accounts, Argon2id, sessions, and CSRF (`apps/server/src/auth.ts`).**
  - `hashPassword` / `verifyPassword`: Argon2id password hashing via `@node-rs/argon2` (`memoryCost: 19456`, `timeCost: 2`, `parallelism: 1`).
  - `createSession` / `loadSessionUser` / `deleteSession`: generates a 256-bit random session token, stores only its SHA-256 digest (`bytea`) in `sessions.token_hash`, sets `HttpOnly; SameSite=Lax` cookie `oxybook_session`, and cleans up expired sessions on access.
  - `deriveCsrfToken` / `verifyCsrfToken`: HMAC-SHA256 CSRF token bound to the session token and `OXYBOOK_SECRET_KEY`, verified with `timingSafeEqual` on HTML form submissions (`_csrf` field or `x-csrf-token` header).
  - `signUpUser` / `authenticateUser`: email normalization, password length check (≥ 8 chars), duplicate-email rejection (`409`), and first-user bootstrap (when the first user signs up on an instance that already has memberless CLI orgs/spaces, they are attached as `owner` of those orgs and `admin` of those spaces).
- **Role-checked org/space setup and UI routes (`apps/server/src/admin.ts`, `apps/server/src/ui-routes.ts`, `apps/server/src/main.ts`).**
  - `createOrgForUser`, `listUserOrgs`, `getUserOrgRole`, `getUserSpaceRole`, `createSpaceForUser`, `listUserSpaces`, `getSpaceDetails`, `setSpaceMemberRole` (ensuring the parent `org_members` row exists before upserting `space_members`), `verifyRepoConnection`, and `listAvailableAppRepos`.
  - HTML and JSON routes on the app server: `/signup`, `/login`, `/logout`, `/api/auth/signup`, `/api/auth/login`, `/api/auth/logout`, `/api/auth/me`, `/` (dashboard with GitHub App status & `/setup/github` or install link, organisations list & create form, discovered repository picker + space creation & repo connection form, spaces list with sync/build status and published site links), `/orgs`, `/api/orgs`, `/spaces`, `/orgs/:org/spaces`, `/api/orgs/:org/spaces`, `/orgs/:org/spaces/:space`, `/api/orgs/:org/spaces/:space`, `/orgs/:org/spaces/:space/sync`, and `/orgs/:org/spaces/:space/members`.

Measured on the owner's machine (Node v22.23.1, Compose `postgres` and `caddy`):
- `pnpm lint`, `pnpm typecheck`, `pnpm build`, and `pnpm test` (with `.env` `DATABASE_URL`) exited 0: 107 unit and integration tests passing across all 11 workspace packages (including new `installations.test.ts` cases in `packages/github` and `auth-ui.test.ts` in `apps/server`).
- Live end-to-end verification against stored App `oxybook-cris` (`5535294`), real GitHub (`crisprintsstuff/oxybook-test`), and Caddy (`CADDY_PORT=8180`):
  1. Signed up `cris@boznetwork.com` via `POST /signup` (`303` → `/`, `oxybook_session` cookie set; adopted existing CLI org `cris` as `owner` and space `cris/test` as `admin`).
  2. Loaded `GET /`, which queried real GitHub as `oxybook-cris` and rendered `<option value="crisprintsstuff/oxybook-test|main">crisprintsstuff/oxybook-test (default branch: main)</option>` in the discovered repositories selector.
  3. Submitted `POST /spaces` (`org_slug=cris`, `slug=ui-test`, `repo=crisprintsstuff/oxybook-test`, `content_root=docs`, `default_ref=main`, `sync_now=true`), which verified installation `176737174` on real GitHub, created space `cris/ui-test`, synced 10 pages at `b8058130b7d5`, built the site (`9 indexed, 3 warnings -> ui-test.docs.localhost`), and redirected (`303`) to `/orgs/cris/spaces/ui-test`.
  4. Stopped the app server and fetched `http://ui-test.docs.localhost:8180/` (`200 OK`, `Server: Caddy`) and `http://ui-test.docs.localhost:8180/pagefind/pagefind-entry.json` (`200 OK`, `"page_count":9`) through Caddy. Cleaned up the temporary `ui-test` space and test user afterwards.

### 2026-10-30 — M1 slice 7: default theme v0 (`packages/theme-default`, Apache-2.0)

Base was `main` at `58935a10bbb4526a540cb0ff0f50f38ad46fce6e` (CI run `40998945491` green).

- **`packages/theme-default` (Apache-2.0).**
  - Standalone default theme package under `Apache-2.0` (`LICENSING.md`), with zero runtime dependencies on AGPL packages.
  - `renderPageDocument`, `render404Document`, `renderRedirectDocument`, `flattenNavPages`, `findPrevNextPages`, and `buildThemeStyles`: renders the 3-column documentation layout (sticky header with site title/logo, version switcher `[data-version-switcher]`, header links, and mobile menu toggle; collapsible left sidebar with Pagefind `#oxybook-search`, `_dir.yml` tree navigation, `data-active-branch="true"`, and `aria-current="page"`; `<main class="oxybook-content" data-pagefind-body>` with automatic `<h1>` synthesis when missing, previous/next page links in reading order, and optional footer; right-hand "On this page" table of contents for `h2`/`h3` headings).
  - Supports `theme:` in `oxybook.yml` (`logo`, `favicon`, `accentColor` with CSS-injection sanitization, `headerLinks`, `footer`, `customCssUrl`), parsed in `@oxybook/renderer` (`parseOxybookConfig`).
  - `buildThemeClientScript`: client-side island script that hydrates `<Tabs>`/`<TabItem>` (tab switching, keyboard arrow navigation, and `data-tabs-group` + `localStorage` synchronization across tab groups), hydrates `::: code-group` / `<CodeGroup>` (`div.oxybook-code-group`) with a generated tab list from child `<pre>` `data-title`/`data-language` attributes, wires the mobile sidebar toggle and `Escape` handler, wires the version switcher `<select>`, and initializes `window.PagefindUI` with `/` and `Ctrl+K`/`Cmd+K` search focus shortcuts.
- **Renderer and workspace integration (`packages/renderer`, `package.json`, `Dockerfile`).** `@oxybook/renderer` (`template.ts`, `build.ts`) delegates HTML document generation to `@oxybook/theme-default` and passes `config.theme` and version links when multiple versions are configured.

Measured on the owner's machine (Node v22.23.1, Compose `postgres` and `caddy`):
- `pnpm lint`, `pnpm typecheck`, `pnpm build`, and `pnpm test` (with `.env` `DATABASE_URL`) exited 0: 102 unit, DOM/island (`node:vm`), and integration tests passing across all 11 workspace packages (6 new in `packages/theme-default/test/theme.test.ts`).
- `pnpm oxybook-admin build cris/test --now` rebuilt `cris/test` at `b8058130b7d5` (`build 33216f01-3c86-4b1a-95ad-cc592e8b2d46`): 10 pages, 1 asset, 1 redirect, 9 indexed pages (`en_80f225fff4`), 3 warnings.
- Verified live through Caddy (`http://test.docs.localhost:8180/guides/configure` with `app` stopped): serves `.oxybook-header`, `.oxybook-sidebar` with `data-active-branch="true"` on `Guides` and `aria-current="page"` on `Configure`, `<div class="oxybook-tabs">` + client island script, `.oxybook-pager` (`Previous: Install` → `/guides/install`, `Next: CLI` → `/reference/commands`), and `/pagefind/pagefind-entry.json` (`"page_count":9`).

### 2026-10-30 — M1 slice 6: build and serve

Base was `main` at `a8d4ceeaa9deec506d89b2f1e2cd72ce3b308bd2` (CI run `40996102332` green).

- **Migration `0004_builds.sql` (`packages/db`).** Adds `builds(id, org_id, space_id, version, ref, commit_sha, status, warning_count, log, created_at, finished_at)`.
- **Jobs (`packages/jobs`).** Adds the `build` queue (`stately`, singletonKey `<space>:<version>`, 2 retries with backoff) and `buildKey`.
- **Navigation, template, Pagefind, and build assembly (`packages/renderer`).**
  - `parseDirConfig` and `buildNavTree` (`nav.ts`): parses `_dir.yml` (`title`, `order`), orders directory entries (files without extension and subdirectories) per `order:` followed by unlisted items sorted alphabetically by title, uses `nav_title` when set, attaches `index.md`/`index.mdx`/`README.md` as the directory's own URL, and omits `hidden: true` pages from the sidebar while still building them at their URL.
  - `isExcluded` (`config.ts`, `packages/sync`): filters pages and assets matching `exclude:` in `oxybook.yml` (exact paths, directory prefixes, and `*`/`**` globs) during both `syncSpace` and `buildSiteVersion`.
  - `renderDocumentHtml`, `render404Html`, and `renderRedirectHtml` (`template.ts`): wraps rendered page bodies in a static HTML document with sidebar navigation (`aria-current="page"`), `<main data-pagefind-body>`, and Pagefind UI hooks; emits `404.html` and static redirect HTML pages (`<meta http-equiv="refresh">` + `<link rel="canonical">` + `location.replace`, without `data-pagefind-body`).
  - `buildSiteVersion` and `runSpaceBuild` (`build.ts`, `runner.ts`): caches rendered page bodies in memory by `(blob_sha, path, config, link targets)`, writes `builds/<space>/<version>/<sha>-<buildId>/`, hardlinks `<dir>.html` to `<dir>/index.html` when `<dir>/` exists on disk, indexes non-hidden pages with `pagefind` (`1.5.2`) into `/pagefind/*`, assembles `spaces/<space>/releases/<sha>-<buildId>/` with `hardlinkTree` (`fs.linkSync`, zero copied bytes), atomically swaps `spaces/<space>/current` (`symlink` + `rename`), maintains relative `by-host/<hostname>` → `../spaces/<space>` symlinks, records status/warnings/log in `builds`, and prunes old builds/releases (default keep 5).
- **Worker and CLI (`apps/worker`, `apps/server`).** Completing a `sync` job in the worker automatically queues a `build` job. `pnpm oxybook-admin build <org>/<space> [--now]` queues or runs a build directly. Default `.oxybook-mirrors` and `.oxybook-sites` paths resolve relative to the repo root so `pnpm dev` and `oxybook-admin` share the same directories.
- **Compose (`docker-compose.yml`, `.env.example`).** Parameterizes `OXYBOOK_SITES_VOLUME` (`.env` sets `./.oxybook-sites` so host builds are served by the compose `caddy` container) and `CADDY_PORT` (`.env` sets `8180` on the owner's machine because `qBittorrent` holds `8080`).

Measured on the owner's machine (Node v22.23.1, Compose `postgres` and `caddy`):
- `pnpm lint`, `pnpm typecheck`, `pnpm build`, and `pnpm test` (with `.env` `DATABASE_URL`) exited 0: 96 unit and integration tests passing across all workspace packages (including new `build.test.ts` in `packages/renderer`, `exclude:` in `packages/sync`, and `sync` → `build` in `apps/worker`).
- `pnpm db:migrate` applied `0004_builds`.
- `pnpm oxybook-admin build cris/test --now` built commit `b8058130b7d5` (`build 10673acf-ba03-4c1a-9ac5-27d2733cc1ca`): 10 pages rendered, 1 asset (`guides/images/stack.svg`), 1 inferred redirect (`/reference/cli` → `/reference/commands`), 9 non-hidden pages indexed by Pagefind (`en_80f225fff4`), and the 3 expected warnings on `guides/configure.mdx`.
- With `app` and `worker` stopped and only `postgres` and `caddy` running in Docker Compose (`CADDY_PORT=8180`), `curl http://test.docs.localhost:8180/` returned HTTP 200 (`Server: Caddy`) with the rendered home page, sidebar nav ordered per `_dir.yml` (`Start here`, `Guides` → `Install`, `Configure`, `Reference` → `CLI`, `Environment variables`, `Second test page`, `Test page`, with `Internal notes` omitted from the sidebar), and rewritten links.
- All other routes verified through Caddy with `app` stopped: `/getting-started` (200), `/guides` (200), `/guides/` (200), `/guides/install` (200), `/guides/configure` (200), `/reference/commands` (200), `/reference/env` (200), `/reference/internal-notes` (200), `/reference/cli` (200 redirect to `/reference/commands`), `/guides/images/stack.svg` (200), `/pagefind/pagefind-entry.json` (200, `"page_count":9`), and deleted `/placeholder` (404 with custom `Page not found — OxyBook test site`).

### 2026-10-30 — M1 slice 5: renderer v0 (`packages/renderer`)

Base was `main` at `f4140bab9415be286d11f9bd49e2c51304d8dafc` (#22).

- **`packages/renderer` (AGPL-3.0-only).**
  - `renderPage` / `renderPageSync`: parses `.md` and `.mdx` once with `@oxybook/doc-model`, transforms mdast to hast with `mdast-util-to-hast` custom handlers, and serializes to HTML with `hast-util-to-html`. Unparseable files degrade to `<pre class="oxybook-unparseable">` with an `unparseable` warning instead of crashing.
  - **Built-in components and allowlist (`DEFAULT_ALLOWLIST`).** Finalizes the M1 list recommended in `docs/M1-NOTES.md`: `Callout`, `Tabs`, `TabItem`, `Card`, `CodeGroup`, `Aside` (rendered as Callout), `Badge`, `CardGrid`, `Code`, `FileTree`, `Icon`, `LinkButton`, `LinkCard`, `Steps`, and `Fragment`, plus `::: code-group` (`DEFAULT_DIRECTIVES`) and GitHub alerts (`> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`, `> [!CAUTION]`).
  - **Static props and placeholders.** Only static attributes (strings, booleans, and JSON-literal expressions parsed via `JSON.parse`) are accepted. Non-static attributes (`dynamic-props`), unknown JSX components (`unknown-component`), non-comment `{expressions}` (`expression`), ESM `export` statements (`export`), and unknown leaf/container directives (`directive`) render as `<div|span class="oxybook-placeholder">` and emit `file:line` warnings. `{/* comments */}` are dropped; `:name` text directives (`localhost:8000`, `4.5:1`) are printed back as literal source text.
  - **Import mapping (`config.ts`).** `parseOxybookConfig` reads `oxybook.yml` and `resolveImports` statically maps both default imports (`"@theme/Tabs": Tabs`) and named module exports (`"@astrojs/starlight/components": { Aside: Callout, Steps: Steps }`) to built-in components without evaluating ESM.
  - **Relative links and assets (`links.ts`).** `resolvePageLink` and `resolveAssetLink` rewrite relative `.md`/`.mdx` links and image/asset paths to site URLs (respecting `slug:` overrides and optional version prefixes), emit `broken-link` warnings when a page/asset table is supplied and a target is missing, and throw `StrictBuildError` when `strict: true`.
  - **Shiki (`highlight.ts`).** Dual-theme (`github-light`/`github-dark` CSS variables) build-time highlighting for fenced/indented code blocks and `<Code>` components, with a bounded `(lang, code)` hast cache and plain `<pre><code>` fallback for unknown grammars.
  - **Search document (`searchDoc`).** Emits `{ url, title, description, headings, text, version }` with deduplicated heading `id` slugs (ARCHITECTURE §6).
- **Root scripts and image.** `pnpm test:corpus` now runs `@oxybook/renderer`'s corpus test after `@oxybook/doc-model`'s identity harness. `build:libs` and `Dockerfile` build `@oxybook/renderer`.

Measured on the owner's machine (Node v22.23.1, Compose `postgres`):
- `pnpm lint`, `pnpm typecheck`, `pnpm build`, and `pnpm test` (with `.env` `DATABASE_URL`) exited 0: 92 unit tests passing across all packages (8 new in `packages/renderer`).
- Security test inspects `packages/renderer/src/*.ts` for `eval`, `Function`, `node:vm`, and dynamic `import()`, and runs hostile `.mdx` with `globalThis.eval` and `globalThis.Function` poisoned to throw. Zero customer code is evaluated.
- `pnpm --filter @oxybook/renderer run test:corpus` rendered all 567 corpus files and 28 fixtures:
  - With `STARTING_ALLOWLIST` and `allowDirectives: []`, every file's `placeholders` list matched `analyzeSource` from slice 1 identically: 286/567 clean, `unknown-component` 2649, `dynamic-props` 1, `expression` 27, `export` 8, `directive` 9.
  - With `DEFAULT_ALLOWLIST` and `allowDirectives: []`, every file matched `analyzeSource` with `DEFAULT_ALLOWLIST`: 352/567 clean, `unknown-component` 822, `dynamic-props` 33, `expression` 27, `export` 8, `directive` 9.
  - With `DEFAULT_ALLOWLIST` and `DEFAULT_DIRECTIVES` (`['code-group']`), 353/567 (62.3%) rendered with zero placeholders (`directive` placeholders dropped from 9 to 3).
- Against the 10 synced pages of `cris/test` (`b8058130b7d5` in PostgreSQL) with `oxybook-test`'s `oxybook.yml`: 9 of 10 pages rendered with 0 placeholders and 0 broken links, and `/guides/configure` (`guides/configure.mdx`) rendered `<Tabs>`/`<TabItem>`, rewrote `../reference/commands.md` to `/reference/commands`, and reported the 2 planted placeholders (`20:expression:3000`, `22:unknown-component:VersionBadge`) and 1 planted broken link (`26:broken-link:../reference/settings.md`).

### 2026-10-30 — Status consolidated; `.env` loading checked on the owner's machine

After #21, the owner restarted `pnpm dev` with `DATABASE_URL` in `.env`. The log showed `github app 5535294 (oxybook-cris) loaded from the database`, `app listening on 3100`, `worker listening on 3101`, and `jobs: working on ping, sync, reconcile`. In a fresh terminal with nothing exported, `pnpm oxybook-admin pages cris/test` printed `main at b8058130b7d5a9da6dc0646bf29e15fce32b3d58, synced 2026-10-30T02:30:10.646Z` and the 10 expected pages. The sync time is 33 s after #5 merged with the webhook off, which is the reconciliation run.

`## Current state` was rewritten as one snapshot, because the bullets had drifted (old ports, "nothing acts on webhooks", oxybook-test#2 described as open; it is merged). Commit SHAs were moved out of it, as this file's header asks. A `## Handoff` section was added. README.md's status line and quickstart no longer claim an admin account, a space UI, or a published site, and no longer say the app image does not exist. AGENTS.md's summary was brought up to date. No code changed.

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
