import { beforeEach, describe, expect, it } from 'vitest';
import type { Feature } from 'geojson';
import { deriveProject, resetDerivedCaches } from './derived';
import { localPlane } from './projection';
import { ringArea } from './intersection';
import { componentsFromSpecs } from '../library/templates';
import { PRIMITIVES } from '../library/primitives';
import type { ComponentType, Direction } from '../library/primitives';
import type { Street } from '../model/types';

/**
 * The derivation pipeline: trimming, and the memoisation that makes it affordable.
 *
 * The cache assertions look like implementation tests but they are not — they pin a
 * performance property the feature depends on. Without them the first refactor that
 * replaces a reference check with a deep copy makes every vertex drag recompute every
 * street's boolean geometry sixty times a second, and nothing fails except the frame rate.
 */

const ORIGIN_LNG = -84.52;
const ORIGIN_LAT = 39.11;
const M_PER_LAT = 111132;
const M_PER_LNG = 111412 * Math.cos((ORIGIN_LAT * Math.PI) / 180);

function at(east: number, north: number): [number, number] {
  return [ORIGIN_LNG + east / M_PER_LNG, ORIGIN_LAT + north / M_PER_LAT];
}

type Spec = readonly [ComponentType, Direction] | readonly [ComponentType, Direction, number];

const SIMPLE: readonly Spec[] = [
  ['sidewalk', 'none', 3],
  ['travelLane', 'backward', 3],
  ['travelLane', 'forward', 3],
  ['sidewalk', 'none', 3],
];

function street(id: string, centerline: [number, number][]): Street {
  return {
    id,
    name: id,
    centerline,
    visible: true,
    section: {
      id: `sec-${id}`,
      name: id,
      anchorOffsetMeters: null,
      components: componentsFromSpecs(SIMPLE),
    },
  };
}

function crossing(): Street[] {
  return [
    street('ns', [at(0, -120), at(0, 120)]),
    street('ew', [at(-120, 0), at(120, 0)]),
  ];
}

/** Total polygon area of a feature list, in square metres. */
function areaOf(features: readonly Feature[]): number {
  const plane = localPlane([ORIGIN_LNG, ORIGIN_LAT]);
  let total = 0;
  for (const feature of features) {
    const geometry = feature.geometry;
    const polygons =
      geometry.type === 'Polygon'
        ? [geometry.coordinates]
        : geometry.type === 'MultiPolygon'
          ? geometry.coordinates
          : [];
    for (const polygon of polygons) {
      for (const [index, ring] of polygon.entries()) {
        const area = Math.abs(
          ringArea((ring as [number, number][]).map((p) => plane.toPlane(p))),
        );
        total += index === 0 ? area : -area;
      }
    }
  }
  return total;
}

beforeEach(resetDerivedCaches);

describe('trimming at junctions', () => {
  it('removes area from the streets where they cross', () => {
    const streets = crossing();
    const trimmed = deriveProject(streets, { trimAtJunctions: true });
    const untrimmed = deriveProject(streets, { trimAtJunctions: false });

    const trimmedArea = [...trimmed.byStreet.values()].reduce((n, g) => n + areaOf(g.bands), 0);
    const fullArea = [...untrimmed.byStreet.values()].reduce((n, g) => n + areaOf(g.bands), 0);

    expect(trimmedArea).toBeLessThan(fullArea);
    // Both streets are 240 m long and 12 m wide; the hole is tens of square metres, not
    // hundreds, so a trim that removed most of the design would fail here.
    expect(trimmedArea).toBeGreaterThan(fullArea * 0.8);
  });

  it('cuts roadway at the kerb line and footway at the wider footprint', () => {
    // The whole two-boundary design in one assertion: asphalt runs further into the
    // junction than the footway does, so the corner is left for the sidewalk to turn.
    const derived = deriveProject(crossing(), { trimAtJunctions: true });
    const geometry = derived.junctionGeometry[0]!;

    const plane = localPlane(geometry.centre);
    const paved = Math.abs(ringArea(geometry.paved.map((p) => plane.toPlane(p))));
    const footprint = Math.abs(ringArea(geometry.footprint.map((p) => plane.toPlane(p))));
    expect(footprint).toBeGreaterThan(paved);

    for (const leg of geometry.legs) {
      expect(leg.footStopOffsetMeters).toBeGreaterThan(leg.stopOffsetMeters);
    }
  });

  it('leaves the design untouched when trimming is off', () => {
    const streets = crossing();
    const off = deriveProject(streets, { trimAtJunctions: false });
    for (const geometry of off.byStreet.values()) {
      for (const band of geometry.bands) {
        expect(band.geometry.type).toBe('Polygon');
      }
    }
    expect(off.junctionGeometry).toHaveLength(0);
  });

  it('keeps every band it started with, minus none', () => {
    const derived = deriveProject(crossing(), { trimAtJunctions: true });
    for (const geometry of derived.byStreet.values()) {
      // Four components each; none is swallowed whole by a junction on a 240 m street.
      expect(geometry.bands).toHaveLength(4);
    }
  });

  it('splits lane markings around the intersection box', () => {
    const derived = deriveProject(crossing(), { trimAtJunctions: true });
    for (const geometry of derived.byStreet.values()) {
      // One centre marking per street, cut into two runs either side of the junction.
      expect(geometry.markings.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('memoisation', () => {
  it('reuses geometry when nothing changed', () => {
    const streets = crossing();
    const first = deriveProject(streets);
    const second = deriveProject(streets);
    expect(second.byStreet.get('ns')).toBe(first.byStreet.get('ns'));
    expect(second.byStreet.get('ew')).toBe(first.byStreet.get('ew'));
  });

  it('rebuilds only the street that moved', () => {
    // The property that makes dragging affordable. Immutable store updates leave the other
    // street's arrays reference-identical, so its trimmed geometry must survive untouched.
    const streets = crossing();
    const first = deriveProject(streets);

    const moved: Street[] = [
      { ...streets[0]!, centerline: [at(2, -120), at(2, 120)] },
      streets[1]!,
    ];
    const second = deriveProject(moved);

    expect(second.byStreet.get('ns')).not.toBe(first.byStreet.get('ns'));
    // 'ew' is untouched in the store, but the junction it shares moved — so it does have
    // to be re-trimmed. What must NOT happen is a rebuild when the junction is unchanged.
    const third = deriveProject(moved);
    expect(third.byStreet.get('ew')).toBe(second.byStreet.get('ew'));
    expect(third.byStreet.get('ns')).toBe(second.byStreet.get('ns'));
  });

  it('rebuilds when a corner radius changes', () => {
    const streets = crossing();
    const first = deriveProject(streets);
    const key = first.junctions[0]!.key;
    const second = deriveProject(streets, {
      overrides: { [key]: { corners: [{ radiusMeters: 1 }, null, null, null] } },
    });

    expect(second.junctionGeometry[0]!.corners[0]!.appliedRadiusMeters).toBeCloseTo(1, 6);
    expect(second.byStreet.get('ns')).not.toBe(first.byStreet.get('ns'));
  });

  it('drops a deleted street rather than holding its geometry alive', () => {
    const streets = crossing();
    deriveProject(streets);
    const after = deriveProject([streets[1]!]);

    expect(after.byStreet.has('ns')).toBe(false);
    expect(after.junctions).toHaveLength(0);
    // And re-adding it produces fresh geometry rather than a stale cache hit.
    const back = deriveProject(streets);
    expect(back.byStreet.get('ns')).toBeDefined();
    expect(back.byStreet.get('ns')!.bands).toHaveLength(4);
  });
});

describe('what the junction reports', () => {
  it('names a crossing distance per leg that matches the section', () => {
    const derived = deriveProject(crossing());
    const geometry = derived.junctionGeometry[0]!;
    expect(geometry.legs).toHaveLength(4);
    for (const leg of geometry.legs) {
      // Two 3 m lanes; the footways are outside the kerb and are not crossed.
      expect(leg.crossingDistanceMeters).toBeCloseTo(6, 6);
    }
  });

  it('uses the roadway flag, not the component name, to decide what is asphalt', () => {
    // Pinned because it is the load-bearing assumption of the two-boundary trim: anything
    // flagged isRoadway is cut at the kerb line, everything else at the footprint.
    expect(PRIMITIVES.travelLane.isRoadway).toBe(true);
    expect(PRIMITIVES.median.isRoadway).toBe(true);
    expect(PRIMITIVES.sidewalk.isRoadway).toBe(false);
  });
});

describe('corner treatments reaching the streets', () => {
  const WIDE: readonly Spec[] = [
    ['sidewalk', 'none', 3],
    ['parkingLaneParallel', 'none', 2.4],
    ['travelLane', 'backward', 3],
    ['travelLane', 'forward', 3],
    ['parkingLaneParallel', 'none', 2.4],
    ['sidewalk', 'none', 3],
  ];

  function wideStreet(id: string, centerline: [number, number][]): Street {
    return {
      id,
      name: id,
      centerline,
      visible: true,
      section: {
        id: `sec-${id}`,
        name: id,
        anchorOffsetMeters: null,
        components: componentsFromSpecs(WIDE),
      },
    };
  }

  const wideCrossing = (): Street[] => [
    wideStreet('ns', [at(0, -120), at(0, 120)]),
    wideStreet('ew', [at(-120, 0), at(120, 0)]),
  ];

  function keyOf(streets: Street[]): string {
    return deriveProject(streets).junctions[0]!.key;
  }

  it('recolours daylighted parking instead of cutting a hole in the road', () => {
    // A hole here would show footway through the middle of the carriageway. Daylighting
    // removes the parking, not the pavement, so the stretch stays roadway and only its
    // material changes.
    const streets = wideCrossing();
    const key = keyOf(streets);

    const plain = deriveProject(streets);
    const lit = deriveProject(streets, {
      overrides: { [key]: { corners: [{ daylightMeters: 6 }, null, null, null] } },
    });

    const areaBefore = [...plain.byStreet.values()].reduce((n, g) => n + areaOf(g.bands), 0);
    const areaAfter = [...lit.byStreet.values()].reduce((n, g) => n + areaOf(g.bands), 0);
    expect(areaAfter).toBeCloseTo(areaBefore, 0);

    const daylighted = [...lit.byStreet.values()]
      .flatMap((g) => g.bands)
      .filter((b) => b.properties?.['daylighted'] === true);
    expect(daylighted.length).toBeGreaterThan(0);
    for (const band of daylighted) {
      expect(band.properties?.['color']).toBe(PRIMITIVES.travelLane.color);
      expect(band.properties?.['componentType']).toMatch(/^parking/);
    }
  });

  it('takes the lane bands out from under a curb extension', () => {
    // Roadway is cut against the un-bulbed box, so the reclaimed ground loses its bands
    // and the footway ring underneath shows through as the extension.
    const streets = wideCrossing();
    const key = keyOf(streets);

    const plain = deriveProject(streets);
    const bulbed = deriveProject(streets, {
      overrides: {
        [key]: {
          corners: Array.from({ length: 4 }, () => ({
            treatment: 'bulbOut' as const,
            bulbOutMeters: 2.4,
          })),
        },
      },
    });

    const areaBefore = [...plain.byStreet.values()].reduce((n, g) => n + areaOf(g.bands), 0);
    const areaAfter = [...bulbed.byStreet.values()].reduce((n, g) => n + areaOf(g.bands), 0);
    expect(areaAfter).toBeLessThan(areaBefore);
  });

  it('emits crossing marks only for legs that asked for them', () => {
    const streets = wideCrossing();
    const key = keyOf(streets);

    expect(deriveProject(streets).crossings).toHaveLength(0);

    const marked = deriveProject(streets, {
      overrides: {
        [key]: {
          legs: [
            { crosswalk: { style: 'continental', widthMeters: 3, setbackMeters: 0 } },
            null,
            null,
            null,
          ],
        },
      },
    });
    expect(marked.crossings.length).toBeGreaterThan(0);
    for (const mark of marked.crossings) {
      expect(mark.properties?.['legIndex']).toBe(0);
      expect(mark.properties?.['junctionKey']).toBe(key);
    }
  });
});
