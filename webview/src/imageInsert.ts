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
import { saveImage, post, MAX_IMAGE_BYTES } from './hostBridge';
import { isEmptyParagraph } from './bodySync';

const IMAGE_MIME = /^image\/(png|jpe?g|webp|gif|avif|hei[cf])$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif|hei[cf])$/i;
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/avif,image/heic,image/heif,.heic,.heif';
const CONCURRENCY = 4;

// Finder / Explorer hand over HEIC with an empty or generic type.
export function isImageFile(file: File): boolean {
  if (IMAGE_MIME.test(file.type)) return true;
  return (file.type === '' || file.type === 'application/octet-stream') && IMAGE_EXT.test(file.name);
}

// `replace`: the text selection the images will replace once saved. It is
// only marked meanwhile, so a failed save leaves it untouched.
type Meta = { add: { id: number; pos: number; replace?: { from: number; to: number } } } | { remove: number };

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
          const { id, pos, replace } = meta.add;
          const dom = labels.get(id);
          const decos = dom ? [Decoration.widget(pos, dom, { id })] : [];
          if (replace) decos.push(Decoration.inline(replace.from, replace.to, { class: 'md-upload-replaced' }, { id, replace: true }));
          set = set.add(tr.doc, decos);
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

// Crepe's code blocks are CodeMirror node views that swallow paste and drop
// before ProseMirror sees them; catch image files there and put the images
// after the code block.
export function attachCodeBlockImageHandling(root: HTMLElement, getView: () => EditorView): void {
  const handle = (e: Event, data: DataTransfer | null) => {
    const codeBlock = e.target instanceof Element ? e.target.closest('.cm-editor') : null;
    if (!codeBlock) return;
    const files = imageFiles(data);
    if (files.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    const view = getView();
    let pos: number | undefined;
    try {
      pos = view.posAtDOM(codeBlock, 0);
    } catch { /* fall back to the selection */ }
    insertImageFiles(view, files, pos);
  };
  root.addEventListener('paste', (e) => handle(e, e.clipboardData), true);
  root.addEventListener('drop', (e) => handle(e, e.dataTransfer), true);
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
  let pos = at;
  let replace: { from: number; to: number } | undefined;
  if (pos === undefined) {
    pos = selection instanceof NodeSelection ? selection.to : selection.from;
    if (!(selection instanceof NodeSelection) && !selection.empty) replace = { from: selection.from, to: selection.to };
  }
  view.dispatch(view.state.tr.setMeta(key, { add: { id, pos, replace } }));

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
        if (file.size > MAX_IMAGE_BYTES) throw new Error('画像が大きすぎます (20MB まで)');
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
  const decos = key.getState(view.state);
  const placeholder = decos?.find(undefined, undefined, (spec) => spec.id === id && !spec.replace)[0];
  const replaced = decos?.find(undefined, undefined, (spec) => spec.id === id && spec.replace)[0];
  let pos = placeholder ? placeholder.from : view.state.selection.from;
  const srcs = results.flatMap((r) => ('relPath' in r ? [r.relPath] : []));
  const tr = view.state.tr.setMeta(key, { remove: id });
  if (srcs.length > 0) {
    if (replaced) {
      tr.deleteRange(replaced.from, replaced.to);
      pos = tr.mapping.map(pos);
    }
    insertImageBlocks(tr, pos, srcs);
  }
  view.dispatch(tr.scrollIntoView());
  if (srcs.length > 0) view.focus();

  const failed = results.flatMap((r) => ('error' in r ? [r] : []));
  if (failed.length > 0) {
    // Keep it short: the host drops oversized messages.
    const names =
      failed.slice(0, 5).map((f) => f.name || '(clipboard)').join(', ') +
      (failed.length > 5 ? ` ほか ${failed.length - 5} 件` : '');
    const reason = failed[0].error.length > 300 ? `${failed[0].error.slice(0, 300)}…` : failed[0].error;
    post({
      type: 'notify',
      level: 'error',
      message: `${failed.length} 枚の画像を挿入できませんでした (${names}): ${reason}`,
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
    const atStart = $pos.parentOffset === 0;
    const atEnd = $pos.parentOffset === parent.content.size;
    if (parent.type.spec.code) {
      insertAt = $pos.after();
    } else if (atStart && canInsert(tr.doc, $pos.before(), imageType)) {
      insertAt = $pos.before();
      continueAfter = true;
    } else if (!atStart && !atEnd && parent.type.name === 'paragraph' && canInsert(tr.doc, $pos.after(), imageType)) {
      tr.split(pos);
      insertAt = pos + 1;
      continueAfter = true;
    } else {
      // End of the block, mid-heading (never split a heading), or the first
      // paragraph of a list item, which must stay first.
      insertAt = $pos.after();
    }
  }
  // Table cells and the like cannot hold an image block: go after the
  // enclosing top-level block instead.
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
