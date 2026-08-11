import type { Crepe } from '@milkdown/crepe';
import { editorViewCtx } from '@milkdown/core';
import type { Node as ProseNode, NodeType } from '@milkdown/prose/model';

// Crepe's `image-block` node stores the image scale as a `ratio` attribute
// and serializes it into the markdown `alt` slot as e.g. `![1.00](img/x.png)`.
// That noise leaks into every saved file and is even harmful downstream (the
// blog's render-image hook writes it into HTML `alt`, breaking accessibility).
//
// This patch rewires the schema runners so the `alt` slot carries the caption
// text instead:
//   - alt in markdown  <->  caption attribute
//   - ratio is dropped from serialization (always 1 on parse)
//
// A resized image will therefore not persist its scale across saves, which is
// an acceptable trade for clean, semantically-correct markdown.
export function patchImageBlockSerialization(crepe: Crepe): void {
  crepe.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const imageBlock = view.state.schema.nodes['image-block'] as NodeType | undefined;
    if (!imageBlock) return;
    const spec = imageBlock.spec as unknown as {
      parseMarkdown?: { runner?: unknown };
      toMarkdown?: { runner?: unknown };
    };
    if (spec.parseMarkdown) {
      spec.parseMarkdown.runner = (state: ParserState, node: MdImageNode, type: NodeType) => {
        state.addNode(type, {
          src: node.url ?? '',
          caption: node.alt ?? '',
          ratio: 1,
        });
      };
    }
    if (spec.toMarkdown) {
      spec.toMarkdown.runner = (state: SerializerState, node: ProseNode) => {
        state.openNode('paragraph');
        state.addNode('image', undefined, undefined, {
          url: node.attrs.src ?? '',
          alt: node.attrs.caption ?? '',
        });
        state.closeNode();
      };
    }
  });
}

interface MdImageNode {
  url?: string;
  alt?: string;
  title?: string;
}

interface ParserState {
  addNode(type: NodeType, attrs?: Record<string, unknown>): unknown;
}

interface SerializerState {
  openNode(type: string, value?: unknown, props?: Record<string, unknown>): unknown;
  addNode(
    type: string,
    children?: unknown,
    value?: unknown,
    props?: Record<string, unknown>,
  ): unknown;
  closeNode(): unknown;
}
