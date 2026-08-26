import { describe, expect, it } from 'vitest';
import { parseProject, serializeProject, toProjectGeoJSON } from './project';
import type { ImportDefaults } from './project';
import { closeRing, resolveRing, tessellateRing } from '../geo/curve';
import { lineLengthMeters } from '../geo/measure';
import { LANDCOVERS, LANDCOVER_TYPES, searchLandcover } from '../library/landcover';
import { createDemoStreets } from '../demo/washingtonPark';
import type { Area } from './types';
import type { LngLat } from '../geo/projection';

/**
 * Land cover: the round-trip, and the closed-ring curve handling.
 *
 * An area is stored unclosed and rendered closed, which is a small asymmetry with a real
 * reason — repeating the first point in state would mean every edit had to keep two copies
 * of one vertex in step — and exactly the kind of thing that rots without a test.
 */

const META = { name: 'Test project', editorVersion: '0.0.0-test' };
const DEFAULTS: ImportDefaults = {
  sectionName: 'Fallback section',
  components: [{ componentType: 'travelLane', widthMeters: 3 }],
};

const ORIGIN_LNG = -84.52;
const ORIGIN_LAT = 39.11;
const M_PER_LAT = 111132;
const M_PER_LNG = 111412 * Math.cos((ORIGIN_LAT * Math.PI) / 180);

function at(east: number, north: number): [number, number] {
  return [ORIGIN_LNG + east / M_PER_LNG, ORIGIN_LAT + north / M_PER_LAT];
}

/** A 60 m square. */
const SQUARE: [number, number][] = [at(0, 0), at(60, 0), at(60, 60), at(0, 60)];

function area(overrides: Partial<Area> = {}): Area {
  return {
    id: 'ar-1',
    name: 'The lawn',
    landcover: 'grass',
    ring: SQUARE,
    visible: true,
    ...overrides,
  };
}

describe('the land cover library', () => {
  it('gives every type a label, a category and a colour', () => {
    for (const type of LANDCOVER_TYPES) {
      const spec = LANDCOVERS[type];
      expect(spec.label.length).toBeGreaterThan(0);
      expect(spec.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(spec.opacity).toBeGreaterThan(0);
      // Nothing is fully opaque: these sit over imagery that should still show through.
      expect(spec.opacity).toBeLessThanOrEqual(0.9);
    }
  });

  it('searches labels, categories and notes', () => {
    expect(searchLandcover('grass')).toContain('grass');
    expect(searchLandcover('water')).toContain('water');
    // Categories are searchable, so typing a group name narrows the list.
    expect(searchLandcover('green').length).toBeGreaterThan(3);
    // And notes, so you can find a thing by what it is for.
    expect(searchLandcover('drainage')).toContain('wetland');
    expect(searchLandcover('zzzz')).toHaveLength(0);
  });

  it('returns everything for an empty query', () => {
    expect(searchLandcover('')).toHaveLength(LANDCOVER_TYPES.length);
  });
});

describe('rings', () => {
  it('closes only when it needs to', () => {
    const closed = closeRing(SQUARE);
    expect(closed).toHaveLength(SQUARE.length + 1);
    expect(closed[closed.length - 1]).toEqual(closed[0]);
    // Closing an already-closed ring must not add a second duplicate.
    expect(closeRing(closed)).toHaveLength(closed.length);
  });

  it('leaves a straight ring untouched', () => {
    expect(resolveRing(area())).toEqual(SQUARE);
  });

  it('rounds every corner including the one at index zero', () => {
    // The whole reason rings get their own tessellator: an open line would leave the
    // first vertex sharp, which is an artefact of where drawing happened to start.
    const rounded = tessellateRing(SQUARE, { mode: 'rounded', radiusMeters: 10 });
    for (const corner of SQUARE) {
      const hit = rounded.some(
        (p) => Math.abs(p[0] - corner[0]) < 1e-12 && Math.abs(p[1] - corner[1]) < 1e-12,
      );
      expect(hit).toBe(false);
    }
  });

  it('shrinks the perimeter when corners are rounded', () => {
    const straight = lineLengthMeters(closeRing(SQUARE) as LngLat[]);
    const rounded = lineLengthMeters(
      closeRing(tessellateRing(SQUARE, { mode: 'rounded', radiusMeters: 10 })) as LngLat[],
    );
    // Four 90 degree corners at R each save 2R - piR/2.
    expect(rounded).toBeCloseTo(straight - 4 * (2 * 10 - (Math.PI * 10) / 2), 0);
  });

  it('smooths around the closure without a kink', () => {
    const smooth = tessellateRing(SQUARE, { mode: 'smooth', radiusMeters: 0 });
    expect(smooth.length).toBeGreaterThan(SQUARE.length * 4);
    // A spline through a square bows outward, so the perimeter grows.
    expect(lineLengthMeters(closeRing(smooth) as LngLat[])).toBeGreaterThan(
      lineLengthMeters(closeRing(SQUARE) as LngLat[]),
    );
  });

  it('honours a pinned corner on a ring', () => {
    const pinned = tessellateRing(SQUARE, {
      mode: 'rounded',
      radiusMeters: 10,
      sharpVertices: [0],
    });
    const kept = pinned.some(
      (p) => Math.abs(p[0] - SQUARE[0]![0]) < 1e-12 && Math.abs(p[1] - SQUARE[0]![1]) < 1e-12,
    );
    expect(kept).toBe(true);
  });
});

describe('the project round-trip', () => {
  const streets = createDemoStreets();

  function reload(areas: Area[]) {
    const result = parseProject(serializeProject(streets, META, {}, areas), DEFAULTS);
    if (!result.ok) throw new Error(result.errors.join(' | '));
    return result;
  }

  it('carries land cover through unchanged', () => {
    const loaded = reload([area(), area({ id: 'ar-2', name: 'Pond', landcover: 'water' })]);
    expect(loaded.areas).toHaveLength(2);
    expect(loaded.areas[0]!.name).toBe('The lawn');
    expect(loaded.areas[0]!.landcover).toBe('grass');
    expect(loaded.areas[1]!.landcover).toBe('water');
  });

  it('stores the ring unclosed on both sides of the trip', () => {
    const loaded = reload([area()]);
    expect(loaded.areas[0]!.ring).toHaveLength(SQUARE.length);
    expect(loaded.areas[0]!.ring[0]).not.toEqual(
      loaded.areas[0]!.ring[loaded.areas[0]!.ring.length - 1],
    );
  });

  it('writes a properly closed polygon for external readers', () => {
    const file = toProjectGeoJSON(streets, META, {}, [area()]);
    const feature = file.features.find((f) => f.properties?.['geostripe'] === 'area')!;
    const ring = (feature.geometry as { coordinates: number[][][] }).coordinates[0]!;
    expect(ring).toHaveLength(SQUARE.length + 1);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
  });

  it('exports the resolved edge as a separate feature, the way bands are', () => {
    // The control ring stays the geometry of the area itself — that is what makes a curve
    // still editable after reloading. The tessellated edge rides along beside it so QGIS
    // gets the real shape, and is discarded on the way back in.
    const curved = area({ curve: { mode: 'smooth', radiusMeters: 0 } });
    const file = toProjectGeoJSON([], META, {}, [curved]);

    const control = file.features.find((f) => f.properties?.['geostripe'] === 'area')!;
    expect(
      (control.geometry as { coordinates: number[][][] }).coordinates[0]!,
    ).toHaveLength(SQUARE.length + 1);

    const shape = file.features.find((f) => f.properties?.['geostripe'] === 'areaShape')!;
    expect(shape).toBeDefined();
    expect(
      (shape.geometry as { coordinates: number[][][] }).coordinates[0]!.length,
    ).toBeGreaterThan(SQUARE.length + 1);
  });

  it('does not write a derived edge for a straight-sided area', () => {
    const file = toProjectGeoJSON([], META, {}, [area()]);
    expect(file.features.filter((f) => f.properties?.['geostripe'] === 'areaShape')).toHaveLength(0);
  });

  it('discards the derived edge on load rather than reading it as a second area', () => {
    const loaded = reload([area({ curve: { mode: 'smooth', radiusMeters: 0 } })]);
    expect(loaded.areas).toHaveLength(1);
  });

  it('round-trips the edge settings alongside the control points', () => {
    const loaded = reload([area({ curve: { mode: 'rounded', radiusMeters: 8 } })]);
    expect(loaded.areas[0]!.curve).toEqual({ mode: 'rounded', radiusMeters: 8 });
    expect(loaded.areas[0]!.ring).toEqual(SQUARE);
  });

  it('loads a file that is nothing but land cover', () => {
    const result = parseProject(serializeProject([], META, {}, [area()]), DEFAULTS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.areas).toHaveLength(1);
    expect(result.streets).toHaveLength(0);
  });

  it('rejects an area whose land type this build has never heard of', () => {
    const file = toProjectGeoJSON([], META, {}, [area()]);
    (file.features[0]!.properties as Record<string, unknown>)['landcover'] = 'unobtanium';
    const result = parseProject(JSON.stringify(file), DEFAULTS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toMatch(/No street centerlines or land cover/);
  });
});
