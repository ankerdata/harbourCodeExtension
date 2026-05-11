// @ts-check
'use strict';

const esbuild = require('esbuild');
const path = require('path');

function makeOptions(dev) {
  /** @type {import('esbuild').BuildOptions} */
  return {
    entryPoints: {
      extension: path.join(__dirname, 'src', 'extension.ts'),
      debugger: path.join(__dirname, 'src', 'debugger.ts'),
    },
    outdir: path.join(__dirname, 'dist'),
    bundle: true,
    platform: 'node',
    target: 'node16',
    format: 'cjs',
    sourcemap: true,
    minify: !dev,
    logLevel: 'info',
    // 'vscode' is provided by the host. The native module and its loader
    // (`bindings`) must be loaded from disk at runtime so that
    // `bindings.js` can locate the .node binary inside node_modules.
    external: [
      'vscode',
      '@yagisumi/win-output-debug-string',
      'bindings',
      'file-uri-to-path',
    ],
  };
}

async function build({ dev = false, watch = false } = {}) {
  const options = makeOptions(dev);
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log('[client] esbuild watching…');
    return ctx;
  }
  return esbuild.build(options);
}

module.exports = { build };

if (require.main === module) {
  const args = new Set(process.argv.slice(2));
  build({ dev: args.has('--dev'), watch: args.has('--watch') }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
