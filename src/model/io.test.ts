import { describe, expect, it } from 'vitest';
import { parseProject, serializeProject, toProjectGeoJSON } from './io';
import { addNode, addSegment, emptyDoc, setElevation } from './doc';
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
  // Height is a property of the place now, so a bridge is a raised junction.
  doc = setElevation(doc, c.nodeId, 1);

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

  it('keeps a junction at its height, which is how bridges survive a save', () => {
    const { doc, assets } = project();
    const back = parseProject(serializeProject(doc, assets, { name: 'Test' }), builtInAssets());
    expect(back.doc.nodes.some((n) => n.elevation === 1)).toBe(true);
  });

  it('refuses a file from the old street format rather than inventing a graph from it', () => {
    // Those files have no nodes in them at all. Anything produced from one would be an
    // invention, and the editor used to do exactly that with a tolerance that called ends
    // seventeen metres apart a junction.
    const old = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [[-84.52, 39.1], [-84.51, 39.1]] },
          properties: { geostripe: 'street', name: 'Street 1' },
        },
      ],
    };

    const back = parseProject(JSON.stringify(old), builtInAssets());
    expect(back.doc.segments).toEqual([]);
    expect(back.warnings.join(' ')).toMatch(/old street format/);
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
