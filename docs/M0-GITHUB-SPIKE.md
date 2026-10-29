# M0 GitHub spike

Date: 2026-10-29. This note is the record ARCHITECTURE §4.3 and MVP.md ask for. It separates what was run for real from what was only exercised against fakes.

## Live-verified (real git, local `file://` remote)

`oxybook-dev propose` builds a commit on a blobless bare mirror and pushes it. GitHub is not involved. One run on this machine printed:

```
commit d970f58ac447c8e6bff47d8ff1b2c9df4c4c9585
ref refs/heads/oxybook/ada/page-1
base 311543cfec53b422ac2f33a5653bf52c181c3280
author Ada Lovelace
bare true
--- diff ---
diff --git a/docs/a.md b/docs/a.md
index 4a58007..e544395 100644
--- a/docs/a.md
+++ b/docs/a.md
@@ -1 +1 @@
-alpha
+alpha from cli
```

The base commit also contained `docs/b.md`. The diff name is only `docs/a.md`.

The same test process checked the rest:

- `git clone --bare --filter=blob:none` against `file://` (the remote had `uploadpack.allowFilter=true`; a plain path ignores `--filter`). Before any blob read, both `docs/a.md` and `docs/b.md` were missing objects (`?` lines from `git rev-list --objects --missing=print`). `git cat-file -e` on the `docs/a.md` blob fetched that blob and left `docs/b.md` missing.
- The new tree was built with `GIT_INDEX_FILE` pointed at `oxybook.index` inside the bare mirror: `read-tree`, `hash-object -w --stdin`, `update-index --cacheinfo`, `write-tree`. `git rev-parse --is-bare-repository` was `true`. Nothing was checked out.
- `commit-tree` recorded the author `Ada Lovelace`.
- The first push used `--force-with-lease=<ref>:` (empty expected value: the ref must not exist) and created `refs/heads/oxybook/ada/page-1`.
- After another commit was pushed to that ref, a second push with `--force-with-lease=<ref>:<old-sha>` exited non-zero with `stale info`. The remote ref stayed on the other commit.

Guards covered by the same tests: the ref must match `refs/heads/oxybook/<user>/<slug>-<id>`; paths must sit under the content root or be `oxybook.yml`; `..` and `.github/workflows/*` are refused.

## Unit-tested against fakes (not live GitHub)

`packages/github`:

- RS256 app JWT. `iat` is 60 seconds before the injected clock. `exp` is 600 seconds after `iat`, so it is 9 minutes from "now" and inside GitHub's 10-minute cap. Verified with a keypair generated in the test process.
- Installation token exchange. A fake `fetch` returns `token` and `expires_at`. The cache returns the same token until 60 seconds before expiry, then asks again. The token is held in a `Map` on the object. This module does not write it anywhere.
- Webhook `X-Hub-Signature-256` over the bytes in `packages/github/test/fixtures/webhook-body.json`, compared with `crypto.timingSafeEqual`. A different body, secret, or header length is rejected.
- App manifest JSON: contents write, pull requests write, metadata read, and no workflows permission. Events are `push`, `pull_request`, `installation`, `installation_repositories`.
- Callback handling. `GET /setup/github` returns an HTML form that POSTs the manifest to `https://github.com/settings/apps/new?state=…`. `GET /setup/github/callback` exchanges `code` with a mocked `POST /app-manifests/{code}/conversions`, stores the credentials in memory, and the HTTP response is `{stored, id, slug}` with no private key. Reusing the state is rejected.

## Still unverified

**Live App Manifest install.** Creating the app needs a browser session on a GitHub account and a redirect back to a URL GitHub can reach. This environment cannot do that click. The route and the manifest JSON are unit-tested only.

**Live webhook delivery.** Signature checks use a fixture. GitHub has not posted a webhook at this process.

**Opening a pull request on GitHub.** The CLI pushes to a `file://` remote. It does not call `POST /repos/{owner}/{repo}/pulls`. A GitHub pull request was not opened.

**Installation tokens against `api.github.com`.** The cache was tested with a fake HTTP response, not a real GitHub App.

**Signed commits and rulesets (ARCHITECTURE §4.3).** On 2026-10-29 the environment token (a GitHub App installation token for the `cursor` account, prefix `ghs_`) was asked:

`POST /repos/crisprintsstuff/OxyBook/rulesets` with `required_signatures` limited to `refs/heads/ruleset-probe-*`.

Response: HTTP 403, body `{"message":"Resource not accessible by integration","documentation_url":"https://docs.github.com/rest/repos/rules#create-a-repository-ruleset","status":"403"}`.

`GET /repos/crisprintsstuff/OxyBook` reported `permissions.admin`, `maintain`, `push`, `pull`, and `triage` all `false`. `GET /repos/crisprintsstuff/OxyBook/rulesets` was `[]` before the attempt and `[]` after. No ruleset and no probe branch were created.

Answering the question needs a token that can administer `crisprintsstuff/OxyBook` (create and delete a repository ruleset) and push (so an unsigned commit can hit `ruleset-probe-*`). Until that push is rejected or accepted, do not assume the Git Database API fallback.
