// Typed protocol shared between extension host and webview.
//
// `syncVersion` is bumped by the host every time it pushes the document to the
// webview (init / externalEdit). The webview stamps each `change` with the
// version it last received so the host can drop changes computed against
// content that has since been edited elsewhere. `appliedChangeId` tells the
// webview which of its changes made it into the text it is being sent; later
// ones were dropped and must be re-applied on top.

export type HostToWebview =
  | { type: 'init'; frontmatter: string; body: string; legacy: LegacyReport; syncVersion: number }
  | { type: 'imageSaved'; requestId: string; relPath: string; displayUri: string }
  | { type: 'imageError'; requestId: string; error: string }
  | { type: 'externalEdit'; frontmatter: string; body: string; syncVersion: number; appliedChangeId: number }
  | { type: 'imageUris'; entries: Array<{ relPath: string; displayUri: string }> };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'change'; frontmatter: string; body: string; syncVersion: number; changeId: number }
  | { type: 'save' }
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
