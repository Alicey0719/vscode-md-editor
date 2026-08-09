// Build script for host (Node) and webview (browser) bundles.
const esbuild = require('esbuild');
const path = require('node:path');
const fs = require('node:fs');

const watch = process.argv.includes('--watch');
const prod = process.env.NODE_ENV === 'production';

const hostOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['vscode'],
  outfile: 'dist/extension.js',
  sourcemap: !prod,
  minify: prod,
  logLevel: 'info',
};

const webviewOptions = {
  entryPoints: ['webview/src/main.ts'],
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  format: 'iife',
  outfile: 'media/webview.js',
  sourcemap: !prod,
  minify: prod,
  loader: {
    '.css': 'css',
    // Drop .woff (legacy) — all target browsers (Chromium in VSCode webview)
    // support .woff2. Keeps the CSS bundle roughly half the size.
    '.woff': 'empty',
    '.woff2': 'dataurl',
    '.ttf': 'dataurl',
    '.svg': 'dataurl',
    '.png': 'dataurl',
  },
  logLevel: 'info',
};

async function main() {
  fs.mkdirSync('dist', { recursive: true });
  fs.mkdirSync('media', { recursive: true });

  if (watch) {
    const host = await esbuild.context(hostOptions);
    const web = await esbuild.context(webviewOptions);
    await Promise.all([host.watch(), web.watch()]);
    console.log('watching...');
  } else {
    await Promise.all([esbuild.build(hostOptions), esbuild.build(webviewOptions)]);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
