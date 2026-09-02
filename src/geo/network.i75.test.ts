import { describe, expect, it } from 'vitest';
import { buildNetwork, envelopesFor, nodeEnvelope } from './network';
import { detectJunctions } from './junctions';
import { createI75Project } from '../demo/cincinnati';

/**
 * The network, against the interchange that broke the old one.
 *
 * The screenshot that started this: several freeway carriageways converging, drawn with
 * seams through them and a black wedge where the pavement should be. The cause was five
 * roads meeting tangentially being read as one five-legged intersection and cut back to a
 * shared rectangle.
 *
 * These are not unit tests of the arithmetic — network.test.ts does that with hand-built
 * ends. These check the arithmetic survives contact with real traced geometry, where
 * bearings are never round numbers and roads never quite end where you think.
 */

const project = createI75Project();
const { junctions, plane } = detectJunctions(project.streets);
const network = buildNetwork(project.streets, junctions, plane);
const envelopes = envelopesFor(network);

describe('the I-75 interchange as a graph', () => {
  it('splits every street into segments that tile it', () => {
    for (const [streetId, ids] of network.segmentsByStreet) {
      expect(ids.length, `${streetId} has no segments`).toBeGreaterThan(0);
      const spans = ids.map((id) => network.segmentById.get(id)!);
      for (let i = 1; i < spans.length; i++) {
        expect(spans[i]!.fromStation).toBeCloseTo(spans[i - 1]!.toStation, 6);
      }
    }
  });

  it('gives every segment two distinct existing nodes', () => {
    for (const segment of network.segments) {
      expect(network.nodeById.has(segment.fromNodeId)).toBe(true);
      expect(network.nodeById.has(segment.toNodeId)).toBe(true);
      expect(segment.fromNodeId).not.toBe(segment.toNodeId);
      expect(segment.lengthMeters).toBeGreaterThan(0);
    }
  });

  it('accounts for every end on both sides', () => {
    // Every end a node holds must belong to a segment that names that node, and every
    // segment must be held by both its nodes. A graph that fails this is not a graph.
    let ends = 0;
    for (const node of network.nodes) {
      for (const end of node.ends) {
        const segment = network.segmentById.get(end.segmentId)!;
        expect([segment.fromNodeId, segment.toNodeId]).toContain(node.id);
        ends += 1;
      }
    }
    expect(ends).toBe(network.segments.length * 2);
  });

  it('reads the ramp fan as a merge rather than boxing it', () => {
    // The specific failure in the screenshot. Any node where four or more roads converge
    // along one corridor must own no ground — the pavement there belongs to the roads.
    const fans = network.nodes.filter(
      (node) => node.ends.length >= 4 && new Set(node.ends.map((e) => e.streetId)).size >= 4,
    );
    expect(fans.length).toBeGreaterThan(0);
    for (const fan of fans) {
      const envelope = nodeEnvelope(fan);
      expect(envelope.form, `node ${fan.id} was boxed`).toBe('merge');
      expect(envelope.surface).toEqual([]);
    }
  });

  it('never retreats a road further than the road is long', () => {
    // The runaway case: a shallow pair whose corner sits hundreds of metres away would eat
    // a whole segment and leave a gap in the pavement. The cap exists to stop exactly this.
    for (const segment of network.segments) {
      const from = network.nodeById.get(segment.fromNodeId)!;
      const to = network.nodeById.get(segment.toNodeId)!;
      const retreatOf = (node: typeof from) => {
        const index = node.ends.findIndex((e) => e.segmentId === segment.id);
        return index < 0 ? 0 : (envelopes.get(node.id)!.retreats[index] ?? 0);
      };
      expect(retreatOf(from) + retreatOf(to)).toBeLessThan(segment.lengthMeters);
    }
  });

  it('builds a simple ring for every junction that owns ground', () => {
    for (const node of network.nodes) {
      const envelope = envelopes.get(node.id)!;
      if (envelope.form !== 'junction') continue;
      expect(envelope.surface.length).toBeGreaterThanOrEqual(6);
      let area = 0;
      const ring = envelope.surface;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]!;
        const b = ring[(i + 1) % ring.length]!;
        area += a.x * b.y - b.x * a.y;
      }
      expect(Math.abs(area / 2), `node ${node.id} has no area`).toBeGreaterThan(1);
    }
  });
});
