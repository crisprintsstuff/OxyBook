// SPDX-License-Identifier: AGPL-3.0-only

import { useCallback, useEffect, useState } from 'react';
import { ApiError, type EditorApi, type Resolution } from './api.ts';
import { Modal } from './dialogs.tsx';
import {
  type ConflictView,
  type DraftSummary,
  displayBlock,
  type FileConflict,
  type RegionChoice,
  resolvedText,
} from './model.ts';

type FileState =
  | { kind: 'regions'; choices: (RegionChoice | undefined)[]; editing: (string | null)[] }
  | { kind: 'choice'; take: 'keep-mine' | 'take-theirs' | undefined };

function initial(file: FileConflict): FileState {
  return file.kind === 'regions'
    ? {
        kind: 'regions',
        choices: Array(file.conflicts).fill(undefined),
        editing: Array(file.conflicts).fill(null),
      }
    : { kind: 'choice', take: undefined };
}

function complete(state: FileState): boolean {
  if (state.kind === 'choice') return state.take !== undefined;
  return state.choices.every((c) => c !== undefined);
}

function toResolution(file: FileConflict, state: FileState): Resolution | null {
  if (state.kind === 'choice') return state.take ? { path: file.path, take: state.take } : null;
  if (file.conflicts === 0) return null; // merged block by block; nothing to choose
  return { path: file.path, choices: state.choices as RegionChoice[] };
}

/**
 * The block-level conflict view (ARCHITECTURE §4.5): each conflicting block side by side,
 * keep mine / take theirs / edit, structural conflicts as an explicit choice, a preview
 * of the result, and GitHub as the way out.
 */
export function ConflictDialog({
  api,
  draft,
  baseRef,
  onClose,
  onResolved,
}: {
  api: EditorApi;
  draft: DraftSummary;
  baseRef: string;
  onClose(): void;
  onResolved(draft: DraftSummary): void;
}) {
  const [view, setView] = useState<ConflictView | null>(null);
  const [states, setStates] = useState<FileState[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const next = await api.conflicts();
      setView(next);
      setStates(next.files.map(initial));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const update = (index: number, next: FileState) =>
    setStates((all) => all.map((s, i) => (i === index ? next : s)));

  const ready =
    view !== null && view.files.length === states.length && states.every((s) => complete(s));

  async function apply() {
    if (!view) return;
    setBusy(true);
    setError(null);
    try {
      const resolutions = view.files.flatMap((f, i) => {
        const r = toResolution(f, states[i] as FileState);
        return r ? [r] : [];
      });
      onResolved(await api.resolve(view.version, view.head, resolutions));
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setError(`${e.message} The conflicts were reloaded; check them again.`);
        await load();
      } else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Resolve conflicts" onClose={onClose}>
      <p className="muted">
        New commits on <code>{baseRef}</code> changed the same parts of these files as your draft.
        Blocks only one side changed are merged for you; choose for the rest.
        {draft.prUrl && (
          <>
            {' '}
            You can also resolve them on{' '}
            <a href={draft.prUrl} target="_blank" rel="noopener noreferrer">
              the pull request
            </a>
            .
          </>
        )}
      </p>
      {error && <div className="banner error">{error}</div>}
      {!view && !error && <p className="muted">Loading…</p>}
      {view?.files.length === 0 && <p>No conflicts left.</p>}
      {view?.files.map((file, index) => {
        const state = states[index];
        if (!state) return null;
        return (
          <section key={file.path} className="conflict-file">
            <h3>
              <code>{file.path}</code> <span className="badge warn">{file.why}</span>
            </h3>
            {state.kind === 'choice' ? (
              <ChoiceConflict
                file={file}
                take={state.take}
                onTake={(take) => update(index, { kind: 'choice', take })}
              />
            ) : (
              <RegionsConflict file={file} state={state} onChange={(next) => update(index, next)} />
            )}
          </section>
        );
      })}
      <div className="actions">
        <button type="button" onClick={onClose}>
          Later
        </button>
        <button
          type="button"
          className="primary"
          disabled={!ready || busy}
          onClick={() => void apply()}
        >
          {busy ? 'Applying…' : 'Apply resolution'}
        </button>
      </div>
    </Modal>
  );
}

function ChoiceConflict({
  file,
  take,
  onTake,
}: {
  file: FileConflict;
  take: 'keep-mine' | 'take-theirs' | undefined;
  onTake(take: 'keep-mine' | 'take-theirs'): void;
}) {
  const label = {
    'keep-mine': file.code === 'edited-upstream' ? 'Delete it anyway' : 'Keep my version',
    'take-theirs':
      file.code === 'deleted-upstream' || file.code === 'rename-source-gone'
        ? 'Drop my change (it was removed upstream)'
        : 'Use the upstream version',
  };
  return (
    <div className="choice-conflict">
      <div className="sides">
        <div>
          <h4>Your draft</h4>
          <pre>{file.mine ?? (file.op === 'delete' ? '(deleted)' : '(binary)')}</pre>
        </div>
        <div>
          <h4>Upstream</h4>
          <pre>{file.theirs ?? '(not there)'}</pre>
        </div>
      </div>
      {file.choices.map((choice) => (
        <label key={choice} className="check">
          <input
            type="radio"
            name={`take-${file.path}`}
            checked={take === choice}
            onChange={() => onTake(choice)}
          />
          <span>{label[choice]}</span>
        </label>
      ))}
    </div>
  );
}

function RegionsConflict({
  file,
  state,
  onChange,
}: {
  file: FileConflict;
  state: Extract<FileState, { kind: 'regions' }>;
  onChange(next: FileState): void;
}) {
  const regions = file.regions ?? [];
  const merged = regions.filter(
    (r) => r.kind === 'mine' || r.kind === 'theirs' || r.kind === 'both',
  ).length;
  const preview = resolvedText(regions, state.choices);
  let conflictIndex = -1;
  const set = (i: number, choice: RegionChoice | undefined, editing: string | null) =>
    onChange({
      kind: 'regions',
      choices: state.choices.map((c, j) => (j === i ? choice : c)),
      editing: state.editing.map((e, j) => (j === i ? editing : e)),
    });
  return (
    <div>
      <p className="muted">
        {file.conflicts === 0
          ? 'The changes are in different blocks, so they merge block by block. Nothing to choose.'
          : `${file.conflicts} conflicting ${file.conflicts === 1 ? 'block' : 'blocks'}`}
        {merged > 0 ? `; ${merged} merged automatically.` : '.'}
      </p>
      {regions.map((region, r) => {
        if (region.kind !== 'conflict') return null;
        conflictIndex++;
        const i = conflictIndex;
        const choice = state.choices[i];
        const editing = state.editing[i] ?? null;
        // The blank lines that separate this block from the one before stay as they were;
        // the text box holds only the block.
        const gap = /^(\r?\n)*/.exec(region.mine || region.theirs)?.[0] ?? '';
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: regions of one file never reorder.
          <div key={r} className="conflict-region">
            <div className="sides">
              <div className={choice === 'mine' ? 'picked' : ''}>
                <h4>Your draft</h4>
                <pre>{displayBlock(region.mine) || '(removed)'}</pre>
              </div>
              <div className={choice === 'theirs' ? 'picked' : ''}>
                <h4>Upstream</h4>
                <pre>{displayBlock(region.theirs) || '(removed)'}</pre>
              </div>
            </div>
            <div className="region-actions">
              <button
                type="button"
                className={choice === 'mine' ? 'on' : ''}
                onClick={() => set(i, 'mine', null)}
              >
                Keep mine
              </button>
              <button
                type="button"
                className={choice === 'theirs' ? 'on' : ''}
                onClick={() => set(i, 'theirs', null)}
              >
                Take theirs
              </button>
              <button
                type="button"
                className={editing !== null ? 'on' : ''}
                onClick={() => {
                  const start =
                    typeof choice === 'object'
                      ? displayBlock(choice.text)
                      : displayBlock(region.mine);
                  set(i, { text: gap + start }, start);
                }}
              >
                Edit
              </button>
            </div>
            {editing !== null && (
              <textarea
                aria-label={`Resolved text for conflict ${i + 1}`}
                value={editing}
                rows={Math.min(12, editing.split('\n').length + 1)}
                onChange={(e) => set(i, { text: gap + e.target.value }, e.target.value)}
              />
            )}
          </div>
        );
      })}
      {preview !== null && (
        <details className="conflict-preview">
          <summary>Preview the result</summary>
          <pre>{preview}</pre>
        </details>
      )}
    </div>
  );
}
