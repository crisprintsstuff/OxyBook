<!-- SPDX-License-Identifier: Apache-2.0 -->

# M1 notes

Measured results for M1, in the style of [M0-NOTES.md](M0-NOTES.md). The plan is [M1-PLAN.md](M1-PLAN.md). What is true now is in `STATUS.md`.

## H3 compatibility report (slice 1)

Date: 2026-10-30. Node v22.22.0. Corpus pinned in `corpus/manifest.json`, fetched by `pnpm test:corpus`, which still reports 100% identity on files that parse. Reproduce with:

```sh
pnpm test:corpus      # fetches corpus/cache at the pinned SHAs
pnpm compat:corpus    # prints this report as markdown
pnpm oxybook-check <dir>   # the same analysis for any docs tree, with file:line warnings
```

### What is counted

`oxybook-check` parses every `.md` and `.mdx` file with `doc-model` and walks the whole tree. Nothing is executed. A **placeholder** is something the renderer will replace with a visible stand-in and a build warning (ARCHITECTURE §5.2):

- a JSX element whose name is capitalised and not in the allowlist (`unknown-component`);
- an allowlisted or intrinsic element with a prop that is not a static literal (`dynamic-props`). JSON-literal expressions such as `count={2}` count as static;
- a `{expression}` that is not a comment (`expression`). `{/* comments */}` are dropped, not placeholders;
- `export` in MDX (`export`). `import` lines render nothing and are counted, not flagged;
- a leaf directive (`::name`) or a `:::name` container that is not a known callout (`directive`).

"Clean" means a parsed file with no placeholder at all. Starting allowlist from MVP.md: `Callout`, `Tabs`, `TabItem`, `Card`, `CodeGroup`.

### Per repo, starting allowlist

| repo | stack | sha | files | .mdx | clean | clean % | unknown-component files | expression files | export files | directive files | `!!!` files |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| fixtures | - | - | 28 | 2 | 26 | 96.3 | 1 | 0 | 0 | 0 | 0 |
| docusaurus | Docusaurus | 4e6fe61666a5 | 89 | 89 | 71 | 79.8 | 16 | 5 | 0 | 1 | 0 |
| starlight | Starlight | f1e9fa5ad4fb | 338 | 290 | 78 | 23.1 | 253 | 8 | 8 | 0 | 0 |
| vitepress | VitePress | 415a6a39507a | 36 | 0 | 34 | 94.4 | 0 | 0 | 0 | 2 | 0 |
| mkdocs | MkDocs | 2862536793b3 | 19 | 0 | 18 | 94.7 | 0 | 0 | 0 | 1 | 0 |
| mkdocs-material | MkDocs | 0f044dbe83cd | 85 | 0 | 85 | 100 | 0 | 0 | 0 | 0 | 39 |

Across the five repos (fixtures excluded): 567 files, 379 `.mdx`, 0 unparseable. 286 (50.4%) render with no placeholder. Placeholders by cause: unknown-component 2649 in 269 files, expression 27 in 13, export 8 in 8, directive 9 in 4, dynamic-props 1 in 1.

### Unknown components, by files affected

| component | files | uses | repos |
| --- | --- | --- | --- |
| `Fragment` | 95 | 284 | starlight |
| `Preview` | 88 | 310 | starlight |
| `Steps` | 63 | 132 | starlight |
| `FileTree` | 58 | 168 | starlight |
| `CardGrid` | 48 | 109 | starlight |
| `LinkCard` | 39 | 903 | starlight |
| `ThirdPartyContent` | 23 | 61 | starlight |
| `AboutAstro` | 17 | 17 | starlight |
| `Testimonial` | 15 | 180 | starlight |
| `TestimonialGrid` | 15 | 15 | starlight |
| `ShowcaseSites` | 12 | 12 | starlight |
| `YouTubeGrid` | 12 | 24 | starlight |
| `Aside` | 8 | 55 | starlight |
| `Badge` | 8 | 80 | starlight |
| `BrowserWindow` | 8 | 16 | docusaurus |
| `Code` | 8 | 24 | starlight |
| `Icon` | 8 | 40 | starlight |
| `LinkButton` | 8 | 32 | starlight |
| `SidebarPreview` | 8 | 120 | starlight |

The full list (38 names) is in the `pnpm compat:corpus` output. `Tabs` (233 uses), `TabItem` (590), and `Card` (140) are already on the allowlist, and they are among the most used elements in the corpus.

### What-if: adding Starlight's built-ins

Allowlist plus Starlight's own component set (`Aside`, `Badge`, `CardGrid`, `Code`, `FileTree`, `Icon`, `LinkButton`, `LinkCard`, `Steps`) and `Fragment` as a pass-through: **352 of 567 (62.1%)** clean, up from 286 (50.4%). Starlight goes from 78 to 144 of 338. Adding Docusaurus's `Admonition`, `TOCInline`, and `DocCardList` moves one more Docusaurus file (353, 62.3%). The remaining Starlight placeholders are components that site defines for itself (`Preview`, `ThirdPartyContent`, `AboutAstro`, the testimonial and showcase set). No built-in can cover those. They are what import mapping and a future custom-component story are for.

### Findings

1. **The starting list is half right.** `Tabs`/`TabItem`/`Card` are heavily used and stay. `CodeGroup` never appears as JSX in the corpus. VitePress writes it as a `::: code-group` container (6 files). `Callout` as JSX does not appear either: callouts arrive as `:::note`-style containers (253 `tip`, 108 `warning`, 82 `note`, 60 `info`, 25 `danger`, 8 `caution`, 7 `details`), as Starlight's `<Aside>` (55 uses), and in principle as Docusaurus's `<Admonition>`.
2. **Recommended M1 list**, by files that would stop showing a placeholder: `Steps`, `FileTree`, `CardGrid`, `LinkCard`, `Aside` (rendered as Callout), `Badge`, plus `Fragment` as a pass-through. Then `Code`, `Icon`, and `LinkButton` if time allows. `code-group` should be a container the renderer knows, not a JSX component.
3. **Import mapping needs named imports.** ARCHITECTURE §5.2 maps a specifier to one component (`"@theme/Tabs": Tabs`). Starlight imports many names from one module: `import { Steps, Aside } from '@astrojs/starlight/components'` (241 files). The mapping has to accept `"@astrojs/starlight/components": { Aside: Callout, Steps: Steps, ... }` or treat a known module's named imports as built-ins. ARCHITECTURE.md is not edited here. This is the correction.
4. **Text directives are literal text.** remark-directive parses `localhost:8000`, `4.5:1`, `mailto:mail`, and `:is` pseudo-selectors as text directives (10 in 7 files across four repos). The editor already keeps the bytes. The renderer must print a text directive back as its source text, never as a placeholder.
5. **MkDocs Material is the biggest degradation that never shows a placeholder.** 39 of its 85 files (46%) use `!!!`/`???` admonitions (info 18, warning 18, tip 13, question 10, note 9, example 7), and there are 275 pymdownx tab markers. MVP.md keeps them as raw text in v1. These numbers are what the post-v1 decision should start from. Plain MkDocs uses neither.
6. **Expressions and exports are rare.** 27 expressions in 13 files, 8 exports in 8 files, against 748 MDX comments, which are dropped without a placeholder.
7. **VitePress writes Vue components as HTML in `.md`.** `<Badge>` appears 19 times inside raw HTML. A `.md` file is never parsed as MDX, so these are HTML, not components. Whether the renderer treats a capitalised HTML tag as a component is an M1 decision. The count is small.

### Caveats

- The corpus is five docs sites, not five customers. Starlight's site documents its own components, so it uses them far more than a typical Starlight user would. About 20 locale directories also repeat each English page, so Starlight's file counts are inflated roughly by the number of translations of each page.
- "Clean" says nothing about rendering quality. It only means no placeholder. Links, images, and raw HTML are not judged here.
- `Fragment` is counted as unknown because it is capitalised. In Astro it renders its children. Treating it as a pass-through is part of the recommendation, not of the starting allowlist.

## Sync (slice 4)

Date: 2026-10-30. Details and numbers are in `STATUS.md`.

### Where ARCHITECTURE.md is wrong or thin

- **§4.2 step 2, `git diff --name-status -M <from> <to>`.** Sync does not apply that diff. It lists the content root at the new head (`git ls-tree`, trees only, no blobs) and compares the result with the stored `pages` rows. A diff needs `from` in the mirror and assumes the stored rows match `from`. Neither holds after a deleted mirror, a force-push, or a sync that failed halfway. The full comparison costs one tree listing and gives the same answer, so reconciliation can call the same function. `git diff -M` is still used, for renames only.
- **§4.2 `blobs(sha PK, bytes)`.** Keyed by `(org_id, sha)` since schema v0 (see M0-NOTES.md).
- **§2.5 inferred redirects.** The text does not say where they are kept. They are in `inferred_redirects`, keyed by `(space_id, ref, from_url)`, until slice 6 serves them and an admin commits them to `oxybook.yml`.
- **§2.2 `exclude:` in `oxybook.yml`.** Applied by both `syncSpace` and `buildSiteVersion` (slice 6).

### Sharp edge: migrations and concurrent schema drops

Kysely's migrator checks for its bookkeeping table with `introspector.getTables()`, which scans every schema in the database and calls `has_schema_privilege` on each. When another session drops a schema during that scan, the migration fails with `schema "<someone else's schema>" does not exist` (SQLSTATE 3F000). Measured 2026-10-30: 21 of 40 migrations failed while a second connection created and dropped schemas in a loop. CI hit this once on #20, because test files in one package ran in parallel, and each creates and drops a throwaway schema. Packages that use the database now run their test files with `--test-concurrency=1`. In production nothing drops schemas while the app starts. If something ever does, migrate-on-start will fail with that message, and a restart will succeed.

## Renderer v0 (slice 5)

Date: 2026-10-30. Node v22.23.1. Details and test numbers are in `STATUS.md`.

### Final M1 built-in component list

`DEFAULT_ALLOWLIST` in `packages/renderer`:
- Starting allowlist (`STARTING_ALLOWLIST`): `Callout`, `Tabs`, `TabItem`, `Card`, `CodeGroup`.
- Starlight built-ins and pass-through from slice 1's recommendation: `Aside` (rendered as Callout), `Badge`, `CardGrid`, `Code` (highlighted via Shiki), `FileTree`, `Icon`, `LinkButton`, `LinkCard`, `Steps`, `Fragment`.
- Non-callout container directive (`DEFAULT_DIRECTIVES`): `::: code-group` (VitePress code groups).

### Corpus rendering verification

`pnpm --filter @oxybook/renderer run test:corpus` (also part of `pnpm test:corpus`) renders all 567 corpus files and 28 adversarial fixtures:
- With `STARTING_ALLOWLIST` and `allowDirectives: []`, every file's `placeholders` list matches `analyzeSource` from slice 1 identically: 286/567 clean (50.4%), `unknown-component` 2649, `dynamic-props` 1, `expression` 27, `export` 8, `directive` 9.
- With `DEFAULT_ALLOWLIST` and `allowDirectives: []`, every file's `placeholders` list matches `analyzeSource` with `DEFAULT_ALLOWLIST` identically: 352/567 clean (62.1%), `unknown-component` 822, `dynamic-props` 33, `expression` 27, `export` 8, `directive` 9.
- With `DEFAULT_ALLOWLIST` and `DEFAULT_DIRECTIVES` (`['code-group']`), **353 of 567 (62.3%)** corpus files render with zero placeholders (`directive` placeholders drop from 9 in 4 files to 3 in 2 files; one of the two VitePress files with `::: code-group` also uses `::: v-pre`).

### Live test repo (`crisprintsstuff/oxybook-test`)

Rendered the 10 synced pages of `cris/test` at `b8058130b7d5a9da6dc0646bf29e15fce32b3d58` from PostgreSQL (`pages` + `blobs`) with `oxybook-test`'s `oxybook.yml` (`"@theme/Tabs": Tabs`, `"@theme/TabItem": TabItem`):
- 9 of 10 pages render with 0 placeholders and 0 broken links.
- `/guides/configure` (`guides/configure.mdx`) renders `<Tabs>`/`<TabItem>`, drops the `{/* ... */}` comment, rewrites `../reference/commands.md` to `/reference/commands`, and reports the 2 planted placeholders (`20:expression:3000`, `22:unknown-component:VersionBadge`) and 1 planted broken link (`26:broken-link:../reference/settings.md` → `reference/settings.md`).

## Build and serve (slice 6)

Date: 2026-10-30. Node v22.23.1. Details and measurements are in `STATUS.md`.

### Where ARCHITECTURE.md is thin

- **§5.3 directory index pages and Caddy `try_files`.** `Caddyfile.dev` uses `try_files {path} {path}.html {path}/index.html`. When a page URL such as `/guides` also has a directory `guides/` on disk (because `guides/install.html` and `guides/images/stack.svg` live inside it), `{path}` matches the directory `guides/`, so Caddy's `file_server` looks for `guides/index.html`. `buildSiteVersion` writes `guides.html` and hardlinks `guides/index.html` to `guides.html` whenever a sibling directory `guides/` exists, so both `/guides` and `/guides/` return 200 with zero duplicated bytes while leaf pages (`/getting-started`, `/guides/install`) are served from `<path>.html` with no trailing-slash redirect.
- **§5.3 redirects when `app` is stopped.** Explicit `redirects:` in `oxybook.yml` and `inferred_redirects` rows from `git diff -M` are emitted as static HTML redirect files (`<meta http-equiv="refresh">`, `<link rel="canonical">`, `location.replace`) without `data-pagefind-body`, so redirects work when `app` is stopped (invariant 4) and are not indexed by Pagefind.
- **Port 8080 on the owner's machine.** `qBittorrent` holds port 8080 on the owner's Windows/WSL2 host, which prevented Docker from binding `8080:80` on `caddy`. `docker-compose.yml` now parameterizes the host port as `${CADDY_PORT:-8080}:80` (with `CADDY_PORT=8180` in the owner's `.env`) and the sites volume as `${OXYBOOK_SITES_VOLUME:-sites}:/srv/sites` (`./.oxybook-sites` in `.env` so host `pnpm dev` / `oxybook-admin` builds are served directly by the compose `caddy` container).

## Default theme v0 (slice 7)

Date: 2026-10-30. Node v22.23.1. Details and measurements are in `STATUS.md`.

### Package boundary and licensing

- `packages/theme-default` is licensed `Apache-2.0` (`LICENSING.md`, ARCHITECTURE §10) and has zero runtime dependencies on AGPL workspace packages (`packages/doc-model`, `packages/renderer`, `packages/sync`, `packages/db`, `packages/jobs`). `@oxybook/renderer` (`AGPL-3.0-only`) imports `@oxybook/theme-default`.
- Ships `renderPageDocument`, `render404Document`, `renderRedirectDocument`, `flattenNavPages`, `findPrevNextPages`, `buildThemeStyles`, `DEFAULT_THEME_CSS`, and `buildThemeClientScript`.
- Client-side island script (`buildThemeClientScript`) hydrates:
  - `<Tabs>` / `<TabItem>` (`.oxybook-tabs`) with keyboard arrow navigation and `data-tabs-group` + `localStorage` synchronization across the page;
  - `::: code-group` / `<CodeGroup>` (`.oxybook-code-group`) by generating a `<div class="oxybook-tabs-list" role="tablist">` from the child `<pre>` blocks' `data-title` or `data-language`;
  - Pagefind search UI (`#oxybook-search`, `/` and `Ctrl+K` / `Cmd+K` focus shortcut), mobile sidebar drawer toggle (`.oxybook-mobile-toggle` + `Escape`), and header version switcher (`[data-version-switcher]`).

## Accounts and install in the UI (slice 8)

Date: 2026-10-30. Node v22.23.1. Details and measurements are in `STATUS.md`.

### Where ARCHITECTURE.md is thin

- **§4.1 repository access check before M2 ("Sign in with GitHub").** ARCHITECTURE §4.1 says connecting a repository to a space checks with the admin's GitHub user token that they have admin or write access to that repo, while M1-PLAN.md defers "Sign in with GitHub" (`/api/github/oauth/callback`) to M2. `verifyRepoConnection` (`apps/server/src/admin.ts`) and `checkUserRepoAccess` (`packages/github`) implement both: when a user token (`user_token` / `userToken`) is supplied (or `requireUserToken: true` is set), `GET /repos/{owner}/{repo}` is called with that user token and requires `permissions.admin || permissions.maintain || permissions.push` (rejecting read-only tokens with HTTP 403); in all cases, it verifies via `GET /repos/{owner}/{repo}/installation` (App JWT) and `GET /repos/{owner}/{repo}` (installation token) that the stored GitHub App is installed on `owner/repo` and can access it. The dashboard also queries `GET /app/installations` and `GET /installation/repositories` as the stored App so an org owner can pick an installed repository in one click.
- **§7 `space_members` composite foreign key.** `0001_schema_v0.sql` declares `FOREIGN KEY (org_id, user_id) REFERENCES org_members (org_id, user_id) ON DELETE CASCADE` on `space_members`. `setSpaceMemberRole` (`apps/server/src/admin.ts`) ensures the target user has an `org_members` row (`role = 'member'` if not already present) in the same transaction before upserting `space_members`.
- **Pre-existing CLI orgs and first user signup.** When the first user signs up on an instance (`count(users) = 0` before insert) where `orgs`/`spaces` were created earlier via `oxybook-admin`, `signUpUser` attaches that first user as `owner` of memberless `orgs` and `admin` of their `spaces` in the same transaction.
