// SPDX-License-Identifier: AGPL-3.0-only

import 'prosemirror-view/style/prosemirror.css';
import 'prosemirror-gapcursor/style/gapcursor.css';
import type { KnownFrontmatterKey } from '@oxybook/doc-model/editor';
import { baseKeymap, lift, setBlockType, toggleMark, wrapIn } from 'prosemirror-commands';
import { dropCursor } from 'prosemirror-dropcursor';
import { gapCursor } from 'prosemirror-gapcursor';
import { history, redo, undo } from 'prosemirror-history';
import { inputRules, textblockTypeInputRule, wrappingInputRule } from 'prosemirror-inputrules';
import { keymap } from 'prosemirror-keymap';
import type { MarkType, NodeType, Node as PmNode } from 'prosemirror-model';
import { liftListItem, sinkListItem, splitListItem, wrapInList } from 'prosemirror-schema-list';
import { type Command, EditorState, type Transaction } from 'prosemirror-state';
import { EditorView, type NodeView } from 'prosemirror-view';
import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Modal } from '../dialogs.tsx';
import { relativeLink } from '../model.ts';
import type { PageEditorHandle } from '../SourceEditor.tsx';
import { openVisual, serializeVisual, setFrontmatter, type VisualSession } from './bridge.ts';
import { schema } from './schema.ts';

const n = schema.nodes;
const m = schema.marks;

interface Props {
  docKey: string;
  initial: string;
  path: string;
  readOnly: boolean;
  pages: { path: string; title: string }[];
  onChange(text: string): void;
  /** The page cannot be shown visually; the parent switches to source mode. */
  onFallback(reason: string): void;
}

function markActive(state: EditorState, type: MarkType): boolean {
  const { from, $from, to, empty } = state.selection;
  if (empty) return Boolean(type.isInSet(state.storedMarks ?? $from.marks()));
  return state.doc.rangeHasMark(from, to, type);
}

function blockActive(state: EditorState, type: NodeType, attrs?: Record<string, unknown>): boolean {
  const { $from } = state.selection;
  const parent = $from.parent;
  if (parent.type !== type) return false;
  return !attrs || Object.entries(attrs).every(([key, value]) => parent.attrs[key] === value);
}

function inside(state: EditorState, type: NodeType): boolean {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type === type) return true;
  return false;
}

/** Read-only view of a construct the visual editor does not edit (ARCHITECTURE §3.3). */
function rawBlockView(node: PmNode): NodeView {
  const dom = document.createElement('div');
  dom.className = 'ob-raw';
  dom.contentEditable = 'false';
  const head = document.createElement('div');
  head.className = 'ob-raw-label';
  head.textContent = node.attrs.label || `${node.attrs.kind}: kept as is`;
  const pre = document.createElement('pre');
  pre.textContent = node.attrs.source;
  dom.append(head, pre);
  return { dom, ignoreMutation: () => true };
}

function rawInlineView(node: PmNode): NodeView {
  const dom = document.createElement('span');
  dom.className = 'ob-raw-inline';
  dom.contentEditable = 'false';
  dom.title = `${node.attrs.label || node.attrs.kind}: kept as is; edit in source mode`;
  dom.textContent = node.attrs.source;
  return { dom, ignoreMutation: () => true };
}

/** Repository images are not served to the editor, so an image shows as a labelled chip. */
function imageView(node: PmNode): NodeView {
  const dom = document.createElement('span');
  dom.className = 'ob-image';
  dom.contentEditable = 'false';
  dom.textContent = `🖼 ${node.attrs.alt || 'image'}`;
  dom.title = node.attrs.src;
  return { dom, ignoreMutation: () => true };
}

function buildPlugins() {
  const rules = inputRules({
    rules: [
      textblockTypeInputRule(/^(#{1,6})\s$/, n.heading as NodeType, (match) => ({
        level: (match[1] as string).length,
      })),
      wrappingInputRule(/^\s*([-+*])\s$/, n.bullet_list as NodeType),
      wrappingInputRule(
        /^(\d+)\.\s$/,
        n.ordered_list as NodeType,
        (match) => ({ start: Number(match[1]) }),
        (match, node) => node.childCount + (node.attrs.start as number) === Number(match[1]),
      ),
      wrappingInputRule(/^\s*>\s$/, n.blockquote as NodeType),
      textblockTypeInputRule(/^```([\w-]+)?\s$/, n.code_block as NodeType, (match) => ({
        language: match[1] ?? null,
      })),
    ],
  });
  const listItem = n.list_item as NodeType;
  const hardBreak: Command = (state, dispatch) => {
    dispatch?.(state.tr.replaceSelectionWith((n.hard_break as NodeType).create()).scrollIntoView());
    return true;
  };
  return [
    rules,
    keymap({
      'Mod-z': undo,
      'Shift-Mod-z': redo,
      'Mod-y': redo,
      'Mod-b': toggleMark(m.strong as MarkType),
      'Mod-i': toggleMark(m.em as MarkType),
      'Mod-`': toggleMark(m.code as MarkType),
      'Shift-Enter': hardBreak,
      Enter: splitListItem(listItem),
      'Mod-[': liftListItem(listItem),
      'Mod-]': sinkListItem(listItem),
      Tab: sinkListItem(listItem),
      'Shift-Tab': liftListItem(listItem),
    }),
    keymap(baseKeymap),
    history(),
    dropCursor(),
    gapCursor(),
  ];
}

/**
 * The visual editor: ProseMirror on the doc-model bridge. Every change is serialized
 * through the bridge, so blocks the user did not touch keep their exact bytes.
 */
export const VisualEditor = forwardRef<PageEditorHandle, Props>(function VisualEditor(
  { docKey, initial, path, readOnly, pages, onChange, onFallback },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const session = useRef<VisualSession | null>(null);
  const changed = useRef(onChange);
  changed.current = onChange;
  const [, setTick] = useState(0);
  const [linkOpen, setLinkOpen] = useState(false);
  const plugins = useMemo(buildPlugins, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new docKey is the only reset; the rest is read once per document.
  useEffect(() => {
    if (!host.current) return;
    const opened = openVisual(initial, path);
    if (opened.mode === 'source-only') {
      onFallback(opened.reason);
      return;
    }
    session.current = opened.session;
    const created = new EditorView(host.current, {
      state: EditorState.create({ doc: opened.doc, plugins }),
      editable: () => !readOnly,
      nodeViews: {
        raw_block: rawBlockView,
        raw_inline: rawInlineView,
        image: imageView,
      },
      dispatchTransaction(tr: Transaction) {
        const next = created.state.apply(tr);
        created.updateState(next);
        if (tr.docChanged && session.current) {
          changed.current(serializeVisual(session.current, next.doc));
        }
        setTick((t) => t + 1);
      },
    });
    view.current = created;
    setTick((t) => t + 1);
    return () => {
      created.destroy();
      view.current = null;
      session.current = null;
    };
  }, [docKey]);

  useImperativeHandle(ref, () => ({
    insertImage(src: string, alt: string) {
      const v = view.current;
      if (!v) return;
      const image = (n.image as NodeType).create({ src, alt });
      v.dispatch(v.state.tr.replaceSelectionWith(image).scrollIntoView());
      v.focus();
    },
  }));

  const v = view.current;
  const state = v?.state;
  const run = (command: Command) => () => {
    if (!v) return;
    command(v.state, v.dispatch, v);
    v.focus();
  };
  const toolbar =
    !readOnly && state ? (
      <div className="vtoolbar" role="toolbar" aria-label="Formatting">
        <select
          aria-label="Block type"
          value={
            blockActive(state, n.heading as NodeType)
              ? `h${state.selection.$from.parent.attrs.level}`
              : blockActive(state, n.code_block as NodeType)
                ? 'code'
                : 'p'
          }
          onChange={(e) => {
            const value = e.target.value;
            if (value === 'p') run(setBlockType(n.paragraph as NodeType))();
            else if (value === 'code') run(setBlockType(n.code_block as NodeType))();
            else
              run(
                setBlockType(n.heading as NodeType, {
                  level: Number(value.slice(1)),
                  style: 'atx',
                }),
              )();
          }}
        >
          <option value="p">Paragraph</option>
          <option value="h1">Heading 1</option>
          <option value="h2">Heading 2</option>
          <option value="h3">Heading 3</option>
          <option value="h4">Heading 4</option>
          <option value="code">Code block</option>
        </select>
        <Tool
          label="Bold"
          short="B"
          active={markActive(state, m.strong as MarkType)}
          onClick={run(toggleMark(m.strong as MarkType))}
        />
        <Tool
          label="Italic"
          short="I"
          active={markActive(state, m.em as MarkType)}
          onClick={run(toggleMark(m.em as MarkType))}
        />
        <Tool
          label="Strikethrough"
          short="S"
          active={markActive(state, m.strike as MarkType)}
          onClick={run(toggleMark(m.strike as MarkType))}
        />
        <Tool
          label="Inline code"
          short="</>"
          active={markActive(state, m.code as MarkType)}
          onClick={run(toggleMark(m.code as MarkType))}
        />
        <Tool
          label={markActive(state, m.link as MarkType) ? 'Remove link' : 'Link'}
          short="🔗"
          active={markActive(state, m.link as MarkType)}
          onClick={() => {
            if (markActive(state, m.link as MarkType)) run(toggleMark(m.link as MarkType))();
            else setLinkOpen(true);
          }}
        />
        <span className="vsep" />
        <Tool
          label="Bulleted list"
          short="•"
          active={inside(state, n.bullet_list as NodeType)}
          onClick={run(wrapInList(n.bullet_list as NodeType))}
        />
        <Tool
          label="Numbered list"
          short="1."
          active={inside(state, n.ordered_list as NodeType)}
          onClick={run(wrapInList(n.ordered_list as NodeType))}
        />
        <Tool
          label="Quote"
          short="❝"
          active={inside(state, n.blockquote as NodeType)}
          onClick={run(wrapIn(n.blockquote as NodeType))}
        />
        <Tool label="Lift out of list or quote" short="⇤" active={false} onClick={run(lift)} />
        <Tool
          label="Horizontal rule"
          short="―"
          active={false}
          onClick={run((s, dispatch) => {
            dispatch?.(
              s.tr.replaceSelectionWith((n.horizontal_rule as NodeType).create()).scrollIntoView(),
            );
            return true;
          })}
        />
        <span className="vsep" />
        <Tool label="Undo" short="↶" active={false} onClick={run(undo)} />
        <Tool label="Redo" short="↷" active={false} onClick={run(redo)} />
      </div>
    ) : null;

  return (
    <div className="visual-wrap">
      {session.current && (
        <MetadataPanel
          key={docKey}
          session={session.current}
          readOnly={readOnly}
          onChange={(key, value) => {
            const s = session.current;
            const current = view.current;
            if (!s || !current) return;
            setFrontmatter(s, key, value);
            changed.current(serializeVisual(s, current.state.doc));
            setTick((t) => t + 1);
          }}
        />
      )}
      {toolbar}
      <div className="visual-editor" ref={host} />
      {linkOpen && (
        <LinkDialog
          pages={pages}
          fromPath={path}
          onClose={() => {
            setLinkOpen(false);
            view.current?.focus();
          }}
          onPick={(href, text) => {
            setLinkOpen(false);
            const current = view.current;
            if (!current) return;
            const link = (m.link as MarkType).create({ href });
            const { from, to, empty } = current.state.selection;
            const tr = empty
              ? current.state.tr.insert(from, schema.text(text || href, [link]))
              : current.state.tr.addMark(from, to, link);
            current.dispatch(tr.scrollIntoView());
            current.focus();
          }}
        />
      )}
    </div>
  );
});

function Tool({
  label,
  short,
  active,
  onClick,
}: {
  label: string;
  short: string;
  active: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      className={`vtool${active ? ' on' : ''}`}
      title={label}
      aria-label={label}
      aria-pressed={active}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {short}
    </button>
  );
}

const FIELDS: { key: Exclude<KnownFrontmatterKey, 'hidden'>; label: string }[] = [
  { key: 'title', label: 'Title' },
  { key: 'nav_title', label: 'Sidebar title' },
  { key: 'description', label: 'Description' },
  { key: 'slug', label: 'URL slug' },
];

/** The page's known frontmatter keys (ARCHITECTURE §2.4); every other key is read-only. */
function MetadataPanel({
  session,
  readOnly,
  onChange,
}: {
  session: VisualSession;
  readOnly: boolean;
  onChange(key: KnownFrontmatterKey, value: string | boolean): void;
}) {
  const fm = session.frontmatter;
  const [values, setValues] = useState(() =>
    Object.fromEntries(FIELDS.map((f) => [f.key, fm.known[f.key] ?? ''])),
  );
  const id = useId();
  if (fm.exists && !fm.parseable) {
    return (
      <details className="meta">
        <summary>Page settings</summary>
        <p className="muted">
          This page's frontmatter is not valid YAML, so it is kept as is. Edit it in source mode.
        </p>
      </details>
    );
  }
  const commit = (key: Exclude<KnownFrontmatterKey, 'hidden'>) => {
    const value = values[key] ?? '';
    if (value === (fm.known[key] ?? '')) return;
    onChange(key, value);
  };
  return (
    <details className="meta">
      <summary>
        Page settings{fm.known.title ? `: ${fm.known.title}` : ''}
        {fm.known.hidden ? ' (hidden)' : ''}
      </summary>
      <div className="meta-grid">
        {FIELDS.map((f) => (
          <label key={f.key} htmlFor={`${id}-${f.key}`}>
            <span>{f.label}</span>
            <input
              id={`${id}-${f.key}`}
              value={values[f.key] ?? ''}
              readOnly={readOnly}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              onBlur={() => commit(f.key)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
            />
          </label>
        ))}
        <label htmlFor={`${id}-hidden`} className="meta-check">
          <input
            id={`${id}-hidden`}
            type="checkbox"
            checked={fm.known.hidden === true}
            disabled={readOnly}
            onChange={(e) => onChange('hidden', e.target.checked)}
          />
          <span>Hide from the sidebar and search</span>
        </label>
      </div>
      {fm.unknownKeys.length > 0 && (
        <div className="meta-unknown">
          <span className="muted">Other keys, kept as is:</span>
          <ul>
            {fm.unknownKeys.map((entry) => (
              <li key={entry.key}>
                <code>
                  {entry.key}: {entry.rawValue}
                </code>
              </li>
            ))}
          </ul>
        </div>
      )}
    </details>
  );
}

/** A link: either a URL, or another page as a relative file path (ARCHITECTURE §2.5). */
function LinkDialog({
  pages,
  fromPath,
  onClose,
  onPick,
}: {
  pages: { path: string; title: string }[];
  fromPath: string;
  onClose(): void;
  onPick(href: string, text: string): void;
}) {
  const [url, setUrl] = useState('');
  const [filter, setFilter] = useState('');
  const id = useId();
  const needle = filter.trim().toLowerCase();
  const shown = pages
    .filter((p) => p.path !== fromPath)
    .filter(
      (p) =>
        !needle || p.title.toLowerCase().includes(needle) || p.path.toLowerCase().includes(needle),
    )
    .slice(0, 50);
  return (
    <Modal title="Insert link" onClose={onClose}>
      <form
        className="link-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim()) onPick(url.trim(), '');
        }}
      >
        <label htmlFor={`${id}-url`}>Web address</label>
        <div className="link-row">
          <input
            id={`${id}-url`}
            type="url"
            placeholder="https://"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button type="submit" className="primary" disabled={!url.trim()}>
            Link
          </button>
        </div>
      </form>
      <label htmlFor={`${id}-page`}>Or a page in this space</label>
      <input
        id={`${id}-page`}
        type="search"
        placeholder="Find a page"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <ul className="link-pages">
        {shown.map((p) => (
          <li key={p.path}>
            <button
              type="button"
              className="page-link"
              onClick={() => onPick(relativeLink(fromPath, p.path), p.title)}
            >
              {p.title} <code className="muted">{relativeLink(fromPath, p.path)}</code>
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
