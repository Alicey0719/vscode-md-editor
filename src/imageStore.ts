// Persist pasted/dropped images into the sibling img/ directory.
// Enforces: magic-byte type check, size cap, path traversal prevention.

import * as vscode from 'vscode';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const MAX_BYTES = 20 * 1024 * 1024;
const HASH_LEN = 16;

type Kind = 'png' | 'jpg' | 'webp' | 'gif';

interface Detected {
  kind: Kind;
  ext: string;
}

function detectKind(bytes: Uint8Array): Detected | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { kind: 'png', ext: '.png' };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { kind: 'jpg', ext: '.jpg' };
  }
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return { kind: 'gif', ext: '.gif' };
  }
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return { kind: 'webp', ext: '.webp' };
  }
  return null;
}

function mimeMatches(mime: string, kind: Kind): boolean {
  const m = mime.toLowerCase();
  switch (kind) {
    case 'png': return m === 'image/png';
    case 'jpg': return m === 'image/jpeg' || m === 'image/jpg';
    case 'webp': return m === 'image/webp';
    case 'gif': return m === 'image/gif';
  }
}

export interface SaveResult {
  relPath: string;
  absPath: string;
}

export class ImageStore {
  constructor(private readonly docUri: vscode.Uri) {}

  private get imgDir(): vscode.Uri {
    return vscode.Uri.joinPath(this.docUri, '..', 'img');
  }

  async save(bytes: Uint8Array, claimedMime: string): Promise<SaveResult> {
    if (bytes.byteLength === 0) throw new Error('empty image');
    if (bytes.byteLength > MAX_BYTES) {
      throw new Error(`image too large (${bytes.byteLength} > ${MAX_BYTES})`);
    }

    const detected = detectKind(bytes);
    if (!detected) throw new Error('unsupported or unrecognized image format');

    if (claimedMime && !mimeMatches(claimedMime, detected.kind)) {
      throw new Error(`mime type mismatch: claimed=${claimedMime}, detected=${detected.kind}`);
    }

    const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, HASH_LEN);
    if (!/^[0-9a-f]{16}$/.test(hash)) throw new Error('hash generation failed');

    const filename = `${hash}${detected.ext}`;
    const target = vscode.Uri.joinPath(this.imgDir, filename);

    const imgDirPath = this.imgDir.fsPath;
    const targetPath = path.resolve(target.fsPath);
    const rel = path.relative(imgDirPath, targetPath);
    if (rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) {
      throw new Error('path traversal detected');
    }

    await vscode.workspace.fs.createDirectory(this.imgDir);
    let exists = false;
    try {
      await vscode.workspace.fs.stat(target);
      exists = true;
    } catch { /* not present */ }

    if (!exists) {
      await vscode.workspace.fs.writeFile(target, bytes);
    }

    return { relPath: `img/${filename}`, absPath: target.fsPath };
  }

  resolveDisplayUri(webview: vscode.Webview, relPath: string): string | null {
    if (!/^img\/[0-9a-zA-Z._-]+$/.test(relPath)) return null;
    if (relPath.includes('..')) return null;
    const abs = vscode.Uri.joinPath(this.docUri, '..', relPath);
    return webview.asWebviewUri(abs).toString();
  }
}
