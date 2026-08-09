// Detect files that contain template/shortcode syntax or raw HTML that the
// WYSIWYG round-trip would damage; when found we warn the user and offer the
// plain text editor as a fallback.
//
// <br> alone is NOT flagged: markdown serializers sometimes emit it for hard
// breaks inside contexts (e.g. inside headings or list items) where the
// backslash-newline form is invalid, and it round-trips cleanly.

import type { LegacyReport } from './messaging';

const CHECKS: Array<{ re: RegExp; reason: string }> = [
  { re: /\{\{[<%]/, reason: 'Template/shortcode syntax detected (e.g. {{< ... >}})' },
  { re: /<(?:div|span|p|iframe|table|figure|font)\b/i, reason: 'Raw HTML block detected' },
  { re: /style\s*=\s*["']/i, reason: 'Inline HTML style attribute detected' },
];

export function detect(body: string): LegacyReport {
  const reasons: string[] = [];
  for (const { re, reason } of CHECKS) {
    if (re.test(body) && !reasons.includes(reason)) {
      reasons.push(reason);
    }
  }
  return { isLegacy: reasons.length > 0, reasons };
}
