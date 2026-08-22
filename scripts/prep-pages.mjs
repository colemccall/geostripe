#!/usr/bin/env node
/**
 * prep-pages.mjs — build GeoStripe for a chosen host, and prepare the output so a
 * static host serves it correctly.
 *
 *   node scripts/prep-pages.mjs --target pages     -> dist/  , base /geostripe/
 *   node scripts/prep-pages.mjs --target docs      -> docs/  , base /geostripe/
 *   node scripts/prep-pages.mjs --target domain    -> dist/  , base /
 *
 *   --domain example.com    also writes a CNAME file (implies --target domain)
 *   --base /custom/         override the base path explicitly
 *
 * Run through npm: `npm run prep:pages`, `npm run prep:docs`, `npm run prep:domain`.
 *
 * Beyond running the build this does two things a plain `vite build` does not:
 *
 *   .nojekyll  GitHub Pages pipes branch-deployed output through Jekyll, which drops
 *              files and folders beginning with an underscore. Vite does not emit those
 *              today, but a future dependency easily could, and the failure looks like a
 *              random 404 rather than a build error. The file costs nothing.
 *   CNAME      GitHub Pages reads the custom domain from this file in the published
 *              output; without it a branch deploy resets the domain setting.
 *
 * No absolute domain is baked into the source — it only ever arrives here as an argument.
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ arguments */

const argv = process.argv.slice(2);
function arg(name) {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
}

const domain = arg('domain');
const target = arg('target') ?? (domain ? 'domain' : 'pages');

const TARGETS = {
  // key:      [ vite --mode, output directory, human label ]
  pages: ['pages', 'dist', 'GitHub Pages project site'],
  docs: ['pages', 'docs', 'GitHub Pages, branch source /docs'],
  domain: ['domain', 'dist', 'Custom domain or root-served host'],
};

if (!TARGETS[target]) {
  console.error(
    `Unknown target "${target}". Expected one of: ${Object.keys(TARGETS).join(', ')}`,
  );
  process.exit(1);
}

const [mode, outDir, label] = TARGETS[target];
const base = arg('base') ?? (target === 'domain' ? '/' : '/geostripe/');
const outPath = join(root, outDir);

/* ---------------------------------------------------------------------- build */

console.log(`\n  GeoStripe — ${label}`);
console.log(`  target ${target}   mode ${mode}   base ${base}   out ${outDir}/\n`);

function run(cmd, args) {
  // shell:true so npm/npx resolve their .cmd shims on Windows.
  const res = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: true });
  if (res.status !== 0) {
    console.error(`\n  Failed: ${cmd} ${args.join(' ')}\n`);
    process.exit(res.status ?? 1);
  }
}

// Typecheck and test before building — a broken deploy is worse than a slow one.
run('npm', ['run', 'typecheck']);
run('npm', ['test']);

// Vite writes to dist/, so build there and relocate afterwards when the target differs.
// VITE_BASE overrides the .env value for one-off --base overrides.
const env = { ...process.env, VITE_BASE: base, VITE_OUT_DIR: 'dist' };
const build = spawnSync('npx', ['vite', 'build', '--mode', mode], {
  cwd: root,
  stdio: 'inherit',
  shell: true,
  env,
});
if (build.status !== 0) process.exit(build.status ?? 1);

/* --------------------------------------------------------------- post-process */

if (outDir !== 'dist') {
  rmSync(outPath, { recursive: true, force: true });
  mkdirSync(outPath, { recursive: true });
  cpSync(join(root, 'dist'), outPath, { recursive: true });
  console.log(`\n  Copied dist/ -> ${outDir}/`);
}

writeFileSync(join(outPath, '.nojekyll'), '');

if (domain) {
  writeFileSync(join(outPath, 'CNAME'), `${domain}\n`);
  console.log(`  Wrote CNAME -> ${domain}`);
}

if (!existsSync(join(outPath, 'index.html'))) {
  console.error('\n  index.html missing from the output — build did not complete.\n');
  process.exit(1);
}

/* ------------------------------------------------------------------ next step */

const next = {
  pages: 'Push to main — the Actions workflow publishes dist/ automatically.\n' +
    '     Or preview locally first:  npm run preview',
  docs: `Commit the docs/ folder and push:\n` +
    '       git add docs && git commit -m "Deploy" && git push\n' +
    '     Then set Settings -> Pages -> Source: Deploy from a branch, main, /docs',
  domain: 'Upload the contents of dist/ to your host, or push to main with\n' +
    '     VITE_BASE=/ set in the workflow. Point the domain at the host,\n' +
    `     and keep the CNAME file in the published output.`,
};

console.log(`\n  Done -> ${outDir}/`);
console.log(`  Next: ${next[target]}\n`);
