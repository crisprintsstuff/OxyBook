// SPDX-License-Identifier: AGPL-3.0-only

import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import type { EditorApi } from './api.ts';
import { type DiffFile, type DraftSummary, diffLines } from './model.ts';

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose(): void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog ref={ref} className="modal" onClose={onClose} aria-label={title}>
      <header>
        <h2>{title}</h2>
        <button type="button" className="link" onClick={onClose}>
          Close
        </button>
      </header>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}

/** The unified diff of the whole draft against its base: what a pull request would show. */
export function DiffModal({ api, onClose }: { api: EditorApi; onClose(): void }) {
  const [files, setFiles] = useState<DiffFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .diff()
      .then(setFiles)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [api]);
  return (
    <Modal title="Your changes" onClose={onClose}>
      {error && <div className="banner error">{error}</div>}
      {!files && !error && <p className="muted">Loading…</p>}
      {files?.length === 0 && <p className="muted">No changes.</p>}
      {files?.map((file) => (
        <section key={file.path} className="diff-file">
          <h3>
            <code>
              {file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ` : ''}
              {file.path}
            </code>{' '}
            <span className="badge">{file.op}</span>{' '}
            <span className="add-count">+{file.additions}</span>{' '}
            <span className="del-count">−{file.deletions}</span>
          </h3>
          {file.binary ? (
            <p className="muted">Binary file.</p>
          ) : (
            <pre className="diff">
              {diffLines(file.patch).map((line, i) => (
                // Lines of one patch never reorder, so the index is a stable key here.
                // biome-ignore lint/suspicious/noArrayIndexKey: see above.
                <div key={i} className={`diff-${line.kind}`}>
                  {line.text || ' '}
                </div>
              ))}
            </pre>
          )}
        </section>
      ))}
    </Modal>
  );
}

const POLL_MS = 2000;
const POLL_LIMIT_MS = 120_000;

/**
 * Propose / update the pull request. The server queues the `propose` job; this polls the
 * draft until the push lands or the job records an error.
 */
export function ProposeDialog({
  api,
  draft,
  defaultTitle,
  onClose,
  onDraft,
}: {
  api: EditorApi;
  draft: DraftSummary;
  defaultTitle: string;
  onClose(): void;
  onDraft(draft: DraftSummary | null): void;
}) {
  const [title, setTitle] = useState(defaultTitle);
  const [signOff, setSignOff] = useState(false);
  const [phase, setPhase] = useState<'form' | 'waiting' | 'done' | 'failed' | 'slow'>('form');
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<DraftSummary | null>(null);
  const titleId = useId();
  const signId = useId();
  const stopped = useRef(false);
  useEffect(
    () => () => {
      stopped.current = true;
    },
    [],
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPhase('waiting');
    setMessage(null);
    const before = draft.pushedSha;
    try {
      await api.propose(title, signOff);
    } catch (error) {
      setPhase('failed');
      setMessage(error instanceof Error ? error.message : String(error));
      return;
    }
    const deadline = Date.now() + POLL_LIMIT_MS;
    while (!stopped.current && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      let now: DraftSummary | null;
      try {
        now = await api.draft();
      } catch {
        continue;
      }
      if (now?.proposeError) {
        onDraft(now);
        setPhase('failed');
        setMessage(now.proposeError);
        return;
      }
      if (now?.state === 'conflicted') {
        onDraft(now);
        setPhase('failed');
        setMessage('The draft conflicts with new commits on its base branch.');
        return;
      }
      if (now?.prUrl && now.pushedSha && now.pushedSha !== before) {
        onDraft(now);
        setResult(now);
        setPhase('done');
        return;
      }
    }
    if (!stopped.current) setPhase('slow');
  }

  const updating = Boolean(draft.prUrl);
  return (
    <Modal title={updating ? 'Update pull request' : 'Propose changes'} onClose={onClose}>
      {phase === 'form' && (
        <form onSubmit={submit} className="propose-form">
          <p className="muted">
            {updating
              ? 'Your new changes are pushed to the same branch as a new commit.'
              : `OxyBook pushes your draft as one commit to a new oxybook/ branch and opens a pull request against ${draft.baseRef}. Review and merge happen on GitHub.`}
          </p>
          {!updating && (
            <>
              <label htmlFor={titleId}>Pull request title</label>
              <input
                id={titleId}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
                maxLength={200}
              />
            </>
          )}
          <div className="check">
            <input
              id={signId}
              type="checkbox"
              checked={signOff}
              onChange={(e) => setSignOff(e.target.checked)}
            />
            <label htmlFor={signId}>
              Add a <code>Signed-off-by</code> line (Developer Certificate of Origin): I certify
              that I have the right to submit this contribution under the project's license.
            </label>
          </div>
          <div className="actions">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={!title.trim()}>
              {updating ? 'Update pull request' : 'Propose'}
            </button>
          </div>
        </form>
      )}
      {phase === 'waiting' && <p>Pushing your changes and opening the pull request…</p>}
      {phase === 'done' && result?.prUrl && (
        <p>
          Done:{' '}
          <a href={result.prUrl} target="_blank" rel="noopener noreferrer">
            pull request #{result.prNumber}
          </a>
          .
        </p>
      )}
      {phase === 'failed' && <div className="banner error">{message}</div>}
      {phase === 'slow' && (
        <p className="muted">
          The propose job is still queued or running. The banner shows the pull request once it is
          open.
        </p>
      )}
    </Modal>
  );
}
