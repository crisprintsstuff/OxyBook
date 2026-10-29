# M0 notes

Date of the measurements below: 2026-10-29. Git used for the conflict spike: 2.43.0. Node used to run the tests: 24.22.2.

This slice is the round-trip library and the scaffolding around it. It is not the M0 exit in [MVP.md](MVP.md). There is no database, no GitHub App, and no `oxybook-dev propose`. The editor, renderer, and publish path are not started.

## What `packages/doc-model` guarantees

- A `.md` file is parsed as CommonMark + GFM + YAML frontmatter + container directives. A `.mdx` file is that plus MDX 3. The MDX plugin is not attached for `.md`.
- A document is a list of top-level blocks. Each block stores its original source slice, the gap before it, and absolute offsets. Constructs the model does not treat as editable (JSX/MDX, raw HTML, HTML comments, unknown directives, link and footnote definitions, unpositioned syntax) keep that slice and are copied back unchanged.
- `serialize(parse(src))` equals `src` for every file that parses, including BOM, CRLF, mixed newlines, and unparseable frontmatter (the frontmatter bytes are kept; the keys are not editable).
- Frontmatter uses the `yaml` package's `Document` API with `keepSourceTokens`. Editing one scalar either changes only that scalar's bytes (comments, key order, anchors, and quoting around other keys stay) or throws. CRLF frontmatter is edited on an LF copy and spliced back, because `Document.toString()` rewrites every CRLF to LF.
- A plain-text insertion into one block changes only bytes inside that block's original range. Nested raw nodes are not offered as editable spans, so the insertion does not rewrite them.
- `checkIdentity` reports `pass`, `fail` (with the line, column, and snippet of the first divergence), or `unparseable`. `oxybook-roundtrip <dir>` prints one row per `.md` / `.mdx` file and exits non-zero only for `fail` or an unexpected crash. Unparseable files are listed and do not fail the process.
- Identity is equality of the JavaScript string. For valid UTF-8, including a BOM, that is the same as the file bytes. Invalid UTF-8 is reported unparseable instead of being rewritten through U+FFFD.

## What it does not guarantee

- It does not build a ProseMirror document. Blocks are plain data with the source slices the editor will need later.
- `reformatBlock` rebuilds one block from mdast using the file's style profile (bullet, emphasis, strong, fence, thematic-break marker). Inside that block the bytes may be normalized. Bytes outside it are not. The corpus and the property tests do not depend on reformat; text edits splice the original slice.
- A column-0 container (`:::name`, `:::name Title`, `::: name Title`, `:::name[Title]`) is one `callout` block from the opening line through the matching closer. The title is an attribute. Marker lines are not editable text spans, so a writer cannot split the container into paragraphs. Nested containers stay inside the outer block. An unclosed container is one raw block through EOF, not a parse error. `:::` inside fenced code, indented code, HTML, or MDX is ignored. Reformatting a callout is refused, because reprinting it would drop the `:::name Title` shape. Interior text of a closed known callout can still be spliced.
- It does not execute MDX, evaluate expressions, or resolve imports.
- It does not promise a safe edit inside a raw JSX or HTML node. Those spans are not listed.
- Overlapping text edits against the same original slice are the caller's problem. Edits are applied to the original block bytes, not to a previous edit.

## Corpus results

`pnpm test:corpus` on 2026-10-29. Repositories are fetched by the pinned SHA into `corpus/cache/` (gitignored), sparse-checkout of the docs path. Counts are files on disk at that SHA, not a GitHub tree listing.

| repo | sha | pass | fail | unparseable |
| --- | --- | --- | ---: | ---: |
| fixtures (`corpus/fixtures`) | — | 27 | 0 | 1 |
| docusaurus `website/docs` | `4e6fe61666a521d35d328ec0561d84eb96609017` | 89 | 0 | 0 |
| starlight `docs/src/content/docs` | `f1e9fa5ad4fbebd12caecebf1cad060349ef020e` | 338 | 0 | 0 |
| vitepress `docs/en` | `415a6a39507af37e282c02eb57ca50594f1bc237` | 36 | 0 | 0 |
| mkdocs `docs` | `2862536793b3c67d9d83c33e0dd6d50a791928f8` | 19 | 0 | 0 |
| mkdocs-material `docs` | `0f044dbe83cd52c8bcc4cf1e84536dcf9e16cdb3` | 85 | 0 | 0 |
| **total** | | **594** | **0** | **1** |

594 of 594 parseable files passed identity, re-measured after container directives with a title are folded into one callout. The six added fixtures (`callout-title`, `callout-tip`, `callout-nested`, `callout-blank-lines`, `callout-unclosed`, `callout-eof`) are in the fixture pass count. Repo counts are unchanged from the earlier 588-file run: the fold did not fail any fetched file. The one unparseable file is `corpus/fixtures/unterminated.mdx` (unclosed `<Tab>`), which is the source-mode case on purpose.

Nothing in the fetched Docusaurus, Starlight, VitePress, MkDocs, or Material for MkDocs trees failed identity or failed to parse. That includes MDX components, imports, expressions, directives, and MkDocs pages. It does not mean those constructs are editable. Most of them are raw slices. Adversarial fixtures that passed: CRLF, BOM, BOM+CRLF, mixed newlines, setext headings, reference-style links, nested lists with mixed markers, tables with escaped pipes, JSX inside a list (`.mdx`), HTML comments, frontmatter with comments and anchors, and a `.md` file that contains `import` and JSX (parsed as markdown, not MDX).

`oxybook-roundtrip` against the checked-out VitePress English docs reported `36 pass, 0 fail, 0 unparseable`.

## Where ARCHITECTURE.md was wrong or thin

Not edited. Corrections live here.

- **§3.4 parser choice.** The sentence reads as GFM + directives for `.md`, or `remark-mdx` instead of those for `.mdx`. MDX in this corpus uses tables and `:::note`. The parser uses `remark-mdx` plus GFM plus directives. `.md` still does not load `remark-mdx`.
- **§3.2 "syntax shared by Docusaurus, VitePress and Starlight".** `remark-directive` 4 parses `:::note` and `:::note[label]`, not `:::note Title` or `::: tip Title`. The folder in `src/callouts.ts` turns those into one callout after the remark parse, without rewriting bytes. Nested containers are not a tree of blocks; the outer block owns the inner bytes.
- **§3.4 "normalise line endings back to the detected style".** Doing that to the whole output would rewrite unedited slices in a mixed-ending file (`corpus/fixtures/mixed-newlines.md` passes only because original slices are copied). Newline conversion is applied to inserted edit text and to a reformatted block, not to the rest of the file.
- **§2.4 / §3.4 frontmatter.** `Document.toString()` with `keepSourceTokens: true` does preserve comments, order, anchors, and quoting on LF input, and an unchanged LF document stringifies back to itself when it already ends in a newline. It does not preserve CRLF. The scalar-only guarantee is implemented by diffing the LF serialization and splicing that span into the original YAML, and by refusing the edit if the diff leaves the scalar's range.
- **§3.4 block granularity.** The text says editing one item of a list re-serializes the list, and that recursive preservation is planned. Text edits splice the text node's own bytes when those bytes equal the mdast value (blockquote continuation markers, where the position covers a `>` the value does not, are not spliced). That is stricter than re-serializing the list. `reformatBlock` is the path that does re-serialize one block.
- **§4.5 `merge-tree --write-tree`.** On a content conflict and on a modify/delete it still prints a tree id and exits 1. The modify/delete tree contains the draft blob with no conflict markers. A caller that commits every tree it is given will resurrect a deleted file. The spike is in `spikes/conflicts/`.
- **LICENSING.md "anything not listed".** The root `Dockerfile` is therefore AGPL-3.0-only. `deploy/oxybook` is Apache-2.0 because it sits in `deploy/`. The table was not changed.
- **MVP.md M0 done-when.** Still open: schema and migrations, App Manifest flow, webhook verification, blobless mirror, push to `oxybook/*`, a CLI that opens a PR, and a note on signed-commit rulesets. This repo does not claim those.

## Docker

`docker-compose.yml` builds `Dockerfile` for `app` and `worker` (`oxybook server` / `oxybook worker`, `/healthz` on port 3000 and `HEALTH_PORT`). On 2026-10-29, after this note was first written, `docker compose up -d --build` did start that image. Inside the containers, app `GET /healthz` returned `200 {"ok":true,"service":"app"}` and worker `GET /healthz` returned `200 {"ok":true,"service":"worker"}`. postgres, caddy, mailpit, app, and worker all reported healthy. The stack was then removed. The README quickstart still says the image does not exist; that file was left unchanged on purpose. Details are in `STATUS.md`.

## What M1 should pick up first

1. The read path that this milestone did not start: accounts are out of scope for the first step, but a space pointed at a repo needs the mirror, the webhook, and a page stored as the git blob. The doc-model can already hand that blob back unchanged.
2. The H3 compatibility count (unknown components, imports, expressions, directives, `!!!` admonitions) over this same corpus. The identity result says the bytes survive. It says nothing about how many of them would render as placeholders.
