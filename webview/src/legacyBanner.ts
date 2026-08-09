import { post } from './hostBridge';
import type { LegacyReport } from './messaging';

export function createLegacyBanner(report: LegacyReport): HTMLElement | null {
  if (!report.isLegacy) return null;

  const el = document.createElement('div');
  el.className = 'md-legacy-banner';

  const text = document.createElement('div');
  text.textContent =
    'このファイルには テンプレート/ショートコード構文 または 生 HTML が含まれています。WYSIWYG で保存すると壊れる可能性があります。';
  el.appendChild(text);

  if (report.reasons.length > 0) {
    const reasons = document.createElement('ul');
    for (const r of report.reasons) {
      const li = document.createElement('li');
      li.textContent = r;
      reasons.appendChild(li);
    }
    el.appendChild(reasons);
  }

  const btn = document.createElement('button');
  btn.className = 'md-legacy-btn';
  btn.textContent = 'プレーンテキストエディタで開く';
  btn.addEventListener('click', () => post({ type: 'openPlainEditor' }));
  el.appendChild(btn);

  return el;
}
