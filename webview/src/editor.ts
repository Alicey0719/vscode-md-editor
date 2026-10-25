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
import { Plugin } from '@milkdown/prose/state';
import { Fragment, type Node as ProseNode } from '@milkdown/prose/model';
import type { EditorView } from '@milkdown/prose/view';
import '@milkdown/crepe/theme/common/style.css';
// Default to the dark frame theme (matches VSCode's default palette). Light theme
// vars are re-declared in styles.css scoped to `body.vscode-light`.
import '@milkdown/crepe/theme/frame-dark.css';

import { saveImage, resolveImageUri, post } from './hostBridge';
import { createToolbar, type Toolbar } from './toolbar';
import { patchImageBlockSerialization } from './imageBlockPatch';
import { BodySync, blockRuns, childrenOf, contentBlocks, isEmptyParagraph, type BlockRun } from './bodySync';
import { attachCodeBlockImageHandling, imageUploadPlugin, pickImageFiles } from './imageInsert';
import { linkRangeAt } from './links';

export interface BodyEditor {
  // Show markdown from the host. `confirmed` is the body the host held before
  // this change as far as we know (our last applied change); `discard` drops
  // local edits instead of keeping them. Returns true when local edits the
  // host does not have survived and must be (re)sent.
  setMarkdown: (markdown: string, confirmed?: string, discard?: boolean) => boolean;
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
  const parse = (markdown: string): ProseNode => withCtx((ctx) => ctx.get(parserCtx)(markdown));
  const sync = withCtx(
    (ctx) => new BodySync(parse, (doc) => ctx.get(serializerCtx)(doc), ctx.get(remarkCtx)),
  );

  // Bring the editor to `incoming` by replacing only the blocks that differ,
  // so the selection, node views and the user's blank lines elsewhere
  // survive. Not added to the undo history: Ctrl+Z must undo the user's own
  // edits, not changes made in another editor.
  const showDoc = (incoming: ProseNode) => {
    const v = view();
    const doc = v.state.doc;
    const cur = childrenOf(doc);
    const inc = childrenOf(incoming);
    const curIdx = contentIndices(cur);
    const incIdx = contentIndices(inc);
    const runs = blockRuns(curIdx.map((i) => cur[i]), incIdx.map((i) => inc[i]));
    if (runs.length === 0) return;

    const starts: number[] = [];
    let pos = 0;
    for (const child of cur) {
      starts.push(pos);
      pos += child.nodeSize;
    }
    starts.push(pos);

    const tr = v.state.tr;
    for (const run of [...runs].reverse()) {
      let from: number;
      let to: number;
      let replacement: ProseNode[];
      if (curIdx.length === 0) {
        // Nothing to anchor to (first load): take the incoming document whole.
        [from, to, replacement] = [0, cur.length, inc];
      } else {
        from =
          run.prevFrom < run.prevTo ? curIdx[run.prevFrom] : run.prevFrom > 0 ? curIdx[run.prevFrom - 1] + 1 : curIdx[0];
        to = run.prevFrom < run.prevTo ? curIdx[run.prevTo - 1] + 1 : from;
        replacement = run.nextFrom < run.nextTo ? inc.slice(incIdx[run.nextFrom], incIdx[run.nextTo - 1] + 1) : [];
      }
      // Within the run, narrow down to the characters that changed.
      const before = Fragment.fromArray(cur.slice(from, to));
      const after = Fragment.fromArray(replacement);
      const start = before.findDiffStart(after);
      if (start === null) continue;
      let { a: endA, b: endB } = before.findDiffEnd(after)!;
      const overlap = start - Math.min(endA, endB);
      if (overlap > 0) {
        endA += overlap;
        endB += overlap;
      }
      tr.replace(starts[from] + start, starts[from] + endA, doc.type.create(null, after).slice(start, endB));
    }
    if (!tr.docChanged) return;
    syncing = true;
    try {
      v.dispatch(tr.setMeta('addToHistory', false));
    } finally {
      syncing = false;
    }
  };

  const setMarkdown = (markdown: string, confirmed: string = sync.text, discard = false): boolean => {
    const doc = view().state.doc;
    const base = sync.blocksOf(confirmed);
    const incoming = sync.setBase(markdown, parse(markdown));
    const local = contentBlocks(doc);
    const mine = blockRuns(base, local);
    if (discard || mine.length === 0) {
      showDoc(incoming);
      return false;
    }
    const external = contentBlocks(incoming);
    const theirs = blockRuns(base, external);
    // Formatting-only change on the host side (format on save, ...): keep
    // the editor as is; the local edits are resent against the new text.
    if (theirs.length === 0) return true;
    const merged = mergeRuns(base, local, external, mine, theirs);
    if (merged) {
      showDoc(doc.type.createAndFill(null, Fragment.fromArray(merged)) ?? incoming);
      return true;
    }
    showDoc(incoming);
    post({
      type: 'notify',
      level: 'warn',
      message: '別のエディタで同じ箇所が変更されたため、こちらの未反映の編集を取り消しました。',
    });
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
  attachCodeBlockImageHandling(host, view);

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

const contentIndices = (nodes: ProseNode[]) => nodes.flatMap((node, i) => (isEmptyParagraph(node) ? [] : [i]));

// Apply both sides' block changes to `base` when they touch different blocks;
// null when they collide.
function mergeRuns(
  base: ProseNode[],
  mine: ProseNode[],
  theirs: ProseNode[],
  a: BlockRun[],
  b: BlockRun[],
): ProseNode[] | null {
  const collide = (x: BlockRun, y: BlockRun) =>
    (x.prevFrom < y.prevTo && y.prevFrom < x.prevTo) ||
    (x.prevFrom === x.prevTo && y.prevFrom <= x.prevFrom && x.prevFrom <= y.prevTo) ||
    (y.prevFrom === y.prevTo && x.prevFrom <= y.prevFrom && y.prevFrom <= x.prevTo);
  if (a.some((x) => b.some((y) => collide(x, y)))) return null;
  const runs = [...a.map((run) => ({ run, src: mine })), ...b.map((run) => ({ run, src: theirs }))].sort(
    (x, y) => x.run.prevFrom - y.run.prevFrom || x.run.prevTo - y.run.prevTo,
  );
  const out: ProseNode[] = [];
  let i = 0;
  for (const { run, src } of runs) {
    out.push(...base.slice(i, run.prevFrom), ...src.slice(run.nextFrom, run.nextTo));
    i = run.prevTo;
  }
  out.push(...base.slice(i));
  return out;
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
