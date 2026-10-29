# Status

Future agents: append a dated entry under Changelog when something meaningful lands or a measured fact changes. Do not silently rewrite or delete older entries. Do update the current-state block and the milestone table so they match the latest entry. If you did not run it, write "unverified". Do not invent metrics.

## Current state

- **Milestone:** M0, in progress. Not done.
- **Last update:** 2026-10-29.
- **What works today:** `packages/doc-model` parses `.md` and `.mdx`, keeps original slices, and serializes an unedited file back to the same string. `:::name Title` (and `:::name`, `::: name Title`, `:::name[Title]`) is one callout block, not a run of paragraphs. On 2026-10-29, after that fold, `pnpm test:corpus` reported 594 pass, 0 fail, 1 unparseable (the planted unterminated `.mdx` fixture). App and worker processes answer `GET /healthz` in unit tests. A scratch-repo spike recorded `git merge-file` / `git merge-tree --write-tree` outcomes for concurrent edits.
- **CI:** The first `check` runs failed in a few seconds with zero steps because Actions billing blocked the job (annotation on runs 40835691209 and 40835716025). Those runs were later re-run successfully. `check` on `d9e725c` (run 40836479834) completed green: install, lint, typecheck, test, and corpus.
- **What does not:** There is no editor, renderer, database, GitHub App, or published site. Opening a page, proposing a PR, and serving docs are not implemented. The Docker image has not been built or started (Docker was unavailable; unverified). This is pre-product infrastructure.

## Milestones

From `docs/MVP.md`. "In progress" means some of the milestone's work is in the tree and the exit criterion is not met.

| Milestone | Status |
| --- | --- |
| M0 — Foundations and risk spikes | in progress |
| M1 — Read path and published site | not started |
| M2 — Editor and write path | not started |
| M3 — Conflicts, versions, renames | not started |
| M4 — Production readiness, v1.0 | not started |

## Changelog

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

- **Signed commits on `oxybook/*` (ARCHITECTURE §4.3).** Rulesets that require signed commits may reject unsigned commits pushed by the worker. The suggested fallback is the Git Database API. Unverified. Do not assume either behavior.
- **Which built-in components ship in M1 (MVP.md H3).** Callout, Tabs, Card, and CodeGroup are a starting guess. The real list waits on a compatibility count over the corpus (unknown components, imports, expressions, directives). That count has not been run. Identity passing does not answer it.
- **Material for MkDocs `!!! note` and other pymdown extensions (MVP.md H3).** v1 leaves them as raw blocks. Native support is explicitly post-v1 and depends on the same unrun report.
