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

## Live-verified (GitHub ruleset probe)

Ruleset `ruleset-probe`, id `26114519`, read back with `GET /repos/crisprintsstuff/OxyBook/rulesets/26114519` on 2026-10-29. `target` is `branch`, `enforcement` is `active`, `conditions.ref_name.include` is `refs/heads/ruleset-probe-*`, `exclude` is empty. `rules` are `deletion`, `non_fast_forward`, and `required_signatures`. The JSON has no `bypass_actors` field. An authenticated read of the same object returned `current_user_can_bypass: "never"`.

Two reads of that ruleset, same day:

- No `Authorization` header. `GET /repos/crisprintsstuff/OxyBook/rulesets` and `GET /repos/crisprintsstuff/OxyBook/rulesets/26114519` both returned HTTP 200. The repo is public, so an anonymous reader can see the rules.
- This environment's credential, a GitHub App installation token (`ghs_`, `gh` account `cursor`). The same two GETs also returned HTTP 200. The response header on the ruleset GET was `X-Accepted-Github-Permissions: metadata=read`. `GET /repos/crisprintsstuff/OxyBook` still reported `permissions.admin`, `maintain`, `push`, `pull`, and `triage` all `false`.

That is not the same as a token GitHub refuses. `POST /repos/crisprintsstuff/OxyBook/rulesets` with an installation token, recorded in the changelog entry that thought the question was still blocked, returned HTTP 403 `{"message":"Resource not accessible by integration","documentation_url":"https://docs.github.com/rest/repos/rules#create-a-repository-ruleset","status":"403"}`. An App token is not an anonymous reader: when GitHub answers `403 Resource not accessible by integration`, the App learns nothing, even though an anonymous GET of this public repo returns 200. A private customer repo has no anonymous GET. That private-repo GET was not called here. The App needs `administration: read` (or an App-side setting) before a refused token can be treated as "no signed-commit rule".

The ruleset's `deletion` rule blocks deleting `ruleset-probe-test`. The ruleset has to be removed before the branch can. Neither was deleted in this run. On 2026-10-29, after this measurement was recorded, that scaffolding was removed, the ruleset first and then the branch, because the `deletion` rule blocks removing a matching branch while the ruleset is active; removing them changed nothing about the measurement (`GET /repos/crisprintsstuff/OxyBook/rulesets` is an empty list, `GET /repos/crisprintsstuff/OxyBook/branches/ruleset-probe-test` is HTTP 404).

**Plain `git push`.** Not re-run here. The repo owner's unsigned push of `2b6d07cee53df072a7437659dbf1278e5d01de02` to `ruleset-probe-test` was rejected and the branch did not move. The remote error was:

`remote: error: GH013: Repository rule violations found for refs/heads/ruleset-probe-test. ... - Commits must have verified signatures. Found 1 violation: 2b6d07cee53df072a7437659dbf1278e5d01de02`

Before this session the branch head was `d284359f4d12f13bb17db60c7cd8fd0e9cf5027c` (`unsigned probe two`, verification `verified: false`, `reason: "unsigned"`). `GET /git/ref/heads/ruleset-probe-test` at the start of this session returned that same sha.

**Git Database API.** Same installation token as above. It is not the identity that made the rejected `git push`. The commit this API created is authored by `cursor[bot] <206951365+cursor[bot]@users.noreply.github.com>` and committed by `GitHub <noreply@github.com>`.

1. `GET /git/commits/d284359f4d12f13bb17db60c7cd8fd0e9cf5027c` tree sha `00c6e7d921eb192c2f6fe14e7c748df700665cf5`.
2. `POST /git/blobs` with content `oxybook git-database-api probe\n` and encoding `utf-8`. Blob sha `739e5f3c781b3b91b08a848b113c0855c9981645`.
3. `POST /git/trees` with that `base_tree` and one entry `docs/gdapi-probe.md`, mode `100644`, type `blob`. Tree sha `69b710d622a74d16b5fdb492c08ac5f7434c8751`. `truncated` was false.
4. `POST /git/commits` with message `gdapi probe: unsigned via git database api`, that tree, parent `d284359`, and no `signature` field. Commit sha `c915f0780c13f25cdf01870fcda216b721c576cf`. The response included verification.
5. `GET /git/commits/c915f0780c13f25cdf01870fcda216b721c576cf` and `GET /commits/c915f0780c13f25cdf01870fcda216b721c576cf` agree:

```json
{
  "verified": true,
  "reason": "valid",
  "verified_at": "2026-10-29T15:04:25Z"
}
```

`signature` is a non-null PGP signature. `payload` records the tree, the parent, the `cursor[bot]` author, and the `GitHub` committer. GitHub signed the object on the way in. The request did not supply a signature.

6. `PATCH /git/refs/heads/ruleset-probe-test` with `{"sha":"c915f0780c13f25cdf01870fcda216b721c576cf","force":false}` returned HTTP 200. Body:

```json
{
  "ref": "refs/heads/ruleset-probe-test",
  "node_id": "REF_kwDOVbb1Tr1yZWZzL2hlYWRzL3J1bGVzZXQtcHJvYmUtdGVzdA",
  "url": "https://api.github.com/repos/crisprintsstuff/OxyBook/git/refs/heads/ruleset-probe-test",
  "object": {
    "sha": "c915f0780c13f25cdf01870fcda216b721c576cf",
    "type": "commit",
    "url": "https://api.github.com/repos/crisprintsstuff/OxyBook/git/commits/c915f0780c13f25cdf01870fcda216b721c576cf"
  }
}
```

`force` was not set to true. A second identical PATCH, still `force: false`, also returned HTTP 200 because the ref was already on that sha. `GET /branches/ruleset-probe-test` then reported head `c915f0780c13f25cdf01870fcda216b721c576cf` and `verification.verified: true`, `reason: "valid"`.

`required_signatures` rejects an unsigned `git push`. It does not reject this Git Database API update, because GitHub attaches a valid signature before the ref moves. The fallback in ARCHITECTURE §4.3 works for an App token that GitHub will sign. It was not tested with a user token.

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

**Installation tokens against `api.github.com`.** The cache was tested with a fake HTTP response, not a real GitHub App. The ruleset probe above did use a real installation token for the Git Database calls. That does not exercise the cache.
