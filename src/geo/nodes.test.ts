import { beforeEach, describe, expect, it } from 'vitest';
import { detectJunctions } from './junctions';
import { deriveProject, resetDerivedCaches } from './derived';
import { distanceMeters } from './measure';
import { componentsFromSpecs } from '../library/templates';
import type { JunctionNode, Street } from '../model/types';

/**
 * Intersections you place, rather than ones the geometry noticed.
 *
 * The two models have to coexist without either quietly winning. A node is authoritative
 * in its own neighbourhood — the junction is AT the node, and the crossing the detector
 * would have found there is dropped, because two junctions on one piece of asphalt fight
 * over it. Everywhere else, detection carries on as before, so a design still works before
 * anyone has thought about intersections.
 *
 * The case that justifies the whole feature is the disabled node: two roads that cross
 * without meeting. Nothing else in the model can say that — deleting the node hands the
 * spot straight back to the detector, which puts the junction back.
 */

const ORIGIN_LNG = -84.52;
const ORIGIN_LAT = 39.11;
const M_PER_LAT = 111132;
const M_PER_LNG = 111412 * Math.cos((ORIGIN_LAT * Math.PI) / 180);

function at(east: number, north: number): [number, number] {
  return [ORIGIN_LNG + east / M_PER_LNG, ORIGIN_LAT + north / M_PER_LAT];
}

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
      components: componentsFromSpecs([
        ['sidewalk', 'none', 3],
        ['travelLane', 'backward', 3.3],
        ['travelLane', 'forward', 3.3],
        ['sidewalk', 'none', 3],
      ]),
    },
  };
}

const CROSSING = (): Street[] => [
  street('ns', [at(0, -120), at(0, 120)]),
  street('ew', [at(-120, 0), at(120, 0)]),
];

const node = (east: number, north: number, extra: Partial<JunctionNode> = {}): JunctionNode => ({
  id: `n-${east}-${north}`,
  position: at(east, north),
  ...extra,
});

beforeEach(() => resetDerivedCaches());

describe('a placed intersection', () => {
  it('replaces the crossing the detector would have found, rather than adding to it', () => {
    // Two junctions on one piece of asphalt would each carve the other's streets.
    const { junctions } = detectJunctions(CROSSING(), { nodes: [node(0, 0)] });
    expect(junctions).toHaveLength(1);
    expect(junctions[0]!.nodeId).toBe('n-0-0');
    expect(junctions[0]!.legs).toHaveLength(4);
  });

  it('is keyed by the node, so its design outlives the streets', () => {
    // The strongest key there is: a street can be deleted and redrawn from scratch and the
    // corner radii stay where they were put, which a street-set key cannot survive.
    const { junctions } = detectJunctions(CROSSING(), { nodes: [node(0, 0)] });
    expect(junctions[0]!.key).toBe('node:n-0-0');
  });

  it('sits where it was placed, not where the centerlines cross', () => {
    // The point of placing one. A node dropped a few metres off the crossing puts the
    // junction there — that is control, not error, and it is how a skewed junction gets
    // pulled to where the pavement really is.
    const offset = node(4, 3);
    const { junctions } = detectJunctions(CROSSING(), { nodes: [offset] });
    expect(distanceMeters(junctions[0]!.position, offset.position)).toBeLessThan(0.01);
    expect(distanceMeters(junctions[0]!.position, at(0, 0))).toBeGreaterThan(4);
  });

  it('leaves crossings elsewhere alone', () => {
    const streets = [
      street('main', [at(-200, 0), at(200, 0)]),
      street('first', [at(-60, -80), at(-60, 80)]),
      street('second', [at(60, -80), at(60, 80)]),
    ];
    const { junctions } = detectJunctions(streets, { nodes: [node(-60, 0)] });
    expect(junctions).toHaveLength(2);
    expect(junctions.filter((j) => j.nodeId)).toHaveLength(1);
  });

  it('needs two streets to be a junction, but still claims its ground with one', () => {
    // A node parked mid-block is not a junction. It still suppresses detection where it
    // sits, which is what makes it usable as "nothing happens here".
    const single = [street('only', [at(-100, 0), at(100, 0)])];
    expect(detectJunctions(single, { nodes: [node(0, 0)] }).junctions).toHaveLength(0);
  });
});

describe('a node set to no junction', () => {
  it('stops the crossing being a junction at all', () => {
    // The thing nothing else in the model can express: two roads crossing without meeting.
    const { junctions } = detectJunctions(CROSSING(), { nodes: [node(0, 0, { disabled: true })] });
    expect(junctions).toHaveLength(0);
  });

  it('leaves both streets whole', () => {
    const streets = CROSSING();
    const derived = deriveProject(streets, { nodes: [node(0, 0, { disabled: true })] });
    expect(derived.junctionGeometry).toHaveLength(0);
    for (const id of ['ns', 'ew']) {
      for (const band of derived.byStreet.get(id)!.bands) {
        expect(band.geometry.type).toBe('Polygon');
      }
    }
  });

  it('is not the same as deleting it', () => {
    // Deleting hands the spot back to the detector, which puts the junction straight back.
    const streets = CROSSING();
    expect(detectJunctions(streets, { nodes: [] }).junctions).toHaveLength(1);
  });
});

describe('placing intersections by hand only', () => {
  it('finds nothing on its own', () => {
    const { junctions } = detectJunctions(CROSSING(), { mode: 'nodes' });
    expect(junctions).toHaveLength(0);
  });

  it('still honours every node placed', () => {
    const { junctions } = detectJunctions(CROSSING(), { mode: 'nodes', nodes: [node(0, 0)] });
    expect(junctions).toHaveLength(1);
    expect(junctions[0]!.nodeId).toBe('n-0-0');
  });

  it('leaves crossing streets simply overlapping', () => {
    const derived = deriveProject(CROSSING(), { junctionMode: 'nodes' });
    expect(derived.junctionGeometry).toHaveLength(0);
    // No box, no trim: both streets run through uncut, which is exactly "these cross and
    // I have not said anything about it yet".
    for (const id of ['ns', 'ew']) {
      for (const band of derived.byStreet.get(id)!.bands) {
        expect(band.geometry.type).toBe('Polygon');
      }
    }
  });
});

describe('a node and the geometry it drives', () => {
  it('produces the same kind of intersection a detected crossing would', () => {
    const streets = CROSSING();
    const placed = deriveProject(streets, { nodes: [node(0, 0)] });
    resetDerivedCaches();
    const found = deriveProject(streets);

    expect(placed.junctionGeometry).toHaveLength(1);
    expect(found.junctionGeometry).toHaveLength(1);
    expect(placed.junctionGeometry[0]!.legs).toHaveLength(4);

    // Same place, same crossings — the node changed who owns the junction, not what it is.
    for (let i = 0; i < 4; i++) {
      expect(placed.junctionGeometry[0]!.legs[i]!.crossingDistanceMeters).toBeCloseTo(
        found.junctionGeometry[0]!.legs[i]!.crossingDistanceMeters,
        6,
      );
    }
  });

  it('reaches far enough across a wide street to find the one on the far side', () => {
    // A node dropped on a boulevard crossing has to reach past the boulevard's own
    // half-width, or it would find only the street it was dropped on.
    const wide: Street = {
      ...street('boulevard', [at(-150, 0), at(150, 0)]),
      section: {
        id: 'sec-wide',
        name: 'boulevard',
        anchorOffsetMeters: null,
        components: componentsFromSpecs([
          ['sidewalk', 'none', 4],
          ['travelLane', 'backward', 3.3],
          ['travelLane', 'backward', 3.3],
          ['median', 'none', 6],
          ['travelLane', 'forward', 3.3],
          ['travelLane', 'forward', 3.3],
          ['sidewalk', 'none', 4],
        ]),
      },
    };
    const { junctions } = detectJunctions([wide, street('side', [at(0, -100), at(0, 0)])], {
      nodes: [node(0, 0)],
    });
    expect(junctions).toHaveLength(1);
    expect(junctions[0]!.streetIds.sort()).toEqual(['boulevard', 'side']);
  });
});
