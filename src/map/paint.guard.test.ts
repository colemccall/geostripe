import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Paint properties MapLibre cannot drive from feature data.
 *
 * `line-dasharray` is the one that keeps catching me. Giving it an expression that reads a
 * feature property does not degrade — MapLibre rejects the whole layer, so the thing you
 * were styling vanishes from the map with nothing on screen and nothing in the console
 * that points at the cause. I have written that bug twice in this file, once for lane
 * markings and once for the junction outline, so it gets a test rather than a third
 * reading of the spec.
 *
 * The fix in both cases is the same: split into two layers with a filter, or use a
 * constant. Not to make the expression cleverer.
 */

/** The files whose layer definitions this guards. */
const SOURCES = ['src/map/MapCanvas.tsx'].map((path) => ({
  path,
  text: readFileSync(path, 'utf8'),
}));

/** Paint properties that take a constant only — no expressions, no feature lookups. */
const CONSTANT_ONLY = ['line-dasharray'];

/**
 * The value written for a property, from the colon to the end of its own entry.
 *
 * Bracket-counting rather than a line count, because these values are formatted freely and
 * a fixed window either misses a long one or runs into the next property and reports it.
 */
function valuesFor(text: string, property: string): string[] {
  const out: string[] = [];
  const needle = `'${property}':`;

  let from = text.indexOf(needle);
  while (from !== -1) {
    let i = from + needle.length;
    let depth = 0;
    let value = '';

    for (; i < text.length; i++) {
      const ch = text[i]!;
      if (ch === '[' || ch === '(' || ch === '{') depth++;
      else if (ch === ']' || ch === ')' || ch === '}') {
        if (depth === 0) break;
        depth--;
      } else if (ch === ',' && depth === 0) break;
      value += ch;
    }

    out.push(value.trim());
    from = text.indexOf(needle, i);
  }

  return out;
}

describe('paint properties that are not data-driven', () => {
  for (const property of CONSTANT_ONLY) {
    for (const source of SOURCES) {
      it(`never reads feature data in ${property} (${source.path})`, () => {
        const offenders = valuesFor(source.text, property).filter(
          (value) => value.includes("'get'") || value.includes("'case'") || value.includes("'match'"),
        );
        expect(offenders).toEqual([]);
      });
    }
  }

  it('catches the mistake it exists for', () => {
    // Guards the guard. A regex that quietly matches nothing passes every test in this
    // file for the wrong reason, which is precisely how this bug got shipped twice.
    const planted = `paint: { 'line-dasharray': ['case', ['get', 'selected'], 1, 2], 'line-width': 2 }`;
    expect(valuesFor(planted, 'line-dasharray').some((v) => v.includes("'get'"))).toBe(true);
  });

  it('does not flag an honest constant', () => {
    const fine = `paint: { 'line-dasharray': [3, 2], 'line-color': ['get', 'color'] }`;
    expect(valuesFor(fine, 'line-dasharray').some((v) => v.includes("'get'"))).toBe(false);
  });

  it('still finds the layers that use dashes at all', () => {
    expect(SOURCES.some((s) => s.text.includes("'line-dasharray'"))).toBe(true);
  });
});
