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

  return {
    base,
    plugins: [react()],
    build: {
      outDir: env.VITE_OUT_DIR || 'dist',
      emptyOutDir: true,
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
