import type { EditorState } from '@milkdown/prose/state';
import type { Mark } from '@milkdown/prose/model';

// The whole link around the selection (caret inside or at either edge of the
// link text, or a selection within it), or null. Lets the Link button / Ctrl+K
// edit an existing URL instead of toggling the link off.
export function linkRangeAt(state: EditorState): { mark: Mark; from: number; to: number } | null {
  const type = state.schema.marks.link;
  if (!type) return null;
  const { $from, from, to } = state.selection;
  const parent = $from.parent;
  if (!parent.isTextblock) return null;
  // The child after the position first, then the one before (caret at the
  // end of the link).
  for (const index of [$from.index(), $from.index() - 1]) {
    if (index < 0 || index >= parent.childCount) continue;
    const mark = type.isInSet(parent.child(index).marks);
    if (!mark) continue;
    let first = index;
    let last = index;
    while (first > 0 && mark.isInSet(parent.child(first - 1).marks)) first--;
    while (last + 1 < parent.childCount && mark.isInSet(parent.child(last + 1).marks)) last++;
    let start = $from.start();
    for (let i = 0; i < first; i++) start += parent.child(i).nodeSize;
    let end = start;
    for (let i = first; i <= last; i++) end += parent.child(i).nodeSize;
    if (start <= from && to <= end) return { mark, from: start, to: end };
  }
  return null;
}
