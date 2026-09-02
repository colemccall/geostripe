import { describe, expect, it } from 'vitest';
import { buildDesignData } from './designLayers';
import { LAYER_GROUPS, allLayersVisible, groupVisibleByDefault } from './layerGroups';
import { componentsFromSpecs } from '../library/templates';
import { createI75Project } from '../demo/cincinnati';
import type { Street } from '../model/types';

/**
 * The network as it reaches the map and the sidebar.
 *
 * network.test.ts proves the graph is right. This proves it survives the trip out: that the
 * overlay has a feature per node, that the sidebar list agrees with it, and that the layer
 * group actually owns the layers it claims to.
 *
 * The last one has bitten before in a different form — a switch wired to a layer id that
 * does not exist is a control that silently does nothing, which is worse than no control.
 */

const ORIGIN_LNG = -84.52;
const ORIGIN_LAT = 39.11;
const M_PER_LAT = 111132;
const M_PER_LNG = 111412 * Math.cos((ORIGIN_LAT * Math.PI) / 180);

function at(east: number, north: number): [number, number] {
  return [ORIGIN_LNG + east / M_PER_LNG, ORIGIN_LAT + north / M_PER_LAT];
}

let counter = 0;
function street(name: string, centerline: [number, number][]): Street {
  counter += 1;
  return {
    id: `st-${counter}`,
    name,
    centerline,
    visible: true,
    section: {
      id: `sec-${counter}`,
      name,
      anchorOffsetMeters: null,
      components: componentsFromSpecs([
        ['travelLane', 'forward'],
        ['travelLane', 'backward'],
      ]),
    },
  };
}

describe('the network overlay', () => {
  const ns = street('North–South', [at(0, -100), at(0, 100)]);
  const ew = street('East–West', [at(-100, 0), at(100, 0)]);
  const data = buildDesignData([ns, ew], null);

  it('draws one point per node', () => {
    expect(data.networkNodes.features).toHaveLength(data.networkNodeList.length);
    expect(data.networkNodeList.length).toBeGreaterThan(0);
  });

  it('labels the crossing a junction and the loose ends termini', () => {
    const forms = data.networkNodeList.map((node) => node.form).sort();
    expect(forms.filter((f) => f === 'junction')).toHaveLength(1);
    expect(forms.filter((f) => f === 'terminus')).toHaveLength(4);
  });

  it('carries the form and end count on the feature, for the paint to read', () => {
    for (const feature of data.networkNodes.features) {
      const props = feature.properties as { form?: string; endCount?: number };
      expect(typeof props.form).toBe('string');
      expect(typeof props.endCount).toBe('number');
    }
  });

  it('draws a cut across the road at every end of every segment', () => {
    // Termini have one end each and are skipped: a road stopping is not a cut. The crossing
    // has four.
    expect(data.networkCuts.features).toHaveLength(4);
    for (const feature of data.networkCuts.features) {
      expect(feature.geometry.type).toBe('LineString');
      const coords = (feature.geometry as unknown as { coordinates: [number, number][] })
        .coordinates;
      expect(coords).toHaveLength(2);
      expect(coords[0]).not.toEqual(coords[1]);
    }
  });

  it('lists segments that agree with the nodes they name', () => {
    const ids = new Set(data.networkNodeList.map((node) => node.id));
    expect(data.networkSegments).toHaveLength(4);
    for (const segment of data.networkSegments) {
      expect(ids.has(segment.fromNodeId)).toBe(true);
      expect(ids.has(segment.toNodeId)).toBe(true);
      expect(segment.toStation).toBeGreaterThan(segment.fromStation);
    }
  });
});

describe('a street that changes its own cross-section', () => {
  it('is cut there too, so the change has a segment boundary to sit on', () => {
    // The distinction the user asked for and the street model could not express: four lanes
    // up to the off-ramp, three after it. One alignment, two roads. Without a cut there is
    // nowhere for "from here on" to attach to.
    const road = street('Widening', [at(-200, 0), at(200, 0)]);
    const narrower = {
      ...road.section,
      components: road.section.components.slice(0, 1),
    };
    const withChange: Street = {
      ...road,
      sectionChanges: [{ stationMeters: 200, section: narrower, taperMeters: 45 }],
    };

    const plain = buildDesignData([road], null);
    const changed = buildDesignData([withChange], null);

    expect(plain.networkSegments).toHaveLength(1);
    expect(changed.networkSegments).toHaveLength(2);

    const boundary = changed.networkSegments
      .map((segment) => segment.toStation)
      .find((station) => Math.abs(station - 200) < 1);
    expect(boundary, 'no segment boundary at the lane change').toBeDefined();

    // And the node there is a continuation, not an intersection: the road carries on.
    const middle = changed.networkNodeList.find((node) => node.endCount === 2);
    expect(middle?.form).toBe('continuation');
  });
});

describe('the network overlay on the I-75 interchange', () => {
  const project = createI75Project();
  const data = buildDesignData(project.streets, null, {
    overrides: project.junctionOverrides,
  });

  it('finds the fork and does not call it a crossing', () => {
    const forks = data.networkNodeList.filter((node) => node.form === 'merge');
    expect(forks.length).toBeGreaterThan(0);
    // A fork of several roads is one bundle of directions, or two facing each other —
    // never the four-plus a crossroads has.
    for (const fork of forks) expect(fork.bundleCount).toBeLessThanOrEqual(2);
  });

  it('covers every street with segments', () => {
    const covered = new Set(data.networkSegments.map((segment) => segment.streetId));
    for (const s of project.streets) expect(covered.has(s.id)).toBe(true);
  });
});

describe('the network layer group', () => {
  const group = LAYER_GROUPS.find((g) => g.id === 'network');

  it('exists and owns the layers the canvas adds', () => {
    expect(group).toBeDefined();
    expect([...group!.layers]).toEqual(['network-cut', 'network-node']);
  });

  it('starts switched off, unlike everything else', () => {
    const visible = allLayersVisible();
    expect(visible.network).toBe(false);
    for (const other of LAYER_GROUPS) {
      if (other.id === 'network') continue;
      expect(visible[other.id], `${other.id} should start on`).toBe(true);
    }
  });

  it('agrees with the default used when a saved setting is missing', () => {
    // Two code paths read this — the initial state and the canvas fallback for a key that
    // is absent from saved settings. If they disagree, the overlay comes back on by itself.
    const visible = allLayersVisible();
    for (const g of LAYER_GROUPS) {
      expect(groupVisibleByDefault(g.id)).toBe(visible[g.id]);
    }
  });
});
