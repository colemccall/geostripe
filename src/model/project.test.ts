import { describe, expect, it } from 'vitest';
import { parseProject, serializeProject, toProjectGeoJSON } from './project';
import type { ImportDefaults } from './project';
import { createDemoStreets } from '../demo/washingtonPark';
import { totalWidth } from './section';
import type { Street } from './types';

/**
 * The project round-trip.
 *
 * This is the test that guards the promise the whole tool makes: a design you download is
 * still a *design* when it comes back, not a picture of one. If a reopened file lost its
 * widths, its component order, or its anchor, everything downstream — the fit check, the
 * inspector, editing at all — would be quietly wrong while still looking right on screen.
 */

const META = { name: 'Test project', editorVersion: '0.0.0-test' };

const DEFAULTS: ImportDefaults = {
  sectionName: 'Fallback section',
  components: [
    { componentType: 'travelLane', widthMeters: 3 },
    { componentType: 'travelLane', widthMeters: 3 },
  ],
};

function roundTrip(streets: Street[]): Street[] {
  const result = parseProject(serializeProject(streets, META), DEFAULTS);
  if (!result.ok) throw new Error(`parse failed: ${result.errors.join(' | ')}`);
  return result.streets;
}

describe('project round-trip', () => {
  const original = createDemoStreets();

  it('preserves every centerline coordinate exactly', () => {
    const loaded = roundTrip(original);
    expect(loaded).toHaveLength(original.length);
    loaded.forEach((street, i) => {
      expect(street.centerline).toEqual(original[i]!.centerline);
    });
  });

  it('preserves names, widths, types, directions and order', () => {
    const loaded = roundTrip(original);

    loaded.forEach((street, i) => {
      const before = original[i]!;
      expect(street.name).toBe(before.name);
      expect(street.section.name).toBe(before.section.name);
      expect(street.section.components.map((c) => c.componentType)).toEqual(
        before.section.components.map((c) => c.componentType),
      );
      expect(street.section.components.map((c) => c.direction)).toEqual(
        before.section.components.map((c) => c.direction),
      );
      // Widths are rounded to 0.1 mm on write, which is far below anything a person can
      // draw or measure but keeps the file readable.
      street.section.components.forEach((c, j) => {
        expect(c.widthMeters).toBeCloseTo(before.section.components[j]!.widthMeters, 4);
      });
      expect(totalWidth(street.section.components)).toBeCloseTo(
        totalWidth(before.section.components),
        3,
      );
    });
  });

  it('preserves the anchor and the measured right-of-way', () => {
    const loaded = roundTrip(original);
    loaded.forEach((street, i) => {
      expect(street.section.anchorOffsetMeters).toBe(original[i]!.section.anchorOffsetMeters);
      expect(street.existingWidthMeters).toBeCloseTo(original[i]!.existingWidthMeters ?? 0, 4);
    });
  });

  it('carries street ids back through the file', () => {
    // This reverses an earlier decision, on purpose. Ids used to be minted fresh on load
    // so a file could never collide with what was already open. Then junctions arrived,
    // and a junction's stable key is built from the ids of the streets that meet there —
    // so discarding them silently dropped every saved corner radius. Loading replaces the
    // whole project, so there is nothing to collide with; only self-collision inside one
    // file still has to be guarded, which the next test covers.
    const loaded = roundTrip(original);
    expect(loaded.map((s) => s.id)).toEqual(original.map((s) => s.id));
  });

  it('reassigns an id a file uses twice, rather than fusing two streets', () => {
    const file = toProjectGeoJSON(original, META);
    const streetFeatures = file.features.filter((f) => f.properties?.['geostripe'] === 'street');
    streetFeatures[1]!.id = streetFeatures[0]!.id;

    const result = parseProject(JSON.stringify(file), DEFAULTS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.streets).toHaveLength(original.length);
    expect(new Set(result.streets.map((s) => s.id)).size).toBe(original.length);
    expect(result.warnings.join(' ')).toMatch(/duplicated and reassigned/);
  });

  it('survives a second round-trip unchanged', () => {
    const once = roundTrip(original);
    const twice = roundTrip(once);
    expect(twice.map((s) => s.centerline)).toEqual(once.map((s) => s.centerline));
    expect(twice.map((s) => s.section.components.map((c) => c.widthMeters))).toEqual(
      once.map((s) => s.section.components.map((c) => c.widthMeters)),
    );
  });
});

describe('derived geometry', () => {
  const original = createDemoStreets();

  it('writes band polygons for external readers', () => {
    const file = toProjectGeoJSON(original, META);
    const bands = file.features.filter((f) => f.properties?.['geostripe'] === 'band');
    const expected = original.reduce((n, s) => n + s.section.components.length, 0);
    expect(bands).toHaveLength(expected);
    expect(bands[0]!.geometry.type).toMatch(/Polygon/);
  });

  it('discards them on load rather than reading them back as streets', () => {
    const loaded = roundTrip(original);
    // Without the discard this would be streets + every band.
    expect(loaded).toHaveLength(original.length);
  });

  it('reports the discard so the count is never a surprise', () => {
    const result = parseProject(serializeProject(original, META), DEFAULTS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.join(' ')).toMatch(/discarded and rebuilt/);
  });
});

describe('intersection settings', () => {
  const original = createDemoStreets();
  // Keyed the way the detector keys them: sorted street ids, then an ordinal.
  const key = `${[...original.map((s) => s.id)].sort().join('~')}#0`;
  const overrides = {
    [key]: {
      corners: [{ radiusMeters: 3 }, null, { radiusMeters: 7.5, treatment: 'bulbOut' as const }, null],
      legs: [{ stopBar: true }, null, null, null],
    },
  };

  it('round-trips a customised corner radius', () => {
    const text = serializeProject(original, META, overrides);
    const result = parseProject(text, DEFAULTS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.junctionOverrides[key]).toEqual(overrides[key]);
  });

  it('writes nothing when no corner has been touched', () => {
    const file = JSON.parse(serializeProject(original, META)) as {
      metadata: Record<string, unknown>;
    };
    expect(file.metadata['junctions']).toBeUndefined();
  });

  it('drops settings whose streets are not in the file', () => {
    const text = serializeProject(original, META, {
      'st-ghost~st-phantom#0': { corners: [{ radiusMeters: 2 }] },
    });
    const result = parseProject(text, DEFAULTS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.junctionOverrides)).toHaveLength(0);
    expect(result.warnings.join(' ')).toMatch(/not in this file/);
  });
});

describe('markings, through the file', () => {
  const marked: Street[] = createDemoStreets().map((street, i) =>
    i === 0
      ? {
          ...street,
          section: {
            ...street.section,
            components: street.section.components.map((component, j) =>
              j === 1
                ? { ...component, glyph: 'none' as const, stripeLeft: 'centreDashed' as const }
                : j === 2
                  ? { ...component, glyph: 'sharrow' as const, glyphSpacingMeters: 18 }
                  : component,
            ),
          },
        }
      : street,
  );

  it('round-trips a chosen symbol, its spacing, and a stripe override', () => {
    const loaded = roundTrip(marked);
    const components = loaded[0]!.section.components;
    expect(components[2]!.glyph).toBe('sharrow');
    expect(components[2]!.glyphSpacingMeters).toBe(18);
    expect(components[1]!.stripeLeft).toBe('centreDashed');
  });

  it('keeps "no symbol" distinct from "never had one"', () => {
    // The distinction the whole three-state control rests on. If `'none'` collapsed to
    // absent on save, a deliberately bare lane would grow its bicycles back on reload.
    const loaded = roundTrip(marked);
    expect(loaded[0]!.section.components[1]!.glyph).toBe('none');
    expect(loaded[0]!.section.components[0]!.glyph).toBeUndefined();
  });

  it('writes nothing for a band nobody has marked', () => {
    const file = JSON.parse(serializeProject(createDemoStreets(), META)) as {
      features: { properties: Record<string, unknown> }[];
    };
    const street = file.features.find((f) => f.properties['geostripe'] === 'street')!;
    for (const component of street.properties['components'] as Record<string, unknown>[]) {
      expect(component['glyph']).toBeUndefined();
      expect(component['stripeLeft']).toBeUndefined();
    }
  });
});

describe('lane assignment and turn pockets, through the file', () => {
  const original = createDemoStreets();
  const key = `${[...original.map((s) => s.id)].sort().join('~')}#0`;
  const overrides = {
    [key]: {
      legs: [
        {
          lanes: [null, ['left' as const, 'through' as const], ['through' as const, 'right' as const]],
          flare: {
            side: 'right' as const,
            componentType: 'turnPocket' as const,
            widthMeters: 3.05,
            storageMeters: 30,
            taperMeters: 15,
            movements: ['right' as const],
          },
        },
        null,
        null,
        null,
      ],
    },
  };

  it('round-trips both, because a junction design is worth as much as a street one', () => {
    const result = parseProject(serializeProject(original, META, overrides), DEFAULTS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.junctionOverrides[key]).toEqual(overrides[key]);
  });
});

describe('curved alignments', () => {
  const curved: Street[] = createDemoStreets().map((street, i) =>
    i === 0
      ? { ...street, curve: { mode: 'rounded' as const, radiusMeters: 18, sharpVertices: [2] } }
      : { ...street, curve: { mode: 'smooth' as const, radiusMeters: 0 } },
  );

  it('round-trips the alignment alongside the control points', () => {
    const loaded = roundTrip(curved);
    expect(loaded[0]!.curve).toEqual({ mode: 'rounded', radiusMeters: 18, sharpVertices: [2] });
    expect(loaded[1]!.curve).toEqual({ mode: 'smooth', radiusMeters: 0 });
    // Control points, not the tessellated line: a reopened curve has to stay editable.
    expect(loaded[0]!.centerline).toEqual(curved[0]!.centerline);
  });

  it('writes nothing for a plain polyline', () => {
    const file = toProjectGeoJSON(createDemoStreets(), META);
    const street = file.features.find((f) => f.properties?.['geostripe'] === 'street')!;
    expect(street.properties?.['curve']).toBeUndefined();
  });

  it('keeps the derived bands following the curve, not the controls', () => {
    // The bands exported for QGIS have to match what is on screen, which means they are
    // built from the resolved line. A curved street's polygons therefore cover more
    // ground than its control polygon would.
    // The same street, with and without an alignment — otherwise this would be comparing
    // two streets that differ in vertex count for unrelated reasons.
    const plain = createDemoStreets()[1]!;
    const straightFile = toProjectGeoJSON([plain], META);
    const curvedFile = toProjectGeoJSON(
      [{ ...plain, curve: { mode: 'smooth' as const, radiusMeters: 0 } }],
      META,
    );
    const count = (f: typeof straightFile) =>
      f.features.filter((x) => x.properties?.['geostripe'] === 'band').length;
    expect(count(curvedFile)).toBe(count(straightFile));

    const curvedBand = curvedFile.features.find((f) => f.properties?.['geostripe'] === 'band')!;
    const straightBand = straightFile.features.find(
      (f) => f.properties?.['geostripe'] === 'band',
    )!;
    const points = (f: typeof curvedBand) =>
      (f.geometry as { coordinates: number[][][] }).coordinates[0]!.length;
    expect(points(curvedBand)).toBeGreaterThan(points(straightBand));
  });
});

describe('graceful failure', () => {
  it('rejects text that is not JSON', () => {
    const result = parseProject('<html>nope</html>', DEFAULTS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatch(/not valid JSON/);
  });

  it('rejects JSON that is not a FeatureCollection', () => {
    const result = parseProject('{"type":"Feature"}', DEFAULTS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatch(/FeatureCollection/);
  });

  it('skips one bad component type and keeps the rest of the file', () => {
    const good = createDemoStreets()[0]!;
    const file = toProjectGeoJSON([good], META);
    const broken = structuredClone(file);
    // A second street whose section names a type this build has never heard of.
    broken.features.push({
      type: 'Feature',
      properties: {
        geostripe: 'street',
        name: 'From the future',
        components: [{ componentType: 'hyperloopBay', widthMeters: 4 }],
      },
      geometry: { type: 'LineString', coordinates: [[-84.5, 39.1], [-84.5, 39.101]] },
    });

    const result = parseProject(JSON.stringify(broken), DEFAULTS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.streets).toHaveLength(1);
    expect(result.streets[0]!.name).toBe(good.name);
    expect(result.warnings.join(' ')).toMatch(/unknown component type/);
  });

  it('reports when a file has polygons but no centerlines', () => {
    const file = toProjectGeoJSON(createDemoStreets(), META);
    const bandsOnly = {
      type: 'FeatureCollection',
      features: file.features.filter((f) => f.properties?.['geostripe'] === 'band'),
    };
    const result = parseProject(JSON.stringify(bandsOnly), DEFAULTS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toMatch(/No street centerlines/);
  });
});

describe('importing lines from elsewhere', () => {
  // The point of this path: trace a way in OSM or QGIS, drop it in, design on top of it.
  const plainLines = JSON.stringify({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { name: 'Vine Street' },
        geometry: {
          type: 'LineString',
          coordinates: [
            [-84.5186, 39.1095],
            [-84.5186, 39.1115],
          ],
        },
      },
    ],
  });

  it('imports a bare LineString with the fallback section', () => {
    const result = parseProject(plainLines, DEFAULTS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.streets).toHaveLength(1);
    expect(result.streets[0]!.name).toBe('Vine Street');
    expect(result.streets[0]!.section.name).toBe(DEFAULTS.sectionName);
    expect(result.streets[0]!.section.components).toHaveLength(2);
  });

  it('says so, rather than pretending the section came from the file', () => {
    const result = parseProject(plainLines, DEFAULTS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.join(' ')).toMatch(/plain LineString/);
  });

  it('ignores points and polygons that are not ours', () => {
    const mixed = JSON.stringify({
      type: 'FeatureCollection',
      features: [
        JSON.parse(plainLines).features[0],
        { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [-84.5, 39.1] } },
      ],
    });
    const result = parseProject(mixed, DEFAULTS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.streets).toHaveLength(1);
    expect(result.warnings.join(' ')).toMatch(/skipped/);
  });
});
