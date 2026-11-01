# OxyBook

[![CI](https://github.com/crisprintsstuff/OxyBook/actions/workflows/ci.yml/badge.svg)](https://github.com/crisprintsstuff/OxyBook/actions/workflows/ci.yml)
![status: early alpha](https://img.shields.io/badge/status-early%20alpha-orange)
![release: none yet](https://img.shields.io/badge/release-none%20yet-lightgrey)
![license: AGPL-3.0 | Apache-2.0](https://img.shields.io/badge/license-AGPL--3.0%20%7C%20Apache--2.0-blue)
![node: 24](https://img.shields.io/badge/node-24-339933?logo=node.js&logoColor=white)
![runs on: Docker Compose](https://img.shields.io/badge/runs%20on-Docker%20Compose-2496ED?logo=docker&logoColor=white)
![git host: GitHub](https://img.shields.io/badge/git%20host-GitHub-181717?logo=github)

A self-hostable documentation platform where the git repository is the source of truth. Writers edit pages in the browser; every change becomes a pull request in your GitHub repository; merged changes publish a static documentation site.

> **Status: early alpha, looking for testers.** There is no release yet, and things will break. What works today, end to end on a real GitHub repository:
>
> - Connect a repository through a GitHub App that OxyBook creates for you.
> - Sync its markdown and MDX into OxyBook, and publish a static site with navigation, search, and redirects for renamed pages.
> - Edit pages in the browser (source mode, with live preview and autosave), review the exact diff, and **propose** it: OxyBook opens a pull request on an `oxybook/*` branch. If you link your GitHub account, the pull request is yours; otherwise the App opens it.
> - When the pull request is merged, the site rebuilds.
>
> Not yet: the visual block editor (pages are edited as markdown text for now), versions, custom domains, email, and a conflict view. [STATUS.md](STATUS.md) says exactly what works and what was measured. The feature list below is what v1 will ship, not what exists today.

## Try it

You need Docker with Compose v2, a GitHub account, and a **test repository** with a few markdown files in a folder such as `docs/`. GitHub has to reach OxyBook over HTTPS for webhooks and sign-in, so you also need a tunnel to your machine (a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/), `cloudflared tunnel --url`, ngrok, or similar).

1. Clone and configure:

   ```sh
   git clone https://github.com/crisprintsstuff/OxyBook.git oxybook
   cd oxybook
   cp .env.example .env
   sed -i "s/^OXYBOOK_SECRET_KEY=.*/OXYBOOK_SECRET_KEY=$(openssl rand -hex 32)/" .env
   ```

2. Start a tunnel to `http://localhost:8080`, and set `OXYBOOK_PUBLIC_URL` in `.env` to its `https://` address. Do this before creating the GitHub App: the App is registered with that address.
3. Start everything, and wait until every service reports `healthy`:

   ```sh
   docker compose up -d --build
   docker compose ps
   ```

4. Open your public URL and sign up, then open `/setup/github` and create the GitHub App. Install it on your test repository only.
5. On the dashboard, create an organisation and connect the repository (content folder `docs`, branch `main`). OxyBook syncs it and builds the site, served at `http://<space>.docs.localhost:8080`.
6. Open the space and click **Edit pages**. Change something, look at **Changes**, and click **Propose changes**. The pull request appears on GitHub; merge it there and the site rebuilds.

Optional: **Link GitHub account** on the dashboard makes proposed pull requests yours instead of the App's, and lets you use **Sign in with GitHub**. More detail, including running from source with `pnpm dev`, is in [docs/LIVE-INSTALL.md](docs/LIVE-INSTALL.md).

Stop with `docker compose down`. Add `-v` to delete volumes; `pgdata` holds accounts and unproposed drafts.

### Feedback

Please [open an issue](https://github.com/crisprintsstuff/OxyBook/issues/new/choose) for anything that breaks, confuses you, or surprises you. The most valuable report is a pull request diff that touches lines you did not edit: attach the smallest file that shows it. Report security problems privately ([Security tab](https://github.com/crisprintsstuff/OxyBook/security/advisories/new)), not in public issues. Use a test repository and a test GitHub App while OxyBook is in alpha.

## Pitch

Documentation teams keep choosing between two bad options. Hosted wiki-style editors are pleasant for non-developers, but the content lives in someone else's database and git sync, where it exists, is an export. Static site generators keep docs in the repo next to the code, but everyone who edits needs to be comfortable with markdown, git and pull requests. OxyBook puts a polished block editor in front of plain markdown and MDX files in a repository you already own. The editor never rewrites bytes it was not asked to change, and it never drops a construct it does not understand. Changes land through ordinary pull requests under your existing review rules, and merged content builds a static, versioned site with search, theming and custom domains.

## The problem, concretely

- **Repo as truth breaks at the editor.** Most visual editors normalise markdown on save: list markers change, tables get re-padded, and MDX components or raw HTML they cannot represent are silently dropped. One save from a well-meaning writer can mangle hand-written content, so teams stop letting non-developers edit.
- **Git sync is usually one-way or periodic.** Wiki.js, the closest existing tool, commits on an interval to a dedicated repository, and pages created before sync was configured are absent from the repo. That is a backup, not a source of truth.
- **SSGs have versioning and no editor.** Docusaurus, VitePress and Starlight handle versions and publishing well, but every contributor works in markdown and git directly.
- **The open-source wiki tools have licensing or feature gates** that matter if you self-host or build on them (see the comparison below).

## How it works

1. Install the OxyBook GitHub App on a repository and pick a content directory (for example `docs/`).
2. The file tree becomes the page tree. Frontmatter is page metadata. Ordering lives in small `_dir.yml` files.
3. Writers edit pages in the browser (a block editor in v1; source mode today). MDX components, raw HTML and anything else the editor cannot represent appear as read-only raw blocks and are preserved byte-for-byte.
4. **Propose changes** opens a pull request on an `oxybook/*` branch containing only the lines that changed. OxyBook never pushes to your base branch.
5. When the PR is merged, a webhook triggers a static rebuild of the affected version, served by Caddy.

Design details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Scope and milestones: [docs/MVP.md](docs/MVP.md).

## Features

### v1 (first release)

- GitHub App integration: webhook-driven sync with periodic reconciliation; changes go out as pull requests in your repository.
- Block editor (TipTap/ProseMirror): headings, lists, task lists, tables, code blocks, images, links, callouts (`:::note` directives and GitHub `> [!NOTE]` alerts).
- Lossless round-trip: unedited blocks keep their exact bytes; MDX/JSX, raw HTML, unknown directives and unparseable frontmatter are preserved as read-only raw blocks; source mode for anything else. Enforced by an identity check on every file load and a CI corpus of real documentation repos.
- Drafts with autosave, exact diff preview before proposing, follow-up commits to an open PR, optional DCO `Signed-off-by` trailer.
- Automatic three-way merge when the base branch moves, plus a block-level conflict view.
- Renames and moves that add redirects and rewrite inbound relative links in the same commit.
- Published static site: sidebar nav from the file tree, versions mapped to git branches or tags, version switcher, full-text search (Pagefind), default theme configurable from `oxybook.yml` plus custom CSS, custom domains with automatic TLS, private sites.
- Accounts with email/password and Sign in with GitHub; per-space roles: Admin, Editor, Viewer. Merging stays on GitHub.
- Self-hosting with one `docker compose up`: PostgreSQL, app, worker, Caddy.

### Planned (after v1)

- Platform-hosted git repository, for teams without one.
- GitLab, Bitbucket, Gitea/Forgejo.
- SSO (SAML/OIDC) and SCIM, under the same AGPL licence with no paid tier gate.
- Editable structured MDX components; sandboxed builds that execute full MDX.
- PR preview deployments; importers (Confluence, Notion, MkDocs nav); Material for MkDocs syntax support.
- Real-time co-editing; comments; i18n; analytics; custom theme code via the SDK.

The full list of v1 non-goals, with reasons, is in [docs/MVP.md](docs/MVP.md#non-goals-for-v1).

## Development

Running from source (`pnpm dev`), tests, and conventions are in [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/LIVE-INSTALL.md](docs/LIVE-INSTALL.md). Milestones and what each one measured are in [STATUS.md](STATUS.md).

## Why not just use…

| | Content lives in | Git integration | Editor for non-developers | Versioned published site | Licence notes |
|---|---|---|---|---|---|
| **Outline** | Outline's database | No repo-as-truth model | Yes | Not a docs-site generator | Business Source License 1.1; the Additional Use Grant bars offering it as a "Document Service"; converts to Apache-2.0 in Oct 2030 |
| **Docmost** | Docmost's database | No repo-as-truth model | Yes | No | AGPL-3.0 core; SSO/SCIM, page-level permissions, templates, REST API and the Confluence importer are in a paid Business tier; `packages/ee` forbids production use without a subscription |
| **Docusaurus** (and VitePress, Starlight) | Your repo | Native: it *is* files in git | No | Yes | Open source; no editor, so every contributor works in markdown and git |
| **Wiki.js** | Wiki.js database, exported to git | Periodic commits on an interval, dedicated repo only, pages created before sync are absent from the repo | Yes | No | Open source; git is a sync target, not the source of truth |
| **OxyBook** | Your repo | Native: reads the repo, writes pull requests | Yes, with lossless round-trip | Yes (versions = git refs) | AGPL-3.0 server/editor, Apache-2.0 SDK/themes/components, no paid edition |

Also relevant: AFFiNE is MIT-licensed except its backend packages, which need a paid EE subscription to run in production. Material for MkDocs is in maintenance mode with end of life announced for 5 May 2027; its users need somewhere to go, and OxyBook preserves their MkDocs-specific syntax as raw blocks from v1 on.

## Licensing

The server, worker, editor and core libraries are licensed under **AGPL-3.0** ([LICENSE](LICENSE)). The SDK, themes, built-in components and deployment files are licensed under **Apache-2.0** ([LICENSE-APACHE](LICENSE-APACHE)). [LICENSING.md](LICENSING.md) gives the path-by-path split and the reasons for it. Contributions use the Developer Certificate of Origin (`git commit -s`), not a CLA.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). Report security issues privately, as described in CONTRIBUTING.md, not in public issues.
