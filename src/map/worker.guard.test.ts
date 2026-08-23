import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Guard for the MapLibre worker configuration.
 *
 * This is a source-level assertion rather than a behavioural one, which is unusual — but
 * the failure it guards against has already happened twice, and it is silent. Without an
 * explicit worker URL, MapLibre resolves it relative to its own chunk, requests a file
 * Rollup never emitted, and gets index.html back. Raster imagery keeps working because
 * tiles load on the main thread, so the map looks healthy while every GeoJSON source
 * quietly fails to parse and the whole design layer disappears.
 *
 * A rendering test would catch it, but needs a browser and a WebGL context. This costs
 * nothing and fails loudly the moment the line is dropped in a refactor.
 */
describe('MapLibre worker configuration', () => {
  const source = readFileSync('src/map/MapCanvas.tsx', 'utf8');

  it('sets an explicit worker URL', () => {
    expect(source).toContain('setWorkerUrl');
  });

  it('points at the verbatim copy in public/, not a Vite-bundled worker', () => {
    // Vite's `?worker&url` produces a bundle MapLibre loads without error and which then
    // never answers — isSourceLoaded() stays false and every vector layer is invisible.
    // Serving MapLibre's own files sidesteps it entirely.
    expect(source).toMatch(/maplibre\/maplibre-gl-worker\.mjs/);
    // Match the import statement, not the comment that explains why we avoid it.
    expect(source).not.toMatch(/^import .*\?worker&url/m);
  });

  it('builds the worker URL from BASE_URL so it survives a custom domain', () => {
    expect(source).toContain('import.meta.env.BASE_URL');
  });

  it('copies both the worker and the shared chunk it imports', () => {
    // The worker imports ./maplibre-gl-shared.mjs; one file without the other is useless.
    const sync = readFileSync('scripts/sync-maplibre-worker.mjs', 'utf8');
    expect(sync).toContain('maplibre-gl-worker.mjs');
    expect(sync).toContain('maplibre-gl-shared.mjs');
  });

  it('syncs the worker before every dev run and build', () => {
    // public/maplibre is gitignored, so a fresh clone has nothing until this runs.
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    for (const hook of ['predev', 'prebuild', 'prebuild:pages', 'prebuild:domain']) {
      expect(pkg.scripts[hook]).toContain('sync-maplibre-worker');
    }
  });

  it('keeps maplibre-gl out of dependency pre-bundling', () => {
    // Vite's optimiser rewrites the entry into .vite/deps without copying the sibling
    // worker, which breaks the dev server in the same way.
    const config = readFileSync('vite.config.ts', 'utf8');
    expect(config).toMatch(/exclude:\s*\[\s*'maplibre-gl'\s*\]/);
  });
});
