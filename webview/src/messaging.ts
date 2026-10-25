// Duplicated from src/messaging.ts to keep the webview bundle standalone.
// Keep in sync manually.

export type HostToWebview =
  | { type: 'init'; frontmatter: string; body: string; legacy: LegacyReport; syncVersion: number }
  | { type: 'imageSaved'; requestId: string; relPath: string; displayUri: string }
  | { type: 'imageError'; requestId: string; error: string }
  | { type: 'applied'; changeId: number }
  | { type: 'flush'; requestId: number }
  | { type: 'externalEdit'; frontmatter: string; body: string; syncVersion: number; discardLocal?: boolean }
  | { type: 'imageUris'; entries: Array<{ relPath: string; displayUri: string }> };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'change'; frontmatter: string; body: string; syncVersion: number; changeId: number }
  | { type: 'flushed'; requestId: number; change?: { frontmatter: string; body: string; syncVersion: number; changeId: number } }
  | { type: 'saveImage'; requestId: string; bytes: Uint8Array; mime: string }
  | { type: 'resolveImages'; relPaths: string[] }
  | { type: 'openLink'; url: string }
  | { type: 'openPlainEditor' }
  | { type: 'notify'; level: 'warn' | 'error'; message: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };

export interface LegacyReport {
  isLegacy: boolean;
  reasons: string[];
}
