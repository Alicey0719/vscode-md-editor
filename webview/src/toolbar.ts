import type { Crepe } from '@milkdown/crepe';
import { commandsCtx, editorViewCtx } from '@milkdown/core';
import {
  toggleStrongCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleLinkCommand,
  wrapInHeadingCommand,
  wrapInBulletListCommand,
  wrapInOrderedListCommand,
  wrapInBlockquoteCommand,
  createCodeBlockCommand,
  turnIntoTextCommand,
  insertHrCommand,
} from '@milkdown/preset-commonmark';
import {
  toggleStrikethroughCommand,
  insertTableCommand,
} from '@milkdown/preset-gfm';

type CmdKey<T> = { key: string } & { _payload?: T };

export interface Toolbar {
  root: HTMLElement;
}

export function createToolbar(crepe: Crepe): Toolbar {
  const bar = document.createElement('div');
  bar.className = 'md-toolbar';

  const focusEditor = () => {
    crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      if (!view.hasFocus()) view.focus();
    });
  };

  const call = <T,>(cmd: unknown, payload?: T) => {
    focusEditor();
    crepe.editor.action((ctx) => {
      ctx.get(commandsCtx).call((cmd as CmdKey<T>).key, payload);
    });
  };

  bar.appendChild(styleDropdown(call));
  bar.appendChild(divider());
  bar.appendChild(markGroup(call));
  bar.appendChild(divider());
  bar.appendChild(blockGroup(call));
  bar.appendChild(divider());
  bar.appendChild(insertGroup(call));

  return { root: bar };
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

function styleDropdown(call: Callable): HTMLElement {
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
    { value: 'quote', label: 'Quote' },
    { value: 'code', label: 'Code block' },
  ];
  for (const o of options) {
    const el = document.createElement('option');
    el.value = o.value;
    el.textContent = o.label;
    select.appendChild(el);
  }
  select.addEventListener('mousedown', (e) => e.stopPropagation());
  select.addEventListener('change', () => {
    switch (select.value) {
      case 'p': call(turnIntoTextCommand); break;
      case 'h1': call(wrapInHeadingCommand, 1); break;
      case 'h2': call(wrapInHeadingCommand, 2); break;
      case 'h3': call(wrapInHeadingCommand, 3); break;
      case 'h4': call(wrapInHeadingCommand, 4); break;
      case 'quote': call(wrapInBlockquoteCommand); break;
      case 'code': call(createCodeBlockCommand); break;
    }
    select.value = 'p';
    select.blur();
  });
  wrap.appendChild(select);
  return wrap;
}

function markGroup(call: Callable): HTMLElement {
  const g = group();
  iconBtn(g, icon.bold, 'Bold (Ctrl+B)', () => call(toggleStrongCommand));
  iconBtn(g, icon.italic, 'Italic (Ctrl+I)', () => call(toggleEmphasisCommand));
  iconBtn(g, icon.strike, 'Strikethrough', () => call(toggleStrikethroughCommand));
  iconBtn(g, icon.code, 'Inline code', () => call(toggleInlineCodeCommand));
  return g;
}

function blockGroup(call: Callable): HTMLElement {
  const g = group();
  iconBtn(g, icon.ul, 'Bullet list', () => call(wrapInBulletListCommand));
  iconBtn(g, icon.ol, 'Numbered list', () => call(wrapInOrderedListCommand));
  iconBtn(g, icon.quote, 'Blockquote', () => call(wrapInBlockquoteCommand));
  iconBtn(g, icon.codeBlock, 'Code block', () => call(createCodeBlockCommand));
  return g;
}

function insertGroup(call: Callable): HTMLElement {
  const g = group();
  iconBtn(g, icon.link, 'Link', () => {
    const href = window.prompt('Link URL');
    if (href) call(toggleLinkCommand, { href, title: '' });
  });
  iconBtn(g, icon.table, 'Insert table', () => call(insertTableCommand));
  iconBtn(g, icon.hr, 'Horizontal rule', () => call(insertHrCommand));
  return g;
}

// Simple monochrome icons (currentColor). Compact SVG paths chosen for legibility
// on 16-20px buttons in both light and dark themes.
const svg = (path: string): string =>
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;

const icon = {
  bold: '<span class="md-toolbar-glyph" style="font-weight:700">B</span>',
  italic: '<span class="md-toolbar-glyph" style="font-style:italic;font-family:serif">I</span>',
  strike: '<span class="md-toolbar-glyph" style="text-decoration:line-through">S</span>',
  code: svg('<polyline points="8 6 3 12 8 18"/><polyline points="16 6 21 12 16 18"/>'),
  ul: svg('<line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="4.5" cy="6" r="1.2"/><circle cx="4.5" cy="12" r="1.2"/><circle cx="4.5" cy="18" r="1.2"/>'),
  ol: svg('<line x1="10" y1="6" x2="20" y2="6"/><line x1="10" y1="12" x2="20" y2="12"/><line x1="10" y1="18" x2="20" y2="18"/><text x="3" y="8" font-size="6" fill="currentColor" stroke="none">1</text><text x="3" y="14" font-size="6" fill="currentColor" stroke="none">2</text><text x="3" y="20" font-size="6" fill="currentColor" stroke="none">3</text>'),
  quote: svg('<path d="M7 8h4v6a4 4 0 0 1-4 4"/><path d="M15 8h4v6a4 4 0 0 1-4 4"/>'),
  codeBlock: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><polyline points="9 9 6 12 9 15"/><polyline points="15 9 18 12 15 15"/>'),
  link: svg('<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>'),
  table: svg('<rect x="3" y="4" width="18" height="16" rx="1"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="3" y1="16" x2="21" y2="16"/><line x1="9" y1="4" x2="9" y2="20"/><line x1="15" y1="4" x2="15" y2="20"/>'),
  hr: svg('<line x1="4" y1="12" x2="20" y2="12"/>'),
};
