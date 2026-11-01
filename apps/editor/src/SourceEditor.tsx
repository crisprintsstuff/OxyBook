// SPDX-License-Identifier: AGPL-3.0-only

import { markdown } from '@codemirror/lang-markdown';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { darkScheme, editorTheme } from './theme.ts';

/** What the page can do to either editor (source or visual) from outside. */
export interface PageEditorHandle {
  /** Insert an image reference at the cursor and focus the editor. */
  insertImage(src: string, alt: string): void;
}

export type SourceEditorHandle = PageEditorHandle;

interface Props {
  /** A new document identity (path + load count) resets the editor and its undo history. */
  docKey: string;
  initial: string;
  readOnly: boolean;
  onChange(text: string): void;
}

/**
 * Source mode: CodeMirror 6 on the raw file (ARCHITECTURE §3.3). The bytes it shows are
 * the bytes that are saved; nothing is normalised on the way in or out.
 */
export const SourceEditor = forwardRef<SourceEditorHandle, Props>(function SourceEditor(
  { docKey, initial, readOnly, onChange },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const editable = useRef(new Compartment());
  const theme = useRef(new Compartment());
  const changed = useRef(onChange);
  changed.current = onChange;

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new docKey is the only reset; `initial` and `readOnly` are read once per document.
  useEffect(() => {
    if (!host.current) return;
    const created = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initial,
        extensions: [
          basicSetup,
          markdown(),
          EditorView.lineWrapping,
          theme.current.of(editorTheme(darkScheme())),
          editable.current.of([
            EditorState.readOnly.of(readOnly),
            EditorView.editable.of(!readOnly),
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) changed.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = created;
    return () => {
      created.destroy();
      view.current = null;
    };
  }, [docKey]);

  useEffect(() => {
    view.current?.dispatch({
      effects: editable.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly]);

  // Follow the system colour scheme while the page is open.
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () =>
      view.current?.dispatch({ effects: theme.current.reconfigure(editorTheme(query.matches)) });
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, []);

  useImperativeHandle(ref, () => ({
    insertImage(src: string, alt: string) {
      const v = view.current;
      if (!v) return;
      v.dispatch(v.state.replaceSelection(`![${alt}](${src})`));
      v.focus();
    },
  }));

  return <div className="source-editor" ref={host} />;
});
