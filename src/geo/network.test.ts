import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CORRIDOR_DEGREES,
  buildNetwork,
  bundlesOf,
  envelopesFor,
  laneBalance,
  legsFromEnds,
  nodeEnvelope,
  segmentSpan,
} from './network';
import type { NetworkNode, SegmentEnd } from './network';
import { detectJunctions } from './junctions';
import { componentsFromSpecs } from '../library/templates';
import type { Street } from '../model/types';

/**
 * The node-and-segment network.
 *
 * The layer that was missing. Everything above it — junction surfaces, lane balance,
 * trimming — becomes arithmetic on ends once this is right, so this is the gate.
 *
 * Cincinnati coordinates again (39.11 N), for the same reason as everywhere else: a degree
 * of longitude there is 0.777 of a degree of latitude, so anything that treats them as the
 * same unit produces bearings that are off by a few degrees — and the fork tests turn on
 * exactly that, since a fork and a crossroads differ by an angle.
 */

const ORIGIN_LNG = -84.52;
const ORIGIN_LAT = 39.11;
const M_PER_LAT = 111132;
const M_PER_LNG = 111412 * Math.cos((ORIGIN_LAT * Math.PI) / 180);

function at(east: number, north: number): [number, number] {
  return [ORIGIN_LNG + east / M_PER_LNG, ORIGIN_LAT + north / M_PER_LAT];
}

/** A point `distance` metres from the origin at a compass-free bearing (0 = east, CCW). */
function ray(bearingDeg: number, distance: number): [number, number] {
  const r = (bearingDeg * Math.PI) / 180;
  return at(Math.cos(r) * distance, Math.sin(r) * distance);
}

let counter = 0;
function street(
  name: string,
  centerline: [number, number][],
  options: { widthMeters?: number; twoWay?: boolean } = {},
): Street {
  counter += 1;
  const widthMeters = options.widthMeters ?? 12;
  const lanes = Math.max(1, Math.round(widthMeters / 3));
  return {
    id: `st-${counter}-${name.replace(/\W/g, '')}`,
    name,
    centerline,
    visible: true,
    section: {
      id: `sec-${counter}`,
      name,
      anchorOffsetMeters: null,
      components: componentsFromSpecs(
        Array.from({ length: lanes }, (_, i) =>
          options.twoWay
            ? ([`travelLane`, i < lanes / 2 ? 'forward' : 'backward'] as const)
            : (['travelLane', 'forward'] as const),
        ),
      ),
    },
  };
}

function networkOf(streets: Street[]) {
  const { junctions, plane } = detectJunctions(streets);
  return buildNetwork(streets, junctions, plane);
}

const DEG = 180 / Math.PI;

/** A bare end, for testing the geometry without building a whole network around it. */
function end(bearingDeg: number, half = 6, over: Partial<SegmentEnd> = {}): SegmentEnd {
  return {
    segmentId: `seg-${bearingDeg}`,
    nodeId: 'n',
    streetId: `street-${bearingDeg}`,
    stationMeters: 0,
    sense: 1,
    bearing: (((bearingDeg * Math.PI) / 180) + Math.PI * 2) % (Math.PI * 2),
    halfLeft: half,
    halfRight: half,
    travelwayHalf: half,
    lengthMeters: 100,
    level: 0,
    ...over,
  };
}

function nodeOf(ends: SegmentEnd[]): NetworkNode {
  return {
    id: 'n',
    position: { x: 0, y: 0 },
    positionLngLat: at(0, 0),
    ends: [...ends].sort((a, b) => a.bearing - b.bearing),
  };
}

// ------------------------------------------------------------------------ the graph

describe('the graph a crossroads makes', () => {
  const ns = street('North–South', [at(0, -100), at(0, 100)]);
  const ew = street('East–West', [at(-100, 0), at(100, 0)]);
  const net = networkOf([ns, ew]);

  it('cuts both streets at the crossing, giving four segments', () => {
    expect(net.segments).toHaveLength(4);
    expect(net.segmentsByStreet.get(ns.id)).toHaveLength(2);
    expect(net.segmentsByStreet.get(ew.id)).toHaveLength(2);
  });

  it('makes one junction node and four loose ends', () => {
    const junctionNodes = net.nodes.filter((n) => n.junctionKey);
    expect(junctionNodes).toHaveLength(1);
    expect(net.nodes).toHaveLength(5);
  });

  it('gives the junction node four ends, one per arm', () => {
    const junction = net.nodes.find((n) => n.junctionKey)!;
    expect(junction.ends).toHaveLength(4);
    expect(junction.ends.map((e) => Math.round(e.bearing * DEG))).toEqual([0, 90, 180, 270]);
  });

  it('gives every loose end exactly one end', () => {
    for (const node of net.nodes.filter((n) => !n.junctionKey)) {
      expect(node.ends).toHaveLength(1);
    }
  });

  it('every segment names two nodes that exist', () => {
    for (const segment of net.segments) {
      expect(net.nodeById.has(segment.fromNodeId)).toBe(true);
      expect(net.nodeById.has(segment.toNodeId)).toBe(true);
      expect(segment.fromNodeId).not.toBe(segment.toNodeId);
    }
  });

  it('every end names a segment that exists, and agrees which node it is at', () => {
    for (const node of net.nodes) {
      for (const e of node.ends) {
        const segment = net.segmentById.get(e.segmentId);
        expect(segment).toBeDefined();
        expect([segment!.fromNodeId, segment!.toNodeId]).toContain(node.id);
        expect(e.nodeId).toBe(node.id);
      }
    }
  });

  it('covers each street exactly once, end to end', () => {
    for (const [streetId, ids] of net.segmentsByStreet) {
      const spans = ids.map((id) => net.segmentById.get(id)!);
      expect(spans[0]!.fromStation).toBeCloseTo(0, 6);
      for (let i = 1; i < spans.length; i++) {
        expect(spans[i]!.fromStation).toBeCloseTo(spans[i - 1]!.toStation, 6);
      }
      const total = spans.reduce((sum, s) => sum + s.lengthMeters, 0);
      expect(total).toBeCloseTo(200, 0);
      expect(streetId).toBeTruthy();
    }
  });

  it('points each end away from its own node', () => {
    // The segment running east from the crossing has an end at the crossing pointing east,
    // and an end at the far terminus pointing back west. Getting this backwards is the
    // classic sign error, and every corner would then be built on the wrong side.
    const junction = net.nodes.find((n) => n.junctionKey)!;
    const eastEnd = junction.ends.find((e) => Math.round(e.bearing * DEG) === 0)!;
    const far = net.nodes.find(
      (n) => !n.junctionKey && n.ends[0]!.segmentId === eastEnd.segmentId,
    )!;
    expect(Math.round(far.ends[0]!.bearing * DEG)).toBe(180);
  });
});

describe('a street that meets nothing', () => {
  const lone = street('Lone', [at(0, 0), at(100, 0)]);
  const net = networkOf([lone]);

  it('is one segment between two termini', () => {
    expect(net.segments).toHaveLength(1);
    expect(net.nodes).toHaveLength(2);
    expect(net.nodes.every((n) => n.ends.length === 1)).toBe(true);
  });

  it('reads as a terminus at each end, owning no ground', () => {
    for (const node of net.nodes) {
      const envelope = nodeEnvelope(node);
      expect(envelope.form).toBe('terminus');
      expect(envelope.surface).toEqual([]);
    }
  });
});

describe('extra cuts', () => {
  it('splits a street where its section changes, with no junction involved', () => {
    const road = street('Widening', [at(0, 0), at(300, 0)]);
    const { junctions, plane } = detectJunctions([road]);
    const net = buildNetwork([road], junctions, plane, { extraCuts: { [road.id]: [150] } });
    expect(net.segmentsByStreet.get(road.id)).toHaveLength(2);
    const middle = net.nodes.find((n) => n.ends.length === 2);
    expect(middle).toBeDefined();
    expect(nodeEnvelope(middle!).form).toBe('continuation');
  });

  it('ignores a cut too close to an end to leave a segment', () => {
    const road = street('Nearly', [at(0, 0), at(300, 0)]);
    const { junctions, plane } = detectJunctions([road]);
    const net = buildNetwork([road], junctions, plane, { extraCuts: { [road.id]: [1] } });
    expect(net.segmentsByStreet.get(road.id)).toHaveLength(1);
  });
});

// --------------------------------------------------------------------- node geometry

describe('how far a road retreats into a junction', () => {
  it('pulls a square crossing back by the other road half-width', () => {
    // Four arms, each 12 m wide. The kerb corner sits 6 m along each arm and 6 m to the
    // side of it — the corner of the square, which is the answer anyone would draw by hand.
    const envelope = nodeEnvelope(nodeOf([end(0), end(90), end(180), end(270)]));
    expect(envelope.form).toBe('junction');
    expect(envelope.retreats).toHaveLength(4);
    for (const retreat of envelope.retreats) expect(retreat).toBeCloseTo(6, 6);
    for (const corner of envelope.corners) expect(corner.point).not.toBeNull();
  });

  it('retreats a wide road less than the narrow one it crosses', () => {
    // The retreat is set by the OTHER road's width, not your own: you stop short far enough
    // to clear what is coming across, and a wide road crossing a narrow one barely stops at
    // all. Getting this the wrong way round makes big roads eat small ones.
    const wide = 20;
    const narrow = 4;
    const node = nodeOf([end(0, wide), end(90, narrow), end(180, wide), end(270, narrow)]);
    const envelope = nodeEnvelope(node);

    for (let i = 0; i < node.ends.length; i++) {
      const isWide = node.ends[i]!.halfLeft === wide;
      expect(envelope.retreats[i]!).toBeCloseTo(isWide ? narrow : wide, 6);
    }
  });

  it('does not retreat a road that runs straight through', () => {
    // Two ends 180 degrees apart have parallel kerbs that never meet. A road passing through
    // a junction is not stopped by itself.
    const node = nodeOf([end(0), end(90), end(180)]);
    const envelope = nodeEnvelope(node);
    const straightPair = envelope.corners.find((c) => Math.round(c.gap * DEG) === 180);
    expect(straightPair?.point).toBeNull();
  });

  it('reaches further on a skewed crossing than a square one', () => {
    const square = nodeEnvelope(nodeOf([end(0), end(90), end(180), end(270)]));
    const skewed = nodeEnvelope(nodeOf([end(0), end(40), end(180), end(220)]));
    expect(skewed.form).toBe('junction');
    expect(Math.max(...skewed.retreats)).toBeGreaterThan(Math.max(...square.retreats));
  });
});

describe('the surface a junction owns', () => {
  const envelope = nodeEnvelope(nodeOf([end(0), end(90), end(180), end(270)]));

  it('is a closed ring with a mouth and a corner per arm', () => {
    // Two mouth points and one corner for each of the four arms.
    expect(envelope.surface).toHaveLength(12);
  });

  it('encloses the node centre', () => {
    // Ray casting: a point inside a simple ring crosses its boundary an odd number of times.
    const ring = envelope.surface;
    let crossings = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      if (a.y > 0 !== b.y > 0) {
        const t = (0 - a.y) / (b.y - a.y);
        if (a.x + t * (b.x - a.x) > 0) crossings++;
      }
    }
    expect(crossings % 2).toBe(1);
  });

  it('is wound counter-clockwise, like every other ring here', () => {
    const ring = envelope.surface;
    let area = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      area += a.x * b.y - b.x * a.y;
    }
    expect(area).toBeGreaterThan(0);
  });

  it('is about as big as the two roads that made it', () => {
    // Four 12 m arms: a 12 by 12 square plus four corner nicks. Not exact, but it must not
    // be an order of magnitude out in either direction.
    const ring = envelope.surface;
    let area = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      area += a.x * b.y - b.x * a.y;
    }
    expect(Math.abs(area / 2)).toBeGreaterThan(100);
    expect(Math.abs(area / 2)).toBeLessThan(200);
  });
});

// -------------------------------------------------------------------- forks and merges

describe('telling a fork from a crossroads', () => {
  it('reads five roads converging along one line as a merge, not a junction', () => {
    // The shape in the screenshot: carriageways of a freeway that separate and rejoin. Read
    // as an intersection this gets cut back to a shared rectangle, which gouges a hole
    // straight through forty metres of pavement.
    const node = nodeOf([end(0), end(6), end(12), end(184), end(190)]);
    const envelope = nodeEnvelope(node);
    expect(envelope.form).toBe('merge');
    expect(envelope.surface).toEqual([]);
    expect(envelope.retreats.every((r) => r === 0)).toBe(true);
  });

  it('reads a ramp leaving a freeway as a merge', () => {
    const node = nodeOf([
      end(0, 10, { streetId: 'freeway' }),
      end(180, 10, { streetId: 'freeway' }),
      end(195, 4, { streetId: 'ramp' }),
    ]);
    expect(nodeEnvelope(node).form).toBe('merge');
  });

  it('still reads a skewed crossing as a junction', () => {
    // Thirty degrees is a rotten angle for an intersection and a perfectly ordinary one for
    // a real street grid. It must not be swallowed by the merge rule.
    //
    // Both roads carry straight on out the far side, which is what makes this a crossing
    // rather than a fork: each street owns the pair of ends 180 degrees apart.
    const node = nodeOf([
      end(0, 6, { streetId: 'a' }),
      end(180, 6, { streetId: 'a' }),
      end(30, 6, { streetId: 'b' }),
      end(210, 6, { streetId: 'b' }),
    ]);
    expect(nodeEnvelope(node).form).toBe('junction');
  });

  it('reads a wide-angle fork as a junction even though the roads all end there', () => {
    // The corridor test is the other half. Three roads terminating together is only a fork
    // if they run the same way; at sixty degrees apart they are a Y, and traffic between
    // two of the arms turns across the third.
    const node = nodeOf([
      end(0, 6, { streetId: 'a' }),
      end(60, 6, { streetId: 'b' }),
      end(180, 6, { streetId: 'c' }),
    ]);
    expect(nodeEnvelope(node).form).toBe('junction');
  });

  it('is not a merge just because three streets run shallow to each other', () => {
    // Three roads at seven degrees, each carrying straight on out the far side. Traffic on
    // every one of them crosses the other two, however unpleasant the angle. What makes a
    // fork a fork is that the roads END there.
    const node = nodeOf([
      end(0, 6, { streetId: 'a' }),
      end(180, 6, { streetId: 'a' }),
      end(7, 6, { streetId: 'b' }),
      end(187, 6, { streetId: 'b' }),
      end(14, 6, { streetId: 'c' }),
      end(194, 6, { streetId: 'c' }),
    ]);
    expect(nodeEnvelope(node).form).toBe('junction');
  });

  it('allows exactly one road to carry through a merge', () => {
    // A freeway with a ramp peeling off is one through road and one that ends. That is the
    // commonest merge there is and must not be excluded by the through-road rule.
    const node = nodeOf([
      end(0, 10, { streetId: 'freeway' }),
      end(180, 10, { streetId: 'freeway' }),
      end(192, 4, { streetId: 'ramp' }),
    ]);
    expect(nodeEnvelope(node).form).toBe('merge');
  });
});

describe('bundling ends by direction', () => {
  it('finds one bundle when everything heads the same way', () => {
    expect(bundlesOf(nodeOf([end(0), end(6), end(12)]).ends)).toHaveLength(1);
  });

  it('finds four bundles at a crossroads', () => {
    expect(bundlesOf(nodeOf([end(0), end(90), end(180), end(270)]).ends)).toHaveLength(4);
  });

  it('splits where the gap exceeds the spread', () => {
    const bundles = bundlesOf(nodeOf([end(0), end(DEFAULT_CORRIDOR_DEGREES + 5)]).ends);
    expect(bundles).toHaveLength(2);
  });

  it('keeps a bundle together across a gap under the spread', () => {
    const bundles = bundlesOf(nodeOf([end(0), end(DEFAULT_CORRIDOR_DEGREES - 5)]).ends);
    expect(bundles).toHaveLength(1);
  });

  it('never reports more than two bundles for a node the classifier calls a merge', () => {
    // The count and the label have to agree, or the sidebar contradicts itself. A merge has
    // every end inside the corridor, so there is one bundle going and at most one coming.
    const forks = [
      nodeOf([end(0), end(6), end(12), end(184), end(190)]),
      nodeOf([end(86), end(108), end(119), end(288)]),
      nodeOf([end(0), end(5), end(10), end(15), end(20)]),
    ];
    for (const fork of forks) {
      expect(nodeEnvelope(fork).form).toBe('merge');
      expect(bundlesOf(fork.ends).length).toBeLessThanOrEqual(2);
    }
  });

  it('accounts for every end exactly once', () => {
    const ends = nodeOf([end(0), end(10), end(95), end(180), end(190), end(300)]).ends;
    const seen = bundlesOf(ends).flat().sort((a, b) => a - b);
    expect(seen).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('wraps around zero', () => {
    // Ends at 350 and 5 degrees are fifteen degrees apart, not three hundred and forty-five.
    expect(bundlesOf(nodeOf([end(350), end(5)]).ends)).toHaveLength(1);
  });
});

// ------------------------------------------------------------------------- the payoff

describe('what the segments are for', () => {
  it('shortens a segment by the retreat at each of its nodes', () => {
    const ns = street('North–South', [at(0, -100), at(0, 100)]);
    const ew = street('East–West', [at(-100, 0), at(100, 0)]);
    const net = networkOf([ns, ew]);
    const envelopes = envelopesFor(net);

    const junction = net.nodes.find((n) => n.junctionKey)!;
    const segmentId = junction.ends[0]!.segmentId;
    const segment = net.segmentById.get(segmentId)!;
    const span = segmentSpan(net, segmentId, envelopes)!;

    expect(span).not.toBeNull();
    // One end is at the junction and retreats; the other is a loose end and does not.
    const shortenedBy = span.fromStation - segment.fromStation + (segment.toStation - span.toStation);
    expect(shortenedBy).toBeGreaterThan(4);
    expect(shortenedBy).toBeLessThan(8);
  });

  it('leaves a segment alone where nothing retreats', () => {
    const lone = street('Lone', [at(0, 0), at(100, 0)]);
    const net = networkOf([lone]);
    const envelopes = envelopesFor(net);
    const segment = net.segments[0]!;
    const span = segmentSpan(net, segment.id, envelopes)!;
    expect(span.fromStation).toBeCloseTo(segment.fromStation, 6);
    expect(span.toStation).toBeCloseTo(segment.toStation, 6);
  });

  it('shares out the road when two junctions are too close together', () => {
    // Three parallel streets crossed by one short link. Each crossing wants to retreat the
    // link by a half-width, and there is not that much link between them.
    const link = street('Link', [at(-40, 0), at(40, 0)], { widthMeters: 12 });
    const a = street('A', [at(-15, -60), at(-15, 60)], { widthMeters: 30 });
    const b = street('B', [at(15, -60), at(15, 60)], { widthMeters: 30 });
    const net = networkOf([link, a, b]);
    const envelopes = envelopesFor(net);

    const middle = net.segments.find(
      (s) => s.streetId === link.id && s.lengthMeters < 31 && s.lengthMeters > 29,
    )!;
    expect(middle).toBeDefined();

    const span = segmentSpan(net, middle.id, envelopes);
    expect(span, 'the link between the two crossings was eaten entirely').not.toBeNull();
    expect(span!.toStation - span!.fromStation).toBeGreaterThan(0);
  });

  it('leaves a long segment its full retreat', () => {
    // The clamp must only bite when there is genuinely no room. A normal block keeps the
    // retreat its kerbs actually need.
    const ns = street('North–South', [at(0, -100), at(0, 100)]);
    const ew = street('East–West', [at(-100, 0), at(100, 0)]);
    const net = networkOf([ns, ew]);
    const junction = net.nodes.find((n) => n.junctionKey)!;
    const relaxed = envelopesFor(net).get(junction.id)!;
    // Square crossing of two identical roads: each stops short by the other's half-width,
    // whatever the section works out to once shoulders and kerbs are counted.
    for (let i = 0; i < junction.ends.length; i++) {
      expect(relaxed.retreats[i]!).toBeCloseTo(junction.ends[i]!.halfLeft, 6);
    }
  });

  it('counts lanes in and out of a node', () => {
    // Two-way, four lanes each: at a crossroads eight arrive and eight leave.
    const ns = street('North–South', [at(0, -100), at(0, 100)], { twoWay: true });
    const ew = street('East–West', [at(-100, 0), at(100, 0)], { twoWay: true });
    const net = networkOf([ns, ew]);
    const junction = net.nodes.find((n) => n.junctionKey)!;
    const balance = laneBalance(junction, [ns, ew]);
    expect(balance.inbound).toBe(8);
    expect(balance.outbound).toBe(8);
  });

  it('hands the intersection builder legs it recognises', () => {
    const ns = street('North–South', [at(0, -100), at(0, 100)]);
    const ew = street('East–West', [at(-100, 0), at(100, 0)]);
    const net = networkOf([ns, ew]);
    const junction = net.nodes.find((n) => n.junctionKey)!;
    const legs = legsFromEnds(junction);
    expect(legs).toHaveLength(4);
    expect(legs.map((l) => Math.round(l.bearing * DEG))).toEqual([0, 90, 180, 270]);
    for (const leg of legs) {
      expect(leg.lengthMeters).toBeGreaterThan(0);
      expect(leg.halfLeft).toBeGreaterThan(0);
    }
  });
});

describe('a fork built from real streets', () => {
  // A trunk running east, splitting into two carriageways that diverge by ten degrees.
  const trunk = street('Trunk', [ray(180, 300), at(0, 0)], { widthMeters: 24 });
  const leftFork = street('Left fork', [at(0, 0), ray(5, 300)], { widthMeters: 12 });
  const rightFork = street('Right fork', [at(0, 0), ray(-5, 300)], { widthMeters: 12 });
  const net = networkOf([trunk, leftFork, rightFork]);

  it('puts all three roads on one node', () => {
    const shared = net.nodes.filter((n) => n.ends.length >= 3);
    expect(shared).toHaveLength(1);
    expect(new Set(shared[0]!.ends.map((e) => e.streetId)).size).toBe(3);
  });

  it('carves nothing there', () => {
    const shared = net.nodes.find((n) => n.ends.length >= 3)!;
    const envelope = nodeEnvelope(shared);
    expect(envelope.form).toBe('merge');
    expect(envelope.surface).toEqual([]);
  });

  it('leaves the roads their full length', () => {
    const envelopes = envelopesFor(net);
    for (const segment of net.segments) {
      const span = segmentSpan(net, segment.id, envelopes)!;
      expect(span.toStation - span.fromStation).toBeCloseTo(segment.lengthMeters, 6);
    }
  });
});
