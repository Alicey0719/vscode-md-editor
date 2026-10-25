// Rewrite <img src="img/xxx.png"> in the editor DOM to the webview-safe URI.
// Uses a MutationObserver + host-side URI resolution. We only mutate DOM attrs,
// never the underlying ProseMirror node attrs, so serialization output stays
// as the original relative path.

import { cachedImageUri, onMessage, requestImageUris } from './hostBridge';

function isTargetSrc(src: string): boolean {
  return /^img\/[0-9a-zA-Z._-]+$/.test(src);
}

function apply(root: HTMLElement): void {
  const imgs = root.querySelectorAll('img');
  const missing: string[] = [];
  imgs.forEach((img) => {
    const original = img.getAttribute('src') ?? '';
    if (!isTargetSrc(original)) return;
    const cached = cachedImageUri(original);
    if (cached) {
      if (img.src !== cached) {
        img.setAttribute('data-original-src', original);
        img.src = cached;
      }
    } else {
      missing.push(original);
    }
  });
  if (missing.length > 0) requestImageUris(missing);
}

export function installImageRewriter(root: HTMLElement): () => void {
  // hostBridge has updated its cache by the time these handlers run.
  onMessage((msg) => {
    if (msg.type === 'imageUris' || msg.type === 'imageSaved') apply(root);
  });

  apply(root);
  // Coalesce: typing mutates the DOM on every keystroke, and documents with
  // many images would rescan all of them each time.
  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      apply(root);
    });
  });
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  return () => observer.disconnect();
}
