<!-- SPDX-License-Identifier: Apache-2.0 -->

# M1 plan

M1 scope and its exit sentence are in [MVP.md](MVP.md). This file only puts that scope in order. It is a plan, not a record. What has actually landed goes in `STATUS.md`.

**M1 is done when:** connecting a test repo yields a published site with working nav and search; a push to the default branch (including a rename and a delete) is reflected on the site with no manual step; a dropped webhook is caught by reconciliation; stopping `app` does not take the published site down.

## Order, and why

Measure before building, then build the read path end to end with no UI, then put accounts and the install flow in front of it. Each slice ends with something you can run.

| # | Slice | Done when | Depends on |
| --- | --- | --- | --- |
| 1 | **Done 2026-10-30, see M1-NOTES.md.** **H3 compatibility report.** `oxybook check <dir>` walks `.md`/`.mdx` with `doc-model` and counts JSX component names, `import` specifiers, `{expressions}`, directive names, GitHub alerts, and `!!!` admonitions. It runs over the pinned corpus. | A committed per-repo table in `docs/M1-NOTES.md`. The built-in component list (MVP.md: Callout, Tabs/TabItem, Card, CodeGroup "to start") is confirmed or changed from those numbers. | `doc-model` only |
| 2 | **Spaces without UI.** A dev CLI that creates an org, a space, and its repo link (`repo_owner`, `repo_name`, installation id, `content_root`, `default_ref`). | One row each in `orgs` and `spaces` pointing at the test repo. | schema v0 |
| 3 | **Job queue.** pg-boss in `apps/worker`, app enqueues, worker dequeues. | A test job round-trips through PostgreSQL. A second worker replica does not run it twice. | schema v0 |
| 4 | **Sync.** Blobless mirror per repo, `sync(space, ref, to_sha)` from ARCHITECTURE §4.2: `git diff --name-status -M`, upsert `blobs` and `pages`, advance `ref_state` in one transaction, record renames. Triggered by the `push` webhook (deduplicated by `X-GitHub-Delivery`) and by a periodic `git ls-remote` reconciliation. | Against the test repo: a push with an edit, a rename, and a delete ends with `pages` matching `git ls-tree` at the new head. Deleting the webhook delivery and waiting for reconciliation gives the same result. | 2, 3, a live App |
| 5 | **Renderer v0.** `packages/renderer`: mdast to hast, the allowlist from slice 1, static props only, placeholders plus build warnings for everything else, Shiki, relative-link rewriting with broken-link warnings, import mapping from `oxybook.yml`. | Every corpus file renders. The warning counts match the slice 1 report. No customer code is evaluated (a test asserts no `import`/`eval`/`Function` path). | 1 |
| 6 | **Build and serve.** Build job (§5.3): render pages, `_dir.yml` nav, Pagefind, write the build dir, hardlinked release, atomic `current` symlink swap, `by-host` links. Caddy serves `<space>.docs.localhost`. | `curl http://<space>.docs.localhost:8080/` returns the test repo's home page, with `app` stopped. | 4, 5 |
| 7 | **Default theme v0.** Layout, sidebar from tree plus `_dir.yml`, search UI over Pagefind. Apache-2.0 (`packages/theme-default`). | Nav and search work in a browser on the test site. | 6 |
| 8 | **Accounts and install in the UI.** Email/password (argon2id), server-side sessions, org and space creation, Admin role, GitHub App install flow and repo connection with the access check from §4.1. | A new user signs up, connects the test repo, and gets the same site as slice 6 without the dev CLI. | 2, 4, 6 |
| 9 | **M1 exit run.** A script that does the exit sentence against the test repo and records the results in `STATUS.md`. | The exit sentence, measured. | all |

Slices 1, 2, and 3 do not depend on each other and can run in parallel. Slice 4 is the first one that needs the live App, which now exists.

## What the owner needs to do

- **Manifest-created App: done 2026-10-30.** `oxybook-cris` opened [oxybook-test#2](https://github.com/crisprintsstuff/oxybook-test/pull/2), and its `ping` and `installation` webhooks reached the server through `oxybook.boznetwork.com`. A `push` delivery arrived when oxybook-test#3 merged. Slice 4 needs the server running whenever the test repo changes, or reconciliation to catch up afterwards.
- **Test repo: decided 2026-10-30.** `crisprintsstuff/oxybook-test` is the M1 test space. [oxybook-test#3](https://github.com/crisprintsstuff/oxybook-test/pull/3) seeded its `docs/` tree. Later slices add the rename and delete pushes the exit needs.

## Open questions this plan does not answer

- The built-in component list. Slice 1 measured it. The recommendation is in M1-NOTES.md, and the final list is chosen in slice 5.
- Material for MkDocs `!!!` admonitions: still raw blocks in v1 (MVP.md H3). Slice 1 measures how often they appear.
- Sign in with GitHub is M2. `/api/github/oauth/callback` answers 501 until then.
