// Turn the editor document back into markdown without reformatting the parts
// the user did not touch.
//
// Milkdown serializes the whole document, so a one-character edit used to
// rewrite list markers, blank lines and escapes across the file. Instead we
// remember the markdown the host holds (`text`) plus the source range of each
// top-level block, diff the editor's top-level blocks against the parsed ones,
// and splice only the changed run back into `text`. The splice is verified by
// re-parsing; if it does not match full serialization we fall back to that.

import { Fragment, type Node as ProseNode } from '@milkdown/prose/model';

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

  constructor(
    private readonly parse: Parse,
    private readonly serialize: Serialize,
    private readonly processor: MarkdownProcessor,
  ) {}

  setBase(text: string, doc: ProseNode = this.parse(text)): ProseNode {
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

  // Whether `doc` has the same content as the base markdown.
  matchesBase(doc: ProseNode): boolean {
    return sameNodes(contentBlocks(doc), this.blocks);
  }

  // Markdown for `doc`; returns `text` itself when nothing changed.
  render(doc: ProseNode): string {
    const next = contentBlocks(doc);
    if (sameNodes(next, this.blocks)) return this.text;
    const full = this.toMarkdown(doc);
    const patched = this.splice(doc, next);
    if (patched === null || patched === full) return full;
    try {
      if (sameNodes(contentBlocks(this.parse(patched)), contentBlocks(this.parse(full)))) return patched;
    } catch { /* fall back */ }
    return full;
  }

  private toMarkdown(doc: ProseNode): string {
    return contentBlocks(doc).length === 0 ? '' : this.serialize(withoutEmptyParagraphs(doc));
  }

  private splice(doc: ProseNode, next: ProseNode[]): string | null {
    const ranges = this.ranges;
    if (!ranges) return null;
    const prev = this.blocks;
    const text = this.text;
    const n = prev.length;
    const m = next.length;
    let p = 0;
    while (p < n && p < m && prev[p].eq(next[p])) p++;
    let s = 0;
    while (s < n - p && s < m - p && prev[n - 1 - s].eq(next[m - 1 - s])) s++;

    const changed = next.slice(p, m - s);
    const inserted = changed.length ? this.toMarkdown(doc.copy(Fragment.fromArray(changed))).replace(/\n+$/, '') : '';

    if (p < n - s) {
      const from = ranges[p][0];
      const to = ranges[n - s - 1][1];
      if (inserted) return text.slice(0, from) + inserted + text.slice(to);
      // Pure deletion: take the separating blank line with it.
      if (s > 0) return text.slice(0, from) + text.slice(ranges[n - s][0]);
      if (p > 0) return text.slice(0, ranges[p - 1][1]) + text.slice(to);
      return text.slice(0, from) + text.slice(to);
    }
    if (!inserted) return text;
    if (p > 0) {
      const at = ranges[p - 1][1];
      return `${text.slice(0, at)}\n\n${inserted}${text.slice(at)}`;
    }
    if (n > 0) {
      const at = ranges[0][0];
      return `${text.slice(0, at)}${inserted}\n\n${text.slice(at)}`;
    }
    return null;
  }
}

// `incoming` with the editor's own empty paragraphs (blank lines the user
// made, the trailing paragraph Crepe appends) kept wherever the content
// around them did not change. Diffing the editor against the raw parse would
// sweep them into the replaced range and drag the caret along with it.
export function keepEditorBlankLines(current: ProseNode, incoming: ProseNode): ProseNode {
  const cur = childrenOf(current);
  const inc = childrenOf(incoming);
  const curContent = cur.flatMap((node, i) => (isEmptyParagraph(node) ? [] : [i]));
  const incContent = inc.flatMap((node, i) => (isEmptyParagraph(node) ? [] : [i]));
  const n = curContent.length;
  const m = incContent.length;
  let p = 0;
  while (p < n && p < m && cur[curContent[p]].eq(inc[incContent[p]])) p++;
  if (p === n && p === m) return current;
  let s = 0;
  while (s < n - p && s < m - p && cur[curContent[n - 1 - s]].eq(inc[incContent[m - 1 - s]])) s++;
  // Nothing in common (e.g. the first load): nothing to anchor blank lines to.
  if (p === 0 && s === 0) return incoming;

  // Where the changed run sits in the editor; an empty run collapses to the
  // gap right after the last unchanged block before it.
  const curFrom = p < n - s ? curContent[p] : p > 0 ? curContent[p - 1] + 1 : curContent[n - s];
  const curTo = p < n - s ? curContent[n - s - 1] + 1 : curFrom;
  const incFrom = p < m - s ? incContent[p] : 0;
  const incTo = p < m - s ? incContent[m - s - 1] + 1 : 0;

  const merged = [...cur.slice(0, curFrom), ...inc.slice(incFrom, incTo), ...cur.slice(curTo)];
  const content = Fragment.fromArray(merged);
  return current.type.validContent(content) ? current.copy(content) : incoming;
}

function childrenOf(node: ProseNode): ProseNode[] {
  const children: ProseNode[] = [];
  node.forEach((child) => children.push(child));
  return children;
}

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

// Empty paragraphs exist only in the editor (blank lines the user made, the
// trailing paragraph Crepe keeps at the end); they never reach the file.
function contentBlocks(doc: ProseNode): ProseNode[] {
  const blocks: ProseNode[] = [];
  doc.forEach((child) => {
    if (!isEmptyParagraph(child)) blocks.push(child);
  });
  return blocks;
}

const isEmptyParagraph = (node: ProseNode) => node.type.name === 'paragraph' && node.content.size === 0;

const sameNodes = (a: ProseNode[], b: ProseNode[]) => a.length === b.length && a.every((node, i) => node.eq(b[i]));

// Milkdown's paragraph handler emits `<br />` for empty paragraphs when
// `remarkPreserveEmptyLinePlugin` is registered (see @milkdown/preset-commonmark
// paragraph toMarkdown); `<br>` lines in existing files parse back into empty
// paragraphs. Drop them before serializing so saved files stay clean markdown.
// (Stripping `<br />` lines from the output text instead would also eat them
// inside code blocks.) Containers whose schema needs the paragraph keep it.
function withoutEmptyParagraphs(node: ProseNode): ProseNode {
  if (node.isTextblock || node.isLeaf) return node;
  const kept: ProseNode[] = [];
  let changed = false;
  node.forEach((child) => {
    if (isEmptyParagraph(child)) {
      changed = true;
      return;
    }
    const next = withoutEmptyParagraphs(child);
    if (next !== child) changed = true;
    kept.push(next);
  });
  if (!changed) return node;
  const content = Fragment.fromArray(kept);
  return node.type.validContent(content) ? node.copy(content) : node;
}
