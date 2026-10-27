import { describe, expect, it } from 'vitest';
import { MAX_PROJECT_BYTES, PROJECT_VERSION, parseProject, serializeProject } from './io';
import { addNode, addSegment, emptyDoc } from './doc';
import type { Doc } from './doc';
import { builtInAssets, defaultLineAssetId } from '../library/assets';

const palette = builtInAssets();
const roadId = defaultLineAssetId(palette);

function sample(): Doc {
  let doc = emptyDoc();
  const a = addNode(doc, [-84.52, 39.1]);
  doc = a.doc;
  const b = addNode(doc, [-84.51, 39.1]);
  doc = b.doc;
  doc = addSegment(doc, { assetId: roadId, fromNodeId: a.nodeId, toNodeId: b.nodeId, shape: [] }).doc;
  return {
    ...doc,
    zones: [
      {
        id: 'z1',
        landUse: 'commercial',
        rings: [
          [[-84.52, 39.101], [-84.51, 39.101], [-84.51, 39.102], [-84.52, 39.102]],
          [[-84.516, 39.1013], [-84.514, 39.1013], [-84.514, 39.1017]],
        ],
        visible: true,
      },
    ],
    buildings: [{ id: 'b1', typeId: 'house', position: [-84.515, 39.1005], rotation: 30, visible: true }],
    districts: [
      {
        id: 'd1',
        name: 'Old Town',
        color: '#4DA3FF',
        rings: [[[-84.53, 39.09], [-84.5, 39.09], [-84.5, 39.11], [-84.53, 39.11]]],
        visible: true,
      },
    ],
  };
}

describe('format version 3', () => {
  it('round-trips zones (with holes), buildings and districts', () => {
    const text = serializeProject(sample(), palette, { name: 'T', includeBands: false });
    const back = parseProject(text, palette);
    expect(back.warnings).toEqual([]);
    expect(back.version).toBe(PROJECT_VERSION);
    expect(back.doc.zones).toEqual(sample().zones);
    expect(back.doc.buildings).toEqual(sample().buildings);
    expect(back.doc.districts).toEqual(sample().districts);
  });

  it('opens a version 2 file as a version 3 document with the new lists empty', () => {
    const doc = sample();
    const v2 = JSON.parse(serializeProject({ ...doc, zones: [], buildings: [], districts: [] }, palette, { name: 'T', includeBands: false }));
    v2.streetcity.version = 2;
    const back = parseProject(JSON.stringify(v2), palette);
    expect(back.warnings).toEqual([]);
    expect(back.doc.segments).toHaveLength(1);
    expect(back.doc.zones).toEqual([]);
  });

  it('says so, and still opens, a file from a newer version', () => {
    const file = JSON.parse(serializeProject(sample(), palette, { name: 'T', includeBands: false }));
    file.streetcity.version = PROJECT_VERSION + 4;
    const back = parseProject(JSON.stringify(file), palette);
    expect(back.warnings.join(' ')).toMatch(/newer version/);
    expect(back.doc.segments).toHaveLength(1);
  });
});

describe('reading a damaged file', () => {
  const base = () => JSON.parse(serializeProject(sample(), palette, { name: 'T', includeBands: false }));

  it('drops a repeated id and says how many', () => {
    const file = base();
    file.features.push(structuredClone(file.features.find((f: { properties: { streetcity: string } }) => f.properties.streetcity === 'building')));
    const back = parseProject(JSON.stringify(file), palette);
    expect(back.doc.buildings).toHaveLength(1);
    expect(back.warnings.join(' ')).toMatch(/repeated an id/);
  });

  it('drops a road whose type is not in the palette', () => {
    const file = base();
    const seg = file.features.find((f: { properties: { streetcity: string } }) => f.properties.streetcity === 'segment');
    seg.properties.assetId = 'no-such-asset';
    const back = parseProject(JSON.stringify(file), palette);
    expect(back.doc.segments).toHaveLength(0);
    expect(back.warnings.join(' ')).toMatch(/not in the file's palette/);
  });

  it('drops a zone with an unknown land use', () => {
    const file = base();
    const zone = file.features.find((f: { properties: { streetcity: string } }) => f.properties.streetcity === 'zone');
    zone.properties.landUse = 'spaceport';
    const back = parseProject(JSON.stringify(file), palette);
    expect(back.doc.zones).toHaveLength(0);
    expect(back.warnings.join(' ')).toMatch(/zone/);
  });

  it('clamps an absurd elevation and kerb radius instead of trusting them', () => {
    const file = base();
    const node = file.features.find((f: { properties: { streetcity: string } }) => f.properties.streetcity === 'node');
    node.properties.elevation = 900;
    node.properties.radiusMeters = 99999;
    const back = parseProject(JSON.stringify(file), palette);
    expect(back.doc.nodes[0]!.elevation).toBe(2);
    expect(back.doc.nodes[0]!.radiusMeters).toBe(200);
  });

  it('drops a road with a malformed bend', () => {
    const file = base();
    const seg = file.features.find((f: { properties: { streetcity: string } }) => f.properties.streetcity === 'segment');
    seg.geometry.coordinates.splice(1, 0, [999, 999]);
    const back = parseProject(JSON.stringify(file), palette);
    expect(back.doc.segments).toHaveLength(0);
  });

  it('refuses text too large to be a project', () => {
    const back = parseProject('x'.repeat(MAX_PROJECT_BYTES + 1), palette);
    expect(back.warnings.join(' ')).toMatch(/too large/);
  });
});
