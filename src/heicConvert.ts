// Convert HEIC/HEIF images (iPhone photos) to JPEG.
//
// Chromium cannot decode HEVC, and bundling a decoder would pull LGPL'd,
// patent-encumbered code into the extension, so we shell out to a converter the
// OS ships (macOS `sips`) or the user has installed (libheif / ImageMagick).

import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const TIMEOUT_MS = 60_000;
const QUALITY = '90';

interface Converter {
  cmd: string;
  args: (input: string, output: string) => string[];
}

function converters(): Converter[] {
  const magick: Converter = { cmd: 'magick', args: (i, o) => [`${i}[0]`, '-auto-orient', '-quality', QUALITY, o] };
  // On Windows `convert` is the built-in filesystem converter, never ImageMagick.
  if (process.platform === 'win32') return [magick];
  const portable: Converter[] = [
    { cmd: 'heif-dec', args: (i, o) => ['-q', QUALITY, i, o] },
    { cmd: 'heif-convert', args: (i, o) => ['-q', QUALITY, i, o] },
    magick,
    { cmd: 'convert', args: (i, o) => [`${i}[0]`, '-auto-orient', '-quality', QUALITY, o] },
  ];
  if (process.platform === 'darwin') {
    return [{ cmd: 'sips', args: (i, o) => ['-s', 'format', 'jpeg', '-s', 'formatOptions', QUALITY, i, '--out', o] }, ...portable];
  }
  return portable;
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: TIMEOUT_MS, windowsHide: true }, (err, _stdout, stderr) => {
      if (err) {
        const code = (err as NodeJS.ErrnoException).code;
        reject(new Error(code === 'ENOENT' ? 'not installed' : (stderr || err.message).trim().split('\n')[0]));
      } else {
        resolve();
      }
    });
  });
}

// libheif writes `out-1.jpg`, `out-2.jpg`, ... for multi-image files, plus
// depth / auxiliary images (`out-1-depth.jpg`). The photo is the largest.
async function findOutput(dir: string, expected: string): Promise<string | null> {
  try {
    await fs.access(expected);
    return expected;
  } catch { /* fall through */ }
  let best: { file: string; size: number } | null = null;
  for (const name of await fs.readdir(dir)) {
    if (!name.endsWith('.jpg')) continue;
    const file = path.join(dir, name);
    const { size } = await fs.stat(file);
    if (!best || size > best.size) best = { file, size };
  }
  return best?.file ?? null;
}

export async function heicToJpeg(input: Uint8Array): Promise<Uint8Array> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdeditor-heic-'));
  try {
    const src = path.join(dir, 'in.heic');
    const dst = path.join(dir, 'out.jpg');
    await fs.writeFile(src, input);
    const failures: string[] = [];
    for (const c of converters()) {
      try {
        // A converter that failed half-way may have left a truncated JPEG.
        for (const name of await fs.readdir(dir)) {
          if (name.endsWith('.jpg')) await fs.rm(path.join(dir, name), { force: true });
        }
        await run(c.cmd, c.args(src, dst));
        const out = await findOutput(dir, dst);
        if (!out) throw new Error('no output produced');
        return new Uint8Array(await fs.readFile(out));
      } catch (err) {
        failures.push(`${c.cmd}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const hint =
      process.platform === 'win32'
        ? 'ImageMagick (magick) をインストールしてください'
        : 'libheif (heif-dec / heif-convert) か ImageMagick をインストールしてください';
    throw new Error(`HEIC を JPEG に変換できませんでした。${hint} [${failures.join('; ')}]`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
