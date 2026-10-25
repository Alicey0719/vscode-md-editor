import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import { split, merge } from './frontmatter';
import { detect } from './legacyDetect';
import { ImageStore, MAX_IMAGE_BYTES } from './imageStore';
import { minimalEdit, toLF, fromLF } from './textEdit';
import type { HostToWebview, WebviewToHost } from './messaging';

export class MdEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'mdEditor.wysiwyg';

  constructor(private readonly context: vscode.ExtensionContext) {}

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const docDir = vscode.Uri.joinPath(document.uri, '..');
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot, docDir],
    };

    const imageStore = new ImageStore(document.uri);
    const post = (msg: HostToWebview) => webviewPanel.webview.postMessage(msg);

    webviewPanel.webview.html = this.renderHtml(webviewPanel.webview);

    // Text (in the document's own EOL) that the webview's state reflects. Any
    // document change that does not leave the text equal to this came from
    // somewhere else (plain editor, formatter, VS Code undo, git) and must be
    // pushed to the webview; everything else (our own edits, the dirty-flag flip
    // on save) must not, or the editor gets reset and loses its cursor.
    let webviewText = '';
    let syncVersion = 0;
    // Last webview change that made it into the document (see messaging.ts).
    let appliedChangeId = 0;
    // Edits are applied strictly in order; `change` handlers would otherwise
    // interleave across the `applyEdit` await.
    let queue: Promise<void> = Promise.resolve();
    const enqueue = (job: () => Promise<void>) => {
      queue = queue.then(job).catch((err) => console.error('[mdEditor]', err));
    };
    let applying = false;
    let pushPending = false;

    const eol = () => (document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n');

    const sendDocument = (type: 'init' | 'externalEdit') => {
      pushPending = false;
      webviewText = document.getText();
      const { frontmatter, body } = split(toLF(webviewText));
      if (type === 'init') {
        void post({ type, frontmatter, body, legacy: detect(body), syncVersion });
      } else {
        void post({ type, frontmatter, body, syncVersion, appliedChangeId });
      }
    };

    // The document changed under the webview. Bump the version right away so
    // queued changes based on the old text are rejected, but send the text
    // only once an edit in flight has settled, so `appliedChangeId` is exact.
    const externalChange = () => {
      syncVersion += 1;
      if (applying) pushPending = true;
      else sendDocument('externalEdit');
    };

    const applyChange = async (msg: { frontmatter: string; body: string; syncVersion: number; changeId: number }) => {
      // Computed before the webview saw the latest external edit: applying it
      // would silently revert that edit. The webview re-applies its edits on
      // top of the newer text (it learns this one was dropped from
      // `appliedChangeId`) and sends them again.
      if (msg.syncVersion !== syncVersion) return;
      const current = document.getText();
      const { hadFrontmatter } = split(current);
      const merged = fromLF(
        merge(msg.frontmatter, msg.body, hadFrontmatter || msg.frontmatter.trim() !== ''),
        eol(),
      );
      const edit = minimalEdit(current, merged);
      if (!edit) {
        appliedChangeId = msg.changeId;
        return;
      }
      webviewText = merged;
      const workspaceEdit = new vscode.WorkspaceEdit();
      workspaceEdit.replace(
        document.uri,
        new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)),
        edit.text,
      );
      applying = true;
      let applied = false;
      try {
        applied = await vscode.workspace.applyEdit(workspaceEdit);
      } finally {
        applying = false;
      }
      if (applied) {
        appliedChangeId = msg.changeId;
        if (pushPending) sendDocument('externalEdit');
      } else {
        // Rejected (the document moved on, or it is read-only): resync.
        syncVersion += 1;
        sendDocument('externalEdit');
      }
    };

    const changeSubscription = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      if (e.contentChanges.length === 0 || document.getText() === webviewText) return;
      externalChange();
    });

    const msgSubscription = webviewPanel.webview.onDidReceiveMessage(async (raw: unknown) => {
      const msg = validateWebviewMessage(raw);
      if (!msg) return;
      switch (msg.type) {
        case 'ready':
          // A (re)loaded webview numbers its changes from 1 again.
          syncVersion += 1;
          appliedChangeId = 0;
          sendDocument('init');
          break;
        case 'change':
          enqueue(() => applyChange(msg));
          break;
        case 'save':
          // Queued behind pending changes so the last keystrokes are saved too.
          enqueue(async () => {
            await document.save();
          });
          break;
        case 'saveImage': {
          try {
            const { relPath } = await imageStore.save(msg.bytes, msg.mime);
            const displayUri = imageStore.resolveDisplayUri(webviewPanel.webview, relPath) ?? '';
            void post({ type: 'imageSaved', requestId: msg.requestId, relPath, displayUri });
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            void post({ type: 'imageError', requestId: msg.requestId, error });
          }
          break;
        }
        case 'resolveImages': {
          const entries: Array<{ relPath: string; displayUri: string }> = [];
          for (const relPath of msg.relPaths) {
            const displayUri = imageStore.resolveDisplayUri(webviewPanel.webview, relPath);
            if (displayUri) entries.push({ relPath, displayUri });
          }
          void post({ type: 'imageUris', entries });
          break;
        }
        case 'openLink':
          await openLink(msg.url, docDir);
          break;
        case 'openPlainEditor': {
          await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
          break;
        }
        case 'notify':
          if (msg.level === 'error') void vscode.window.showErrorMessage(`mdEditor: ${msg.message}`);
          else void vscode.window.showWarningMessage(`mdEditor: ${msg.message}`);
          break;
        case 'log':
          console[msg.level === 'error' ? 'error' : msg.level === 'warn' ? 'warn' : 'log'](
            '[mdEditor webview]',
            msg.message,
          );
          break;
      }
    });

    webviewPanel.onDidDispose(() => {
      changeSubscription.dispose();
      msgSubscription.dispose();
    });
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview.css'),
    );
    const cacheBust = `?v=${Date.now()}`;
    const cspSource = webview.cspSource;
    const csp = [
      `default-src 'none'`,
      `script-src ${cspSource} 'nonce-${nonce}'`,
      `style-src ${cspSource} 'unsafe-inline'`,
      `img-src ${cspSource} data: https:`,
      `font-src ${cspSource} data:`,
      `connect-src 'none'`,
    ].join('; ');

    return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>mdEditor</title>
<link rel="stylesheet" href="${styleUri}${cacheBust}" />
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${scriptUri}${cacheBust}"></script>
</body>
</html>`;
  }
}

// http(s)/mailto open in the browser; relative links (`../other.md`,
// `img/x.png#frag`) open the workspace file next to the document.
async function openLink(url: string, docDir: vscode.Uri): Promise<void> {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    try {
      const parsed = vscode.Uri.parse(url, true);
      if (parsed.scheme === 'http' || parsed.scheme === 'https' || parsed.scheme === 'mailto') {
        await vscode.env.openExternal(parsed);
      }
    } catch { /* invalid url */ }
    return;
  }
  let relPath: string;
  try {
    relPath = decodeURIComponent(url.replace(/[?#].*$/, ''));
  } catch {
    return;
  }
  if (!relPath || relPath.startsWith('/')) return;
  const target = vscode.Uri.joinPath(docDir, relPath);
  try {
    await vscode.workspace.fs.stat(target);
  } catch {
    void vscode.window.showWarningMessage(`mdEditor: ${relPath} が見つかりません`);
    return;
  }
  await vscode.commands.executeCommand('vscode.open', target);
}

function toBytes(value: unknown): Uint8Array | null {
  // VS Code transfers typed arrays as-is; older builds may hand over a plain
  // ArrayBuffer or a JSON number array.
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value) && value.length <= MAX_IMAGE_BYTES && value.every((b) => typeof b === 'number')) {
    return Uint8Array.from(value as number[]);
  }
  return null;
}

function validateWebviewMessage(raw: unknown): WebviewToHost | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case 'ready':
      return { type: 'ready' };
    case 'change':
      if (
        typeof m.frontmatter === 'string' &&
        typeof m.body === 'string' &&
        typeof m.syncVersion === 'number' &&
        typeof m.changeId === 'number'
      ) {
        return { type: 'change', frontmatter: m.frontmatter, body: m.body, syncVersion: m.syncVersion, changeId: m.changeId };
      }
      return null;
    case 'save':
      return { type: 'save' };
    case 'saveImage': {
      const bytes = toBytes(m.bytes);
      if (
        typeof m.requestId === 'string' &&
        m.requestId.length > 0 &&
        m.requestId.length < 128 &&
        bytes &&
        bytes.byteLength > 0 &&
        bytes.byteLength <= MAX_IMAGE_BYTES &&
        typeof m.mime === 'string' &&
        m.mime.length < 128
      ) {
        return { type: 'saveImage', requestId: m.requestId, bytes, mime: m.mime };
      }
      return null;
    }
    case 'resolveImages':
      if (Array.isArray(m.relPaths) && m.relPaths.every((p) => typeof p === 'string' && p.length < 256)) {
        return { type: 'resolveImages', relPaths: m.relPaths as string[] };
      }
      return null;
    case 'openLink':
      if (typeof m.url === 'string' && m.url.length < 2048) {
        return { type: 'openLink', url: m.url };
      }
      return null;
    case 'openPlainEditor':
      return { type: 'openPlainEditor' };
    case 'notify':
      if ((m.level === 'warn' || m.level === 'error') && typeof m.message === 'string' && m.message.length < 4096) {
        return { type: 'notify', level: m.level, message: m.message };
      }
      return null;
    case 'log':
      if (
        (m.level === 'info' || m.level === 'warn' || m.level === 'error') &&
        typeof m.message === 'string' &&
        m.message.length < 4096
      ) {
        return { type: 'log', level: m.level, message: m.message };
      }
      return null;
  }
  return null;
}
