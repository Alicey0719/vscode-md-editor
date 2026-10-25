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
  // What the host last sent us and its version (see src/messaging.ts). Kept
  // even while the editor is still mounting so no update is lost.
  let hostBody = '';
  let hostFrontmatter = '';
  let syncVersion = 0;
  // Changes sent but not yet acknowledged with `applied`.
  let sent: Array<{ id: number; body: string; frontmatter: string }> = [];
  let nextChangeId = 0;
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
    const changeId = ++nextChangeId;
    sent.push({ id: changeId, body: markdown, frontmatter: frontmatterValue });
    post({ type: 'change', frontmatter: frontmatterValue, body: markdown, syncVersion, changeId });
  };

  const scheduleChange = () => {
    if (changeTimer !== null) clearTimeout(changeTimer);
    changeTimer = setTimeout(flush, DEBOUNCE_MS);
  };

  onMessage((msg) => {
    if (msg.type === 'init') {
      syncVersion = msg.syncVersion;
      hostBody = msg.body;
      hostFrontmatter = msg.frontmatter;
      frontmatterValue = msg.frontmatter;
      frontmatterDirty = false;
      sent = [];
      nextChangeId = 0;
      void mount(msg.legacy);
    } else if (msg.type === 'applied') {
      const i = sent.findIndex((c) => c.id === msg.changeId);
      if (i < 0) return;
      hostBody = sent[i].body;
      hostFrontmatter = sent[i].frontmatter;
      sent = sent.slice(i + 1);
    } else if (msg.type === 'externalEdit') {
      // Every change still unacknowledged was dropped; the host held
      // hostBody / hostFrontmatter before this edit.
      const confirmedBody = hostBody;
      const confirmedFrontmatter = hostFrontmatter;
      sent = [];
      syncVersion = msg.syncVersion;
      hostBody = msg.body;
      hostFrontmatter = msg.frontmatter;
      // Frontmatter: an edit elsewhere wins; otherwise keep (and resend) ours.
      const external = msg.frontmatter !== confirmedFrontmatter || msg.discardLocal;
      if (external && msg.frontmatter !== frontmatterValue) {
        frontmatterValue = msg.frontmatter;
        frontmatterPane?.setValue(msg.frontmatter);
      }
      frontmatterDirty = frontmatterValue !== msg.frontmatter;
      if (!bodyEditor) return;
      if (bodyEditor.setMarkdown(msg.body, confirmedBody, msg.discardLocal) || frontmatterDirty) scheduleChange();
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
    // Non-Latin layouts (Cyrillic, Greek, ...) report another letter in
    // e.key; ProseMirror and VS Code fall back to the physical key, so do too.
    const key = /^[a-z]$/i.test(e.key) ? e.key.toLowerCase() : e.code.replace(/^Key/, '').toLowerCase();
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
