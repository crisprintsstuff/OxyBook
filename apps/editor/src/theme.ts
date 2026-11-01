// SPDX-License-Identifier: AGPL-3.0-only

import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

/**
 * Source-mode colours in the dashboard's palette (GitHub's light and dark tokens), so the
 * editor follows the system colour scheme like the rest of the app.
 */

export const darkScheme = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;

function chrome(dark: boolean): Extension {
  const c = dark
    ? {
        bg: '#0d1117',
        fg: '#e6edf3',
        gutter: '#0d1117',
        gutterFg: '#6e7681',
        active: 'rgba(110, 118, 129, 0.1)',
        selection: 'rgba(56, 139, 253, 0.35)',
        cursor: '#e6edf3',
        border: '#30363d',
        panel: '#161b22',
        match: 'rgba(187, 128, 9, 0.4)',
      }
    : {
        bg: '#ffffff',
        fg: '#1f2328',
        gutter: '#ffffff',
        gutterFg: '#8c959f',
        active: 'rgba(234, 238, 242, 0.5)',
        selection: 'rgba(84, 174, 255, 0.4)',
        cursor: '#1f2328',
        border: '#d0d7de',
        panel: '#f6f8fa',
        match: 'rgba(212, 167, 44, 0.4)',
      };
  return EditorView.theme(
    {
      '&': { color: c.fg, backgroundColor: c.bg },
      '.cm-content': { caretColor: c.cursor },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: c.cursor },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
        { backgroundColor: c.selection },
      '.cm-activeLine': { backgroundColor: c.active },
      '.cm-activeLineGutter': { backgroundColor: c.active, color: c.fg },
      '.cm-gutters': {
        backgroundColor: c.gutter,
        color: c.gutterFg,
        borderRight: `1px solid ${c.border}`,
      },
      '.cm-searchMatch': { backgroundColor: c.match },
      '.cm-panels': { backgroundColor: c.panel, color: c.fg },
      '.cm-tooltip': { backgroundColor: c.panel, color: c.fg, border: `1px solid ${c.border}` },
      '.cm-foldPlaceholder': { backgroundColor: c.panel, color: c.gutterFg, border: 'none' },
    },
    { dark },
  );
}

function highlight(dark: boolean): Extension {
  const c = dark
    ? {
        heading: '#79c0ff',
        keyword: '#ff7b72',
        string: '#a5d6ff',
        tag: '#7ee787',
        attr: '#79c0ff',
        link: '#a5d6ff',
        url: '#8b949e',
        meta: '#8b949e',
        quote: '#8b949e',
        code: '#ffa657',
      }
    : {
        heading: '#0550ae',
        keyword: '#cf222e',
        string: '#0a3069',
        tag: '#116329',
        attr: '#0550ae',
        link: '#0a3069',
        url: '#59636e',
        meta: '#59636e',
        quote: '#59636e',
        code: '#953800',
      };
  return syntaxHighlighting(
    HighlightStyle.define([
      { tag: t.heading, color: c.heading, fontWeight: '600' },
      { tag: t.strong, fontWeight: '600' },
      { tag: t.emphasis, fontStyle: 'italic' },
      { tag: t.strikethrough, textDecoration: 'line-through' },
      { tag: [t.link, t.labelName], color: c.link, textDecoration: 'underline' },
      { tag: t.url, color: c.url },
      { tag: t.monospace, color: c.code },
      { tag: t.quote, color: c.quote, fontStyle: 'italic' },
      { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: c.meta },
      { tag: [t.keyword, t.operator], color: c.keyword },
      { tag: [t.string, t.special(t.string)], color: c.string },
      { tag: [t.tagName, t.angleBracket], color: c.tag },
      { tag: t.attributeName, color: c.attr },
      { tag: [t.comment, t.lineComment, t.blockComment], color: c.meta, fontStyle: 'italic' },
      { tag: [t.number, t.bool, t.null], color: c.heading },
    ]),
  );
}

export function editorTheme(dark: boolean): Extension {
  return [chrome(dark), highlight(dark)];
}
