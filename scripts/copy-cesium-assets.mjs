#!/usr/bin/env node
/**
 * Copy Cesium's static runtime assets into public/cesium so they're served at
 * /cesium (window.CESIUM_BASE_URL). Cesium's Web Workers, terrain-height table,
 * widget CSS/images etc. are loaded at runtime from that base URL — they are
 * NOT bundled by Vite — so they must exist as plain files under public/.
 *
 * Run automatically via the `predev` / `prebuild` npm hooks; public/cesium is
 * gitignored (regenerated from node_modules on install/build).
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'node_modules', 'cesium', 'Build', 'Cesium');
const DEST = join(ROOT, 'public', 'cesium');
const DIRS = ['Workers', 'Assets', 'ThirdParty', 'Widgets'];

if (!existsSync(SRC)) {
  console.error(`Cesium build assets not found at ${SRC} — is cesium installed?`);
  process.exit(0); // don't fail the build if the 3D viewer isn't in use
}

mkdirSync(DEST, { recursive: true });
for (const d of DIRS) {
  const from = join(SRC, d);
  if (existsSync(from)) cpSync(from, join(DEST, d), { recursive: true });
}
console.log(`Copied Cesium assets (${DIRS.join(', ')}) -> ${DEST}`);
