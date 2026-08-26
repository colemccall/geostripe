import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * `base` is the URL prefix every built asset is requested from, and it differs by target:
 *
 *   GitHub Pages project site   https://<user>.github.io/geostripe/   ->  /geostripe/
 *   Custom domain / root host   https://example.com/                  ->  /
 *
 * It is read from VITE_BASE, supplied by the per-mode .env files that are committed
 * alongside this config (.env, .env.pages, .env.domain). Selecting a target is therefore
 * `vite build --mode domain` rather than an inline environment variable — which matters
 * because `VITE_BASE=/ npm run build` is bash syntax and silently fails in PowerShell.
 *
 * No absolute domain appears anywhere in this project, so pointing GeoStripe at a custom
 * domain later is a config change, never a code change.
 */
export default defineConfig(({ mode }) => {
  // '' as the third argument loads every var, not just the VITE_-prefixed ones.
  const env = loadEnv(mode, process.cwd(), '');
  const base = env.VITE_BASE || '/geostripe/';

  // One version number, read from the manifest that already holds it.
  //
  // There used to be three: a literal in the header, a different literal written into every
  // exported project, and package.json — none of which moved when the others did, so the
  // number on screen said nothing about what was running. Reading the manifest here keeps
  // `npm version` as the single place it changes.
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
    version: string;
  };

  // Stamped into the bundle so the running app can say which build it is.
  //
  // This exists because "I don't see my changes" is indistinguishable from a failed
  // deploy, a stale index.html in the browser cache, and a build that never ran — and
  // GitHub Pages serves index.html with a ten-minute cache, so the middle one is common.
  // A build id on screen turns that question into a glance.
  const buildId = (() => {
    try {
      return execSync('git rev-parse --short HEAD', {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim();
    } catch {
      // No git in the build environment is fine; the timestamp still identifies the build.
      return 'local';
    }
  })();

  return {
    base,
    plugins: [react()],
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __BUILD_ID__: JSON.stringify(buildId),
      // Full ISO, formatted for reading at the point of display. The timestamp is the part
      // that answers "is this newer than what I pushed" — a commit hash cannot be ordered
      // by eye, and that was the whole question the build stamp existed to settle.
      __BUILT_AT__: JSON.stringify(new Date().toISOString()),
    },
    // MapLibre instantiates its worker with `{ type: 'module' }`, so the bundle it loads
    // has to actually be an ES module. Vite's default worker format is 'iife', which
    // loads without complaint but leaves the worker inert: GeoJSON sources are parsed in
    // the worker, so every vector layer silently renders nothing while raster imagery
    // (main thread) looks perfectly healthy.
    worker: { format: 'es' },
    optimizeDeps: {
      // MapLibre 6 ships as three sibling ESM files and locates its worker at runtime
      // with `new Worker(new URL('./maplibre-gl-worker.mjs', import.meta.url))`.
      // Pre-bundling rewrites the entry into node_modules/.vite/deps/ without copying
      // that sibling, so import.meta.url resolves to a file that does not exist and the
      // map fails to start — no tiles, no pan, no zoom.
      //
      // Excluding it makes Vite serve the package straight from node_modules, where the
      // relative URL resolves correctly. Production builds are unaffected: Rollup
      // understands the `new URL(..., import.meta.url)` pattern and emits the worker as
      // a real asset.
      exclude: ['maplibre-gl'],
    },
    build: {
      outDir: env.VITE_OUT_DIR || 'dist',
      emptyOutDir: true,
      // MapLibre is ~800 kB and cannot be trimmed meaningfully. It is already isolated
      // into the lazy-loaded MapEditor chunk, so /builder never downloads it. Raised so
      // the warning stays meaningful for chunks we can actually do something about.
      chunkSizeWarningLimit: 1100,
    },
    test: {
      // Geometry lives in pure modules with no DOM dependency, so the default
      // environment stays 'node'. Add jsdom later only if a component needs it.
      environment: 'node',
      include: ['src/**/*.test.ts'],
      // Scaffold has no tests yet, and an empty run must not fail CI or the prep
      // script. Remove this once src/geo/ lands — from that point on, a run that
      // finds no tests is itself a bug worth failing on.
      passWithNoTests: true,
    },
  };
});
