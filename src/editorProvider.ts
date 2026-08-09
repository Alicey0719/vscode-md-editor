import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import { split, merge } from './frontmatter';
import { detect } from './legacyDetect';
import { ImageStore } from './imageStore';
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

    let selfWriting = false;
    let lastText = document.getText();

    const pushInit = () => {
      const { frontmatter, body } = split(document.getText());
      const legacy = detect(body);
      post({ type: 'init', frontmatter, body, legacy });
      lastText = document.getText();
    };

    const changeSubscription = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      if (selfWriting) return;
      const { frontmatter, body } = split(document.getText());
      post({ type: 'externalEdit', frontmatter, body });
      lastText = document.getText();
    });

    const msgSubscription = webviewPanel.webview.onDidReceiveMessage(async (raw: unknown) => {
      const msg = validateWebviewMessage(raw);
      if (!msg) return;
      switch (msg.type) {
        case 'ready':
          pushInit();
          break;
        case 'change': {
          const { hadFrontmatter } = split(document.getText());
          const merged = merge(msg.frontmatter, msg.body, hadFrontmatter || msg.frontmatter.trim() !== '');
          if (merged === document.getText()) return;
          const edit = new vscode.WorkspaceEdit();
          const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(document.getText().length),
          );
          edit.replace(document.uri, fullRange, merged);
          selfWriting = true;
          try {
            await vscode.workspace.applyEdit(edit);
            lastText = document.getText();
          } finally {
            selfWriting = false;
          }
          break;
        }
        case 'saveImage': {
          try {
            const bytes = new Uint8Array(msg.bytes);
            const { relPath } = await imageStore.save(bytes, msg.mime);
            const displayUri = imageStore.resolveDisplayUri(webviewPanel.webview, relPath) ?? '';
            post({ type: 'imageSaved', requestId: msg.requestId, relPath, displayUri });
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            post({ type: 'imageError', requestId: msg.requestId, error });
          }
          break;
        }
        case 'resolveImages': {
          const entries: Array<{ relPath: string; displayUri: string }> = [];
          for (const relPath of msg.relPaths) {
            const displayUri = imageStore.resolveDisplayUri(webviewPanel.webview, relPath);
            if (displayUri) entries.push({ relPath, displayUri });
          }
          post({ type: 'imageUris', entries });
          break;
        }
        case 'openLink': {
          try {
            const parsed = vscode.Uri.parse(msg.url, true);
            if (parsed.scheme !== 'http' && parsed.scheme !== 'https') return;
            await vscode.env.openExternal(parsed);
          } catch { /* invalid url */ }
          break;
        }
        case 'openPlainEditor': {
          await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
          break;
        }
        case 'log':
          console[msg.level === 'error' ? 'error' : msg.level === 'warn' ? 'warn' : 'log'](
            '[mdEditor webview]',
            msg.message,
          );
          break;
      }
      // suppress unused warning for lastText baseline
      void lastText;
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

function validateWebviewMessage(raw: unknown): WebviewToHost | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case 'ready':
      return { type: 'ready' };
    case 'change':
      if (typeof m.frontmatter === 'string' && typeof m.body === 'string') {
        return { type: 'change', frontmatter: m.frontmatter, body: m.body };
      }
      return null;
    case 'saveImage':
      if (
        typeof m.requestId === 'string' &&
        m.requestId.length > 0 &&
        m.requestId.length < 128 &&
        Array.isArray(m.bytes) &&
        m.bytes.length > 0 &&
        m.bytes.length < 20 * 1024 * 1024 &&
        typeof m.mime === 'string' &&
        m.mime.length < 128
      ) {
        return { type: 'saveImage', requestId: m.requestId, bytes: m.bytes as number[], mime: m.mime };
      }
      return null;
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
