// Persist pasted/dropped images into the sibling img/ directory.
// Enforces: magic-byte type check, size cap, path traversal prevention.

import * as vscode from 'vscode';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { heicToJpeg } from './heicConvert';

const MAX_BYTES = 20 * 1024 * 1024;
const HASH_LEN = 16;

type Kind = 'png' | 'jpg' | 'webp' | 'gif' | 'avif' | 'heic';

const EXT: Record<Exclude<Kind, 'heic'>, string> = {
  png: '.png',
  jpg: '.jpg',
  webp: '.webp',
  gif: '.gif',
  avif: '.avif',
};

const ascii = (bytes: Uint8Array, from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));

// ISO-BMFF `ftyp` brands. AVIF and HEIC share the container (and `mif1`), so
// AVIF brands win when both appear.
const AVIF_BRANDS = new Set(['avif', 'avis']);
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);

function detectIsoBmff(bytes: Uint8Array): Kind | null {
  if (ascii(bytes, 4, 8) !== 'ftyp') return null;
  const boxSize = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  const end = Math.min(bytes.length, Math.max(16, boxSize));
  const brands = [ascii(bytes, 8, 12)];
  for (let i = 16; i + 4 <= end; i += 4) brands.push(ascii(bytes, i, i + 4));
  if (brands.some((b) => AVIF_BRANDS.has(b))) return 'avif';
  if (brands.some((b) => HEIF_BRANDS.has(b))) return 'heic';
  return null;
}

function detectKind(bytes: Uint8Array): Kind | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'gif';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'webp';
  return detectIsoBmff(bytes);
}

function mimeMatches(mime: string, kind: Kind): boolean {
  const m = mime.toLowerCase();
  // Finder / Explorer often hand over HEIC and AVIF with no or a generic type.
  if (m === '' || m === 'application/octet-stream') return true;
  switch (kind) {
    case 'png': return m === 'image/png';
    case 'jpg': return m === 'image/jpeg' || m === 'image/jpg';
    case 'webp': return m === 'image/webp';
    case 'gif': return m === 'image/gif';
    case 'avif': return m === 'image/avif';
    case 'heic': return /^image\/hei[cf](-sequence)?$/.test(m);
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

    const kind = detectKind(bytes);
    if (!kind) throw new Error('unsupported or unrecognized image format');

    if (!mimeMatches(claimedMime, kind)) {
      throw new Error(`mime type mismatch: claimed=${claimedMime}, detected=${kind}`);
    }

    // Hash the original bytes so re-pasting the same HEIC skips the conversion.
    const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, HASH_LEN);
    if (!/^[0-9a-f]{16}$/.test(hash)) throw new Error('hash generation failed');

    const filename = `${hash}${kind === 'heic' ? EXT.jpg : EXT[kind]}`;
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
      let out = bytes;
      if (kind === 'heic') {
        out = await heicToJpeg(bytes);
        if (detectKind(out) !== 'jpg') throw new Error('HEIC conversion did not produce a JPEG');
      }
      await vscode.workspace.fs.writeFile(target, out);
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
