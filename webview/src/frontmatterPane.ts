export interface FrontmatterPane {
  root: HTMLElement;
  getValue: () => string;
  setValue: (v: string) => void;
  onChange: (cb: (v: string) => void) => void;
}

export function createFrontmatterPane(initial: string): FrontmatterPane {
  const root = document.createElement('details');
  root.className = 'md-frontmatter';
  root.open = false;

  const summary = document.createElement('summary');
  summary.textContent = 'Frontmatter (YAML)';
  root.appendChild(summary);

  const textarea = document.createElement('textarea');
  textarea.className = 'md-frontmatter-input';
  textarea.spellcheck = false;
  textarea.value = initial;
  textarea.rows = Math.min(20, Math.max(4, initial.split('\n').length + 1));
  root.appendChild(textarea);

  const changeCallbacks: Array<(v: string) => void> = [];
  textarea.addEventListener('input', () => {
    for (const cb of changeCallbacks) cb(textarea.value);
  });

  return {
    root,
    getValue: () => textarea.value,
    setValue: (v) => {
      textarea.value = v;
    },
    onChange: (cb) => changeCallbacks.push(cb),
  };
}
