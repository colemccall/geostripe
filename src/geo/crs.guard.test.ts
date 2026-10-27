import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * geo/crs.ts is the only module allowed to turn degrees into metres.
 *
 * The editor used to hold four different scales at once (a series plane, a spherical
 * cos(latitude), a per-segment metres-per-degree, and a bare cos(lat) in the pointer code),
 * which disagreed by tenths of a percent and, worse, were baked at one latitude for a whole
 * project. This guard fails the build if any non-test source reintroduces one.
 */

const SRC = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(full);
  }
  return out;
}

const FORBIDDEN: [RegExp, string][] = [
  [/\b111[_]?(132|320|412|000)\b/, 'a metres-per-degree literal'],
  [/Math\.cos\([^)]*(lat|Lat)/, 'cos(latitude) math'],
  [/\b40075016\b/, 'the Earth circumference literal'],
  [/\b6378137\b/, 'the Mercator radius literal'],
];

describe('coordinate conversion lives in one place', () => {
  for (const file of sourceFiles(SRC)) {
    const rel = relative(SRC, file).split(sep).join('/');
    if (rel === 'geo/crs.ts') continue;
    it(`${rel} does no latitude math`, () => {
      const text = readFileSync(file, 'utf8')
        // Comments may explain the formula; code may not use it.
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      for (const [pattern, what] of FORBIDDEN) {
        expect(pattern.test(text), `${rel} contains ${what}`).toBe(false);
      }
    });
  }
});
