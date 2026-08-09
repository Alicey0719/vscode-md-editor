// Rewrite <img src="img/xxx.png"> in the editor DOM to the webview-safe URI.
// Uses a MutationObserver + host-side URI resolution. We only mutate DOM attrs,
// never the underlying ProseMirror node attrs, so serialization output stays
// as the original relative path.

import { post, onMessage } from './hostBridge';

const uriCache = new Map<string, string>();
const pending = new Set<string>();

function isTargetSrc(src: string): boolean {
  return /^img\/[0-9a-zA-Z._-]+$/.test(src);
}

function requestResolve(relPaths: string[]): void {
  const need = relPaths.filter((p) => !uriCache.has(p) && !pending.has(p));
  if (need.length === 0) return;
  need.forEach((p) => pending.add(p));
  post({ type: 'resolveImages', relPaths: need });
}

function apply(root: HTMLElement): void {
  const imgs = root.querySelectorAll('img');
  const missing: string[] = [];
  imgs.forEach((img) => {
    const original = img.getAttribute('src') ?? '';
    if (!isTargetSrc(original)) return;
    const cached = uriCache.get(original);
    if (cached) {
      if (img.src !== cached) {
        img.setAttribute('data-original-src', original);
        img.src = cached;
      }
    } else {
      missing.push(original);
    }
  });
  if (missing.length > 0) requestResolve(missing);
}

export function installImageRewriter(root: HTMLElement): () => void {
  onMessage((msg) => {
    if (msg.type === 'imageUris') {
      for (const { relPath, displayUri } of msg.entries) {
        uriCache.set(relPath, displayUri);
        pending.delete(relPath);
      }
      apply(root);
    } else if (msg.type === 'imageSaved') {
      uriCache.set(msg.relPath, msg.displayUri);
      apply(root);
    }
  });

  apply(root);
  const observer = new MutationObserver(() => apply(root));
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  return () => observer.disconnect();
}
