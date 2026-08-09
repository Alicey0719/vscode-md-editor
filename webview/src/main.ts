import './styles.css';
import { post, onMessage } from './hostBridge';
import { createBodyEditor, type BodyEditor } from './editor';
import { createFrontmatterPane } from './frontmatterPane';
import { createLegacyBanner } from './legacyBanner';
import { installImageRewriter } from './imageRewrite';

const DEBOUNCE_MS = 250;

async function bootstrap(): Promise<void> {
  const appOrNull = document.getElementById('app');
  if (!appOrNull) throw new Error('#app not found');
  const app: HTMLElement = appOrNull;

  let bodyEditor: BodyEditor | null = null;
  let frontmatterValue = '';
  let bodyValue = '';
  let changeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleChange = () => {
    if (changeTimer !== null) clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      post({ type: 'change', frontmatter: frontmatterValue, body: bodyValue });
    }, DEBOUNCE_MS);
  };

  onMessage((msg) => {
    if (msg.type === 'init') {
      void mount(msg.frontmatter, msg.body, msg.legacy);
    } else if (msg.type === 'externalEdit') {
      if (!bodyEditor) return;
      frontmatterValue = msg.frontmatter;
      bodyValue = msg.body;
      frontmatterPane?.setValue(msg.frontmatter);
      bodyEditor.setMarkdown(msg.body);
    }
  });

  let frontmatterPane: ReturnType<typeof createFrontmatterPane> | null = null;

  async function mount(frontmatter: string, body: string, legacy: import('./messaging').LegacyReport): Promise<void> {
    app.innerHTML = '';
    frontmatterValue = frontmatter;
    bodyValue = body;

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

    frontmatterPane = createFrontmatterPane(frontmatter);
    frontmatterPane.onChange((v) => {
      frontmatterValue = v;
      scheduleChange();
    });
    column.appendChild(frontmatterPane.root);

    const bodyHost = document.createElement('div');
    column.appendChild(bodyHost);

    bodyEditor = await createBodyEditor(bodyHost, body);
    bodyEditor.onChange((markdown) => {
      bodyValue = markdown;
      scheduleChange();
    });

    toolbarShell.appendChild(bodyEditor.toolbar);
    installImageRewriter(bodyHost);
  }

  post({ type: 'ready' });
}

bootstrap().catch((e) => {
  const err = e instanceof Error ? e.stack ?? e.message : String(e);
  post({ type: 'log', level: 'error', message: `bootstrap failed: ${err}` });
});
