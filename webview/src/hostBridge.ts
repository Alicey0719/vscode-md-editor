import type { HostToWebview, WebviewToHost } from './messaging';

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const api = acquireVsCodeApi();

type Handler = (msg: HostToWebview) => void;
const handlers = new Set<Handler>();

window.addEventListener('message', (e) => {
  const data = e.data as HostToWebview | undefined;
  if (!data || typeof data !== 'object') return;
  for (const h of handlers) h(data);
});

export function post(msg: WebviewToHost): void {
  api.postMessage(msg);
}

export function onMessage(h: Handler): () => void {
  handlers.add(h);
  return () => handlers.delete(h);
}

let counter = 0;
export function nextRequestId(): string {
  counter += 1;
  return `${Date.now().toString(36)}-${counter}`;
}

const pending = new Map<string, { resolve: (r: { relPath: string; displayUri: string }) => void; reject: (e: Error) => void }>();

onMessage((msg) => {
  if (msg.type === 'imageSaved') {
    const p = pending.get(msg.requestId);
    if (p) {
      pending.delete(msg.requestId);
      p.resolve({ relPath: msg.relPath, displayUri: msg.displayUri });
    }
  } else if (msg.type === 'imageError') {
    const p = pending.get(msg.requestId);
    if (p) {
      pending.delete(msg.requestId);
      p.reject(new Error(msg.error));
    }
  }
});

export function saveImage(bytes: Uint8Array, mime: string): Promise<{ relPath: string; displayUri: string }> {
  const requestId = nextRequestId();
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    post({
      type: 'saveImage',
      requestId,
      bytes: Array.from(bytes),
      mime,
    });
    setTimeout(() => {
      if (pending.has(requestId)) {
        pending.delete(requestId);
        reject(new Error('timeout'));
      }
    }, 30000);
  });
}

const uriCache = new Map<string, string>();
const uriWaiters = new Map<string, Array<(uri: string | null) => void>>();

onMessage((msg) => {
  if (msg.type === 'imageUris') {
    for (const { relPath, displayUri } of msg.entries) {
      uriCache.set(relPath, displayUri);
      const waiters = uriWaiters.get(relPath);
      if (waiters) {
        uriWaiters.delete(relPath);
        for (const w of waiters) w(displayUri);
      }
    }
  }
});

export function resolveImageUri(relPath: string): Promise<string | null> {
  const cached = uriCache.get(relPath);
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve) => {
    const waiters = uriWaiters.get(relPath) ?? [];
    waiters.push(resolve);
    uriWaiters.set(relPath, waiters);
    post({ type: 'resolveImages', relPaths: [relPath] });
    setTimeout(() => {
      const list = uriWaiters.get(relPath);
      if (list && list.includes(resolve)) {
        const filtered = list.filter((r) => r !== resolve);
        if (filtered.length === 0) uriWaiters.delete(relPath);
        else uriWaiters.set(relPath, filtered);
        resolve(null);
      }
    }, 5000);
  });
}

export function primeImageUris(entries: Array<{ relPath: string; displayUri: string }>): void {
  for (const { relPath, displayUri } of entries) uriCache.set(relPath, displayUri);
}
