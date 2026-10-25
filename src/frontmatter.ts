// Pure functions to split/merge YAML frontmatter from a Markdown document.

import { toLF, fromLF } from './textEdit';

export interface Split {
  frontmatter: string;
  body: string;
  hadFrontmatter: boolean;
}

const FENCE = /^---\s*\r?\n/;

export function split(text: string): Split {
  if (!FENCE.test(text)) {
    return { frontmatter: '', body: text, hadFrontmatter: false };
  }
  const rest = text.replace(FENCE, '');
  const closer = rest.match(/\r?\n---\s*(?:\r?\n|$)/);
  if (!closer || closer.index === undefined) {
    return { frontmatter: '', body: text, hadFrontmatter: false };
  }
  const frontmatter = rest.slice(0, closer.index);
  const body = rest.slice(closer.index + closer[0].length);
  return { frontmatter, body, hadFrontmatter: true };
}

export function merge(frontmatter: string, body: string, hadFrontmatter: boolean): string {
  const bodyOut = body.endsWith('\n') ? body : body + '\n';
  if (!hadFrontmatter && frontmatter.trim() === '') {
    return bodyOut;
  }
  const fm = frontmatter.replace(/\r?\n$/, '');
  return `---\n${fm}\n---\n\n${bodyOut.replace(/^\r?\n+/, '')}`;
}

// The document text for the webview's frontmatter and body. When the
// frontmatter is unchanged, everything before the body (fences, the blank
// line after them) is kept byte for byte, so body edits never touch it.
export function documentText(current: string, frontmatter: string, body: string, eol: '\n' | '\r\n'): string {
  const cur = split(current);
  const bodyOut = body.endsWith('\n') ? body : `${body}\n`;
  // merge() drops one trailing newline from the frontmatter, so ignore it.
  const sameFrontmatter = toLF(cur.frontmatter).replace(/\n$/, '') === frontmatter.replace(/\n$/, '');
  if (sameFrontmatter && (cur.hadFrontmatter || frontmatter.trim() === '')) {
    // A fully re-serialized body has no leading blank line; keep the old one.
    const lead = bodyOut.startsWith('\n') ? '' : (/^\n*/.exec(toLF(cur.body)) ?? [''])[0];
    return current.slice(0, current.length - cur.body.length) + fromLF(lead + bodyOut, eol);
  }
  return fromLF(merge(frontmatter, body, cur.hadFrontmatter || frontmatter.trim() !== ''), eol);
}
