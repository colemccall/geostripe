#!/usr/bin/env node
/**
 * Copy MapLibre's worker files into public/ so they are served verbatim.
 *
 * Why not let Vite bundle the worker (`?worker&url`)? Because it does not work here. Vite
 * produces a valid-looking, self-contained bundle that MapLibre loads without error — and
 * then the worker never answers. The map ends up with `isSourceLoaded('bands') === false`
 * forever: raster imagery renders fine on the main thread while every GeoJSON layer stays
 * invisible, with nothing in the console to explain it.
 *
 * Serving MapLibre's own untouched files sidesteps the whole question. The worker keeps
 * its sibling `./maplibre-gl-shared.mjs` import, which resolves because both files are
 * copied into the same directory, and `public/` is emitted to the build root, so the URL
 * is stable and base-path aware via import.meta.env.BASE_URL.
 *
 * Copied rather than committed so it cannot drift from the installed MapLibre version.
 * Runs from `predev` and `prebuild`.
 */

import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'node_modules', 'maplibre-gl', 'dist');
const to = join(root, 'public', 'maplibre');

// The worker plus the shared chunk it imports. Both, or neither works.
const FILES = ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs'];

if (!existsSync(from)) {
  console.error('maplibre-gl is not installed — run npm install first.');
  process.exit(1);
}

mkdirSync(to, { recursive: true });

for (const file of FILES) {
  const source = join(from, file);
  if (!existsSync(source)) {
    console.error(`Missing ${file} in maplibre-gl/dist — the package layout has changed.`);
    process.exit(1);
  }
  copyFileSync(source, join(to, file));
}

console.log(`maplibre worker synced -> public/maplibre/ (${FILES.length} files)`);
