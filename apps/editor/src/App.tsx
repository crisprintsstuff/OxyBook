// SPDX-License-Identifier: AGPL-3.0-only

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, type EditorApi } from './api.ts';
import { DiffModal, ProposeDialog } from './dialogs.tsx';
import {
  altText,
  buildTreeRows,
  type DraftSummary,
  describeWarning,
  type FileOp,
  newPagePath,
  newPageSource,
  type PreviewResponse,
  type TreeResponse,
  uploadTarget,
} from './model.ts';
import { SourceEditor, type SourceEditorHandle } from './SourceEditor.tsx';

type SaveState =
  | { kind: 'saved' }
  | { kind: 'dirty' }
  | { kind: 'saving' }
  | { kind: 'conflict'; current: number }
  | { kind: 'error'; message: string };

interface OpenPage {
  path: string;
  /** The op a save of this page records: `modify` for a page on the base, `add` for a new one. */
  op: FileOp;
  baseBlobSha: string | null;
  initial: string;
  docKey: string;
  othersEditing: string[];
}

const SAVE_DELAY_MS = 800;
const PREVIEW_DELAY_MS = 400;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function App({ api }: { api: EditorApi }) {
  const [tree, setTree] = useState<TreeResponse | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftSummary | null>(null);
  const [page, setPage] = useState<OpenPage | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [save, setSave] = useState<SaveState>({ kind: 'saved' });
  const [showPreview, setShowPreview] = useState(true);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [dialog, setDialog] = useState<'diff' | 'propose' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const editor = useRef<SourceEditorHandle>(null);
  const pageRef = useRef<OpenPage | null>(null);
  const version = useRef<number | null>(null);
  const text = useRef('');
  const savedText = useRef('');
  const inFlight = useRef<Promise<void> | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const previewTimer = useRef<number | undefined>(undefined);
  const previewSeq = useRef(0);
  const loads = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);

  const canWrite = tree?.role === 'editor' || tree?.role === 'admin';

  const applyDraft = useCallback((next: DraftSummary | null) => {
    setDraft(next);
    version.current = next ? next.version : null;
  }, []);

  const refreshDraft = useCallback(async () => {
    applyDraft(await api.draft());
  }, [api, applyDraft]);

  const runPreview = useCallback(
    (path: string, content: string) => {
      const seq = ++previewSeq.current;
      api
        .preview(path, content)
        .then((result) => {
          if (seq === previewSeq.current) setPreview(result);
        })
        .catch((error) => {
          if (seq === previewSeq.current)
            setPreview({ parsed: false, error: errorText(error), html: '', warnings: [] });
        });
    },
    [api],
  );

  /** Make sure there is an open draft, and return its version. */
  const ensureDraft = useCallback(async (): Promise<number> => {
    if (version.current !== null) return version.current;
    const opened = await api.openDraft();
    applyDraft(opened);
    return opened.version;
  }, [api, applyDraft]);

  /** Save the open page if it changed; one save at a time, and saves again if typing went on. */
  const flush = useCallback(async (): Promise<void> => {
    window.clearTimeout(saveTimer.current);
    if (inFlight.current) await inFlight.current;
    const current = pageRef.current;
    if (!current || text.current === savedText.current) return;
    const content = text.current;
    const attempt = (async () => {
      setSave({ kind: 'saving' });
      try {
        let ifMatch = await ensureDraft();
        const file = {
          op: current.op,
          path: current.path,
          baseBlobSha: current.baseBlobSha,
          content,
        };
        let saved: number;
        try {
          saved = await api.saveFile(ifMatch, file);
        } catch (error) {
          // The draft was proposed and merged or closed meanwhile: start a new one.
          if (error instanceof ApiError && error.status === 409 && error.current === null) {
            await refreshDraft();
            ifMatch = await ensureDraft();
            saved = await api.saveFile(ifMatch, file);
          } else throw error;
        }
        version.current = saved;
        savedText.current = content;
        const known = draft?.files.some((f) => f.path === current.path);
        if (!known) await refreshDraft();
        else setDraft((d) => (d ? { ...d, version: saved } : d));
        setSave(text.current === savedText.current ? { kind: 'saved' } : { kind: 'dirty' });
      } catch (error) {
        if (error instanceof ApiError && error.status === 409 && error.current !== null) {
          setSave({ kind: 'conflict', current: error.current });
        } else {
          setSave({ kind: 'error', message: errorText(error) });
        }
      }
    })();
    inFlight.current = attempt;
    try {
      await attempt;
    } finally {
      inFlight.current = null;
    }
    if (text.current !== savedText.current && pageRef.current === current) {
      saveTimer.current = window.setTimeout(() => void flush(), SAVE_DELAY_MS);
    }
  }, [api, draft, ensureDraft, refreshDraft]);

  const loadPage = useCallback(
    async (path: string, fresh?: { op: FileOp; source: string }) => {
      await flush();
      setPageError(null);
      try {
        const loaded = fresh
          ? { path, source: fresh.source, baseBlobSha: null, othersEditing: [] }
          : await api.page(path);
        const next: OpenPage = {
          path,
          op: fresh?.op ?? (loaded.baseBlobSha ? 'modify' : 'add'),
          baseBlobSha: loaded.baseBlobSha,
          initial: loaded.source,
          docKey: `${path}#${++loads.current}`,
          othersEditing: loaded.othersEditing ?? [],
        };
        pageRef.current = next;
        text.current = loaded.source;
        // A new page is unsaved until its first save.
        savedText.current = fresh ? '\u0000' : loaded.source;
        setPage(next);
        setSave(fresh ? { kind: 'dirty' } : { kind: 'saved' });
        setPreview(null);
        runPreview(path, loaded.source);
        if (fresh) void flush();
        const url = new URL(window.location.href);
        url.searchParams.set('page', path);
        window.history.replaceState(null, '', url);
      } catch (error) {
        setPageError(errorText(error));
      }
    },
    [api, flush, runPreview],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: loads the space once per api; loadPage changes as the draft does.
  useEffect(() => {
    let cancelled = false;
    api
      .tree()
      .then((loaded) => {
        if (cancelled) return;
        setTree(loaded);
        applyDraft(loaded.draft);
        const wanted = new URL(window.location.href).searchParams.get('page');
        const first =
          loaded.pages.find((p) => p.path === wanted) ??
          loaded.pages.find((p) => !p.hidden) ??
          loaded.pages[0];
        if (wanted && !loaded.pages.some((p) => p.path === wanted)) void loadPage(wanted);
        else if (first) void loadPage(first.path);
      })
      .catch((error) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 401) {
          window.location.assign('/login');
          return;
        }
        setFatal(
          error instanceof ApiError && error.status === 404
            ? 'There is no such space, or you are not a member of it.'
            : errorText(error),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (text.current !== savedText.current || inFlight.current) {
        void flush();
        event.preventDefault();
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [flush]);

  const onChange = useCallback(
    (next: string) => {
      text.current = next;
      const current = pageRef.current;
      if (!current) return;
      if (canWrite) {
        setSave((s) => (s.kind === 'conflict' ? s : { kind: 'dirty' }));
        window.clearTimeout(saveTimer.current);
        saveTimer.current = window.setTimeout(() => void flush(), SAVE_DELAY_MS);
      }
      window.clearTimeout(previewTimer.current);
      previewTimer.current = window.setTimeout(
        () => runPreview(current.path, text.current),
        PREVIEW_DELAY_MS,
      );
    },
    [canWrite, flush, runPreview],
  );

  const rows = useMemo(
    () =>
      tree
        ? buildTreeRows({
            pages: tree.pages,
            draft,
            contentRoot: tree.space.contentRoot,
            filter,
          })
        : [],
    [tree, draft, filter],
  );

  async function keepMine() {
    if (save.kind !== 'conflict') return;
    version.current = save.current;
    setSave({ kind: 'dirty' });
    await flush();
  }

  async function loadLatest() {
    const current = pageRef.current;
    if (!current) return;
    savedText.current = text.current;
    await refreshDraft();
    await loadPage(current.path);
  }

  async function newPage() {
    if (!tree) return;
    const typed = window.prompt(
      `New page, relative to ${tree.space.contentRoot || 'the repository root'}:`,
      'new-page.md',
    );
    if (typed === null) return;
    const result = newPagePath(typed, tree.space.contentRoot);
    if ('error' in result) {
      setNotice(result.error);
      return;
    }
    if (tree.pages.some((p) => p.path === result.path)) {
      await loadPage(result.path);
      return;
    }
    await loadPage(result.path, { op: 'add', source: newPageSource(result.path) });
  }

  async function revertPage() {
    const current = pageRef.current;
    if (!current || version.current === null) return;
    if (!window.confirm(`Drop your changes to ${current.path}?`)) return;
    window.clearTimeout(saveTimer.current);
    if (inFlight.current) await inFlight.current;
    try {
      version.current = await api.revertFile(version.current, current.path);
      savedText.current = text.current;
      await refreshDraft();
      if (current.op === 'add') {
        pageRef.current = null;
        setPage(null);
      } else await loadPage(current.path);
    } catch (error) {
      setNotice(errorText(error));
    }
  }

  async function discardDraft() {
    if (version.current === null) return;
    if (!window.confirm('Discard your whole draft? Every unproposed change is lost.')) return;
    window.clearTimeout(saveTimer.current);
    if (inFlight.current) await inFlight.current;
    try {
      await api.discard(version.current);
      savedText.current = text.current;
      applyDraft(null);
      const current = pageRef.current;
      if (current && current.op !== 'add') await loadPage(current.path);
      else {
        pageRef.current = null;
        setPage(null);
      }
      setNotice('Draft discarded.');
    } catch (error) {
      setNotice(errorText(error));
    }
  }

  async function uploadImage(file: File) {
    const current = pageRef.current;
    if (!current) return;
    const target = uploadTarget(current.path, file.name);
    try {
      await flush();
      const ifMatch = await ensureDraft();
      version.current = await api.upload(ifMatch, target.path, file);
      await refreshDraft();
      editor.current?.insert(`![${altText(file.name)}](${target.reference})`);
      setNotice(`Uploaded ${target.path}. It is part of your draft.`);
    } catch (error) {
      setNotice(`Upload failed: ${errorText(error)}`);
    }
  }

  if (fatal) {
    return (
      <div className="fatal">
        <h1>OxyBook editor</h1>
        <p>{fatal}</p>
        <p>
          <a href="/">Back to the dashboard</a>
        </p>
      </div>
    );
  }
  if (!tree) return <div className="loading">Loading…</div>;

  const spaceHref = `/orgs/${encodeURIComponent(api.org)}/spaces/${encodeURIComponent(api.space)}`;
  const mine = draft?.files.find((f) => f.path === page?.path);
  const changeCount = draft?.files.length ?? 0;

  return (
    <div className="editor">
      <header className="topbar">
        <a className="brand" href={spaceHref}>
          ← {tree.space.name}
        </a>
        <span className="muted">
          on <code>{tree.space.ref}</code>
        </span>
        <span className="spacer" />
        {canWrite ? <SaveBadge save={save} /> : <span className="badge">read-only</span>}
        <button type="button" onClick={() => setShowPreview((v) => !v)}>
          {showPreview ? 'Hide preview' : 'Show preview'}
        </button>
        {canWrite && (
          <>
            <button
              type="button"
              disabled={changeCount === 0}
              onClick={() => void flush().then(() => setDialog('diff'))}
            >
              Changes ({changeCount})
            </button>
            <button
              type="button"
              className="primary"
              disabled={changeCount === 0}
              onClick={() => void flush().then(() => setDialog('propose'))}
            >
              {draft?.prUrl ? 'Update pull request' : 'Propose changes'}
            </button>
          </>
        )}
        <span className="muted user">{tree.user.name}</span>
      </header>

      {draft && <DraftBanner draft={draft} onDiscard={canWrite ? discardDraft : undefined} />}
      {save.kind === 'conflict' && (
        <div className="banner warn">
          Your draft changed in another tab or window (now version {save.current}).{' '}
          <button type="button" onClick={() => void keepMine()}>
            Keep this tab's text
          </button>{' '}
          <button type="button" onClick={() => void loadLatest()}>
            Load the saved text
          </button>
        </div>
      )}
      {save.kind === 'error' && <div className="banner error">Not saved: {save.message}</div>}
      {notice && (
        <div className="banner info">
          {notice}{' '}
          <button type="button" className="link" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}
      {!canWrite && (
        <div className="banner info">
          You can read this space. Editing needs the editor or admin role.
        </div>
      )}

      <div className={`panes${showPreview ? ' with-preview' : ''}`}>
        <nav className="sidebar" aria-label="Pages">
          <input
            type="search"
            placeholder="Find a page"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Find a page"
          />
          {canWrite && (
            <button type="button" className="new-page" onClick={() => void newPage()}>
              + New page
            </button>
          )}
          <ul>
            {rows.map((row) =>
              row.kind === 'dir' ? (
                <li key={row.key} className="dir" style={{ paddingLeft: `${row.depth * 12}px` }}>
                  {row.name}/
                </li>
              ) : (
                <li key={row.key} style={{ paddingLeft: `${row.depth * 12}px` }}>
                  <button
                    type="button"
                    className={`page-link${page?.path === row.path ? ' active' : ''}${row.hidden ? ' hidden-page' : ''}`}
                    onClick={() => void loadPage(row.path)}
                    title={row.path}
                  >
                    {row.label}
                    {row.mine && (
                      <span
                        className={`mark mark-${row.mine}`}
                        title={`In your draft: ${row.mine}`}
                      >
                        {row.mine === 'add' ? '+' : row.mine === 'delete' ? '−' : '●'}
                      </span>
                    )}
                    {row.othersEditing.length > 0 && (
                      <span
                        className="mark others"
                        title={`Open drafts: ${row.othersEditing.join(', ')}`}
                      >
                        ✎{row.othersEditing.length}
                      </span>
                    )}
                  </button>
                </li>
              ),
            )}
          </ul>
        </nav>

        <main className="main">
          {pageError && <div className="banner error">{pageError}</div>}
          {page ? (
            <>
              <div className="pagebar">
                <code>{page.path}</code>
                {page.op === 'add' && <span className="badge">new</span>}
                {page.othersEditing.length > 0 && (
                  <span className="badge warn">
                    {page.othersEditing.join(', ')} also{' '}
                    {page.othersEditing.length === 1 ? 'has' : 'have'} an open draft on this page
                  </span>
                )}
                <span className="spacer" />
                <span className="badge">source</span>
                {canWrite && (
                  <>
                    <button type="button" onClick={() => fileInput.current?.click()}>
                      Insert image
                    </button>
                    <input
                      ref={fileInput}
                      type="file"
                      accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml,image/avif"
                      hidden
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (file) void uploadImage(file);
                      }}
                    />
                    {mine && (
                      <button type="button" onClick={() => void revertPage()}>
                        Revert page
                      </button>
                    )}
                  </>
                )}
              </div>
              <SourceEditor
                ref={editor}
                docKey={page.docKey}
                initial={page.initial}
                readOnly={!canWrite}
                onChange={onChange}
              />
            </>
          ) : (
            <p className="empty muted">Pick a page on the left.</p>
          )}
        </main>

        {showPreview && (
          <aside className="preview" aria-label="Preview">
            <PreviewPane preview={preview} />
          </aside>
        )}
      </div>

      {dialog === 'diff' && <DiffModal api={api} onClose={() => setDialog(null)} />}
      {dialog === 'propose' && draft && (
        <ProposeDialog
          api={api}
          draft={draft}
          defaultTitle={defaultTitle(tree, draft)}
          onClose={() => setDialog(null)}
          onDraft={applyDraft}
        />
      )}
    </div>
  );
}

function defaultTitle(tree: TreeResponse, draft: DraftSummary): string {
  const pages = draft.files.filter((f) => /\.mdx?$/i.test(f.path));
  if (pages.length === 1 && pages[0]) {
    const known = tree.pages.find((p) => p.path === pages[0]?.path);
    return `Edit ${known?.title || pages[0].path}`;
  }
  return `Edit ${draft.files.length} files`;
}

function SaveBadge({ save }: { save: SaveState }) {
  const text =
    save.kind === 'saved'
      ? 'Saved'
      : save.kind === 'dirty'
        ? 'Unsaved changes'
        : save.kind === 'saving'
          ? 'Saving…'
          : save.kind === 'conflict'
            ? 'Changed elsewhere'
            : 'Not saved';
  return (
    <span className={`badge save-${save.kind}`} role="status">
      {text}
    </span>
  );
}

function DraftBanner({
  draft,
  onDiscard,
}: {
  draft: DraftSummary;
  onDiscard: (() => Promise<void>) | undefined;
}) {
  return (
    <div className={`banner ${draft.state === 'conflicted' ? 'warn' : 'info'}`}>
      {draft.state === 'conflicted' ? (
        <>
          Your draft conflicts with new commits on <code>{draft.baseRef}</code>. Fix the conflicting
          page in source mode, or discard the draft. (A block-level conflict view comes later.)
        </>
      ) : draft.prUrl ? (
        <>
          Proposed as{' '}
          <a href={draft.prUrl} target="_blank" rel="noopener noreferrer">
            pull request #{draft.prNumber}
          </a>
          . Further edits stay in your draft until you update the pull request.
        </>
      ) : (
        <>
          Your draft has {draft.files.length} changed {draft.files.length === 1 ? 'file' : 'files'}.
          Nothing reaches GitHub until you propose.
        </>
      )}
      {draft.proposeError && <> Last propose failed: {draft.proposeError}</>}
      {onDiscard && (
        <>
          {' '}
          <button type="button" className="link" onClick={() => void onDiscard()}>
            Discard draft
          </button>
        </>
      )}
    </div>
  );
}

const PREVIEW_STYLE = `
  body { font: 16px/1.6 system-ui, sans-serif; margin: 0; padding: 16px 20px; color: #1f2328; }
  pre { background: #f6f8fa; padding: 12px; overflow: auto; border-radius: 6px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }
  table { border-collapse: collapse; } td, th { border: 1px solid #d0d7de; padding: 4px 8px; }
  img { max-width: 100%; }
  blockquote { margin: 0; padding-left: 12px; border-left: 4px solid #d0d7de; color: #59636e; }
  .shiki span { color: var(--shiki-light); }
  [data-oxybook-placeholder], .oxybook-placeholder { border: 1px dashed #bf8700; padding: 6px; }
`;

function PreviewPane({ preview }: { preview: PreviewResponse | null }) {
  if (!preview) return <p className="muted">Rendering…</p>;
  // The preview iframe is sandboxed with no permissions: no scripts, no same-origin access.
  const doc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>${PREVIEW_STYLE}</style></head><body>${preview.html}</body></html>`;
  return (
    <>
      {preview.error && <div className="banner warn">{preview.error}</div>}
      {preview.warnings.length > 0 && (
        <ul className="warnings">
          {preview.warnings.map((w) => (
            <li key={`${w.reason}:${w.line}:${w.name ?? w.href ?? ''}`}>{describeWarning(w)}</li>
          ))}
        </ul>
      )}
      <iframe title="Page preview" sandbox="" srcDoc={doc} />
    </>
  );
}
