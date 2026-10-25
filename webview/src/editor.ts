import { Crepe } from '@milkdown/crepe';
import {
  editorViewCtx,
  parserCtx,
  remarkCtx,
  remarkStringifyOptionsCtx,
  serializerCtx,
} from '@milkdown/core';
import type { Ctx } from '@milkdown/ctx';
import { $prose } from '@milkdown/kit/utils';
import { linkTooltipAPI } from '@milkdown/kit/component/link-tooltip';
import { headingIdGenerator } from '@milkdown/preset-commonmark';
import { Plugin } from '@milkdown/prose/state';
import { Transform } from '@milkdown/prose/transform';
import type { Node as ProseNode } from '@milkdown/prose/model';
import type { EditorView } from '@milkdown/prose/view';
import '@milkdown/crepe/theme/common/style.css';
// Default to the dark frame theme (matches VSCode's default palette). Light theme
// vars are re-declared in styles.css scoped to `body.vscode-light`.
import '@milkdown/crepe/theme/frame-dark.css';

import { saveImage, resolveImageUri, post } from './hostBridge';
import { createToolbar, type Toolbar } from './toolbar';
import { patchImageBlockSerialization } from './imageBlockPatch';
import { BodySync, keepEditorBlankLines } from './bodySync';
import { imageUploadPlugin, pickImageFiles } from './imageInsert';
import { linkRangeAt } from './links';
import { applyEdit, minimalEdit } from '../../src/textEdit';

export interface BodyEditor {
  // Show markdown from the host. Returns true when local edits that the host
  // has not seen yet survived (rebased onto the new text) and must be sent.
  setMarkdown: (markdown: string) => boolean;
  // Markdown to send to the host; `changed` is false when it already has it.
  takeMarkdown: () => { markdown: string; changed: boolean };
  onChange: (cb: () => void) => void;
  editLink: () => void;
  toolbar: HTMLElement;
  root: HTMLElement;
  destroy: () => Promise<void>;
}

export async function createBodyEditor(host: HTMLElement): Promise<BodyEditor> {
  host.classList.add('md-paper');

  const changeCallbacks: Array<() => void> = [];
  let toolbar: Toolbar | null = null;
  // Set while host content is being applied, so it is not echoed back.
  let syncing = false;

  const crepe = new Crepe({
    root: host,
    // Content is set after the image-block patch below, so the first parse
    // already maps `alt` to the caption.
    defaultValue: '',
    features: {
      [Crepe.Feature.Latex]: false,
      [Crepe.Feature.Toolbar]: false,
      [Crepe.Feature.ListItem]: false,
    },
    featureConfigs: {
      [Crepe.Feature.ImageBlock]: {
        onUpload: async (file: File) => {
          try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            const { relPath } = await saveImage(bytes, file.type);
            return relPath;
          } catch (err) {
            console.error('image upload failed', err);
            throw err;
          }
        },
        proxyDomURL: async (url: string) => {
          if (!/^img\/[0-9a-zA-Z._-]+$/.test(url)) return url;
          const resolved = await resolveImageUri(url);
          return resolved ?? url;
        },
      },
    },
  });

  crepe.editor
    // `-` is what most hand-written markdown and formatters (Prettier,
    // markdownlint) use; Milkdown defaults to `*`.
    .config((ctx) => ctx.update(remarkStringifyOptionsCtx, (options) => ({ ...options, bullet: '-' as const })))
    .use($prose(() => imageUploadPlugin()))
    .use(
      $prose(
        () =>
          new Plugin({
            view: () => ({
              update: (view, prev) => {
                toolbar?.refresh(view.state);
                if (!syncing && view.state.doc !== prev.doc) for (const cb of changeCallbacks) cb();
              },
            }),
          }),
      ),
    );

  await crepe.create();
  patchImageBlockSerialization(crepe);

  const withCtx = <T,>(fn: (ctx: Ctx) => T): T => crepe.editor.action(fn);
  const view = (): EditorView => withCtx((ctx) => ctx.get(editorViewCtx));
  const parse = (markdown: string): ProseNode =>
    withCtx((ctx) => withHeadingIds(ctx.get(parserCtx)(markdown), ctx.get(headingIdGenerator.key)));
  const sync = withCtx(
    (ctx) => new BodySync(parse, (doc) => ctx.get(serializerCtx)(doc), ctx.get(remarkCtx)),
  );

  // Replace only the part of the document that differs, so the selection (and
  // the node views around it) survive. Not added to the undo history: Ctrl+Z
  // must undo the user's own edits, not changes made in another editor.
  const showDoc = (incoming: ProseNode) => {
    const v = view();
    const doc = v.state.doc;
    const next = keepEditorBlankLines(doc, incoming);
    const start = doc.content.findDiffStart(next.content);
    if (start === null) return;
    let { a: endA, b: endB } = doc.content.findDiffEnd(next.content)!;
    const overlap = start - Math.min(endA, endB);
    if (overlap > 0) {
      endA += overlap;
      endB += overlap;
    }
    const tr = v.state.tr.replace(start, endA, next.slice(start, endB)).setMeta('addToHistory', false);
    syncing = true;
    try {
      v.dispatch(tr);
    } finally {
      syncing = false;
    }
  };

  const setMarkdown = (markdown: string): boolean => {
    const base = sync.text;
    const local = sync.render(view().state.doc);
    const incoming = parse(markdown);
    // Formatting-only change on the host side (format on save, ...).
    const sameContent = sync.matchesBase(incoming);
    sync.setBase(markdown, incoming);

    if (local === base) {
      if (!sync.matchesBase(view().state.doc)) showDoc(incoming);
      return false;
    }
    // Both sides changed. Keep the unsent local edits unless they collide
    // with the external one; on a collision the document wins.
    if (sameContent) return true;
    const mine = minimalEdit(base, local);
    const theirs = minimalEdit(base, markdown);
    if (mine && theirs && (mine.end <= theirs.start || theirs.end <= mine.start)) {
      const [first, second] = mine.start < theirs.start ? [mine, theirs] : [theirs, mine];
      showDoc(parse(applyEdit(applyEdit(base, second), first)));
      return true;
    }
    showDoc(incoming);
    return false;
  };

  const editLink = () =>
    withCtx((ctx) => {
      const v = ctx.get(editorViewCtx);
      if (!v.hasFocus()) v.focus();
      const api = ctx.get(linkTooltipAPI.key);
      const { from, to } = v.state.selection;
      const link = linkRangeAt(v.state);
      if (link) api.editLink(link.mark, link.from, link.to);
      else api.addLink(from, to);
    });

  attachLinkClickHandler(host);

  toolbar = createToolbar(crepe, {
    editLink,
    insertImage: () => pickImageFiles(view()),
  });
  toolbar.refresh(view().state);

  return {
    setMarkdown,
    takeMarkdown: () => {
      const markdown = sync.render(view().state.doc);
      if (markdown === sync.text) return { markdown, changed: false };
      sync.setBase(markdown);
      return { markdown, changed: true };
    },
    onChange: (cb) => changeCallbacks.push(cb),
    editLink,
    toolbar: toolbar.root,
    root: host,
    destroy: async () => {
      await crepe.destroy();
    },
  };
}

// Milkdown's syncHeadingIdPlugin gives every heading in the editor an `id`
// derived from its text, but freshly parsed documents carry `id: ''`. Assign
// them the same way (including the `-#2` suffix for duplicates) so parsed and
// edited documents compare equal and external updates diff minimally.
function withHeadingIds(doc: ProseNode, getId: (node: ProseNode) => string): ProseNode {
  const tr = new Transform(doc);
  const seen: Record<string, number> = {};
  doc.descendants((node, pos) => {
    if (node.type.name !== 'heading' || node.textContent.trim().length === 0) return;
    let id = getId(node);
    if (seen[id]) {
      seen[id] += 1;
      id += `-#${seen[id]}`;
    } else {
      seen[id] = 1;
    }
    if (node.attrs.id !== id) tr.setNodeMarkup(pos, undefined, { ...node.attrs, id });
  });
  return tr.doc;
}

function attachLinkClickHandler(root: HTMLElement): void {
  // VS Code's webview host opens every clicked <a href> externally, from a
  // window-level listener. Stop link clicks before they reach it — in the
  // bubble phase, so ProseMirror still places the caret inside the link text
  // (that is how a link gets edited). Ctrl/Cmd+click opens the link; links in
  // Crepe's hover preview open on a plain click.
  const intercept = (e: MouseEvent) => {
    const anchor = e.target instanceof Element ? e.target.closest('a[href]') : null;
    if (!anchor) return;
    e.preventDefault();
    e.stopPropagation();
    const inDocument = anchor.closest('.ProseMirror') !== null;
    const open = e.type === 'click' && (!inDocument || e.ctrlKey || e.metaKey);
    if (open) post({ type: 'openLink', url: anchor.getAttribute('href') ?? '' });
  };
  root.addEventListener('click', intercept);
  root.addEventListener('auxclick', intercept);
}
