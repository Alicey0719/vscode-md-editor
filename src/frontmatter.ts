// Pure functions to split/merge YAML frontmatter from a Markdown document.

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
