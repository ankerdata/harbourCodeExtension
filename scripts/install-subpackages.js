// @ts-check
'use strict';

// Run `npm install` inside both subpackages. We avoid npm workspaces because
// vsce's VSIX builder gets confused by hoisted node_modules — duplicate
// entries would land in the package, or the extension's runtime require()
// would miss its native module. Per-subpackage installs keep each
// node_modules tree isolated and make `vsce package` deterministic.

const { execSync } = require('child_process');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const targets = ['client', 'server'];

// Use execSync (always shells out) so this works uniformly on POSIX and on
// Windows — where `npm` is `npm.cmd` and Node 22+ refuses to spawn() it
// directly. execSync inherits stdio and throws on non-zero exit.
for (const target of targets) {
  const cwd = path.join(repoRoot, target);
  console.log(`[install] ${target}`);
  try {
    execSync('npm install', { cwd, stdio: 'inherit' });
  } catch (err) {
    console.error(`[install] failed in ${target}: ${err.message}`);
    process.exit(err.status ?? 1);
  }
}
