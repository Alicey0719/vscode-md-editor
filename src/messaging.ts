// Typed protocol shared between extension host and webview.
//
// `syncVersion` is bumped by the host every time it pushes the document to the
// webview (init / externalEdit). The webview stamps each `change` with the
// version it last received so the host can drop changes computed against
// content that has since been edited elsewhere. Each applied change is
// acknowledged with `applied` (always before any later externalEdit), so on
// an externalEdit every unacknowledged change was dropped and the webview
// re-applies it on top. `discardLocal` means the document refused the edit
// (read-only): show the document as is. Before every save the host sends
// `flush` and gets pending edits back in `flushed`, so no save path misses
// the last keystrokes.

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
