import { Crepe } from '@milkdown/crepe';
import { editorViewCtx, parserCtx } from '@milkdown/core';
import { splitBlock } from '@milkdown/prose/commands';
import '@milkdown/crepe/theme/common/style.css';
// Default to the dark frame theme (matches VSCode's default palette). Light theme
// vars are re-declared in styles.css scoped to `body.vscode-light`.
import '@milkdown/crepe/theme/frame-dark.css';

import { saveImage, resolveImageUri, post } from './hostBridge';
import { createToolbar } from './toolbar';
import { patchImageBlockSerialization } from './imageBlockPatch';

const IMAGE_MIME = /^image\/(png|jpeg|jpg|webp|gif)$/i;

export interface BodyEditor {
  getMarkdown: () => string;
  setMarkdown: (markdown: string) => void;
  onChange: (cb: (markdown: string) => void) => void;
  toolbar: HTMLElement;
  root: HTMLElement;
  destroy: () => Promise<void>;
}

export async function createBodyEditor(host: HTMLElement, initial: string): Promise<BodyEditor> {
  host.classList.add('md-paper');

  let latest = initial;
  const changeCallbacks: Array<(m: string) => void> = [];
  let suppressChange = false;

  const crepe = new Crepe({
    root: host,
    defaultValue: initial,
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

  await crepe.create();
  patchImageBlockSerialization(crepe);

  crepe.on((listener) => {
    listener.markdownUpdated((_ctx, markdown) => {
      const cleaned = stripEmptyBrLines(markdown);
      latest = cleaned;
      if (suppressChange) return;
      for (const cb of changeCallbacks) cb(cleaned);
    });
  });

  attachPasteHandler(host, crepe);
  attachLinkClickHandler(host);

  const toolbar = createToolbar(crepe);

  return {
    toolbar: toolbar.root,
    getMarkdown: () => latest,
    setMarkdown: (markdown: string) => {
      suppressChange = true;
      try {
        crepe.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const parser = ctx.get(parserCtx);
          const doc = parser(markdown);
          if (!doc) return;
          const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content);
          view.dispatch(tr);
        });
        latest = markdown;
      } finally {
        suppressChange = false;
      }
    },
    onChange: (cb) => changeCallbacks.push(cb),
    root: host,
    destroy: async () => {
      await crepe.destroy();
    },
  };
}

function attachPasteHandler(root: HTMLElement, crepe: Crepe): void {
  const handleFiles = async (files: FileList | File[] | null | undefined, ev: Event) => {
    if (!files || files.length === 0) return false;
    const images: File[] = [];
    for (const f of Array.from(files as ArrayLike<File>)) {
      if (IMAGE_MIME.test(f.type)) images.push(f);
    }
    if (images.length === 0) return false;
    ev.preventDefault();
    ev.stopPropagation();
    for (let i = 0; i < images.length; i++) {
      const file = images[i];
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const { relPath } = await saveImage(bytes, file.type);
        insertImage(crepe, relPath);
        // Multiple images should land on separate lines. After each image
        // except the last, split the paragraph so the next image lands in a
        // fresh empty paragraph below.
        if (i < images.length - 1) {
          splitCurrentBlock(crepe);
        }
      } catch (err) {
        console.error('image save failed', err);
      }
    }
    return true;
  };

  root.addEventListener('paste', (e) => {
    const cd = e.clipboardData;
    if (!cd) return;
    const files: File[] = [];
    for (const item of Array.from(cd.items)) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) void handleFiles(files, e);
  }, true);

  root.addEventListener('drop', (e) => {
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) void handleFiles(files, e);
  }, true);
}

// Milkdown's paragraph handler emits `<br />` on its own line for empty
// paragraphs when `remarkPreserveEmptyLinePlugin` is registered
// (see @milkdown/preset-commonmark paragraph toMarkdown). Strip those so saved
// files stay clean markdown. Also normalizes lookalike variants (`<br>`,
// `<br/>`, `<br >`) that show up in some contexts.
function stripEmptyBrLines(markdown: string): string {
  return markdown.replace(/^[ \t]*<br\s*\/?>[ \t]*(?:\r?\n)?/gm, '');
}

function attachLinkClickHandler(root: HTMLElement): void {
  // Default click on a link should behave like a text edit (cursor placement),
  // not navigate away. Shift/Cmd/Ctrl+click opens the URL in the external
  // browser. Must stopPropagation on ALL clicks so VSCode webview's built-in
  // <a href> auto-navigator (which bubbles up to <body>) never fires; and must
  // hook mousedown too because that is where the navigator actually latches.
  const intercept = (e: MouseEvent, allowHostAction: boolean) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest('a');
    if (!anchor) return;
    const href = anchor.getAttribute('href') ?? '';
    if (!href) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (allowHostAction && (e.shiftKey || e.metaKey || e.ctrlKey)) {
      post({ type: 'openLink', url: href });
    }
  };
  root.addEventListener('click', (e) => intercept(e, true), true);
  root.addEventListener('mousedown', (e) => intercept(e, false), true);
  root.addEventListener('auxclick', (e) => intercept(e, true), true);
}

function insertImage(crepe: Crepe, src: string): void {
  crepe.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const { state } = view;
    const imageType = state.schema.nodes.image;
    if (!imageType) {
      console.warn('image node not in schema, falling back to text');
      view.dispatch(state.tr.insertText(`![](${src})`));
      return;
    }
    const node = imageType.create({ src, alt: '' });
    const tr = state.tr.replaceSelectionWith(node, false);
    view.dispatch(tr);
  });
}

function splitCurrentBlock(crepe: Crepe): void {
  crepe.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    splitBlock(view.state, view.dispatch);
  });
}
