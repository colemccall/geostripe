import { describe, expect, it } from 'vitest';
import { DECKS, deckOf, metresToPixels, paintDoc, pixelsPerMetre, projectCentre } from './paint';
import { addNode, addSegment, emptyDoc, setElevation } from '../model/doc';
import type { Doc } from '../model/doc';
import { assetMap, builtInAssets, defaultLineAssetId } from '../library/assets';
import type { Asset, LineAsset } from '../model/asset';
import { totalWidth } from '../model/section';

/**
 * The claims this whole rendering approach rests on.
 *
 * Widths are no longer computed into polygons — they are handed to MapLibre as an
 * expression and evaluated on the GPU. That buys back an order of magnitude, and it moves
 * the correctness question somewhere a test has to follow it: the expression itself. If a
 * 3.6 m lane does not measure 3.6 m at every zoom, the editor is lying about the one thing
 * it exists to be honest about, and it would do so invisibly.
 */

const LAT = 39.1; // Cincinnati, which is what the real project data is of.

/** Evaluate the interpolation the way MapLibre does, so the test checks the real curve. */
function evaluate(expr: unknown[], zoom: number, metres: number): number {
  // ['interpolate', ['exponential', 2], ['zoom'], z0, ['*', m, k0], z1, ['*', m, k1]]
  const z0 = expr[3] as number;
  const z1 = expr[5] as number;
  const k0 = (expr[4] as unknown[])[2] as number;
  const k1 = (expr[6] as unknown[])[2] as number;
  const base = 2;
  const t =
    (Math.pow(base, zoom - z0) - 1) / (Math.pow(base, z1 - z0) - 1);
  return metres * k0 + t * (metres * k1 - metres * k0);
}

describe('metre-exact widths', () => {
  it('puts a 3.6 m lane at the same ground width on every zoom', () => {
    const expr = metresToPixels(LAT, ['get', 'widthM'] as never) as unknown[];

    for (const zoom of [12, 14, 16, 18, 20, 22]) {
      const pixels = evaluate(expr, zoom, 3.6);
      const metres = pixels / pixelsPerMetre(LAT, zoom);
      expect(metres).toBeCloseTo(3.6, 6);
    }
  });

  it('holds at a high latitude, where cos(latitude) is doing real work', () => {
    const expr = metresToPixels(69, ['get', 'widthM'] as never) as unknown[];
    const pixels = evaluate(expr, 18, 3.6);
    expect(pixels / pixelsPerMetre(69, 18)).toBeCloseTo(3.6, 6);
  });

  it('scales exactly by two per zoom level, which is what Mercator does', () => {
    const expr = metresToPixels(LAT, ['get', 'widthM'] as never) as unknown[];
    const at18 = evaluate(expr, 18, 10);
    const at19 = evaluate(expr, 19, 10);
    expect(at19 / at18).toBeCloseTo(2, 9);
  });

  it('keeps zoom as the outermost input, which is the only form MapLibre accepts', () => {
    const expr = metresToPixels(LAT, ['get', 'widthM'] as never) as unknown[];
    expect(expr[0]).toBe('interpolate');
    expect(expr[2]).toEqual(['zoom']);
    // The feature property is multiplied INSIDE a stop, never outside the interpolation.
    expect((expr[4] as unknown[])[0]).toBe('*');
  });
});

// ---------------------------------------------------------------------------- fixture

function twoRoads(assetId?: string): { doc: Doc; assets: Map<string, Asset> } {
  const all = builtInAssets();
  const assets = assetMap(all);
  const line = assets.get(assetId ?? defaultLineAssetId(all)) as LineAsset;

  let doc = emptyDoc();
  const west = addNode(doc, [-84.52, 39.1]);
  doc = west.doc;
  const centre = addNode(doc, [-84.51, 39.1]);
  doc = centre.doc;
  const east = addNode(doc, [-84.5, 39.1]);
  doc = east.doc;
  const north = addNode(doc, [-84.51, 39.11]);
  doc = north.doc;

  doc = addSegment(doc, {
    assetId: line.id,
    fromNodeId: west.nodeId,
    toNodeId: centre.nodeId,
    shape: [],
  }).doc;
  doc = addSegment(doc, {
    assetId: line.id,
    fromNodeId: centre.nodeId,
    toNodeId: east.nodeId,
    shape: [],
  }).doc;
  doc = addSegment(doc, {
    assetId: line.id,
    fromNodeId: centre.nodeId,
    toNodeId: north.nodeId,
    shape: [],
  }).doc;

  return { doc, assets };
}

describe('painting a document', () => {
  it('emits one band feature per component per segment', () => {
    const { doc, assets } = twoRoads();
    const asset = assets.get(doc.segments[0]!.assetId) as LineAsset;
    const sources = paintDoc(doc, assets, { defaultRadiusMeters: 6 });

    expect(sources.bands.features).toHaveLength(asset.components.length * 3);
  });

  it('gives every band the same geometry as its segment, offset rather than moved', () => {
    const { doc, assets } = twoRoads();
    const sources = paintDoc(doc, assets, { defaultRadiusMeters: 6 });
    const first = sources.bands.features.filter(
      (f) => f.properties!.segmentId === doc.segments[0]!.id,
    );

    // Every band of one road shares one LineString. That identity is the whole saving: the
    // geometry is authored once and drawn many times, rather than offset once per band.
    for (const band of first) {
      expect(band.geometry).toBe(first[0]!.geometry);
    }
  });

  it('spans the section: band offsets cover the full width, no more and no less', () => {
    const { doc, assets } = twoRoads();
    const asset = assets.get(doc.segments[0]!.assetId) as LineAsset;
    const sources = paintDoc(doc, assets, { defaultRadiusMeters: 6 });
    const bands = sources.bands.features.filter(
      (f) => f.properties!.segmentId === doc.segments[0]!.id,
    );

    let left = Infinity;
    let right = -Infinity;
    for (const band of bands) {
      const offset = band.properties!.offsetM as number;
      const width = band.properties!.widthM as number;
      left = Math.min(left, offset - width / 2);
      right = Math.max(right, offset + width / 2);
    }

    expect(right - left).toBeCloseTo(totalWidth(asset.components), 9);
  });

  it('builds a junction plate where three roads meet, and none at a dead end', () => {
    const { doc, assets } = twoRoads();
    const sources = paintDoc(doc, assets, { defaultRadiusMeters: 6 });
    const nodeIds = new Set(sources.plates.features.map((f) => f.properties!.nodeId));

    // The centre node has three roads; the three outer nodes have one each.
    expect(nodeIds.size).toBe(1);
    expect(sources.plates.features.length).toBeGreaterThanOrEqual(1);
  });

  it('draws the footprint before the paved plate, which is what makes the corner footway', () => {
    const { doc, assets } = twoRoads();
    const sources = paintDoc(doc, assets, { defaultRadiusMeters: 6 });
    const kinds = sources.plates.features.map((f) => f.properties!.kind);

    expect(kinds[0]).toBe('footprint');
    expect(kinds).toContain('paved');
  });

  it('lays no asphalt where paths meet, because a greenway junction has none', () => {
    const { doc, assets } = twoRoads('builtin-path-greenway');
    const sources = paintDoc(doc, assets, { defaultRadiusMeters: 2 });
    const kinds = sources.plates.features.map((f) => f.properties!.kind);

    // A path has no carriageway at all, so the junction is footway all the way across.
    // The old model had to special-case this; here it falls out of there being no roadway
    // components to take a paved extent from.
    expect(kinds).toEqual(['footprint']);
  });

  it('never cuts a segment short — a road runs the full distance between its nodes', () => {
    const { doc, assets } = twoRoads();
    const sources = paintDoc(doc, assets, { defaultRadiusMeters: 6 });
    const nodes = new Map(doc.nodes.map((n) => [n.id, n.position]));
    const segment = doc.segments[0]!;
    const band = sources.bands.features.find((f) => f.properties!.segmentId === segment.id)!;
    const coords = band.geometry.coordinates;

    // The junction is drawn OVER the road end rather than subtracted from it, so the line
    // still reaches its node. Anything else means trimming crept back in.
    expect(coords[0]).toEqual(nodes.get(segment.fromNodeId));
    expect(coords[coords.length - 1]).toEqual(nodes.get(segment.toNodeId));
  });
});

describe('markings', () => {
  it('puts the double yellow on the centre line, between opposing directions', () => {
    const { doc, assets } = twoRoads();
    const sources = paintDoc(doc, assets, { defaultRadiusMeters: 6 });
    const yellow = sources.stripes.features.filter(
      (f) => f.properties!.style === 'centreDouble',
    );

    expect(yellow.length).toBeGreaterThan(0);
    // A double line is two stripes straddling the boundary, and on a symmetric street that
    // boundary is the drawn line itself.
    for (const stripe of yellow) {
      expect(Math.abs(stripe.properties!.offsetM as number)).toBeLessThan(0.5);
    }
  });

  it('runs stripes the full length, leaving the plate to cover the junction', () => {
    const { doc, assets } = twoRoads();
    const sources = paintDoc(doc, assets, { defaultRadiusMeters: 6 });
    const segment = doc.segments[0]!;
    const stripe = sources.stripes.features.find(
      (f) => f.properties!.segmentId === segment.id,
    )!;
    const nodes = new Map(doc.nodes.map((n) => [n.id, n.position]));

    expect(stripe.geometry.coordinates[0]).toEqual(nodes.get(segment.fromNodeId));
  });

  it('repeats a pavement symbol along the lane that calls for one', () => {
    const { doc, assets } = twoRoads('builtin-bike-raised-track');
    const sources = paintDoc(doc, assets, { defaultRadiusMeters: 6 });

    expect(sources.stamps.features.length).toBeGreaterThan(0);
    for (const stamp of sources.stamps.features) {
      expect(typeof stamp.properties!.glyph).toBe('string');
      expect(Number.isFinite(stamp.properties!.bearing)).toBe(true);
    }
  });

  it('paints no symbol on an ordinary travel lane', () => {
    const { doc, assets } = twoRoads();
    const sources = paintDoc(doc, assets, { defaultRadiusMeters: 6 });

    // A bare lane has nothing painted in it. The symbol library is opt-in per component
    // type, and a road covered in arrows nobody asked for is worse than a plain one.
    expect(sources.stamps.features).toHaveLength(0);
  });

  it('offsets symbols into their own lane, not onto the centerline', () => {
    const { doc, assets } = twoRoads('builtin-bike-raised-track');
    const sources = paintDoc(doc, assets, { defaultRadiusMeters: 6 });
    const segment = doc.segments.find((s) => s.id === doc.segments[0]!.id)!;
    const nodes = new Map(doc.nodes.map((n) => [n.id, n.position]));
    const from = nodes.get(segment.fromNodeId)!;

    // The road runs due east, so a symbol in a kerbside cycle track sits off that latitude.
    const strayed = sources.stamps.features.some(
      (f) => Math.abs((f.geometry.coordinates[1] as number) - from[1]) > 1e-6,
    );
    expect(strayed).toBe(true);
  });
});

describe('grade separation', () => {
  it('raises every road that meets a junction when the junction is raised', () => {
    const { doc, assets } = twoRoads();
    const centre = doc.segments[0]!.toNodeId;
    const raised = setElevation(doc, centre, 1);
    const sources = paintDoc(raised, assets, { defaultRadiusMeters: 6 });

    // Height is a property of the place, so lifting it lifts everything that meets there.
    // Nothing can be left behind on the ground, because no road carries a height of its own.
    const decks = new Set(
      sources.bands.features
        .filter((f) => f.properties!.segmentId !== undefined)
        .map((f) => f.properties!.deck),
    );
    expect(decks.has(1)).toBe(true);
  });

  it('still builds the junction, because everything there is at one height', () => {
    const { doc, assets } = twoRoads();
    const centre = doc.segments[0]!.toNodeId;
    const raised = setElevation(doc, centre, 1);
    const sources = paintDoc(raised, assets, { defaultRadiusMeters: 6 });

    // The old model needed a rule suppressing junctions between roads at different levels,
    // because it could express that contradiction. This one cannot, so the rule is gone and
    // the junction survives being lifted.
    expect(sources.plates.features.length).toBeGreaterThan(0);
    expect(sources.plates.features.every((f) => f.properties!.deck === 1)).toBe(true);
  });

  it('builds no junction where every road is heading the same way', () => {
    // Two roads meeting end to end are a joint, not a junction. A ramp joining a mainline
    // at a shallow angle is a merge, and a plate there is a lozenge across the carriageway.
    const { doc, assets } = twoRoads();
    const straight: Doc = {
      ...doc,
      // Drop the north leg, leaving the east-west road running through its middle node.
      segments: doc.segments.slice(0, 2),
    };

    const sources = paintDoc(straight, assets, { defaultRadiusMeters: 6 });
    expect(sources.plates.features).toHaveLength(0);
  });
});

describe('decks', () => {
  it('files every level onto one of three decks', () => {
    expect(deckOf(undefined)).toBe(0);
    expect(deckOf(0)).toBe(0);
    expect(deckOf(-1)).toBe(-1);
    expect(deckOf(-3)).toBe(-1);
    expect(deckOf(1)).toBe(1);
    expect(deckOf(4)).toBe(1);
    for (const deck of DECKS) expect(deckOf(deck)).toBe(deck);
  });

  it('orders bands by deck, so a tunnel is drawn under the ground above it', () => {
    const { doc, assets } = twoRoads();
    let raised: Doc = doc;
    raised = setElevation(raised, doc.segments[0]!.fromNodeId, 1);
    raised = setElevation(raised, doc.segments[2]!.toNodeId, -1);
    const sources = paintDoc(raised, assets, { defaultRadiusMeters: 6 });
    const decks = sources.bands.features.map((f) => f.properties!.deck as number);

    expect(decks).toEqual([...decks].sort((a, b) => a - b));
  });
});

describe('project centre', () => {
  it('sits inside the project, which is what the metre scale is built from', () => {
    const { doc } = twoRoads();
    const [lng, lat] = projectCentre(doc);
    expect(lng).toBeGreaterThan(-84.53);
    expect(lng).toBeLessThan(-84.49);
    expect(lat).toBeGreaterThan(39.09);
    expect(lat).toBeLessThan(39.12);
  });
});
