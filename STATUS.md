# Status

Future agents: append a dated entry under Changelog when something meaningful lands or a measured fact changes. Do not silently rewrite or delete older entries. Do update the current-state block and the milestone table so they match the latest entry. If you did not run it, write "unverified". Do not invent metrics.

## Current state

- **Milestone:** M0, in progress. Not done.
- **Last update:** 2026-10-29.
- **What works today:** `packages/doc-model` parses `.md` and `.mdx`, keeps original slices, and serializes an unedited file back to the same string. `:::name Title` (and `:::name`, `::: name Title`, `:::name[Title]`) is one callout block, not a run of paragraphs. On 2026-10-29, after that fold, `pnpm test:corpus` reported 594 pass, 0 fail, 1 unparseable (the planted unterminated `.mdx` fixture). App and worker processes answer `GET /healthz` in unit tests. A scratch-repo spike recorded `git merge-file` / `git merge-tree --write-tree` outcomes for concurrent edits.
- **CI:** `main` is `4837c97c7e546e80b31b265d67e24c70ae910939`. Push run [40898410005](https://github.com/crisprintsstuff/OxyBook/actions/runs/40898410005) succeeded. The `check` job ran 2026-10-29T15:07:55Z–15:08:27Z (32s). `.github/workflows/ci.yml` runs `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm test:corpus`. That corpus step fetches the pinned corpus repos, so the job needs network. History, not this head: PR #4 at `b6318ec9` had successful `pull_request` run [40898205659](https://github.com/crisprintsstuff/OxyBook/actions/runs/40898205659) and `push` run [40898195014](https://github.com/crisprintsstuff/OxyBook/actions/runs/40898195014). Earlier still: `99fe76f` push [40836564769](https://github.com/crisprintsstuff/OxyBook/actions/runs/40836564769) (job 07:37:00Z–07:37:31Z, 31s) and pull_request [40836572202](https://github.com/crisprintsstuff/OxyBook/actions/runs/40836572202) (job 07:37:03Z–07:37:29Z, 26s); merge `d942fb2` push [40836670051](https://github.com/crisprintsstuff/OxyBook/actions/runs/40836670051) (job 07:37:57Z–07:38:20Z, 23s).
- **Docker:** `docker compose up -d --build` built `localhost/oxybook:dev` (engine 29.1.3, Compose 2.40.3). postgres, caddy, mailpit, app, and worker all reported healthy. From inside the containers, `GET /healthz` returned 200 `{"ok":true,"service":"app"}` on port 3000 and 200 `{"ok":true,"service":"worker"}` on port 3001. The image's git is 2.39.5. The stack was then removed with `docker compose down --remove-orphans -v`.
- **Git write path:** `oxybook-dev propose` was run against a local `file://` bare remote. The diff touched only `docs/a.md`. A stale `--force-with-lease` was refused. An unsigned `git push` to `ruleset-probe-test` was rejected by ruleset `26114519` (`GH013`, commits must have verified signatures). A fast-forward `PATCH /git/refs/heads/ruleset-probe-test` of a Git Database API commit returned HTTP 200; GitHub had signed that commit (`verification.verified: true`, `reason: "valid"`). The measured head was `c915f0780c13f25cdf01870fcda216b721c576cf`. Details are in `docs/M0-GITHUB-SPIKE.md`.
- **Signed-commit note:** The note `docs/MVP.md` asks for exists: `docs/M0-GITHUB-SPIKE.md`. It concludes that `required_signatures` rejects an unsigned `git push` (`GH013`) and accepts a GitHub-signed Git Database API fast-forward (HTTP 200, `verification.verified: true`, `reason: "valid"`).
- **What does not:** There is no editor, renderer, database, or published site. A GitHub App has not been installed on a real account, and no GitHub pull request has been opened by OxyBook. Probe scaffolding (ruleset `ruleset-probe`, id `26114519`, and branch `ruleset-probe-test`) was removed on 2026-10-29 after the measurement was recorded, the ruleset first and then the branch, because the ruleset's own `deletion` rule blocks removing a matching branch while it is active. Removing them changed nothing about the measurement. See "M0 still open".

## Milestones

From `docs/MVP.md`. "In progress" means some of the milestone's work is in the tree and the exit criterion is not met.

| Milestone | Status |
| --- | --- |
| M0 — Foundations and risk spikes | in progress |
| M1 — Read path and published site | not started |
| M2 — Editor and write path | not started |
| M3 — Conflicts, versions, renames | not started |
| M4 — Production readiness, v1.0 | not started |

## M0 still open

`docs/MVP.md` says M0 is done when corpus identity runs in CI, the CLI opens a real pull request against a test repo whose diff is only the intended change, and a written note records the signed-commit ruleset behaviour. That is the exit sentence. Two of the three are met. The third is not, so M0 stays in progress.

Exit, from that sentence:

1. **Corpus identity in CI.** Met. `.github/workflows/ci.yml` runs `pnpm test:corpus`.
2. **Written note.** Met. `docs/M0-GITHUB-SPIKE.md` records the signed-commit behaviour. See "Signed-commit note" above.
3. **Real pull request.** Not met. This is the remaining M0 exit blocker. `oxybook-dev propose` has pushed to a local `file://` remote. It has not opened a pull request against a test repo.

`docs/MVP.md` also lists M0 work that is not part of that exit sentence. Still open, and not the exit blocker:

1. **Database schema v0 and migrations** (Kysely + SQL migrations, `pnpm db:migrate`). Not started. Unverified.
2. **Live GitHub App.** Manifest JSON and the callback route are unit-tested against a fake `fetch`. A real app was not created (that needs a public callback URL and a human approving the manifest). Webhook delivery from GitHub is unverified. `POST /repos/{owner}/{repo}/pulls` was not called. See `docs/M0-GITHUB-SPIKE.md`.

## Changelog

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
