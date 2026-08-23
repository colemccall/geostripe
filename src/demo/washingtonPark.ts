import type { Street } from '../model/types';
import { newId } from '../model/types';
import { componentsFromSpecs } from '../library/templates';
import type { ComponentType, Direction } from '../library/primitives';

/**
 * The Washington Park demo.
 *
 * Two streets bounding Washington Park in Over-the-Rhine, Cincinnati — one running
 * north-south and one east-west, deliberately. A cross-section that measures correctly on
 * one bearing and wrongly on another is the single easiest geometry bug to ship, so the
 * demo puts both orientations on screen at once where any discrepancy would be obvious.
 *
 * Centerlines are hand-placed from the park's block geometry rather than imported from
 * OpenStreetMap — good to a few metres, which is fine for a demo, and every vertex is
 * draggable. Widths are illustrative, not surveyed.
 */

type Spec = readonly [ComponentType, Direction] | readonly [ComponentType, Direction, number];

function street(
  name: string,
  centerline: [number, number][],
  specs: readonly Spec[],
  existingWidthMeters: number,
): Street {
  return {
    id: newId('st'),
    name,
    centerline,
    existingWidthMeters,
    visible: true,
    section: {
      id: newId('sec'),
      name,
      components: componentsFromSpecs(specs),
      anchorOffsetMeters: null,
    },
  };
}

/** Roughly the centre of the park — where the map opens. */
export const DEMO_CENTER: [number, number] = [-84.51866, 39.11012];
export const DEMO_ZOOM = 17.4;

export function createDemoStreets(): Street[] {
  return [
    // Race Street runs north-south along the east edge of the park. Given as a redesign:
    // a road diet trading two of the four lanes for protected bike lanes both ways.
    street(
      'Race Street — protected retrofit',
      [
        [-84.51787, 39.10855],
        [-84.51789, 39.10975],
        [-84.51791, 39.11095],
        [-84.51794, 39.11215],
      ],
      [
        ['sidewalk', 'none', 2.4],
        ['bikeLaneProtected', 'backward'],
        ['travelLane', 'backward'],
        ['travelLane', 'forward'],
        ['bikeLaneProtected', 'forward'],
        ['sidewalk', 'none', 2.4],
      ],
      16.5,
    ),

    // West 12th Street runs east-west along the south edge. Kept closer to as-built:
    // one lane each way with parking on both sides, which is what OTR mostly looks like.
    street(
      'West 12th Street — calmed',
      [
        [-84.52065, 39.10874],
        [-84.51925, 39.10877],
        [-84.51785, 39.10880],
        [-84.51645, 39.10883],
      ],
      [
        ['sidewalk', 'none', 3.0],
        ['parkingLaneParallel', 'none'],
        ['travelLane', 'backward'],
        ['travelLane', 'forward'],
        ['parkingLaneParallel', 'none'],
        ['sidewalk', 'none', 3.0],
      ],
      15.2,
    ),
  ];
}
