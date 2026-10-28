import { describe, expect, it } from 'vitest';
import { addRamp } from './interchange';
import type { RampResult } from './interchange';
import { layRoad } from './build';
import { addNode, addSegment, emptyDoc, endsAt, nodeMap, setElevation, splitPointFor, splitSegment } from './doc';
import type { Doc } from './doc';
import { roadIssues } from './validity';
import { paintDoc } from '../map/paint';
import { assetMap, builtInAssets } from '../library/assets';
import { isLineAsset } from './asset';
import type { Asset, LineAsset } from './asset';
import { localPlane } from '../geo/crs';
import type { LngLat } from '../geo/crs';

/**
 * A diamond interchange, built the way a person would build it, then painted.
 *
 * A freeway runs east-west. An arterial crosses it north-south on a bridge. Each of the four
 * ramps is made with the ramp tool and then joined to the arterial's ground-level approach
 * with the ordinary road tool. What is checked is that the pieces work together: the graph
 * is connected where it should be, the junctions where ramps meet the arterial exist, and
 * the whole thing paints without a hitch.
 */

const palette = builtInAssets();
const freeway = palette.find((a) => a.name.includes('Freeway, 4 lanes, open median')) as LineAsset;
const arterial = palette.find((a) => isLineAsset(a) && a.family === 'arterial') as LineAsset;
const plane = localPlane([-84.52, 39.1]);
const at = (x: number, y: number): LngLat => plane.toLngLat({ x, y });

function build(): { doc: Doc; assets: Asset[]; ramps: RampResult[]; terminals: string[] } {
  let doc = emptyDoc();
  let assets: Asset[] = palette;

  const node = (x: number, y: number, elevation = 0) => {
    const added = addNode(doc, at(x, y));
    doc = added.doc;
    if (elevation) doc = setElevation(doc, added.nodeId, elevation);
    return added.nodeId;
  };
  const road = (assetId: string, a: string, b: string) => {
    const built = addSegment(doc, { assetId, fromNodeId: a, toNodeId: b, shape: [] });
    doc = built.doc;
    return built.segmentId;
  };

  // The freeway.
  const f0 = node(-900, 0);
  const f1 = node(900, 0);
  const freewayId = road(freeway.id, f0, f1);

  // The arterial, rising onto a bridge over the freeway and coming down again.
  const p = [node(0, -400), node(0, -90), node(0, -50, 1), node(0, 50, 1), node(0, 90), node(0, 400)];
  for (let i = 0; i < p.length - 1; i++) road(arterial.id, p[i]!, p[i + 1]!);

  const ramps: RampResult[] = [];
  const terminals: string[] = [];

  /** Join a ramp's free end to the arterial at the given height up the road. */
  const join = (ramp: RampResult, arterialY: number) => {
    const segment = doc.segments.find((s) => {
      const a = plane.toPlane(nodeMap(doc).get(s.fromNodeId)!.position);
      const b = plane.toPlane(nodeMap(doc).get(s.toNodeId)!.position);
      return (
        Math.abs(a.x) < 1 &&
        Math.abs(b.x) < 1 &&
        Math.min(a.y, b.y) <= arterialY &&
        Math.max(a.y, b.y) >= arterialY &&
        nodeMap(doc).get(s.fromNodeId)!.elevation !== 1 &&
        nodeMap(doc).get(s.toNodeId)!.elevation !== 1
      );
    })!;
    const position = at(0, arterialY);
    const split = splitSegment(
      doc,
      segment.id,
      position,
      splitPointFor(segment, nodeMap(doc), position)!.shapeIndex,
    )!;
    doc = split.doc;
    terminals.push(split.nodeId);
    const free = ramp.freeNodeId;
    // An exit ends at its free end, so its connector runs from there to the arterial; an
    // entrance starts at its free end, so its connector runs the other way.
    const isExit = doc.segments.find((s) => s.id === ramp.rampSegmentId)!.toNodeId === free;
    const [fromId, toId] = isExit ? [free, split.nodeId] : [split.nodeId, free];
    const laid = layRoad(doc, {
      assetId: arterial.id,
      fromNodeId: fromId,
      toNodeId: toId,
      handles: [],
      curved: false,
      elevation: 0,
    });
    doc = laid.doc;
  };

  const place = (x: number, kind: 'exit' | 'entrance', side: 'right' | 'left') => {
    const main = doc.segments.find((s) => {
      const a = plane.toPlane(nodeMap(doc).get(s.fromNodeId)!.position);
      const b = plane.toPlane(nodeMap(doc).get(s.toNodeId)!.position);
      return Math.abs(a.y) < 1 && Math.abs(b.y) < 1 && Math.min(a.x, b.x) <= x && Math.max(a.x, b.x) >= x;
    })!;
    const result = addRamp(doc, assets, main.id, at(x, 0), { kind, side });
    if ('error' in result) throw new Error(result.error);
    doc = result.doc;
    assets = result.assets;
    ramps.push(result);
    return result;
  };

  // Lane runs and tapers must not overlap, so the four ramps are spread along the freeway.
  // Eastbound traffic keeps to the south (right of the drawn line): an exit well before the
  // arterial, an entrance just after it. Westbound traffic is on the north (left of the line):
  // an entrance before the arterial in its direction of travel, an exit after it.
  join(place(-620, 'exit', 'right'), -300);
  join(place(-300, 'entrance', 'left'), 180);
  join(place(300, 'entrance', 'right'), -200);
  join(place(620, 'exit', 'left'), 300);

  void freewayId;
  return { doc, assets, ramps, terminals };
}

describe('a diamond interchange', () => {
  const { doc, assets, ramps, terminals } = build();

  it('has the four ramps, each with its own taper, gore and lane line', () => {
    expect(ramps).toHaveLength(4);
    for (const ramp of ramps) {
      const own = doc.patches.filter((p) => p.ownerId === ramp.rampSegmentId);
      expect(own.map((p) => p.kind).sort()).toEqual(['gore', 'paint', 'taper']);
    }
  });

  it('keeps the freeway in three-piece runs around each ramp, still one connected road', () => {
    const freewayPieces = doc.segments.filter((s) => (assetMap(assets).get(s.assetId) as LineAsset).name.startsWith('Freeway'));
    // 1 original + 2 per ramp.
    expect(freewayPieces).toHaveLength(1 + 2 * 4);
    const nodes = nodeMap(doc);
    // Walking from the west end along the freeway reaches the east end through every piece.
    let at = freewayPieces.find((s) => nodes.get(s.fromNodeId)!.position[0] === Math.min(...freewayPieces.map((p) => nodes.get(p.fromNodeId)!.position[0])))!;
    let steps = 1;
    while (true) {
      const following = freewayPieces.find((s) => s.fromNodeId === at.toNodeId);
      if (!following) break;
      at = following;
      steps++;
    }
    expect(steps).toBe(freewayPieces.length);
  });

  it('meets the arterial at ground level at each ramp terminal, as a real junction', () => {
    expect(terminals).toHaveLength(4);
    for (const id of terminals) {
      // Two halves of the arterial plus the ramp connector.
      expect(endsAt(id, doc.segments)).toHaveLength(3);
    }
  });

  it('leaves the bridge alone: nothing joins the arterial at its raised deck', () => {
    const raised = doc.nodes.filter((n) => n.elevation === 1);
    expect(raised).toHaveLength(2);
    for (const n of raised) expect(endsAt(n.id, doc.segments)).toHaveLength(2);
  });

  it('obeys the road rules everywhere: no sliver angles, no stubs', () => {
    const nodes = nodeMap(doc);
    for (const s of doc.segments) {
      const issues = roadIssues(
        doc,
        { position: nodes.get(s.fromNodeId)!.position },
        { position: nodes.get(s.toNodeId)!.position },
      );
      expect(issues.filter((i) => i === 'tooShort')).toEqual([]);
    }
  });

  it('paints without error, with junction plates at the terminals and the patches on top', () => {
    const painted = paintDoc(doc, assetMap(assets), { defaultRadiusMeters: 6 });
    const plateNodes = new Set(painted.plates.features.map((f) => f.properties!.nodeId).filter(Boolean));
    for (const id of terminals) expect(plateNodes.has(id)).toBe(true);

    const kinds = painted.plates.features.map((f) => f.properties!.kind as string);
    expect(kinds.filter((k) => k === 'taper')).toHaveLength(4);
    expect(kinds.filter((k) => k === 'gore')).toHaveLength(4);

    // Within a deck, junction ground is drawn before tapers, before gore, before paint.
    const order = ['footprint', 'paved', 'taper', 'gore', 'paint'];
    const ground = painted.plates.features.filter((f) => f.properties!.deck === 0).map((f) => order.indexOf(f.properties!.kind as string));
    expect(ground).toEqual([...ground].sort((a, b) => a - b));
  });

  it('does not offer to join a ramp nose to the mainline as if it were a loose end', () => {
    const painted = paintDoc(doc, assetMap(assets), { defaultRadiusMeters: 6 });
    const noses = doc.nodes.filter((n) => n.role === 'rampNose').map((n) => n.id);
    expect(noses).toHaveLength(4);
    for (const f of painted.handles.features) {
      if (noses.includes(f.properties!.nodeId as string)) expect(f.properties!.loose).toBe(0);
    }
  });
});
