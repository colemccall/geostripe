import { describe, expect, it } from 'vitest';
import { buildRoadGeometry } from './roadGeometry';
import {
  addNode,
  addSegment,
  emptyRoadNetwork,
  mergeNodes,
  moveNode,
  removeNode,
  removeSegment,
  splitSegment,
} from '../model/road';
import type { RoadNetworkDoc } from '../model/road';
import { roadNetworkFromStreets } from '../model/roadImport';
import { componentsFromSpecs } from '../library/templates';
import { createI75Project } from '../demo/cincinnati';
import type { CrossSection } from '../model/types';

/**
 * Roads as nodes and segments.
 *
 * The model a road-building game uses, and the one GeoStripe should have had from the
 * start. A node is a place you put; a segment is a road between two of them. Nothing is
 * detected and nothing is cut, so the tests that matter most here are the ones about what
 * does NOT happen: no road gets a hole in it, and no junction is built by subtraction.
 *
 * Cincinnati coordinates (39.11 N) as everywhere else — longitude degrees are 0.777 of
 * latitude degrees there, so anything treating them alike gets bearings wrong and every
 * junction comes out lopsided.
 */

const ORIGIN_LNG = -84.52;
const ORIGIN_LAT = 39.11;
const M_PER_LAT = 111132;
const M_PER_LNG = 111412 * Math.cos((ORIGIN_LAT * Math.PI) / 180);

function at(east: number, north: number): [number, number] {
  return [ORIGIN_LNG + east / M_PER_LNG, ORIGIN_LAT + north / M_PER_LAT];
}

let counter = 0;
function section(lanes = 4): CrossSection {
  counter += 1;
  return {
    id: `sec-${counter}`,
    name: 'Road',
    anchorOffsetMeters: null,
    components: componentsFromSpecs(
      Array.from({ length: lanes }, () => ['travelLane', 'forward'] as const),
    ),
  };
}

/** A crossroads: four roads meeting at one node. */
function crossroads(): { doc: RoadNetworkDoc; centre: string } {
  let doc = emptyRoadNetwork();
  const centre = addNode(doc, at(0, 0));
  doc = centre.doc;
  const arms = [at(100, 0), at(0, 100), at(-100, 0), at(0, -100)].map((position) => {
    const added = addNode(doc, position);
    doc = added.doc;
    return added.nodeId;
  });
  for (const arm of arms) {
    const added = addSegment(doc, {
      fromNodeId: centre.nodeId,
      toNodeId: arm,
      shape: [],
      section: section(),
    });
    doc = added.doc;
  }
  return { doc, centre: centre.nodeId };
}

// -------------------------------------------------------------------------- the model

describe('editing the network', () => {
  it('joins two nodes with a road', () => {
    let doc = emptyRoadNetwork();
    const a = addNode(doc, at(0, 0));
    doc = a.doc;
    const b = addNode(doc, at(100, 0));
    doc = b.doc;
    const added = addSegment(doc, {
      fromNodeId: a.nodeId,
      toNodeId: b.nodeId,
      shape: [],
      section: section(),
    });
    expect(added.doc.segments).toHaveLength(1);
    expect(added.doc.nodes).toHaveLength(2);
  });

  it('splits a road in two at a new node', () => {
    // The move the old model could not make. A ramp meeting a freeway does not cross it —
    // the freeway becomes two roads that share a node, and the ramp is a third road there.
    let doc = emptyRoadNetwork();
    const a = addNode(doc, at(-100, 0));
    doc = a.doc;
    const b = addNode(doc, at(100, 0));
    doc = b.doc;
    const road = addSegment(doc, {
      fromNodeId: a.nodeId,
      toNodeId: b.nodeId,
      shape: [],
      section: section(),
    });
    doc = road.doc;

    const split = splitSegment(doc, road.segmentId, at(0, 0), 0)!;
    expect(split).not.toBeNull();
    expect(split.doc.segments).toHaveLength(2);
    expect(split.doc.nodes).toHaveLength(3);
    // The two halves share exactly the new node, and still reach the original ends.
    const [first, second] = split.doc.segments;
    expect([first!.toNodeId, second!.fromNodeId]).toEqual([split.nodeId, split.nodeId]);
  });

  it('carries every road with the node it is attached to', () => {
    // The invariant the model rests on: a segment has no ends of its own. Moving a node
    // moves the roads, with nothing to keep in step by hand.
    const { doc, centre } = crossroads();
    const before = buildRoadGeometry(doc);
    const after = buildRoadGeometry(moveNode(doc, centre, at(30, 30)));

    const line = (g: typeof before) => g.segmentLines.get(doc.segments[0]!.id)!.line;
    expect(line(after)[0]).not.toEqual(line(before)[0]);
    expect(after.graphNodes.find((n) => n.id === centre)!.positionLngLat).toEqual(at(30, 30));
  });

  it('sweeps up a node nothing is attached to any more', () => {
    let doc = emptyRoadNetwork();
    const a = addNode(doc, at(0, 0));
    doc = a.doc;
    const b = addNode(doc, at(100, 0));
    doc = b.doc;
    const road = addSegment(doc, {
      fromNodeId: a.nodeId,
      toNodeId: b.nodeId,
      shape: [],
      section: section(),
    });
    const after = removeSegment(road.doc, road.segmentId);
    expect(after.segments).toHaveLength(0);
    expect(after.nodes).toHaveLength(0);
  });

  it('takes the roads with a deleted node', () => {
    const { doc, centre } = crossroads();
    const after = removeNode(doc, centre);
    expect(after.segments).toHaveLength(0);
    expect(after.nodes).toHaveLength(0);
  });

  it('joins two separate roads by merging their nodes', () => {
    // What the derived model could never do: two roads that run alongside each other and
    // never cross had no way to become connected. Here it is one edit.
    let doc = emptyRoadNetwork();
    const a = addNode(doc, at(0, 0));
    doc = a.doc;
    const b = addNode(doc, at(100, 0));
    doc = b.doc;
    const c = addNode(doc, at(101, 3));
    doc = c.doc;
    const d = addNode(doc, at(200, 3));
    doc = d.doc;
    doc = addSegment(doc, {
      fromNodeId: a.nodeId,
      toNodeId: b.nodeId,
      shape: [],
      section: section(),
    }).doc;
    doc = addSegment(doc, {
      fromNodeId: c.nodeId,
      toNodeId: d.nodeId,
      shape: [],
      section: section(),
    }).doc;

    const joined = mergeNodes(doc, b.nodeId, c.nodeId);
    expect(joined.nodes).toHaveLength(3);
    expect(joined.segments).toHaveLength(2);
    expect(joined.segments.every((s) => s.fromNodeId !== c.nodeId && s.toNodeId !== c.nodeId)).toBe(
      true,
    );

    // And the geometry now sees one place with two roads, not two places with one each.
    const geometry = buildRoadGeometry(joined);
    const shared = geometry.graphNodes.find((n) => n.id === b.nodeId)!;
    expect(shared.ends).toHaveLength(2);
  });

  it('drops a road whose two ends became the same node', () => {
    let doc = emptyRoadNetwork();
    const a = addNode(doc, at(0, 0));
    doc = a.doc;
    const b = addNode(doc, at(50, 0));
    doc = b.doc;
    doc = addSegment(doc, {
      fromNodeId: a.nodeId,
      toNodeId: b.nodeId,
      shape: [],
      section: section(),
    }).doc;
    expect(mergeNodes(doc, a.nodeId, b.nodeId).segments).toHaveLength(0);
  });
});

// ----------------------------------------------------------------------- the geometry

describe('a crossroads', () => {
  const { doc, centre } = crossroads();
  const geometry = buildRoadGeometry(doc);

  it('reads as a junction and owns the ground in the middle', () => {
    expect(geometry.envelopes.get(centre)!.form).toBe('junction');
    expect(geometry.nodeSurfaces).toHaveLength(1);
  });

  it('stops each road short of the middle', () => {
    for (const segment of doc.segments) {
      const line = geometry.segmentLines.get(segment.id)!;
      // Every road runs from the centre outward, so it is the from-end that retreats.
      expect(line.fromStation).toBeGreaterThan(1);
      expect(line.toStation).toBeCloseTo(line.lengthMeters, 6);
    }
  });

  it('draws bands for every road, none of them cut', () => {
    // The point of the whole exercise. A band is generated over the stretch that is
    // actually road, so there is no hole to punch and nothing to subtract.
    const streetIds = new Set(geometry.bands.map((band) => band.properties.streetId));
    expect(streetIds.size).toBe(4);
    for (const band of geometry.bands) {
      expect(band.geometry.type).toBe('Polygon');
    }
  });

  it('builds a junction surface that encloses the node', () => {
    const ring = geometry.nodeSurfaces[0]!.geometry.coordinates[0]!;
    const node = geometry.graphNodes.find((n) => n.id === centre)!;
    const [cx, cy] = node.positionLngLat;
    let crossings = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const a = ring[i]!;
      const b = ring[i + 1]!;
      if (a[1]! > cy !== b[1]! > cy) {
        const t = (cy - a[1]!) / (b[1]! - a[1]!);
        if (a[0]! + t * (b[0]! - a[0]!) > cx) crossings++;
      }
    }
    expect(crossings % 2).toBe(1);
  });
});

describe('a road that just runs between two ends', () => {
  it('is drawn its whole length', () => {
    let doc = emptyRoadNetwork();
    const a = addNode(doc, at(0, 0));
    doc = a.doc;
    const b = addNode(doc, at(200, 0));
    doc = b.doc;
    doc = addSegment(doc, {
      fromNodeId: a.nodeId,
      toNodeId: b.nodeId,
      shape: [],
      section: section(),
    }).doc;

    const geometry = buildRoadGeometry(doc);
    const line = geometry.segmentLines.get(doc.segments[0]!.id)!;
    expect(line.fromStation).toBe(0);
    expect(line.toStation).toBeCloseTo(line.lengthMeters, 6);
    expect(geometry.nodeSurfaces).toHaveLength(0);
  });
});

describe('a fork', () => {
  // A trunk arriving from the west, splitting into two roads that diverge by ten degrees.
  let doc = emptyRoadNetwork();
  const centre = addNode(doc, at(0, 0));
  doc = centre.doc;
  const west = addNode(doc, at(-300, 0));
  doc = west.doc;
  const upper = addNode(doc, at(299, 26));
  doc = upper.doc;
  const lower = addNode(doc, at(299, -26));
  doc = lower.doc;
  for (const [from, to] of [
    [west.nodeId, centre.nodeId],
    [centre.nodeId, upper.nodeId],
    [centre.nodeId, lower.nodeId],
  ]) {
    doc = addSegment(doc, {
      fromNodeId: from!,
      toNodeId: to!,
      shape: [],
      section: section(),
    }).doc;
  }
  const geometry = buildRoadGeometry(doc);

  it('is a merge, not a junction', () => {
    expect(geometry.envelopes.get(centre.nodeId)!.form).toBe('merge');
  });

  it('carves nothing and shortens nothing', () => {
    // The screenshot failure, stated as a test. A fork drawn as an intersection cuts every
    // road back to a shared rectangle and gouges a hole through the pavement.
    expect(geometry.nodeSurfaces).toHaveLength(0);
    for (const segment of doc.segments) {
      const line = geometry.segmentLines.get(segment.id)!;
      expect(line.fromStation).toBe(0);
      expect(line.toStation).toBeCloseTo(line.lengthMeters, 6);
    }
  });
});

describe('setting the form by hand', () => {
  it('leaves a crossroads alone when told it is a merge', () => {
    // Whether traffic yields or crosses is not in the geometry, so the override has to win —
    // and it has to change the retreats too, or the roads stop short of a junction that is
    // no longer being built.
    const { doc, centre } = crossroads();
    const forced = {
      ...doc,
      nodes: doc.nodes.map((node) =>
        node.id === centre ? { ...node, form: 'merge' as const } : node,
      ),
    };
    const geometry = buildRoadGeometry(forced);
    expect(geometry.nodeSurfaces).toHaveLength(0);
    for (const segment of forced.segments) {
      expect(geometry.segmentLines.get(segment.id)!.fromStation).toBe(0);
    }
  });

  it('builds a box at a fork when told it is a junction', () => {
    let doc = emptyRoadNetwork();
    const centre = addNode(doc, at(0, 0));
    doc = centre.doc;
    for (const position of [at(-300, 0), at(299, 26), at(299, -26)]) {
      const arm = addNode(doc, position);
      doc = addSegment(arm.doc, {
        fromNodeId: centre.nodeId,
        toNodeId: arm.nodeId,
        shape: [],
        section: section(),
      }).doc;
    }
    const forced = {
      ...doc,
      nodes: doc.nodes.map((node) =>
        node.id === centre.nodeId ? { ...node, form: 'junction' as const } : node,
      ),
    };
    expect(buildRoadGeometry(forced).nodeSurfaces).toHaveLength(1);
  });
});

describe('two junctions crowding each other', () => {
  it('keeps road visible between them', () => {
    // Both nodes want more room than there is. Neither is wrong, so both give way.
    let doc = emptyRoadNetwork();
    const left = addNode(doc, at(-9, 0));
    doc = left.doc;
    const right = addNode(doc, at(9, 0));
    doc = right.doc;
    doc = addSegment(doc, {
      fromNodeId: left.nodeId,
      toNodeId: right.nodeId,
      shape: [],
      section: section(8),
    }).doc;
    for (const [node, north] of [
      [left.nodeId, 80],
      [left.nodeId, -80],
      [right.nodeId, 80],
      [right.nodeId, -80],
    ] as const) {
      const arm = addNode(doc, at(node === left.nodeId ? -9 : 9, north));
      doc = addSegment(arm.doc, {
        fromNodeId: node,
        toNodeId: arm.nodeId,
        shape: [],
        section: section(8),
      }).doc;
    }

    const geometry = buildRoadGeometry(doc);
    const link = geometry.segmentLines.get(doc.segments[0]!.id)!;
    expect(link.toStation - link.fromStation).toBeGreaterThan(0);
  });
});

// --------------------------------------------------------------------------- the data

describe('importing the streets already drawn', () => {
  const project = createI75Project();
  const { doc, segmentsByStreet, nearMisses } = roadNetworkFromStreets(project.streets);
  const geometry = buildRoadGeometry(doc);

  it('turns every street into at least one road', () => {
    for (const street of project.streets) {
      expect(segmentsByStreet.get(street.id)?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('gives every road two nodes that exist', () => {
    const ids = new Set(doc.nodes.map((node) => node.id));
    for (const segment of doc.segments) {
      expect(ids.has(segment.fromNodeId)).toBe(true);
      expect(ids.has(segment.toNodeId)).toBe(true);
      expect(segment.fromNodeId).not.toBe(segment.toNodeId);
    }
  });

  it('leaves no node with nothing attached', () => {
    const used = new Set<string>();
    for (const segment of doc.segments) {
      used.add(segment.fromNodeId);
      used.add(segment.toNodeId);
    }
    for (const node of doc.nodes) expect(used.has(node.id)).toBe(true);
  });

  it('joins roads that genuinely cross', () => {
    const shared = geometry.graphNodes.filter((node) => node.ends.length >= 3);
    expect(shared.length).toBeGreaterThan(0);
  });

  it('puts every node on the roads that meet there', () => {
    // The failure this import exists to end. The old detector reported junctions at the
    // centroid of a scatter — up to 16.8 m from every street supposedly meeting there — and
    // the geometry then had to build a junction at a spot no road reached. A node must be
    // somewhere its roads actually are.
    for (const node of geometry.graphNodes) {
      for (const end of node.ends) {
        const line = geometry.segmentLines.get(end.segmentId)!;
        const at = end.sense === 1 ? line.line[0]! : line.line[line.line.length - 1]!;
        const dLat = (at[1] - node.positionLngLat[1]) * 111132;
        const dLng =
          (at[0] - node.positionLngLat[0]) * 111132 * Math.cos((at[1] * Math.PI) / 180);
        expect(Math.hypot(dLat, dLng), `${node.id} is off its own road`).toBeLessThan(0.5);
      }
    }
  });

  it('builds junctions only where roads really cross', () => {
    // Every junction here is a near-square crossing, because that is all this interchange
    // actually contains once the invented ones are gone. A junction whose arms lie within a
    // few degrees of each other would be a fan being boxed again.
    const junctions = geometry.graphNodes.filter(
      (node) => geometry.envelopes.get(node.id)!.form === 'junction',
    );
    expect(junctions.length).toBeGreaterThan(0);
    for (const junction of junctions) {
      const bearings = junction.ends.map((end) => (end.bearing * 180) / Math.PI);
      let widest = 0;
      for (let i = 0; i < bearings.length; i++) {
        for (let j = i + 1; j < bearings.length; j++) {
          const raw = Math.abs(bearings[i]! - bearings[j]!) % 360;
          const acute = raw > 180 ? 360 - raw : raw;
          widest = Math.max(widest, Math.min(acute, 180 - acute));
        }
      }
      expect(widest, `node ${junction.id} is a fan, not a crossing`).toBeGreaterThan(40);
    }
  });

  it('reports the ends that came close without joining', () => {
    // The 38 places the old model quietly turned into junctions. Reported instead, because
    // a road that stops seventeen metres short of another has not been joined to it, and
    // saying so is the difference between a design and a guess.
    expect(nearMisses.length).toBeGreaterThan(0);
    for (const miss of nearMisses) {
      expect(miss.gapMeters).toBeGreaterThan(3.5);
      expect(miss.between[0]).not.toBe(miss.between[1]);
    }
  });

  it('never eats a whole road', () => {
    for (const segment of doc.segments) {
      const line = geometry.segmentLines.get(segment.id);
      if (!line) continue;
      expect(line.toStation - line.fromStation, `${segment.id} vanished`).toBeGreaterThan(0);
    }
  });

  it('draws bands for every road', () => {
    const drawn = new Set(geometry.bands.map((band) => band.properties.streetId));
    for (const segment of doc.segments) expect(drawn.has(segment.id)).toBe(true);
  });
});
