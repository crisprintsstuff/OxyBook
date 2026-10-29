# Licensing

OxyBook uses two licences. Which one applies is decided by the path a file lives in.

## Which paths

| Path | Licence |
|---|---|
| `apps/server/` | AGPL-3.0-only |
| `apps/worker/` | AGPL-3.0-only |
| `apps/editor/` | AGPL-3.0-only |
| `packages/doc-model/` | AGPL-3.0-only |
| `packages/renderer/` | AGPL-3.0-only |
| `packages/sdk/` | Apache-2.0 |
| `packages/theme-default/` and any other `packages/theme-*` | Apache-2.0 |
| `packages/components/` | Apache-2.0 |
| `deploy/`, `docker-compose.yml`, `.env.example` | Apache-2.0 |
| `docs/` and other documentation | Apache-2.0 |
| Anything not listed | AGPL-3.0-only |

The full texts are in [LICENSE](LICENSE) (GNU Affero General Public License v3.0) and [LICENSE-APACHE](LICENSE-APACHE) (Apache License 2.0). Every source file carries an SPDX header (`// SPDX-License-Identifier: AGPL-3.0-only` or `Apache-2.0`), and each package's `package.json` declares its licence. If a header and this table ever disagree, open an issue. The intent is this table.

There is no `ee/` directory, no "enterprise edition", and no code in this repository that requires a subscription to run in production.

## Why the split

- **AGPL for the product.** The server, editor and the parsing/rendering core are what someone would take to run a competing hosted service. AGPL means anyone who offers OxyBook to users over a network must offer those users the corresponding source, including their modifications. Improvements to the hosted product come back to everyone.
- **Apache-2.0 for what customers build with or ship to readers.** Themes, components and the SDK end up inside published documentation sites and inside customers' own code (custom themes, components, config tooling). Putting those under a permissive licence means publishing your docs with OxyBook, or writing a theme for it, never raises copyleft questions for your site or your code. Deployment files are permissive so they can be copied into infrastructure repos freely.

## What a fork or a host may do

**You may:**

- Self-host OxyBook for your organisation, unmodified or modified, at no cost and without telling anyone. If only your own staff use a modified version, AGPL §13 obligations apply to those users, which in practice means making the modified source available to them.
- Offer OxyBook as a paid hosted service to others.
- Fork it, rename it, and distribute your fork.
- Build proprietary themes, components or tooling against the Apache-2.0 SDK and keep them closed.
- Publish documentation sites built with OxyBook under any licence. Your content is yours. The licences cover OxyBook's code, not your docs.

**You must, if you run a modified version of the AGPL parts for users over a network, or distribute them:**

- Offer those users the complete corresponding source of your modified version under AGPL-3.0 (AGPL §13; GPLv3 §6 for distribution).
- Keep copyright and licence notices intact, and mark your changes.

**You may not:**

- Relicense AGPL-covered code under different terms, or add further restrictions (for example a "no production use" clause) to it.
- Use the project's name or logos in a way that implies your fork or service is the official project. Neither licence grants trademark rights (Apache-2.0 §6 says so explicitly).

This is a plain-language summary, not legal advice. The licence texts govern.

## Contributions: Developer Certificate of Origin

OxyBook does **not** use a Contributor Licence Agreement. Contributors keep their copyright. Contributions are accepted under the licence of the path they touch (inbound = outbound), certified with the [Developer Certificate of Origin 1.1](https://developercertificate.org/).

To certify, add a `Signed-off-by` line to every commit, matching the commit author:

```
Signed-off-by: Your Name <you@example.com>
```

`git commit -s` adds it for you. By signing off you state that you wrote the change, or otherwise have the right to submit it under the project's licence. Because nobody assigns copyright to a single party, the project cannot be relicensed unilaterally. That is deliberate. A CI check rejects pull requests containing commits without a valid sign-off. See [CONTRIBUTING.md](CONTRIBUTING.md#developer-certificate-of-origin-dco) for how to fix a missed sign-off.
