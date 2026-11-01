// SPDX-License-Identifier: AGPL-3.0-only

import { type NodeSpec, Schema } from 'prosemirror-model';

/**
 * The visual editor's ProseMirror schema. Node names and attributes mirror the editor
 * document model in `@oxybook/doc-model` (`EditorBlockNode`, `EditorInlineNode`), so its
 * JSON loads directly and edited blocks convert back without a translation table.
 * Content expressions are permissive on purpose: the bridge, not the schema, decides
 * what a file may contain, and a node the schema refused would force source mode.
 */

const srcId = { srcId: { default: null } };

const block = (spec: NodeSpec): NodeSpec => ({ group: 'block', ...spec });

export const schema = new Schema({
  nodes: {
    doc: { content: 'block*' },
    text: { group: 'inline' },

    paragraph: block({
      attrs: { ...srcId },
      content: 'inline*',
      parseDOM: [{ tag: 'p' }],
      toDOM: () => ['p', 0],
    }),
    heading: block({
      attrs: { ...srcId, level: { default: 1 }, style: { default: 'atx' } },
      content: 'inline*',
      defining: true,
      parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, attrs: { level } })),
      toDOM: (node) => [`h${node.attrs.level}`, 0],
    }),
    code_block: block({
      attrs: {
        ...srcId,
        language: { default: null },
        meta: { default: null },
        indented: { default: false },
      },
      content: 'text*',
      marks: '',
      code: true,
      defining: true,
      parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }],
      toDOM: (node) => [
        'pre',
        node.attrs.language ? { 'data-language': node.attrs.language } : {},
        ['code', 0],
      ],
    }),
    blockquote: block({
      attrs: { ...srcId },
      content: 'block*',
      defining: true,
      parseDOM: [{ tag: 'blockquote' }],
      toDOM: () => ['blockquote', 0],
    }),
    alert: block({
      attrs: { ...srcId, alertKind: { default: 'NOTE' } },
      content: 'block*',
      defining: true,
      toDOM: (node) => [
        'div',
        {
          class: `ob-alert ob-alert-${String(node.attrs.alertKind).toLowerCase()}`,
          'data-label': node.attrs.alertKind,
        },
        0,
      ],
    }),
    callout: block({
      attrs: {
        ...srcId,
        name: { default: 'note' },
        title: { default: null },
        openerLine: { default: null },
        closerLine: { default: null },
      },
      content: 'block*',
      defining: true,
      toDOM: (node) => [
        'div',
        {
          class: `ob-callout ob-callout-${node.attrs.name}`,
          'data-label': node.attrs.title
            ? `${node.attrs.name}: ${node.attrs.title}`
            : node.attrs.name,
        },
        0,
      ],
    }),
    bullet_list: block({
      attrs: { ...srcId, spread: { default: false } },
      content: 'list_item*',
      parseDOM: [{ tag: 'ul' }],
      toDOM: () => ['ul', 0],
    }),
    ordered_list: block({
      attrs: { ...srcId, start: { default: 1 }, spread: { default: false } },
      content: 'list_item*',
      parseDOM: [{ tag: 'ol' }],
      toDOM: (node) => ['ol', node.attrs.start === 1 ? {} : { start: node.attrs.start }, 0],
    }),
    task_list: block({
      attrs: { ...srcId, spread: { default: false } },
      content: 'list_item*',
      toDOM: () => ['ul', { class: 'ob-task-list' }, 0],
    }),
    list_item: {
      attrs: { checked: { default: null } },
      content: 'block*',
      defining: true,
      parseDOM: [{ tag: 'li' }],
      toDOM: (node) => [
        'li',
        node.attrs.checked === null ? {} : { 'data-checked': String(node.attrs.checked) },
        0,
      ],
    },
    table: block({
      attrs: { ...srcId, align: { default: [] } },
      content: 'table_row*',
      isolating: true,
      toDOM: () => ['table', ['tbody', 0]],
    }),
    table_row: { content: '(table_header | table_cell)*', toDOM: () => ['tr', 0] },
    table_header: { content: 'inline*', isolating: true, toDOM: () => ['th', 0] },
    table_cell: { content: 'inline*', isolating: true, toDOM: () => ['td', 0] },
    horizontal_rule: block({
      attrs: { ...srcId },
      parseDOM: [{ tag: 'hr' }],
      toDOM: () => ['hr'],
    }),
    raw_block: block({
      attrs: {
        ...srcId,
        source: { default: '' },
        kind: { default: 'unparsed' },
        label: { default: '' },
      },
      atom: true,
      selectable: true,
      draggable: true,
    }),

    hard_break: {
      group: 'inline',
      inline: true,
      selectable: false,
      attrs: { backslash: { default: false } },
      parseDOM: [{ tag: 'br' }],
      toDOM: () => ['br'],
    },
    image: {
      group: 'inline',
      inline: true,
      draggable: true,
      attrs: { src: { default: '' }, alt: { default: null }, title: { default: null } },
      parseDOM: [
        {
          tag: 'img[src]',
          getAttrs: (dom) => ({
            src: (dom as HTMLElement).getAttribute('src'),
            alt: (dom as HTMLElement).getAttribute('alt'),
            title: (dom as HTMLElement).getAttribute('title'),
          }),
        },
      ],
      toDOM: (node) => [
        'img',
        { src: node.attrs.src, alt: node.attrs.alt ?? '', title: node.attrs.title },
      ],
    },
    raw_inline: {
      group: 'inline',
      inline: true,
      atom: true,
      selectable: true,
      attrs: { source: { default: '' }, kind: { default: 'unparsed' }, label: { default: '' } },
    },
  },
  marks: {
    link: {
      attrs: {
        href: { default: '' },
        title: { default: null },
        referenceType: { default: null },
        identifier: { default: null },
      },
      inclusive: false,
      parseDOM: [
        {
          tag: 'a[href]',
          getAttrs: (dom) => ({
            href: (dom as HTMLElement).getAttribute('href'),
            title: (dom as HTMLElement).getAttribute('title'),
          }),
        },
      ],
      toDOM: (mark) => [
        'a',
        { href: mark.attrs.href, title: mark.attrs.title, rel: 'noopener noreferrer' },
        0,
      ],
    },
    strong: {
      parseDOM: [{ tag: 'strong' }, { tag: 'b' }],
      toDOM: () => ['strong', 0],
    },
    em: {
      parseDOM: [{ tag: 'em' }, { tag: 'i' }],
      toDOM: () => ['em', 0],
    },
    strike: {
      parseDOM: [{ tag: 's' }, { tag: 'del' }],
      toDOM: () => ['s', 0],
    },
    code: {
      parseDOM: [{ tag: 'code' }],
      toDOM: () => ['code', 0],
    },
  },
});
