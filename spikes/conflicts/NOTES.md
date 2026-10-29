# H2 spike: what git actually does with concurrent doc edits

Recorded against git 2.43 on a scratch repository. Re-run with `pnpm test` (the assertions live in `conflicts.test.ts`; the files in `recorded/` are the stable byte fixtures). This is not production merge code.

The page under test is three paragraphs, `alpha` / `beta` / `gamma`. The draft changes `beta` to `beta draft`.

## Same paragraph

`git merge-file` exits 1 and writes conflict markers around that paragraph only. The default style has no base section. `git merge-tree --write-tree` also exits 1, still emits a tree id, and with `merge.conflictStyle=diff3` the blob contains `<<<<<<<`, `|||||||` (the base paragraph), and `>>>>>>>`.

That tree must not be committed. The markers are the raw material for the later block-level view, not a result to push. Paragraphs are single lines here, so the conflict region lines up with one block. A multi-line paragraph would still be one conflict hunk; M3 has to map hunks back onto blocks rather than assume one line is one block.

## Different paragraph

Both `merge-file` and `merge-tree` exit 0. The result contains `beta draft` and `gamma upstream`. This is the "updated with changes from main" case. Nothing outside the two touched paragraphs moves.

## Upstream rename

`merge-tree --write-tree` exits 0. The tree has `docs/guide.md` and not `docs/page.md`, and the blob is the draft text. Rename detection applied the draft edit onto the new path.

A draft keyed only by the old path cannot see this if it only runs `merge-file` on `docs/page.md`. The worker has to look at the tree (or `git diff -M`) and retarget the draft onto `docs/guide.md` when the merge is clean. If the upstream rewrite is large enough that rename detection misses, this collapses into the delete case below.

## Upstream delete

`merge-tree` exits 1 with `CONFLICT (modify/delete)`. The tree it writes still contains `docs/page.md`, and the blob is the draft with no conflict markers. Exit status is the only signal that the merge is not safe.

Taking that tree because it exists would resurrect a file the upstream deleted and would drop the deletion without asking. A non-zero merge must not be auto-applied. The choice is keep-ours (recreate) or take-theirs (drop the draft's file), and it has to be explicit.

## Someone else pushed to the PR branch

`git push --force-with-lease=refs/heads/oxybook/demo:<our last sha>` is rejected (`stale info`) and the remote tip does not move. After fetching that tip, `merge-tree --write-tree` between our follow-up and their commit is clean when the edits are in different places. `commit-tree` with their commit as first parent and ours as second, then a normal push, fast-forwards the branch. Both commits stay reachable. History was not rewritten.

The lease has to name the sha we last pushed. A bare `--force-with-lease` without the expected sha is a weaker check. Conflict on this merge stops the push the same way a content conflict does; it does not justify a force push.
