// Turn the editor document back into markdown without reformatting the parts
// the user did not touch.
//
// Milkdown serializes the whole document, so a one-character edit used to
// rewrite list markers, blank lines and escapes across the file. Instead we
// remember the markdown the host holds (`text`) plus the source range of each
// top-level block, diff the editor's top-level blocks against the parsed
// ones, and splice only the changed runs back into `text`. The splice is
// verified by re-parsing; if it does not match we fall back to full
// serialization.

import { Fragment, Mark, type Node as ProseNode } from '@milkdown/prose/model';

type Parse = (markdown: string) => ProseNode;
type Serialize = (doc: ProseNode) => string;

interface MdastRoot {
  children: Array<{ type: string; position?: { start: { offset?: number }; end: { offset?: number } } }>;
}

export interface MarkdownProcessor {
  parse(markdown: string): unknown;
}

export class BodySync {
  // Markdown the host currently holds for the body.
  text = '';
  private blocks: ProseNode[] = [];
  // Source range in `text` of each entry of `blocks`; null when the mdast and
  // ProseMirror top-level nodes could not be paired up.
  private ranges: Array<[number, number]> | null = [];
  // The last parse done while verifying a splice, reused by setBase.
  private parsed: { text: string; doc: ProseNode } | null = null;

  constructor(
    private readonly parse: Parse,
    private readonly serialize: Serialize,
    private readonly processor: MarkdownProcessor,
  ) {}

  setBase(text: string, doc: ProseNode = this.parseCached(text)): ProseNode {
    this.text = text;
    const children = childrenOf(doc);
    const ranges = sourceRanges(this.processor, text, children.length);
    this.blocks = [];
    this.ranges = ranges ? [] : null;
    children.forEach((child, i) => {
      if (isEmptyParagraph(child)) return;
      this.blocks.push(child);
      if (ranges) this.ranges!.push(ranges[i]);
    });
    return doc;
  }

  // Content blocks of `text` (the current base when it is the same text).
  blocksOf(text: string): ProseNode[] {
    return text === this.text ? this.blocks : contentBlocks(this.parseCached(text));
  }

  // Markdown for `doc`; returns `text` itself when nothing changed.
  render(doc: ProseNode): string {
    const next = contentBlocks(doc);
    if (sameBlocks(next, this.blocks)) return this.text;
    const patched = this.splice(doc, next);
    if (patched !== null) {
      try {
        const parsed = this.parse(patched);
        if (sameBlocks(contentBlocks(parsed), next)) {
          this.parsed = { text: patched, doc: parsed };
          return patched;
        }
      } catch { /* fall back */ }
    }
    return this.toMarkdown(doc);
  }

  private parseCached(text: string): ProseNode {
    return this.parsed?.text === text ? this.parsed.doc : this.parse(text);
  }

  private toMarkdown(doc: ProseNode): string {
    return contentBlocks(doc).length === 0 ? '' : this.serialize(withoutEmptyParagraphs(doc));
  }

  private splice(doc: ProseNode, next: ProseNode[]): string | null {
    const ranges = this.ranges;
    if (!ranges) return null;
    const n = this.blocks.length;
    let text = this.text;
    // Back to front, so earlier ranges stay valid.
    for (const run of blockRuns(this.blocks, next).reverse()) {
      const changed = next.slice(run.nextFrom, run.nextTo);
      const inserted = changed.length ? this.toMarkdown(doc.copy(Fragment.fromArray(changed))).replace(/\n+$/, '') : '';
      if (run.prevFrom < run.prevTo) {
        const from = ranges[run.prevFrom][0];
        const to = ranges[run.prevTo - 1][1];
        if (inserted) text = text.slice(0, from) + inserted + text.slice(to);
        // Pure deletion: take the separating blank line with it.
        else if (run.prevTo < n) text = text.slice(0, from) + text.slice(ranges[run.prevTo][0]);
        else if (run.prevFrom > 0) text = text.slice(0, ranges[run.prevFrom - 1][1]) + text.slice(to);
        else text = text.slice(0, from) + text.slice(to);
      } else if (run.prevFrom > 0) {
        const at = ranges[run.prevFrom - 1][1];
        text = `${text.slice(0, at)}\n\n${inserted}${text.slice(at)}`;
      } else if (n > 0) {
        const at = ranges[0][0];
        text = `${text.slice(0, at)}${inserted}\n\n${text.slice(at)}`;
      } else {
        return null;
      }
    }
    return text;
  }
}

export interface BlockRun {
  prevFrom: number;
  prevTo: number;
  nextFrom: number;
  nextTo: number;
}

// Runs of blocks that differ between two lists, aligned on the blocks they
// share (common prefix/suffix, then an LCS of the middle), so edits in two
// places do not drag everything between them along.
export function blockRuns(prev: ProseNode[], next: ProseNode[]): BlockRun[] {
  let p = 0;
  while (p < prev.length && p < next.length && sameBlock(prev[p], next[p])) p++;
  let s = 0;
  while (s < prev.length - p && s < next.length - p && sameBlock(prev[prev.length - 1 - s], next[next.length - 1 - s])) s++;
  const a = prev.slice(p, prev.length - s);
  const b = next.slice(p, next.length - s);
  if (a.length === 0 && b.length === 0) return [];
  // Not worth an LCS (e.g. switching git branches): one run.
  if (a.length === 0 || b.length === 0 || a.length * b.length > 40000) {
    return [{ prevFrom: p, prevTo: prev.length - s, nextFrom: p, nextTo: next.length - s }];
  }

  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const same = new Uint8Array(n * m);
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (sameBlock(a[i], b[j])) {
        same[i * m + j] = 1;
        lcs[i * w + j] = lcs[(i + 1) * w + j + 1] + 1;
      } else {
        lcs[i * w + j] = Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
  }
  const runs: BlockRun[] = [];
  let open: BlockRun | null = null;
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && same[i * m + j] && lcs[i * w + j] === lcs[(i + 1) * w + j + 1] + 1) {
      if (open) runs.push(open);
      open = null;
      i++;
      j++;
      continue;
    }
    open ??= { prevFrom: p + i, prevTo: p + i, nextFrom: p + j, nextTo: p + j };
    if (j < m && (i === n || lcs[i * w + j + 1] >= lcs[(i + 1) * w + j])) open.nextTo = p + ++j;
    else open.prevTo = p + ++i;
  }
  if (open) runs.push(open);
  return runs;
}

// Attributes Milkdown derives from other data and keeps in sync on its own
// (heading ids from the text, list labels from the position) or that we never
// save (image scale). They must not make two blocks count as different.
const DERIVED_ATTRS: Record<string, readonly string[]> = {
  heading: ['id'],
  list_item: ['label', 'listType'],
  'image-block': ['ratio'],
};

export function sameBlock(a: ProseNode, b: ProseNode): boolean {
  if (a === b) return true;
  if (a.type !== b.type || !Mark.sameSet(a.marks, b.marks)) return false;
  if (a.isText) return a.text === b.text;
  const derived = DERIVED_ATTRS[a.type.name] ?? [];
  for (const key of Object.keys(a.attrs)) {
    if (!derived.includes(key) && JSON.stringify(a.attrs[key]) !== JSON.stringify(b.attrs[key])) return false;
  }
  // Blank lines inside lists and quotes are editor-only too.
  const ac = a.isTextblock ? childrenOf(a) : contentBlocks(a);
  const bc = b.isTextblock ? childrenOf(b) : contentBlocks(b);
  return sameBlocks(ac, bc);
}

export const sameBlocks = (a: ProseNode[], b: ProseNode[]): boolean =>
  a.length === b.length && a.every((node, i) => sameBlock(node, b[i]));

// Top-level children with source offsets, paired 1:1 with the ProseMirror
// doc's children. Link reference definitions are folded into the links by
// remark-inline-links and have no node of their own.
function sourceRanges(processor: MarkdownProcessor, text: string, expected: number): Array<[number, number]> | null {
  let tree: MdastRoot;
  try {
    tree = processor.parse(text) as MdastRoot;
  } catch {
    return null;
  }
  const nodes = tree.children.filter((n) => n.type !== 'definition');
  if (nodes.length !== expected) return null;
  const ranges: Array<[number, number]> = [];
  for (const node of nodes) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return null;
    ranges.push([start, end]);
  }
  return ranges;
}

export function childrenOf(node: ProseNode): ProseNode[] {
  const children: ProseNode[] = [];
  node.forEach((child) => children.push(child));
  return children;
}

// Empty paragraphs exist only in the editor (blank lines the user made, the
// trailing paragraph Crepe keeps at the end); they never reach the file.
export function contentBlocks(node: ProseNode): ProseNode[] {
  return childrenOf(node).filter((child) => !isEmptyParagraph(child));
}

export const isEmptyParagraph = (node: ProseNode): boolean =>
  node.type.name === 'paragraph' && node.content.size === 0;

// Milkdown's paragraph handler emits `<br />` for empty paragraphs when
// `remarkPreserveEmptyLinePlugin` is registered (see @milkdown/preset-commonmark
// paragraph toMarkdown); `<br>` lines in existing files parse back into empty
// paragraphs. Drop them before serializing so saved files stay clean markdown.
// (Stripping `<br />` lines from the output text instead would also eat them
// inside code blocks.)
function withoutEmptyParagraphs(node: ProseNode): ProseNode {
  if (node.isTextblock || node.isLeaf) return node;
  const children = childrenOf(node);
  const kept: ProseNode[] = [];
  let changed = false;
  children.forEach((child, i) => {
    if (!isEmptyParagraph(child)) {
      const next = withoutEmptyParagraphs(child);
      if (next !== child) changed = true;
      kept.push(next);
      return;
    }
    changed = true;
    // `- ![](x.png)` parses as a list item holding an empty paragraph and an
    // image block (list items must start with a paragraph). Write the image
    // inline in that paragraph instead of a `- <br />` line.
    const following = children[i + 1];
    const image = node.type.schema.nodes.image;
    if (kept.length === 0 && following?.type.name === 'image-block' && image) {
      children[i + 1] = child.copy(
        Fragment.from(image.create({ src: following.attrs.src, alt: following.attrs.caption ?? '' })),
      );
    }
  });
  if (!changed) return node;
  const content = Fragment.fromArray(kept);
  return node.type.validContent(content) ? node.copy(content) : node;
}
