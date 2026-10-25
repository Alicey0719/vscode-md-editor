// Pure text helpers for syncing the webview's markdown into the TextDocument.

export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

// Smallest single-range edit that turns `before` into `after` (null if equal).
// Replacing only the changed span keeps the plain-text editor's cursor and
// scroll position, and keeps VS Code's undo steps small.
export function minimalEdit(before: string, after: string): TextEdit | null {
  if (before === after) return null;
  const max = Math.min(before.length, after.length);
  let start = 0;
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  let endB = before.length;
  let endA = after.length;
  while (endB > start && endA > start && before.charCodeAt(endB - 1) === after.charCodeAt(endA - 1)) {
    endB--;
    endA--;
  }
  // Never cut a CRLF or a surrogate pair in half.
  while (
    start > 0 &&
    isFirstHalf(before.charCodeAt(start - 1)) &&
    (isSecondHalf(before.charCodeAt(start)) || isSecondHalf(after.charCodeAt(start)))
  ) {
    start--;
  }
  while (
    endB < before.length &&
    isSecondHalf(before.charCodeAt(endB)) &&
    (isFirstHalf(before.charCodeAt(endB - 1)) || isFirstHalf(after.charCodeAt(endA - 1)))
  ) {
    endB++;
    endA++;
  }
  return { start, end: endB, text: after.slice(start, endA) };
}

const isFirstHalf = (c: number) => c === 0x0d || (c >= 0xd800 && c <= 0xdbff);
const isSecondHalf = (c: number) => c === 0x0a || (c >= 0xdc00 && c <= 0xdfff);

export const toLF = (text: string): string => text.replace(/\r\n/g, '\n');

export const fromLF = (text: string, eol: '\n' | '\r\n'): string =>
  eol === '\n' ? text : text.replace(/\r?\n/g, '\r\n');
