// Typed protocol shared between extension host and webview.

export type HostToWebview =
  | { type: 'init'; frontmatter: string; body: string; legacy: LegacyReport }
  | { type: 'imageSaved'; requestId: string; relPath: string; displayUri: string }
  | { type: 'imageError'; requestId: string; error: string }
  | { type: 'externalEdit'; frontmatter: string; body: string }
  | { type: 'imageUris'; entries: Array<{ relPath: string; displayUri: string }> };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'change'; frontmatter: string; body: string }
  | { type: 'saveImage'; requestId: string; bytes: number[]; mime: string }
  | { type: 'resolveImages'; relPaths: string[] }
  | { type: 'openLink'; url: string }
  | { type: 'openPlainEditor' }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };

export interface LegacyReport {
  isLegacy: boolean;
  reasons: string[];
}
