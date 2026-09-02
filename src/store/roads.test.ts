import { beforeEach, describe, expect, it } from 'vitest';
import { useEditorStore } from './useEditorStore';
import { emptyRoadNetwork } from '../model/road';
import { buildRoadGeometry } from '../geo/roadGeometry';

/**
 * Building roads, as the editor actually does it.
 *
 * The geometry is proven elsewhere; what is under test here is the gesture. Click-to-draw
 * has to behave the same whether the click lands on empty ground, on a node that is already
 * there, or partway along a road — and getting that wrong is not a visible bug, it is a
 * network that looks joined and is not.
 */

const ORIGIN_LNG = -84.52;
const ORIGIN_LAT = 39.11;
const M_PER_LAT = 111132;
const M_PER_LNG = 111412 * Math.cos((ORIGIN_LAT * Math.PI) / 180);

function at(east: number, north: number): [number, number] {
  return [ORIGIN_LNG + east / M_PER_LNG, ORIGIN_LAT + north / M_PER_LAT];
}

const store = () => useEditorStore.getState();

beforeEach(() => {
  useEditorStore.setState({
    roads: emptyRoadNetwork(),
    roadDraftFrom: null,
    selectedRoadNodeId: null,
    selectedSegmentId: null,
    past: [],
    future: [],
  });
});

describe('drawing a road', () => {
  it('takes two clicks: the first starts, the second finishes', () => {
    store().drawRoadTo(at(0, 0));
    expect(store().roads.segments).toHaveLength(0);
    expect(store().roadDraftFrom).not.toBeNull();

    store().drawRoadTo(at(100, 0));
    expect(store().roads.segments).toHaveLength(1);
    expect(store().roads.nodes).toHaveLength(2);
  });

  it('carries on from where the last road ended', () => {
    // A chain of roads is a chain of clicks, not a chain of pairs of clicks.
    store().drawRoadTo(at(0, 0));
    store().drawRoadTo(at(100, 0));
    store().drawRoadTo(at(100, 100));
    expect(store().roads.segments).toHaveLength(2);
    expect(store().roads.nodes).toHaveLength(3);

    // And the two roads share the node between them, rather than each having its own.
    const [first, second] = store().roads.segments;
    expect(first!.toNodeId).toBe(second!.fromNodeId);
  });

  it('stops when you click the node you are standing on', () => {
    store().drawRoadTo(at(0, 0));
    const nodeId = store().roadDraftFrom!;
    store().drawRoadTo(at(0, 0), { kind: 'node', nodeId });
    expect(store().roads.segments).toHaveLength(0);
    expect(store().roadDraftFrom).toBeNull();
  });

  it('joins to a node that is already there instead of stacking one on top', () => {
    store().drawRoadTo(at(0, 0));
    store().drawRoadTo(at(100, 0));
    const target = store().roads.nodes[0]!.id;
    store().cancelRoadDraft();

    store().drawRoadTo(at(0, 60));
    store().drawRoadTo(at(0, 0), { kind: 'node', nodeId: target });

    expect(store().roads.segments).toHaveLength(2);
    // Three nodes, not four: the second road ended AT the first road's start.
    expect(store().roads.nodes).toHaveLength(3);
    const geometry = buildRoadGeometry(store().roads);
    expect(geometry.graphNodes.find((node) => node.id === target)!.ends).toHaveLength(2);
  });

  it('splits a road when the click lands partway along it', () => {
    // The move the old model could not make. A ramp meeting a freeway does not cross it:
    // the freeway becomes two roads that share a node, and the ramp is a third road there.
    store().drawRoadTo(at(-100, 0));
    store().drawRoadTo(at(100, 0));
    const road = store().roads.segments[0]!.id;
    store().cancelRoadDraft();

    store().drawRoadTo(at(0, 80));
    store().drawRoadTo(at(0, 0), { kind: 'segment', segmentId: road, shapeIndex: 0 });

    // Two halves of the original, plus the road that arrived.
    expect(store().roads.segments).toHaveLength(3);
    const geometry = buildRoadGeometry(store().roads);
    const junction = geometry.graphNodes.find((node) => node.ends.length === 3);
    expect(junction, 'the arriving road did not join the one it landed on').toBeDefined();
    expect(geometry.envelopes.get(junction!.id)!.form).toBe('junction');
  });

  it('cancelling leaves the roads already placed alone', () => {
    store().drawRoadTo(at(0, 0));
    store().drawRoadTo(at(100, 0));
    store().cancelRoadDraft();
    expect(store().roads.segments).toHaveLength(1);
    expect(store().roadDraftFrom).toBeNull();
  });
});

describe('editing the network', () => {
  const twoRoads = () => {
    store().drawRoadTo(at(0, 0));
    store().drawRoadTo(at(100, 0));
    store().cancelRoadDraft();
    store().drawRoadTo(at(105, 4));
    store().drawRoadTo(at(200, 4));
    store().cancelRoadDraft();
  };

  it('joins two ends that were never connected', () => {
    // The complaint the whole model exists to answer: roads that run alongside each other
    // never crossed, so nothing could ever join them.
    twoRoads();
    expect(store().roads.nodes).toHaveLength(4);

    const nodes = store().roads.nodes;
    store().joinRoadNodes(nodes[1]!.id, nodes[2]!.id);

    expect(store().roads.nodes).toHaveLength(3);
    expect(store().roads.segments).toHaveLength(2);
    const geometry = buildRoadGeometry(store().roads);
    expect(geometry.graphNodes.find((n) => n.id === nodes[1]!.id)!.ends).toHaveLength(2);
  });

  it('takes the roads with a deleted node, and sweeps up what is stranded', () => {
    twoRoads();
    store().deleteRoadNode(store().roads.nodes[0]!.id);
    expect(store().roads.segments).toHaveLength(1);
    expect(store().roads.nodes).toHaveLength(2);
  });

  it('sets and clears a node form by hand', () => {
    twoRoads();
    const nodeId = store().roads.nodes[0]!.id;
    store().setRoadNodeForm(nodeId, 'merge');
    expect(store().roads.nodes.find((n) => n.id === nodeId)!.form).toBe('merge');
    store().setRoadNodeForm(nodeId, undefined);
    expect(store().roads.nodes.find((n) => n.id === nodeId)!.form).toBeUndefined();
  });
});

describe('undo', () => {
  it('takes back one road per press, not one node', () => {
    // Drawing a road places a node and a segment. If those were two history entries, undo
    // would leave a node behind with nothing attached and the network would look broken.
    store().drawRoadTo(at(0, 0));
    store().drawRoadTo(at(100, 0));
    expect(store().roads.segments).toHaveLength(1);

    store().undo();
    expect(store().roads.segments).toHaveLength(0);
  });

  it('restores a joined pair when the join is undone', () => {
    store().drawRoadTo(at(0, 0));
    store().drawRoadTo(at(100, 0));
    store().cancelRoadDraft();
    store().drawRoadTo(at(105, 4));
    store().drawRoadTo(at(200, 4));
    store().cancelRoadDraft();

    const nodes = store().roads.nodes;
    store().joinRoadNodes(nodes[1]!.id, nodes[2]!.id);
    expect(store().roads.nodes).toHaveLength(3);

    store().undo();
    expect(store().roads.nodes).toHaveLength(4);
  });
});

describe('the network the editor opens with', () => {
  it('is the imported I-75 interchange, not an empty document', () => {
    // Reset wipes it for the tests above; a fresh store has the real thing.
    useEditorStore.setState({ roads: emptyRoadNetwork() });
    store().reimportRoads();
    expect(store().roads.segments.length).toBeGreaterThan(0);
    expect(store().roads.nodes.length).toBeGreaterThan(0);
    expect(store().roadNearMisses.length).toBeGreaterThan(0);
  });
});
