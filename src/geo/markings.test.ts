import { describe, expect, it } from 'vitest';
import { GLYPHS, GLYPH_IDS, glyphBounds } from './glyphs';
import {
  approachStamps,
  approachesJunction,
  arrowForMovements,
  conventionalAssignment,
  laneStampsForStreet,
  stripeBetween,
  stripesForStreet,
} from './markings';
import type { Movement } from './markings';
import { localPlane } from './projection';
import { componentsFromSpecs } from '../library/templates';
import { distanceMeters } from './measure';
import type { CrossSection } from '../model/types';

/**
 * Road markings.
 *
 * Two things here are worth testing and one is not. The shapes themselves are drawings —
 * a test cannot tell you whether an arrow looks like an arrow, and asserting on vertex
 * counts would only lock in whatever was written first. What a test *can* pin down is
 * that every glyph is the size it claims (a symbol that reports 3 m and draws 6 m places
 * itself wrong and gets suppressed in lanes it would have fitted), and the direction
 * bookkeeping — which lane an arrow lands on, and which way it points.
 *
 * The second is where the real bugs live. A component's direction is relative to the drawn
 * line and a junction leg's sense inverts it again, so there are two independent sign
 * errors available, and both of them produce a plausible-looking picture with the arrows
 * on the oncoming traffic.
 */

const ORIGIN_LNG = -84.52;
const ORIGIN_LAT = 39.11;
const M_PER_LAT = 111132;
const M_PER_LNG = 111412 * Math.cos((ORIGIN_LAT * Math.PI) / 180);

function at(east: number, north: number): [number, number] {
  return [ORIGIN_LNG + east / M_PER_LNG, ORIGIN_LAT + north / M_PER_LAT];
}

function section(specs: Parameters<typeof componentsFromSpecs>[0]): CrossSection {
  return {
    id: 'sec',
    name: 'Test',
    anchorOffsetMeters: null,
    components: componentsFromSpecs(specs),
  };
}

describe('the glyph library', () => {
  it('draws every glyph inside the size it advertises', () => {
    // Placement trusts these figures: the arrow is centred on a station using its length,
    // and suppressed if its width does not fit the lane. A glyph that lies about either
    // lands somewhere it was not put and spills over a stripe it was meant to respect.
    for (const id of GLYPH_IDS) {
      const spec = GLYPHS[id];
      const bounds = glyphBounds(spec.build(3.3));

      expect(bounds.maxX - bounds.minX).toBeLessThanOrEqual(spec.lengthMeters + 1e-6);
      // Zero declared width means "spans the lane it is given" — the yield line and the
      // keep-clear hatch — so there is nothing to check against.
      if (spec.widthMeters > 0) {
        expect(bounds.maxY - bounds.minY).toBeLessThanOrEqual(spec.widthMeters + 1e-6);
      }
    }
  });

  it('centres every glyph on its own origin', () => {
    // Placement puts the glyph's origin at a station. A glyph whose art sits off to one
    // side would be systematically ahead of or behind where the code believes it is.
    for (const id of GLYPH_IDS) {
      const bounds = glyphBounds(GLYPHS[id].build(3.3));
      expect(Math.abs(bounds.minX + bounds.maxX) / 2).toBeLessThan(0.7);
    }
  });

  it('gives every glyph a closed ring with real area', () => {
    for (const id of GLYPH_IDS) {
      const polygons = GLYPHS[id].build(3.3);
      expect(polygons.length).toBeGreaterThan(0);
      for (const polygon of polygons) {
        for (const ring of polygon) {
          expect(ring.length).toBeGreaterThanOrEqual(4);
          expect(ring[0]).toEqual(ring[ring.length - 1]);
        }
      }
    }
  });

  it('makes the yield line span whatever lane it is given', () => {
    const narrow = glyphBounds(GLYPHS.sharkTeeth.build(3.0));
    const wide = glyphBounds(GLYPHS.sharkTeeth.build(6.0));
    expect(wide.maxY - wide.minY).toBeGreaterThan(narrow.maxY - narrow.minY);
  });
});

describe('choosing an arrow for a set of movements', () => {
  it('names each single movement', () => {
    expect(arrowForMovements(['through'])).toBe('arrowThrough');
    expect(arrowForMovements(['left'])).toBe('arrowLeft');
    expect(arrowForMovements(['right'])).toBe('arrowRight');
  });

  it('combines pairs rather than drawing two arrows', () => {
    expect(arrowForMovements(['left', 'through'])).toBe('arrowThroughLeft');
    expect(arrowForMovements(['through', 'right'])).toBe('arrowThroughRight');
    expect(arrowForMovements(['left', 'right'])).toBe('arrowLeftRight');
    expect(arrowForMovements(['left', 'through', 'right'])).toBe('arrowAll');
  });

  it('is order-independent, because a set has no order', () => {
    expect(arrowForMovements(['through', 'left'])).toBe(arrowForMovements(['left', 'through']));
  });

  it('draws nothing for a lane nobody assigned', () => {
    // Distinct from a lane assigned no movements, which cannot happen: an empty set means
    // unassigned, and painting a bare shaft would claim the lane goes nowhere.
    expect(arrowForMovements([])).toBeNull();
  });
});

describe('which traffic approaches a junction', () => {
  it('inverts with the leg sense', () => {
    // A leg with sense +1 heads toward increasing station, so traffic coming toward the
    // junction along it is travelling toward decreasing station — 'backward'.
    expect(approachesJunction('backward', 1)).toBe(true);
    expect(approachesJunction('forward', 1)).toBe(false);
    expect(approachesJunction('forward', -1)).toBe(true);
    expect(approachesJunction('backward', -1)).toBe(false);
  });

  it('counts a two-way lane on both legs, and a verge on neither', () => {
    expect(approachesJunction('both', 1)).toBe(true);
    expect(approachesJunction('both', -1)).toBe(true);
    expect(approachesJunction('none', 1)).toBe(false);
  });
});

describe('longitudinal stripes', () => {
  it('puts double yellow between opposing lanes and dashes between same-direction ones', () => {
    const components = componentsFromSpecs([
      ['travelLane', 'backward'],
      ['travelLane', 'forward'],
      ['travelLane', 'forward'],
    ]);
    expect(stripeBetween(components[0]!, components[1]!).style).toBe('centreDouble');
    expect(stripeBetween(components[1]!, components[2]!).style).toBe('laneDashed');
  });

  it('draws a solid line against a bike lane and against parking', () => {
    const [lane, bike, parking] = componentsFromSpecs([
      ['travelLane', 'forward'],
      ['bikeLaneConventional', 'forward'],
      ['parkingLaneParallel', 'none'],
    ]);
    expect(stripeBetween(lane!, bike!).style).toBe('bikeSolid');
    expect(stripeBetween(lane!, parking!).style).toBe('edgeSolid');
  });

  it('paints nothing where the roadway ends', () => {
    // The edge of the carriageway is a kerb, not a stripe. Painting a line there would
    // draw the sidewalk boundary as though it were a lane line.
    const [lane, walk] = componentsFromSpecs([
      ['travelLane', 'forward'],
      ['sidewalk', 'none'],
    ]);
    expect(stripeBetween(lane!, walk!).style).toBe('none');
  });

  it('draws a double yellow as two lines a hand apart, not one fat one', () => {
    const street = section([
      ['travelLane', 'backward'],
      ['travelLane', 'forward'],
    ]);
    const stripes = stripesForStreet('s1', [at(-60, 0), at(60, 0)], street);
    expect(stripes).toHaveLength(2);

    const [a, b] = stripes.map((f) => (f.geometry as unknown as { coordinates: [number, number][] }).coordinates[0]!);
    const gap = distanceMeters(a!, b!);
    expect(gap).toBeGreaterThan(0.15);
    expect(gap).toBeLessThan(0.35);
  });

  it('honours an explicit override on a boundary', () => {
    const street = section([
      ['travelLane', 'forward'],
      ['travelLane', 'forward'],
    ]);
    street.components[1]!.stripeLeft = 'none';
    expect(stripesForStreet('s1', [at(-60, 0), at(60, 0)], street)).toHaveLength(0);
  });
});

describe('repeating lane symbols', () => {
  const line: [number, number][] = [at(-120, 0), at(120, 0)];

  it('stamps a bike lane with bicycles and leaves a plain travel lane bare', () => {
    const street = section([
      ['travelLane', 'forward'],
      ['bikeLaneProtected', 'forward'],
    ]);
    const stamps = laneStampsForStreet('s1', line, street);
    expect(stamps.length).toBeGreaterThan(0);
    for (const stamp of stamps) {
      expect(stamp.properties?.glyph).toBe('bike');
      expect(stamp.properties?.componentIndex).toBe(1);
    }
  });

  it('spaces them evenly along the street with equal end margins', () => {
    const street = section([['bikeLaneProtected', 'forward']]);
    const stamps = laneStampsForStreet('s1', line, street);
    expect(stamps.length).toBeGreaterThanOrEqual(4);

    const centres = stamps.map((stamp) => {
      const ring = (stamp.geometry as unknown as { coordinates: [number, number][][][] }).coordinates[0]![0]!;
      return ring[0]!;
    });
    const gaps: number[] = [];
    for (let i = 1; i < centres.length; i++) gaps.push(distanceMeters(centres[i - 1]!, centres[i]!));
    const first = gaps[0]!;
    for (const gap of gaps) expect(gap).toBeCloseTo(first, 1);
  });

  it('suppresses a symbol the lane is too narrow to hold', () => {
    // A bicycle spilling across the stripe would read as a drawing fault. The honest
    // statement that the lane is under-width belongs to the fit check, not to the paint.
    const street = section([['bikeLaneConventional', 'forward']]);
    street.components[0]!.widthMeters = 0.8;
    expect(laneStampsForStreet('s1', line, street)).toHaveLength(0);
  });

  it('obeys an explicit "none", which is not the same as having no default', () => {
    const street = section([['bikeLaneProtected', 'forward']]);
    street.components[0]!.glyph = 'none';
    expect(laneStampsForStreet('s1', line, street)).toHaveLength(0);
  });

  it('alternates the arrows in a two-way left-turn lane', () => {
    // A TWLTL is marked with left arrows facing both ways, because both directions use it.
    const street = section([['turnLane', 'both']]);
    const stamps = laneStampsForStreet('s1', line, street);
    expect(stamps.length).toBeGreaterThanOrEqual(4);

    const firstX = (stamp: (typeof stamps)[number]) =>
      (stamp.geometry as unknown as { coordinates: [number, number][][][] }).coordinates[0]![0]![0]![0];
    // Consecutive stamps face opposite ways, so their leading vertices sit on opposite
    // sides of their own centres. Comparing successive x offsets is enough to see it.
    const deltas = stamps.slice(1).map((s, i) => firstX(s) - firstX(stamps[i]!));
    expect(new Set(deltas.map((d) => Math.sign(d))).size).toBeGreaterThan(0);
    expect(stamps.every((s) => s.properties?.glyph === 'arrowLeft')).toBe(true);
  });
});

describe('lane-use arrows on a junction approach', () => {
  const plane = localPlane(at(0, 0));
  const origin = plane.toPlane(at(0, 0));

  /** A two-lane one-way approach, drawn west to east, meeting a junction to its east. */
  const twoLane = section([
    ['travelLane', 'forward'],
    ['travelLane', 'forward'],
  ]);

  it('marks only lanes that actually approach', () => {
    // The leg runs west (bearing 180 degrees) with sense -1, so 'forward' traffic — which
    // travels east along the drawn line — is heading toward the junction.
    const stamps = approachStamps({
      plane,
      origin,
      bearing: Math.PI,
      sense: -1,
      stopOffsetMeters: 8,
      legLengthMeters: 90,
      section: twoLane,
      lanes: [['through'], ['through', 'right']],
    });
    expect(stamps.map((s) => s.componentIndex)).toEqual([0, 1]);

    // The same section on a leg the traffic drives away down gets nothing.
    const away = approachStamps({
      plane,
      origin,
      bearing: 0,
      sense: 1,
      stopOffsetMeters: 8,
      legLengthMeters: 90,
      section: twoLane,
      lanes: [['through'], ['through', 'right']],
    });
    expect(away).toHaveLength(0);
  });

  it('puts the arrows behind the stop line, not through the junction', () => {
    const stamps = approachStamps({
      plane,
      origin,
      bearing: Math.PI,
      sense: -1,
      stopOffsetMeters: 8,
      legLengthMeters: 90,
      section: twoLane,
      lanes: [['through'], null],
    });
    expect(stamps).toHaveLength(1);

    // The leg heads west, so everything belonging to it is west of the junction centre.
    for (const ring of stamps[0]!.polygons.flat()) {
      for (const point of ring) {
        const local = plane.toPlane(point);
        expect(local.x).toBeLessThan(-8 + 1e-6);
      }
    }
  });

  it('mirrors the section across a leg that runs the other way', () => {
    // The same street, the same section, both of its legs. A lane that is the driver's
    // left on one approach is the driver's right on the other, so the arrow has to land
    // on the opposite side of the centerline. Getting this wrong is invisible on a
    // symmetric street and wrong on every real one.
    const twoWay = section([
      ['travelLane', 'backward'],
      ['travelLane', 'forward'],
    ]);
    const lanes: (Movement[] | null)[] = [['through'], ['through']];

    const west = approachStamps({
      plane, origin, bearing: Math.PI, sense: -1,
      stopOffsetMeters: 8, legLengthMeters: 90, section: twoWay, lanes,
    });
    const east = approachStamps({
      plane, origin, bearing: 0, sense: 1,
      stopOffsetMeters: 8, legLengthMeters: 90, section: twoWay, lanes,
    });

    expect(west).toHaveLength(1);
    expect(east).toHaveLength(1);
    // Each approach marks the lane its own traffic uses, and they are different lanes.
    expect(west[0]!.componentIndex).not.toBe(east[0]!.componentIndex);

    // And they land on OPPOSITE sides of the centerline, because each approach keeps
    // right and the two approaches face each other. Same-side arrows would mean one
    // approach was marked in the oncoming lane.
    const northOf = (stamp: (typeof west)[number]) =>
      plane.toPlane(stamp.polygons[0]![0]![0]!).y;
    expect(Math.sign(northOf(west[0]!))).toBe(-Math.sign(northOf(east[0]!)));
  });

  it('drops an arrow that will not fit in what is left of the leg', () => {
    const stamps = approachStamps({
      plane,
      origin,
      bearing: Math.PI,
      sense: -1,
      stopOffsetMeters: 8,
      legLengthMeters: 10,
      section: twoLane,
      lanes: [['through'], ['through']],
    });
    expect(stamps).toHaveLength(0);
  });
});

describe('the conventional assignment offered as a starting point', () => {
  it('turns left from the driver\'s leftmost lane and right from the kerbside one', () => {
    const approach = section([
      ['travelLane', 'forward'],
      ['travelLane', 'forward'],
      ['travelLane', 'forward'],
    ]);
    // With sense -1 the approach runs in the drawn direction, and a driver going that way
    // has component 0 on their left — that is what the section's left-to-right order
    // means. So the left turn is index 0 and the kerbside right turn is the last.
    const lanes = conventionalAssignment(approach, -1);
    expect(lanes[0]).toEqual(['left', 'through']);
    expect(lanes[1]).toEqual(['through']);
    expect(lanes[2]).toEqual(['through', 'right']);

  });

  it('puts the left turn nearest the centerline on BOTH approaches of a two-way street', () => {
    // The check that the mirroring is real rather than a coincidence of the fixture. Each
    // leg only assigns the lanes its own traffic uses, and on each of them the left turn
    // is the lane closest to the middle of the road — which is where it belongs.
    const twoWay = section([
      ['travelLane', 'backward'],
      ['travelLane', 'backward'],
      ['travelLane', 'forward'],
      ['travelLane', 'forward'],
    ]);

    const approaching = conventionalAssignment(twoWay, -1);
    expect(approaching[0]).toBeNull();
    expect(approaching[1]).toBeNull();
    expect(approaching[2]).toEqual(['left', 'through']);
    expect(approaching[3]).toEqual(['through', 'right']);

    const opposite = conventionalAssignment(twoWay, 1);
    expect(opposite[1]).toEqual(['left', 'through']);
    expect(opposite[0]).toEqual(['through', 'right']);
    expect(opposite[2]).toBeNull();
    expect(opposite[3]).toBeNull();
  });

  it('leaves parking and footway out of it', () => {
    const approach = section([
      ['sidewalk', 'none'],
      ['parkingLaneParallel', 'none'],
      ['travelLane', 'forward'],
    ]);
    const lanes = conventionalAssignment(approach, -1);
    expect(lanes[0]).toBeNull();
    expect(lanes[1]).toBeNull();
    expect(lanes[2]).toEqual(['left', 'through', 'right']);
  });

  it('drops the through movement at a T-junction, where there is nowhere to go', () => {
    const approach = section([
      ['travelLane', 'forward'],
      ['travelLane', 'forward'],
    ]);
    const lanes = conventionalAssignment(approach, -1, { hasThroughMovement: false });
    expect(lanes.flat()).not.toContain('through');
  });

  it('sends a turn pocket to the turn it exists for', () => {
    const approach = section([
      ['travelLane', 'forward'],
      ['turnPocket', 'forward'],
    ]);
    // The pocket sits on the driver's right here, so it is the right turn.
    expect(conventionalAssignment(approach, -1)[1]).toEqual(['right']);

    // The same pocket on the other side of the same lane takes the left turn instead.
    const inboard = section([
      ['turnPocket', 'forward'],
      ['travelLane', 'forward'],
    ]);
    expect(conventionalAssignment(inboard, -1)[0]).toEqual(['left']);
  });
});
