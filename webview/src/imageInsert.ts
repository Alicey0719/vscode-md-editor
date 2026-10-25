// Paste / drop / pick image files: save them through the host, then insert
// them as image blocks where the user put them.
//
// Saving is async (HEIC conversion can take seconds), so the target position
// is held by a placeholder decoration that ProseMirror maps through any edits
// made meanwhile (the pattern from prosemirror.net's upload example). Files
// are saved in parallel, each batch is inserted with one transaction, and the
// caret lands right after the last image — never on it, so the next paste
// cannot replace the previous image.

import { NodeSelection, Plugin, PluginKey, TextSelection, type Transaction } from '@milkdown/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/prose/view';
import type { Node as ProseNode, NodeType } from '@milkdown/prose/model';
import { saveImage, post } from './hostBridge';

const IMAGE_MIME = /^image\/(png|jpe?g|webp|gif|avif|hei[cf])$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif|hei[cf])$/i;
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/avif,image/heic,image/heif,.heic,.heif';
const CONCURRENCY = 4;

// Finder / Explorer hand over HEIC with an empty or generic type.
export function isImageFile(file: File): boolean {
  if (IMAGE_MIME.test(file.type)) return true;
  return (file.type === '' || file.type === 'application/octet-stream') && IMAGE_EXT.test(file.name);
}

type Meta = { add: { id: number; pos: number } } | { remove: number };

const key = new PluginKey<DecorationSet>('mdEditorImageUpload');
const labels = new Map<number, HTMLElement>();
let nextId = 1;

export function imageUploadPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set) {
        set = set.map(tr.mapping, tr.doc);
        const meta = tr.getMeta(key) as Meta | undefined;
        if (meta && 'add' in meta) {
          const dom = labels.get(meta.add.id);
          if (dom) set = set.add(tr.doc, [Decoration.widget(meta.add.pos, dom, { id: meta.add.id })]);
        } else if (meta && 'remove' in meta) {
          set = set.remove(set.find(undefined, undefined, (spec) => spec.id === meta.remove));
        }
        return set;
      },
    },
    props: {
      decorations: (state) => key.getState(state),
      handleDOMEvents: {
        paste: (view, event) => {
          const files = imageFiles(event.clipboardData);
          if (files.length === 0) return false;
          event.preventDefault();
          insertImageFiles(view, files);
          return true;
        },
        drop: (view, event) => {
          const files = imageFiles(event.dataTransfer);
          if (files.length === 0) return false;
          event.preventDefault();
          const hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
          insertImageFiles(view, files, hit?.pos);
          return true;
        },
      },
    },
  });
}

function imageFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  let files = Array.from(data.files);
  if (files.length === 0) {
    files = Array.from(data.items)
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null);
  }
  return files.filter(isImageFile);
}

export function pickImageFiles(view: EditorView): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = IMAGE_ACCEPT;
  input.multiple = true;
  input.addEventListener('change', () => {
    const files = Array.from(input.files ?? []).filter(isImageFile);
    if (files.length > 0) insertImageFiles(view, files);
  });
  input.click();
}

// `at` is a drop position; without it images go at the selection.
export function insertImageFiles(view: EditorView, files: File[], at?: number): void {
  const id = nextId++;
  const label = document.createElement('span');
  label.className = 'md-upload-placeholder';
  label.contentEditable = 'false';
  label.textContent = progressText(0, files.length);
  labels.set(id, label);

  const { selection } = view.state;
  const tr = view.state.tr;
  let pos = at;
  if (pos === undefined) {
    if (selection instanceof NodeSelection) pos = selection.to;
    else {
      if (!selection.empty) tr.deleteSelection();
      pos = tr.selection.from;
    }
  }
  view.dispatch(tr.setMeta(key, { add: { id, pos } }));

  void saveAll(files, (done) => {
    label.textContent = progressText(done, files.length);
  }).then((results) => finish(view, id, results));
}

const progressText = (done: number, total: number) =>
  total > 1 ? `画像を保存中… ${done}/${total}` : '画像を保存中…';

type Result = { relPath: string } | { error: string; name: string };

async function saveAll(files: File[], onProgress: (done: number) => void): Promise<Result[]> {
  const results: Result[] = new Array(files.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < files.length) {
      const i = next++;
      const file = files[i];
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        results[i] = { relPath: (await saveImage(bytes, file.type)).relPath };
      } catch (err) {
        results[i] = { error: err instanceof Error ? err.message : String(err), name: file.name };
      }
      onProgress(++done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));
  return results;
}

function finish(view: EditorView, id: number, results: Result[]): void {
  labels.delete(id);
  if (view.isDestroyed) return;
  const placeholder = key.getState(view.state)?.find(undefined, undefined, (spec) => spec.id === id)[0];
  const pos = placeholder ? placeholder.from : view.state.selection.from;
  const srcs = results.flatMap((r) => ('relPath' in r ? [r.relPath] : []));
  const tr = view.state.tr.setMeta(key, { remove: id });
  if (srcs.length > 0) insertImageBlocks(tr, pos, srcs);
  view.dispatch(tr.scrollIntoView());
  if (srcs.length > 0) view.focus();

  const failed = results.flatMap((r) => ('error' in r ? [r] : []));
  if (failed.length > 0) {
    const names = failed.map((f) => f.name || '(clipboard)').join(', ');
    post({
      type: 'notify',
      level: 'error',
      message: `${failed.length} 枚の画像を挿入できませんでした (${names}): ${failed[0].error}`,
    });
  }
}

// Insert image blocks at `pos`, splitting the paragraph when it is mid-text,
// and put the caret in the text block right after them.
export function insertImageBlocks(tr: Transaction, pos: number, srcs: string[]): Transaction {
  const { schema } = tr.doc.type;
  const imageType = schema.nodes['image-block'];
  const paragraph = schema.nodes.paragraph;
  if (!imageType) return tr.insertText(srcs.map((src) => `![](${src})`).join('\n'), pos);
  const images = srcs.map((src) => imageType.create({ src }));

  const $pos = tr.doc.resolve(pos);
  const parent = $pos.parent;
  let insertAt = pos;
  // Whether the block after the images is where the caret should continue
  // (the empty paragraph or the text after the split) instead of a new one.
  let continueAfter = false;
  if (parent.isTextblock) {
    const nested = $pos.depth > 1;
    if (parent.type.spec.code || !canInsert(tr.doc, $pos.after(), imageType)) {
      // Code blocks and table cells cannot hold an image block: go after the
      // enclosing top-level block instead.
      insertAt = nested ? $pos.after(1) : $pos.after();
    } else if (parent.content.size === 0 || $pos.parentOffset === 0) {
      insertAt = $pos.before();
      continueAfter = true;
    } else if ($pos.parentOffset === parent.content.size) {
      insertAt = $pos.after();
    } else {
      tr.split(pos);
      insertAt = pos + 1;
      continueAfter = true;
    }
  }
  if (!canInsert(tr.doc, insertAt, imageType)) {
    const $at = tr.doc.resolve(insertAt);
    insertAt = $at.depth > 0 ? $at.after(1) : insertAt;
    continueAfter = false;
  }

  tr.insert(insertAt, images);
  const after = insertAt + images.reduce((size, node) => size + node.nodeSize, 0);
  const next = tr.doc.nodeAt(after);
  const reusable = next?.isTextblock && !next.type.spec.code && (continueAfter || isEmptyParagraph(next));
  if (!reusable) {
    if (!canInsert(tr.doc, after, paragraph)) {
      return tr.setSelection(NodeSelection.create(tr.doc, after - images[images.length - 1].nodeSize));
    }
    tr.insert(after, paragraph.create());
  }
  return tr.setSelection(TextSelection.create(tr.doc, after + 1));
}

function canInsert(doc: ProseNode, pos: number, type: NodeType): boolean {
  const $pos = doc.resolve(pos);
  const index = $pos.index();
  return $pos.parent.canReplaceWith(index, index, type);
}

const isEmptyParagraph = (node: ProseNode) => node.type.name === 'paragraph' && node.content.size === 0;
