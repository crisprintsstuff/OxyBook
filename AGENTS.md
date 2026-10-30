# OxyBook — agent orientation

OxyBook is a self-hostable documentation platform. Writers edit markdown and MDX that already live in a customer's git repository; a change leaves as a pull request; a merge publishes a static site.

The non-negotiable invariant: **content lives in the customer's git repository, and the platform never rewrites bytes it was not asked to change.** Everything else in the design can move. This cannot.

## Read this first

1. `README.md` — what the product is and how a local stack is supposed to start.
2. `docs/ARCHITECTURE.md` — the technical design. Read all of it before touching `packages/doc-model` or anything that will become the sync layer.
3. `docs/MVP.md` — v1 scope, the three hard problems (H1 round-trip, H2 conflicts, H3 rendering), and the milestone exits.
4. `docs/M0-NOTES.md` — what the round-trip library actually guarantees, the measured corpus numbers, and where the design docs are wrong or thin.
5. `docs/M0-GITHUB-SPIKE.md` — which GitHub and git-write checks were run for real, and which are still fakes.
6. `STATUS.md` — what is in progress. That file is the status source of truth. Do not duplicate it here.
7. `docs/LIVE-INSTALL.md` — the owner's checklist for a live GitHub App created from `/setup/github`. Run once on 2026-10-30; results are in `STATUS.md`.
8. `docs/M1-PLAN.md` — M1 scope in order. A plan, not a record.
9. `docs/M1-NOTES.md` — M1 measurements: the H3 compatibility report and the component list it recommends.

## Hard constraints

- Never parse `.md` as MDX. `<` and `{` mean different things. Format comes from the filename, not from the contents.
- Never push to a base branch. Writes go to an `oxybook/*` branch and then a pull request. The customer's merge rules decide what lands.
- Never rewrite history on a branch someone else has pushed to. Update it with a merge commit. `--force-with-lease=<ref>:<expected-sha>` on every force update, including the expected sha.
- Never execute customer MDX (`import` / `export`, `{expressions}`, customer components) on the server or at build time.
- Licence follows the path, in `LICENSING.md`. `packages/doc-model`, `apps/server`, and `apps/worker` are AGPL-3.0-only. `deploy/` is Apache-2.0. Every new source file gets the SPDX header for its path. There is no CLA and no paid edition.
- DCO, not a CLA, for human contributors (`git commit -s`, author matches the trailer). Do not add a `Signed-off-by` trailer on someone else's behalf, and do not invent one for an agent commit.

## Where the work stands

M0 is complete. M1 is in progress: the H3 compatibility report (`oxybook-check`, `docs/M1-NOTES.md`) is done, and `crisprintsstuff/oxybook-test` is the M1 test repo. The exit in `docs/MVP.md` is met: corpus identity runs in CI, `docs/M0-GITHUB-SPIKE.md` records the signed-commit behaviour, and [oxybook-test#1](https://github.com/crisprintsstuff/oxybook-test/pull/1) is a real pull request whose diff is only `docs/test-page.md`. That App was created by hand. On 2026-10-30 an App created from `/setup/github` opened [oxybook-test#2](https://github.com/crisprintsstuff/oxybook-test/pull/2), and GitHub's `ping` and `installation` webhooks were verified. A `push` delivery has not been observed. Database schema v0 and `pnpm db:migrate` exist (`packages/db`); nothing reads or writes those tables yet. The editor, the renderer, and a published site do not exist. Read `STATUS.md` before assuming a milestone is done, and update that file when you change what is true.

## Repository layout

```
apps/server            AGPL   HTTP process. /healthz, migrations on start, GitHub manifest flow (App stored encrypted), webhook verify.
apps/worker            AGPL   worker process. M0: GET /healthz only.
packages/doc-model     AGPL   parse, raw slices, serialize, identity check, CLIs (oxybook-roundtrip, oxybook-check).
packages/github         AGPL   App JWT, installation-token cache, webhook HMAC, manifest exchange, open a pull request.
packages/git-write      AGPL   blobless mirror, commit from a temporary index, push to oxybook/*.
packages/db             AGPL   schema v0 as plain SQL migrations, Kysely types and connection, migrator.
corpus/manifest.json          pinned doc repos (SHA + sparse path).
corpus/fixtures               adversarial markdown, committed.
corpus/cache                  fetched repos. Gitignored. Do not commit.
spikes/conflicts              H2 spike: git merge scenarios, recorded bytes, NOTES.md.
deploy/oxybook                Apache  image entrypoint: `oxybook server|worker`.
Dockerfile                    AGPL   multi-stage image the compose file builds.
docs/M0-NOTES.md              measured results and design corrections.
docs/M0-GITHUB-SPIKE.md       what the GitHub spike verified, and what it did not.
```

`packages/renderer`, `packages/sdk`, and `apps/editor` are in the architecture and are not in the tree.

## How to run it

Requirements: Node.js 24, pnpm 10 (the `packageManager` field), git ≥ 2.38. One `oxybook-dev propose` run succeeded on Node v22.23.1 after pnpm printed an Unsupported engine warning. That does not make Node 22 supported.

```sh
pnpm install
pnpm test          # unit tests, property tests, H2 spike; packages/db skips without DATABASE_URL
pnpm db:migrate    # needs DATABASE_URL; forward-only SQL files in packages/db/migrations
pnpm test:corpus   # fetches the pinned repos, then identity-checks every file
pnpm lint
pnpm typecheck
pnpm build
pnpm oxybook-roundtrip <file-or-directory>
pnpm oxybook-check <dir>      # what would render as a placeholder, file:line
pnpm compat:corpus           # the H3 report over corpus/cache; run test:corpus first
pnpm oxybook-dev propose <file> --remote file:///path/to/remote.git
# no leading -- before propose; pnpm forwards it and the parser used to treat "propose" as the file
```

`oxybook-roundtrip` prints `PASS` / `FAIL` / `UNPARSEABLE` / `ERROR` per file. Exit code 1 means an identity failure or a crash. Unparseable is reported and does not fail the command. `pnpm test:corpus` prints a markdown table of every file and fails the test if any parseable file is not identical.

`pnpm dev` starts the app and worker health servers on the host (`PORT` 3000, `HEALTH_PORT` 3001). The app script builds `@oxybook/github` and `@oxybook/db` and then runs `tsx watch`, because `apps/server` imports those packages from `dist` and the source is TypeScript. With `OXYBOOK_MIGRATE_ON_START=true` (compose sets it) the app applies migrations before it listens. `pnpm test:integration` and `pnpm test:e2e` are not scripts in this tree. `docker compose up --build` builds the same image. The measured container result (app and worker `/healthz`) is in `STATUS.md`, not repeated here.

## Conventions

- Commit subject: `<area>: <imperative>`, at most 72 characters. Areas are listed in `CONTRIBUTING.md`. The body says why.
- One logical change per commit. Do not mix a doc-model behavior change with a drive-by reformat of unrelated files.
- Keep `docs/ARCHITECTURE.md` and `docs/MVP.md` accurate when you change a design decision. If you are not allowed to edit them, record the correction in `docs/M0-NOTES.md` and in `STATUS.md`. Do not leave a known lie in the design docs without a pointer.
- New markdown fixtures that depend on exact bytes (CRLF, BOM) need `corpus/fixtures/** -text` in `.gitattributes`, which is already set. Do not "normalize" those files.
- A bug that mangled a file gets a minimal fixture in `corpus/fixtures` before the fix. `pnpm test:corpus` stays at 100% identity on files that parse.

## Sharp edges

From `docs/M0-NOTES.md`. Re-read that file if it has grown since this one.

- Green identity does not mean a construct is editable. JSX, HTML, and unknown directives are raw slices. `:::name Title` is one callout block; nested containers live inside that block, and reformatting a callout is refused so the marker lines stay byte-exact.
- `git merge-tree --write-tree` prints a tree even when it exits 1. On a delete-vs-edit conflict that tree still contains the draft file, with no conflict markers. Do not commit a tree just because an id was printed.
- Do not normalize line endings across a whole file. Original slices must be copied. Mixed LF/CRLF is a tested fixture.
- The README still describes `app` and `worker` as a missing image. Compose builds `Dockerfile`. Whether a given machine has Docker is separate from the measurement recorded in `STATUS.md`.
- M0's exit is met by the pull request in `STATUS.md`. M1 is in progress; do not mark it done until the exit run in `docs/M1-PLAN.md` slice 9 is recorded. Schema v0 exists; never edit a merged migration, add a new file. The signed-commit ruleset question is measured in `docs/M0-GITHUB-SPIKE.md` on this repo, not on `oxybook-test`: an unsigned push is rejected, and the Git Database API fast-forward from an installation token was accepted. `STATUS.md` is the list of what is still unverified.
