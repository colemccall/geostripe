import { dedupe } from '../geo/crs';
import { resolveCenterline } from '../geo/curve';
import { lineLengthMeters } from '../geo/measure';
import { isLineAsset } from './asset';
import type { Asset } from './asset';
import { nodeMap, segmentControlPoints } from './doc';
import type { Doc } from './doc';
import { sectionExtent } from './section';
import { districtBreakdown } from './districts';
import { zoneAreaSquareMetres } from './zones';

/**
 * Measurements of the plan.
 *
 * These are sums over what is drawn, not predictions of anything: how long the roads are, how
 * much ground they take, how much land is given to each use. Everything is in SI units here
 * and converted for display.
 */

export interface FamilyStats {
  lengthMetres: number;
  /** Length times the number of travel lanes, a measure of road capacity in lane-metres. */
  laneMetres: number;
}

export interface Stats {
  roads: {
    lengthMetres: number;
    laneMetres: number;
    /** Ground taken by road cross-sections, kerb to kerb including footways. */
    rightOfWayAreaSquareMetres: number;
    byFamily: Record<string, FamilyStats>;
  };
  landUseSquareMetres: Record<string, number>;
  buildingCount: number;
  districts: { id: string; name: string; color: string; totalSquareMetres: number; byLandUse: Record<string, number> }[];
}

export function computeStats(doc: Doc, assets: ReadonlyMap<string, Asset>): Stats {
  const nodes = nodeMap(doc);
  const roads: Stats['roads'] = { lengthMetres: 0, laneMetres: 0, rightOfWayAreaSquareMetres: 0, byFamily: {} };

  for (const segment of doc.segments) {
    if (segment.visible === false) continue;
    const asset = assets.get(segment.assetId);
    if (!asset || !isLineAsset(asset)) continue;
    const controls = segmentControlPoints(segment, nodes);
    if (!controls) continue;

    const length = lineLengthMeters(
      dedupe(resolveCenterline({ id: segment.id, centerline: controls, curve: segment.curve })),
    );
    const lanes = asset.components.filter((c) => c.componentType === 'travelLane').length;
    const extent = sectionExtent(asset);

    roads.lengthMetres += length;
    roads.laneMetres += length * lanes;
    roads.rightOfWayAreaSquareMetres += length * (extent.left + extent.right);
    const family = (roads.byFamily[asset.family] ??= { lengthMetres: 0, laneMetres: 0 });
    family.lengthMetres += length;
    family.laneMetres += length * lanes;
  }

  const landUseSquareMetres: Record<string, number> = {};
  for (const zone of doc.zones) {
    if (!zone.visible) continue;
    landUseSquareMetres[zone.landUse] = (landUseSquareMetres[zone.landUse] ?? 0) + zoneAreaSquareMetres(zone);
  }

  return {
    roads,
    landUseSquareMetres,
    buildingCount: doc.buildings.filter((b) => b.visible).length,
    districts: doc.districts
      .filter((d) => d.visible && d.rings.length > 0)
      .map((d) => {
        const breakdown = districtBreakdown(doc, d);
        return { id: d.id, name: d.name, color: d.color, totalSquareMetres: breakdown.total, byLandUse: breakdown.byLandUse };
      }),
  };
}
