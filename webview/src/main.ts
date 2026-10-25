import './styles.css';
import { post, onMessage } from './hostBridge';
import { createBodyEditor, type BodyEditor } from './editor';
import { createFrontmatterPane } from './frontmatterPane';
import { createLegacyBanner } from './legacyBanner';
import { installImageRewriter } from './imageRewrite';
import type { LegacyReport } from './messaging';

const DEBOUNCE_MS = 250;

async function bootstrap(): Promise<void> {
  const appOrNull = document.getElementById('app');
  if (!appOrNull) throw new Error('#app not found');
  const app: HTMLElement = appOrNull;

  let bodyEditor: BodyEditor | null = null;
  let frontmatterPane: ReturnType<typeof createFrontmatterPane> | null = null;
  let frontmatterValue = '';
  let frontmatterDirty = false;
  // Latest body from the host and its version (see src/messaging.ts). Kept
  // even while the editor is still mounting so no update is lost.
  let hostBody = '';
  let syncVersion = 0;
  let changeTimer: ReturnType<typeof setTimeout> | null = null;

  // Send local edits now (debounce elapsed, focus left, or about to save).
  const flush = () => {
    if (changeTimer !== null) {
      clearTimeout(changeTimer);
      changeTimer = null;
    }
    if (!bodyEditor) return;
    const { markdown, changed } = bodyEditor.takeMarkdown();
    if (!changed && !frontmatterDirty) return;
    frontmatterDirty = false;
    post({ type: 'change', frontmatter: frontmatterValue, body: markdown, syncVersion });
  };

  const scheduleChange = () => {
    if (changeTimer !== null) clearTimeout(changeTimer);
    changeTimer = setTimeout(flush, DEBOUNCE_MS);
  };

  onMessage((msg) => {
    if (msg.type === 'init') {
      syncVersion = msg.syncVersion;
      hostBody = msg.body;
      frontmatterValue = msg.frontmatter;
      frontmatterDirty = false;
      void mount(msg.legacy);
    } else if (msg.type === 'externalEdit') {
      syncVersion = msg.syncVersion;
      hostBody = msg.body;
      if (msg.frontmatter !== frontmatterValue) {
        frontmatterValue = msg.frontmatter;
        frontmatterDirty = false;
        frontmatterPane?.setValue(msg.frontmatter);
      }
      if (!bodyEditor) return;
      if (bodyEditor.setMarkdown(msg.body) || frontmatterDirty) scheduleChange();
      else if (changeTimer !== null) {
        clearTimeout(changeTimer);
        changeTimer = null;
      }
    }
  });

  async function mount(legacy: LegacyReport): Promise<void> {
    const previous = bodyEditor;
    bodyEditor = null;
    if (previous) await previous.destroy();
    app.innerHTML = '';

    // Toolbar shell (sticky, full-width) — will host the editor's toolbar after editor mounts.
    const toolbarShell = document.createElement('div');
    toolbarShell.className = 'md-toolbar-shell';
    app.appendChild(toolbarShell);

    // Centered content column for banner, frontmatter, and paper.
    const column = document.createElement('div');
    column.className = 'md-content-column';
    app.appendChild(column);

    const banner = createLegacyBanner(legacy);
    if (banner) column.appendChild(banner);

    frontmatterPane = createFrontmatterPane(frontmatterValue);
    frontmatterPane.onChange((v) => {
      frontmatterValue = v;
      frontmatterDirty = true;
      scheduleChange();
    });
    column.appendChild(frontmatterPane.root);

    const bodyHost = document.createElement('div');
    column.appendChild(bodyHost);

    const editor = await createBodyEditor(bodyHost);
    editor.setMarkdown(hostBody);
    editor.onChange(scheduleChange);
    bodyEditor = editor;

    toolbarShell.appendChild(editor.toolbar);
    installImageRewriter(bodyHost);
  }

  // Focus leaving the webview is when VS Code auto-saves (onFocusChange /
  // onWindowChange); get pending edits in before that.
  window.addEventListener('blur', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flush();
  });

  // Runs after ProseMirror / the textarea handled the key (bubble phase on
  // document), but before VS Code's window-level listener forwards it.
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const key = e.key.toLowerCase();
    const target = e.target instanceof Node ? e.target : null;
    const inBody = target !== null && bodyEditor !== null && bodyEditor.root.contains(target);
    const inFrontmatter = target !== null && frontmatterPane !== null && frontmatterPane.root.contains(target);
    if ((key === 'z' || key === 'y') && (inBody || inFrontmatter)) {
      // The editor has its own undo history. Forwarded, the key would also run
      // VS Code's undo on the TextDocument — which can roll back edits made
      // in the plain-text editor — and the two would fight.
      e.stopPropagation();
    } else if (key === 's' && !e.shiftKey) {
      // Apply pending edits first, then save: VS Code would otherwise save
      // before the last keystrokes arrive and leave the file dirty.
      e.preventDefault();
      e.stopPropagation();
      flush();
      post({ type: 'save' });
    } else if (key === 'k' && !e.shiftKey && inBody) {
      // Ctrl+K is also VS Code's chord prefix; keep it in the editor.
      e.preventDefault();
      e.stopPropagation();
      bodyEditor?.editLink();
    }
  });

  post({ type: 'ready' });
}

bootstrap().catch((e) => {
  const err = e instanceof Error ? e.stack ?? e.message : String(e);
  post({ type: 'log', level: 'error', message: `bootstrap failed: ${err}` });
});
