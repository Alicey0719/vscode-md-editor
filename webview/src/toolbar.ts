import type { Crepe } from '@milkdown/crepe';
import { commandsCtx, editorViewCtx } from '@milkdown/core';
import type { EditorState, Transaction } from '@milkdown/prose/state';
import { lift } from '@milkdown/prose/commands';
import {
  toggleStrongCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  wrapInHeadingCommand,
  wrapInBulletListCommand,
  wrapInOrderedListCommand,
  wrapInBlockquoteCommand,
  createCodeBlockCommand,
  turnIntoTextCommand,
  insertHrCommand,
  liftListItemCommand,
} from '@milkdown/preset-commonmark';
import {
  toggleStrikethroughCommand,
  insertTableCommand,
} from '@milkdown/preset-gfm';
import { undoCommand, redoCommand } from '@milkdown/kit/plugin/history';

type CmdKey<T> = { key: string } & { _payload?: T };

export interface ToolbarActions {
  // Opens Crepe's inline URL editor: prefilled when the caret is in a link.
  editLink: () => void;
  insertImage: () => void;
}

export interface Toolbar {
  root: HTMLElement;
  // Reflect the selection: active marks / blocks and the current text style.
  refresh: (state: EditorState) => void;
}

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const mod = isMac ? '⌘' : 'Ctrl+';

export function createToolbar(crepe: Crepe, actions: ToolbarActions): Toolbar {
  const bar = document.createElement('div');
  bar.className = 'md-toolbar';
  const trackers: Array<(state: EditorState) => void> = [];

  const focusEditor = () => {
    crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      if (!view.hasFocus()) view.focus();
    });
  };

  const call: Callable = (cmd, payload) => {
    focusEditor();
    crepe.editor.action((ctx) => {
      ctx.get(commandsCtx).call((cmd as CmdKey<unknown>).key, payload);
    });
  };

  const runOnView: RunOnView = (fn) => {
    focusEditor();
    crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      fn(view.state, view.dispatch);
    });
  };

  // Toggle button: highlighted while `isActive` holds for the selection.
  const toggle = (parent: HTMLElement, svgOrText: string, label: string, isActive: (s: EditorState) => boolean, onClick: () => void) => {
    const b = iconBtn(parent, svgOrText, label, onClick);
    trackers.push((state) => {
      const active = isActive(state);
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-pressed', String(active));
    });
  };

  const history = group();
  iconBtn(history, icon.undo, `Undo (${mod}Z)`, () => call(undoCommand));
  iconBtn(history, icon.redo, `Redo (${isMac ? '⇧⌘Z' : 'Ctrl+Y'})`, () => call(redoCommand));
  bar.appendChild(history);
  bar.appendChild(divider());

  const style = styleDropdown(call, runOnView);
  trackers.push(style.refresh);
  bar.appendChild(style.root);
  bar.appendChild(divider());

  const marks = group();
  toggle(marks, icon.bold, `Bold (${mod}B)`, markActive('strong'), () => call(toggleStrongCommand));
  toggle(marks, icon.italic, `Italic (${mod}I)`, markActive('emphasis'), () => call(toggleEmphasisCommand));
  toggle(marks, icon.strike, 'Strikethrough', markActive('strike_through'), () => call(toggleStrikethroughCommand));
  toggle(marks, icon.code, 'Inline code', markActive('inlineCode'), () => call(toggleInlineCodeCommand));
  bar.appendChild(marks);
  bar.appendChild(divider());

  const blocks = group();
  const inBullet = inNode('bullet_list');
  const inOrdered = inNode('ordered_list');
  const inQuote = inNode('blockquote');
  const inCode = (s: EditorState) => s.selection.$from.parent.type.name === 'code_block';
  toggle(blocks, icon.ul, 'Bullet list', inBullet, () => call(innermostList(crepe) === 'bullet_list' ? liftListItemCommand : wrapInBulletListCommand));
  toggle(blocks, icon.ol, 'Numbered list', inOrdered, () => call(innermostList(crepe) === 'ordered_list' ? liftListItemCommand : wrapInOrderedListCommand));
  toggle(blocks, icon.quote, 'Blockquote', inQuote, () => (isActiveNow(crepe, inQuote) ? runOnView(lift) : call(wrapInBlockquoteCommand)));
  toggle(blocks, icon.codeBlock, 'Code block', inCode, () => call(isActiveNow(crepe, inCode) ? turnIntoTextCommand : createCodeBlockCommand));
  bar.appendChild(blocks);
  bar.appendChild(divider());

  const insert = group();
  toggle(insert, icon.link, `Link (${mod}K)`, markActive('link'), actions.editLink);
  iconBtn(insert, icon.image, 'Insert image', actions.insertImage);
  iconBtn(insert, icon.table, 'Insert table', () => call(insertTableCommand));
  iconBtn(insert, icon.hr, 'Horizontal rule', () => call(insertHrCommand));
  bar.appendChild(insert);

  return {
    root: bar,
    refresh: (state) => {
      for (const t of trackers) t(state);
    },
  };
}

function divider(): HTMLElement {
  const d = document.createElement('span');
  d.className = 'md-toolbar-divider';
  return d;
}

function group(): HTMLElement {
  const g = document.createElement('div');
  g.className = 'md-toolbar-group';
  return g;
}

interface Callable {
  <T>(cmd: unknown, payload?: T): void;
}

type RunOnView = (fn: (state: EditorState, dispatch: (tr: Transaction) => void) => boolean) => void;

function markActive(name: string) {
  return (state: EditorState): boolean => {
    const type = state.schema.marks[name];
    if (!type) return false;
    const { from, to, empty, $from } = state.selection;
    if (empty) return Boolean(type.isInSet(state.storedMarks ?? $from.marks()));
    return state.doc.rangeHasMark(from, to, type);
  };
}

function inNode(name: string) {
  return (state: EditorState): boolean => {
    const { $from } = state.selection;
    for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === name) return true;
    return false;
  };
}

function innermostList(crepe: Crepe): string | null {
  return crepe.editor.action((ctx) => {
    const { $from } = ctx.get(editorViewCtx).state.selection;
    for (let d = $from.depth; d > 0; d--) {
      const name = $from.node(d).type.name;
      if (name === 'bullet_list' || name === 'ordered_list') return name;
    }
    return null;
  });
}

function isActiveNow(crepe: Crepe, test: (s: EditorState) => boolean): boolean {
  return crepe.editor.action((ctx) => test(ctx.get(editorViewCtx).state));
}

function iconBtn(
  parent: HTMLElement,
  svgOrText: string,
  label: string,
  onClick: () => void,
): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'md-toolbar-btn';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.innerHTML = svgOrText;
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', onClick);
  parent.appendChild(b);
  return b;
}

function styleDropdown(call: Callable, runOnView: RunOnView): { root: HTMLElement; refresh: (state: EditorState) => void } {
  const wrap = document.createElement('label');
  wrap.className = 'md-toolbar-style';
  const select = document.createElement('select');
  select.className = 'md-toolbar-select';
  select.title = 'Text style';
  const options: Array<{ value: string; label: string }> = [
    { value: 'p', label: 'Normal text' },
    { value: 'h1', label: 'Heading 1' },
    { value: 'h2', label: 'Heading 2' },
    { value: 'h3', label: 'Heading 3' },
    { value: 'h4', label: 'Heading 4' },
    { value: 'h5', label: 'Heading 5' },
    { value: 'h6', label: 'Heading 6' },
    { value: 'quote', label: 'Quote' },
    { value: 'code', label: 'Code block' },
    // Shown when the selection is not in a text block (image, table, ...).
    { value: '', label: '—' },
  ];
  for (const o of options) {
    const el = document.createElement('option');
    el.value = o.value;
    el.textContent = o.label;
    if (o.value === '') el.hidden = true;
    select.appendChild(el);
  }
  let inQuote = false;
  select.addEventListener('mousedown', (e) => e.stopPropagation());
  select.addEventListener('change', () => {
    const v = select.value;
    if (v === 'p') {
      call(turnIntoTextCommand);
      if (inQuote) runOnView(lift);
    } else if (/^h[1-6]$/.test(v)) {
      call(wrapInHeadingCommand, Number(v.slice(1)));
    } else if (v === 'quote') {
      call(wrapInBlockquoteCommand);
    } else if (v === 'code') {
      call(createCodeBlockCommand);
    }
    select.blur();
  });
  wrap.appendChild(select);

  const refresh = (state: EditorState) => {
    const { $from } = state.selection;
    const parent = $from.parent;
    inQuote = inNode('blockquote')(state);
    let value = '';
    if (parent.type.name === 'heading') value = `h${parent.attrs.level}`;
    else if (parent.type.name === 'code_block') value = 'code';
    else if (parent.type.name === 'paragraph') value = inQuote ? 'quote' : 'p';
    if (select.value !== value) select.value = value;
  };
  return { root: wrap, refresh };
}

// Simple monochrome icons (currentColor). Compact SVG paths chosen for legibility
// on 16-20px buttons in both light and dark themes.
const svg = (path: string): string =>
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;

const icon = {
  undo: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
  redo: svg('<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>'),
  bold: '<span class="md-toolbar-glyph" style="font-weight:700">B</span>',
  italic: '<span class="md-toolbar-glyph" style="font-style:italic;font-family:serif">I</span>',
  strike: '<span class="md-toolbar-glyph" style="text-decoration:line-through">S</span>',
  code: svg('<polyline points="8 6 3 12 8 18"/><polyline points="16 6 21 12 16 18"/>'),
  ul: svg('<line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="4.5" cy="6" r="1.2"/><circle cx="4.5" cy="12" r="1.2"/><circle cx="4.5" cy="18" r="1.2"/>'),
  ol: svg('<line x1="10" y1="6" x2="20" y2="6"/><line x1="10" y1="12" x2="20" y2="12"/><line x1="10" y1="18" x2="20" y2="18"/><text x="3" y="8" font-size="6" fill="currentColor" stroke="none">1</text><text x="3" y="14" font-size="6" fill="currentColor" stroke="none">2</text><text x="3" y="20" font-size="6" fill="currentColor" stroke="none">3</text>'),
  quote: svg('<path d="M7 8h4v6a4 4 0 0 1-4 4"/><path d="M15 8h4v6a4 4 0 0 1-4 4"/>'),
  codeBlock: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><polyline points="9 9 6 12 9 15"/><polyline points="15 9 18 12 15 15"/>'),
  link: svg('<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>'),
  image: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m21 16-5-5-9 9"/>'),
  table: svg('<rect x="3" y="4" width="18" height="16" rx="1"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="3" y1="16" x2="21" y2="16"/><line x1="9" y1="4" x2="9" y2="20"/><line x1="15" y1="4" x2="15" y2="20"/>'),
  hr: svg('<line x1="4" y1="12" x2="20" y2="12"/>'),
};
