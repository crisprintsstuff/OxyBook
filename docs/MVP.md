# OxyBook v1 scope

v1 is about one thing: **a non-developer edits a page in a polished editor, a pull request appears in the customer's GitHub repo containing only the lines they changed, and when it is merged the versioned published site updates.** Anything that does not serve that loop is cut.

Assumed team: 2–4 engineers. Estimates are in engineer-weeks (ew), are rough, and include tests and docs for the milestone. They are planning numbers to be revised after M0, not commitments.

## In scope for v1

- GitHub App integration: install, webhook-driven sync, reconciliation, PRs opened in the customer's repo.
- One space = one repo + content root + default ref; several spaces per instance.
- Block editor (TipTap/ProseMirror) for the constructs listed in ARCHITECTURE §3.2; raw read-only blocks for everything else; source mode as fallback.
- Lossless round-trip, enforced by load-time identity checks, the CI corpus and property tests.
- Frontmatter metadata panel (known keys editable; unknown keys preserved and shown read-only).
- Drafts with autosave, diff preview, propose/update PR, optional DCO trailer.
- Conflict handling when the base moved (automatic three-way merge, block-level conflict view).
- Renames and moves with redirects and inbound-link rewriting; nav ordering via `_dir.yml`.
- Static published site: sidebar tree, versions from git refs, version switcher, Pagefind search, default theme configurable from `oxybook.yml`, custom CSS, custom domains with on-demand TLS, private sites.
- Accounts: email/password, Sign in with GitHub, invites; roles Admin / Editor / Viewer per space.
- Self-hosting: `docker compose up` with postgres, app, worker and caddy; documented backup and upgrade.

## Non-goals for v1

Each is deliberately excluded. Most are good ideas; none are needed to prove the core loop.

1. **Real-time co-editing.** Drafts are per user; concurrent edits resolve through the merge path. CRDT collaboration would add a second source of truth next to git, and that is the hardest thing to get right.
2. **Platform-hosted internal git repository.** v1 requires the customer's GitHub repo. A hosted repo is a later milestone.
3. **GitLab, Bitbucket, Gitea/Forgejo, or generic git remotes.** The sync layer is written behind a provider interface, but only GitHub ships.
4. **SSO (SAML/OIDC) and SCIM.** When these ship they ship under AGPL with no paid gate. They are not v1.
5. **Internationalisation**, both of the UI and of content (translated doc sets).
6. **Analytics** (page views, search analytics, feedback widgets).
7. **Comments, inline discussions, page reactions.** Review happens on the PR.
8. **Merging from OxyBook.** Review and merge stay on GitHub, under branch protection.
9. **Page-level permissions.** The unit of access is the space.
10. **Executing MDX:** evaluating `import`/`export`, `{expressions}`, or customer-supplied components at build time. Needs a sandboxed build runner first.
11. **Editable structured MDX components** (editing markdown children of `<Tabs>` in the visual editor). Raw blocks in v1.
12. **Importers** (Confluence, Notion, GitBook, MkDocs `nav` conversion). v1 onboarding is "point OxyBook at an existing markdown directory".
13. **PR preview deployments** (a built site per PR, check-run link). In-editor preview exists; per-PR deploys do not.
14. **Custom theme code / plugin system.** v1 theming is config + CSS. The Apache-2.0 SDK defines interfaces, but no third-party plugin loading ships.
15. **API reference generation** (OpenAPI, TypeDoc, etc.).
16. **PDF / offline export, and static export as a product feature.** The build output is static by construction; packaging it is later.
17. **Stable public REST API.** An internal API exists and is not versioned.
18. **Git LFS writes.** Repos that track images with LFS can be read; image upload into LFS-tracked paths is refused with a clear message.
19. **Hosted multi-tenant SaaS operations:** billing, quotas, RLS hardening, abuse handling.
20. **AI features** of any kind.
21. **Mobile editing.** The editor targets desktop browsers; the published site is responsive.

## The hard problems, and how each is de-risked early

### H1. MDX/markdown round-trip fidelity

*Risk:* the editor silently rewrites bytes it did not need to touch, or loses a construct, in some file shape we did not anticipate. This breaks the product's core promise permanently for that customer.

*De-risking:*
- Build `packages/doc-model` **first, in M0, with no UI**. It is a pure library with a CLI: `oxybook-roundtrip <dir>` reports identity pass/fail/unparseable per file.
- Assemble the corpus in week 1: pinned SHAs of several public Docusaurus, Starlight, VitePress and MkDocs documentation repositories, fetched at CI time, plus hand-written adversarial fixtures (CRLF, BOM, setext headings, reference links, nested lists with mixed markers, tables with escaped pipes, JSX inside lists, HTML comments, unterminated JSX in `.mdx`).
- Exit criterion for M0: 100% identity on every file that parses; unparseable files are counted and fall back to source mode by design.
- Property tests (random single-block edits ⇒ diff confined to that block) land in M0 and run on every commit for the life of the project.
- In production, the load-time identity check means an unknown failure degrades to source mode instead of corrupting a file.

### H2. Conflicts from concurrent edits

*Risk:* the base branch moves while a draft or PR is open, and the user either loses work, gets a broken file, or faces raw `<<<<<<<` markers they cannot understand.

*De-risking:*
- M0 spike: script the scenarios against a scratch repo (upstream edits same paragraph / different paragraph / renames file / deletes file; someone pushes to the PR branch) using `git merge-file` and `git merge-tree --write-tree`, and record outcomes as fixtures.
- Ship in two layers. M2 handles only the clean cases automatically and sends conflicting drafts to "resolve on GitHub / source mode". M3 adds the block-level conflict view. If M3 slips, v1 is still safe, only less pleasant.
- History is never rewritten on a branch someone else has pushed to, and every push uses `--force-with-lease`. These are tested invariants, not conventions.

### H3. Rendering compatibility with existing content

*Risk:* a team points OxyBook at an existing Docusaurus/Starlight repo and the published site is full of placeholders, because their MDX relies on imports, expressions and framework components we deliberately do not execute.

*De-risking:*
- In M1, run the renderer over the same corpus and produce a **compatibility report**: counts of unknown components, imports, expressions and directives per repo. This decides which built-in components ship first. Building for the long tail instead of the observed head would waste time.
- Import mapping in `oxybook.yml` lets `@theme/Tabs`-style imports resolve to built-ins without executing anything.
- Every placeholder is also a build warning listing file and line, and `oxybook check` (CLI, M1) prints the report locally before a team commits to migrating.
- Material for MkDocs content (admonitions `!!! note`, pymdownx extensions) is surfaced as raw blocks and measured in the same report. Native support is a post-v1 candidate, driven by the numbers.

## Milestones

### M0 — Foundations and risk spikes (≈ 6 ew)

- Monorepo (pnpm workspaces), CI, lint/test setup, `docker-compose.yml` with postgres + caddy + mailpit running; app/worker skeletons with `/healthz`.
- Database schema v0 and migration tooling (Kysely + SQL migrations).
- `packages/doc-model`: parser, raw nodes, style profile, serializer, identity check; corpus harness and property tests (H1).
- GitHub spike: App Manifest flow creates an app; webhook received and verified; blobless mirror fetch; tree built and pushed to `oxybook/*`; PR opened from a CLI (`oxybook-dev propose <file>`).
- Conflict scenario fixtures (H2).

**Done when:** corpus identity is 100% on parseable files and runs in CI; the CLI opens a real PR against a test repo whose diff contains only the intended change; a written note records the signed-commit ruleset behaviour (ARCHITECTURE §4.3).

### M1 — Read path and published site (≈ 9 ew)

- Accounts (email/password, sessions), organisations, spaces, Admin role.
- GitHub App install flow in the UI; repo connection with access check; webhook sync + reconciliation; read model in PostgreSQL.
- Renderer: mdast→hast handlers, allowlisted components (Callout, Tabs/TabItem, Card, CodeGroup to start; final list from the H3 report), Shiki, link rewriting and broken-link warnings, import mapping.
- Build job, release assembly with hardlinks, atomic swap; `by-host` symlinks; Caddy serving `<space>.docs.localhost` in dev.
- Default theme v0, sidebar from tree + `_dir.yml`, Pagefind.
- `oxybook check` compatibility CLI; corpus rendering report.

**Done when:** connecting a test repo yields a published site with working nav and search; a push to the default branch (including a rename and a delete) is reflected on the site with no manual step; a dropped webhook is caught by reconciliation; stopping `app` does not take the published site down.

### M2 — Editor and write path (≈ 12 ew)

- Editor SPA: page tree, TipTap editor for the §3.2 constructs, raw block/inline NodeViews, source mode (CodeMirror 6), metadata panel, image upload, link picker inserting relative paths, in-editor preview through the renderer.
- Dirty-block tracking via step maps; serializer integration.
- Drafts with autosave and optimistic concurrency; diff preview; propose / update PR; app-authored vs user-authored PRs; DCO trailer option; path and branch guards in the worker.
- Editor and Viewer roles; Sign in with GitHub.
- Clean-merge handling when the base moved; conflicting drafts routed to GitHub/source mode.

**Done when:** an end-to-end test edits one paragraph in an `.mdx` page containing JSX components, raw HTML and unusual frontmatter, and the resulting PR diff touches only that paragraph's lines; a non-GitHub user can propose a change that a GitHub user then merges, and the site updates.

### M3 — Conflicts, versions, renames (≈ 8 ew)

- Block-level conflict view; branch rewrite vs merge-commit logic; `--force-with-lease` everywhere (H2).
- Versions from refs: `versions:` config, per-version builds, version switcher, tags read-only in the editor, editing older versions targets their branch.
- Rename/move in the editor with redirect entries and inbound-link byte patches; inferred redirects for out-of-band renames with "commit redirect" PR.
- Drag-and-drop nav ordering writing `_dir.yml`; "someone has an open draft on this page" indicator.

**Done when:** scripted concurrent-edit scenarios from the M0 fixtures all end in either a clean merge or a resolvable conflict view, with no lost bytes; a three-version site builds and serves with correct cross-version URLs; renaming a page in the editor yields one PR containing the move, the redirect and updated links, and the old URL redirects after merge.

### M4 — Production readiness, v1.0 (≈ 7 ew)

- Custom domains: DNS TXT verification, Caddy on-demand TLS `ask` endpoint, production Caddyfile.
- Private sites via `forward_auth` and the code-exchange callback.
- Theming config completed (logo, colours, fonts, header/footer links, custom CSS).
- Invites and email (SMTP optional), password reset, member management.
- Self-host docs: install, upgrade, backup/restore (what must be backed up and what is cache), sizing guidance written from measurements on the corpus.
- Security review: webhook verification, token handling, path guards, SSRF on image URLs, session handling; dependency audit; `SECURITY.md` with the configured private reporting channel.
- Release engineering: versioned container images, migration safety on upgrade, `v1.0.0` tag.

**Done when:** a fresh machine goes from `git clone` to a published site on a custom domain with HTTPS using only the README; an upgrade from the previous release candidate preserves drafts and accounts; the security checklist is closed.

**Total:** ≈ 42 ew. With three engineers that is roughly four months of calendar time before slack. Plan for five to six; the editor (M2) is where estimates usually break.
