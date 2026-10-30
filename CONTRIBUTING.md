# Contributing to OxyBook

Thanks for helping. This file covers how to get a working dev environment, how to run tests, and what a mergeable pull request looks like. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before changing anything in `packages/doc-model` or the sync layer. Both carry invariants that are easy to break by accident.

## Developer Certificate of Origin (DCO)

Every commit must be signed off under the [Developer Certificate of Origin 1.1](https://developercertificate.org/). There is no CLA; you keep your copyright. See [LICENSING.md](LICENSING.md) for what this means.

```sh
git commit -s -m "doc-model: preserve setext heading style"
```

`-s` appends `Signed-off-by: Your Name <email>` using your `user.name` and `user.email`; it must match the commit author. Forgot it?

```sh
git commit --amend -s --no-edit          # last commit
git rebase --signoff main                # every commit on your branch
git push --force-with-lease
```

The DCO check on pull requests fails until every commit is signed off.

## Development setup

Requirements: Docker with Compose v2, Node.js 24 LTS, pnpm (via `corepack enable`), git ≥ 2.38.

```sh
cp .env.example .env
docker compose up -d postgres mailpit caddy   # infrastructure
pnpm install
DATABASE_URL=postgres://oxybook:oxybook-dev@127.0.0.1:5432/oxybook pnpm db:migrate
pnpm dev                                      # app and worker on the host, with reload
```

`pnpm db:migrate` applies the plain SQL files in `packages/db/migrations/` in filename order, in one transaction, and records them in `kysely_migration`. Migrations are forward-only: never edit a file that has merged, add a new one. In compose, `app` runs the same migrations at start (`OXYBOOK_MIGRATE_ON_START=true`). `pnpm test:integration` and `pnpm test:e2e` are not implemented.

Or run everything in containers, as the README quickstart does: `docker compose up -d`. Then open <http://app.localhost:8080>.

To test the GitHub integration, create a personal development GitHub App from the setup screen, install it on a scratch repository you own, and use the `webhooks` compose profile with a smee.io channel (see README). Never point a dev instance at a production repository.

## Tests

```sh
pnpm test                 # unit tests, all packages; packages/db needs DATABASE_URL or it skips
pnpm test:corpus          # round-trip identity over the pinned documentation corpus (fetches by SHA)
pnpm lint && pnpm typecheck
```

`pnpm test:integration` and `pnpm test:e2e` are not implemented. The root `package.json` has no such scripts. Do not run them.

Rules that reviewers enforce:

- Any change to `packages/doc-model` must keep `pnpm test:corpus` at 100% identity on parseable files, and must add a fixture for the case it fixes.
- A bug report about a mangled file gets a minimal fixture reproducing it before the fix.
- Sync-layer changes need an integration test against the local bare-repo harness, including the "base moved" case where relevant.

## Commits and pull requests

- Commit subject: `<area>: <imperative summary>`, at most 72 characters. Areas: `doc-model`, `editor`, `renderer`, `server`, `worker`, `sync`, `theme`, `sdk`, `deploy`, `docs`, `ci`. Example: `sync: use force-with-lease when updating PR branches`.
- Body: what changed and why, not how. Reference issues with `Fixes #123`.
- One logical change per PR. Refactors go in separate PRs from behaviour changes.
- PRs need passing CI, DCO sign-off on every commit, and one maintainer approval; changes to `doc-model` or `sync` need two.
- User-visible changes add a line to `CHANGELOG.md` under "Unreleased".
- New files carry the SPDX header for their path (see LICENSING.md).

## Reporting a security issue

Do **not** open a public issue, discussion or pull request for a security vulnerability.

Use GitHub's private vulnerability reporting on this repository ("Security" tab → "Report a vulnerability"), which must be enabled before the repository goes public. A dedicated security contact address will be listed in `SECURITY.md` before launch; until it exists, private vulnerability reporting is the only channel. Include affected versions, reproduction steps and impact. Maintainers will acknowledge the report, agree a disclosure timeline with you, and credit you in the advisory unless you prefer otherwise.

## Code of Conduct

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
