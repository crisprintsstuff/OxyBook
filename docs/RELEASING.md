# Releasing

OxyBook is released as a git tag, a container image, and a GitHub release. `.github/workflows/release.yml` does the work when a tag is pushed; a maintainer decides when.

## Versions

- `v0.MINOR.PATCH` until 1.0. Every `0.x` release is a GitHub pre-release, and any `0.x` may break things; the release notes say what.
- A new feature or anything that needs a migration bumps `MINOR` (`v0.1.0` → `v0.2.0`). A fix-only release bumps `PATCH`.
- A test build before a release gets a suffix, such as `v0.2.0-rc.1`. Suffixed tags do not move `latest`.
- Never move or reuse a tag that has been pushed. Fix forward with the next patch version.

## Cutting a release

1. `main` is green on CI, and `STATUS.md` matches what is in it.
2. Tag the `main` commit and push the tag:

   ```sh
   git checkout main && git pull
   git tag -a v0.1.0 -m "OxyBook v0.1.0"
   git push origin v0.1.0
   ```

3. Watch **Actions → Release**. It runs the CI checks, builds `ghcr.io/crisprintsstuff/oxybook` for `linux/amd64` and `linux/arm64` (tags `0.1.0`, `0.1`, and `latest` unless the version has a suffix), and creates a **draft** release with notes generated from the merged pull requests.
4. Try the image: follow the README's **Try it** with the new version on a clean machine or a fresh clone with `docker compose down -v` first. At minimum: services healthy, `/healthz` reports the version, sign in, open **Edit pages**.
5. Edit the draft: a few lines on what is new and what is known broken, then **Publish release**.

### First release only

The first push creates the `oxybook` package on GitHub's container registry as **private**. On the repository page, open **Packages → oxybook → Package settings**, set **Change visibility** to public, and check that the package is linked to this repository. Until then, `docker compose pull` fails for anyone but you.

## If the workflow fails

Nothing is published until the image job succeeds, and the release is a draft until a maintainer publishes it. Fix the cause on `main`, then release the next patch version. If the image was pushed but the release step failed, create the release by hand from the tag (**Releases → Draft a new release**).
