import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseProject, serializeProject, toProjectGeoJSON } from './io';
import { addNode, addSegment, emptyDoc } from './doc';
import type { Doc } from './doc';
import { builtInAssets, defaultLineAssetId } from '../library/assets';
import type { LineAsset } from './asset';

/**
 * The file is the only thing that outlives the session, so what survives a round trip is
 * the real definition of what the editor can express. These tests are about that boundary
 * rather than about JSON.
 */

function project(): { doc: Doc; assets: ReturnType<typeof builtInAssets> } {
  const assets = builtInAssets();
  const assetId = defaultLineAssetId(assets);

  let doc = emptyDoc();
  const a = addNode(doc, [-84.52, 39.1]);
  doc = a.doc;
  const b = addNode(doc, [-84.51, 39.1]);
  doc = b.doc;
  const c = addNode(doc, [-84.51, 39.11]);
  doc = c.doc;

  doc = addSegment(doc, {
    assetId,
    fromNodeId: a.nodeId,
    toNodeId: b.nodeId,
    shape: [[-84.515, 39.1005]],
    curve: { mode: 'smooth', radiusMeters: 12 },
  }).doc;
  doc = addSegment(doc, {
    assetId,
    fromNodeId: b.nodeId,
    toNodeId: c.nodeId,
    shape: [],
    level: 1,
  }).doc;

  return { doc, assets };
}

describe('round trip', () => {
  it('brings back the graph exactly — nodes, roads, and which meets which', () => {
    const { doc, assets } = project();
    const text = serializeProject(doc, assets, { name: 'Test' });
    const back = parseProject(text, builtInAssets());

    expect(back.warnings).toEqual([]);
    expect(back.name).toBe('Test');
    expect(back.doc.nodes).toEqual(doc.nodes);
    expect(back.doc.segments).toEqual(doc.segments);
  });

  it('keeps a curve curved, rather than reopening it as its own tessellation', () => {
    const { doc, assets } = project();
    const back = parseProject(serializeProject(doc, assets, { name: 'Test' }), builtInAssets());
    const curved = back.doc.segments.find((s) => s.curve);

    expect(curved?.curve?.mode).toBe('smooth');
    // One shape point in, one shape point out. A tessellated curve would come back with
    // dozens and could never be re-curved.
    expect(curved?.shape).toHaveLength(1);
  });

  it('keeps a segment at its level, which is how bridges survive a save', () => {
    const { doc, assets } = project();
    const back = parseProject(serializeProject(doc, assets, { name: 'Test' }), builtInAssets());
    expect(back.doc.segments.some((s) => s.level === 1)).toBe(true);
  });

  it('carries the palette, so the roads still know what they are made of', () => {
    const { doc, assets } = project();
    const custom = assets.map((a) =>
      a.id === defaultLineAssetId(assets) && a.kind === 'line'
        ? ({ ...a, name: 'My street', components: a.components.slice(0, 2) } as LineAsset)
        : a,
    );

    const back = parseProject(serializeProject(doc, custom, { name: 'Test' }), builtInAssets());
    const asset = back.assets.find((a) => a.id === doc.segments[0]!.assetId) as LineAsset;

    expect(asset.name).toBe('My street');
    expect(asset.components).toHaveLength(2);
  });

  it('writes band polygons for QGIS but never reads them back', () => {
    const { doc, assets } = project();
    const collection = toProjectGeoJSON(doc, assets, { name: 'Test' });
    const bands = collection.features.filter((f) => f.properties?.streetcity === 'band');

    expect(bands.length).toBeGreaterThan(0);
    for (const band of bands) expect(band.geometry.type).toMatch(/Polygon/);

    // Reading is by feature kind, so the bands are inert on the way back in.
    const back = parseProject(JSON.stringify(collection), builtInAssets());
    expect(back.doc.segments).toHaveLength(doc.segments.length);
  });

  it('can leave the bands out, for a file meant only to be reopened here', () => {
    const { doc, assets } = project();
    const lean = toProjectGeoJSON(doc, assets, { name: 'Test', includeBands: false });
    expect(lean.features.some((f) => f.properties?.streetcity === 'band')).toBe(false);
  });

  it('is still valid GeoJSON — the palette rides in a foreign member', () => {
    const { doc, assets } = project();
    const collection = toProjectGeoJSON(doc, assets, { name: 'Test' }) as unknown as Record<string, unknown>;

    expect(collection.type).toBe('FeatureCollection');
    expect(Array.isArray(collection.features)).toBe(true);
    expect(collection.streetcity).toBeTruthy();
  });
});

describe('reading files that are not ours', () => {
  it('reports bad JSON rather than throwing', () => {
    const back = parseProject('{not json', builtInAssets());
    expect(back.warnings[0]).toMatch(/valid JSON/);
    expect(back.doc.segments).toEqual([]);
  });

  it('reports a file that is not a FeatureCollection', () => {
    const back = parseProject('{"type":"Feature"}', builtInAssets());
    expect(back.warnings[0]).toMatch(/FeatureCollection/);
  });
});

describe('converting a project from the street model', () => {
  const source = readFileSync('cinci.geojson', 'utf8');

  it('turns every street into a road between two nodes', () => {
    const back = parseProject(source, builtInAssets());

    expect(back.converted).toBe(true);
    expect(back.doc.segments.length).toBeGreaterThan(0);
    for (const segment of back.doc.segments) {
      expect(segment.fromNodeId).toBeTruthy();
      expect(segment.toNodeId).toBeTruthy();
      expect(segment.fromNodeId).not.toBe(segment.toNodeId);
    }
  });

  it('leaves no road pointing at a node that is not there', () => {
    const back = parseProject(source, builtInAssets());
    const ids = new Set(back.doc.nodes.map((n) => n.id));
    for (const segment of back.doc.segments) {
      expect(ids.has(segment.fromNodeId)).toBe(true);
      expect(ids.has(segment.toNodeId)).toBe(true);
    }
  });

  it('gives every road an asset that exists in the palette', () => {
    const back = parseProject(source, builtInAssets());
    const ids = new Set(back.assets.map((a) => a.id));
    for (const segment of back.doc.segments) {
      expect(ids.has(segment.assetId)).toBe(true);
    }
  });

  it('makes one asset per distinct cross-section, not one per street', () => {
    const back = parseProject(source, builtInAssets());
    const imported = back.assets.filter((a) => a.id.startsWith('imported-'));

    // The point of the conversion: streets that were the same street get the same type,
    // which the old model had no way to say.
    expect(imported.length).toBeGreaterThan(0);
    expect(imported.length).toBeLessThanOrEqual(back.doc.segments.length);
  });

  it('discards the old model’s derived bands', () => {
    const back = parseProject(source, builtInAssets());
    const original = JSON.parse(source) as { features: { properties?: { geostripe?: string } }[] };
    const bands = original.features.filter((f) => f.properties?.geostripe === 'band');

    expect(bands.length).toBeGreaterThan(0);
    expect(back.doc.segments.length).toBeLessThan(bands.length);
  });

  it('splits streets where they genuinely cross, and shares the node', () => {
    const back = parseProject(source, builtInAssets());
    const degree = new Map<string, number>();
    for (const segment of back.doc.segments) {
      degree.set(segment.fromNodeId, (degree.get(segment.fromNodeId) ?? 0) + 1);
      degree.set(segment.toNodeId, (degree.get(segment.toNodeId) ?? 0) + 1);
    }

    // A crossing is the one thing the conversion is allowed to infer, because the point is
    // computed and lies exactly on both lines. Ten long streets come in as a network rather
    // than as ten roads that merely overlap.
    const junctions = [...degree.values()].filter((d) => d >= 3).length;
    expect(junctions).toBeGreaterThan(5);
    expect(back.doc.segments.length).toBeGreaterThan(20);
  });

  it('never leaves a road with no length between two crossings', () => {
    const back = parseProject(source, builtInAssets());
    for (const segment of back.doc.segments) {
      expect(segment.fromNodeId).not.toBe(segment.toNodeId);
    }
  });

  it('says what it did, including what it refused to join', () => {
    const back = parseProject(source, builtInAssets());
    expect(back.warnings.join(' ')).toMatch(/Converted \d+ street/);
  });

  it('re-saves as a native file that needs no conversion next time', () => {
    const back = parseProject(source, builtInAssets());
    const again = parseProject(
      serializeProject(back.doc, back.assets, { name: 'Cincinnati', includeBands: false }),
      builtInAssets(),
    );

    expect(again.converted).toBe(false);
    expect(again.doc.segments).toHaveLength(back.doc.segments.length);
    expect(again.doc.nodes).toHaveLength(back.doc.nodes.length);
  });
});
