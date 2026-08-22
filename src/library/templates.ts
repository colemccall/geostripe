import type { ComponentType, Direction } from './primitives';
import { PRIMITIVES } from './primitives';
import type { CrossSection, SectionComponent } from '../model/types';
import { newId } from '../model/types';

/**
 * Starter cross-sections.
 *
 * Each is defined purely as an ordered list of primitives — widths resolve from the
 * primitive library at instantiation, so there is no second dimension table to keep in
 * sync, and editing a primitive's default updates every template that uses it.
 *
 * A width is only ever specified inline where the template is *about* that width, such
 * as the wide commercial sidewalk in "Main street".
 */

type Spec = readonly [ComponentType, Direction] | readonly [ComponentType, Direction, number];

export interface TemplateDef {
  readonly id: string;
  readonly label: string;
  readonly note: string;
  readonly specs: readonly Spec[];
}

export const TEMPLATES: readonly TemplateDef[] = [
  {
    id: 'existing-stroad',
    label: 'Existing — 4 lanes + center turn',
    note: 'as built',
    specs: [
      ['sidewalk', 'none'],
      ['travelLane', 'backward'],
      ['travelLane', 'backward'],
      ['turnLane', 'both'],
      ['travelLane', 'forward'],
      ['travelLane', 'forward'],
      ['sidewalk', 'none'],
    ],
  },
  {
    id: 'protected-retrofit',
    label: '1+1 + turn + protected bike both',
    note: 'road diet',
    specs: [
      ['sidewalk', 'none'],
      ['bikeLaneProtected', 'backward'],
      ['travelLane', 'backward'],
      ['turnLane', 'both'],
      ['travelLane', 'forward'],
      ['bikeLaneProtected', 'forward'],
      ['sidewalk', 'none'],
    ],
  },
  {
    id: 'transit-priority',
    label: 'Bus lanes both + 1+1',
    note: 'transit',
    specs: [
      ['sidewalk', 'none'],
      ['busLane', 'backward'],
      ['travelLane', 'backward'],
      ['travelLane', 'forward'],
      ['busLane', 'forward'],
      ['sidewalk', 'none'],
    ],
  },
  {
    id: 'parking-protected',
    label: '1+1 + parking-protected bike both',
    note: 'parking as buffer',
    specs: [
      ['sidewalk', 'none'],
      ['bikeLaneConventional', 'backward'],
      ['parkingLaneParallel', 'none'],
      ['travelLane', 'backward'],
      ['travelLane', 'forward'],
      ['parkingLaneParallel', 'none'],
      ['bikeLaneConventional', 'forward'],
      ['sidewalk', 'none'],
    ],
  },
  {
    id: 'median-boulevard',
    label: '1+1 + planted median + bike both',
    note: 'boulevard',
    specs: [
      ['sidewalk', 'none'],
      ['bikeLaneBuffered', 'backward'],
      ['travelLane', 'backward'],
      ['median', 'none'],
      ['travelLane', 'forward'],
      ['bikeLaneBuffered', 'forward'],
      ['sidewalk', 'none'],
    ],
  },
  {
    id: 'neighborhood',
    label: '1+1 + parking both sides',
    note: 'local street',
    specs: [
      ['sidewalk', 'none'],
      ['parkingLaneParallel', 'none'],
      ['travelLane', 'backward'],
      ['travelLane', 'forward'],
      ['parkingLaneParallel', 'none'],
      ['sidewalk', 'none'],
    ],
  },
  {
    // Deliberately asymmetric. This is the case where the travelway anchor and the
    // geometric centre diverge, which is why the anchor is stored rather than assumed.
    id: 'main-street',
    label: 'Main street — wide walk one side',
    note: 'asymmetric',
    specs: [
      ['sidewalk', 'none', 3.7],
      ['parkingLaneParallel', 'none'],
      ['travelLane', 'backward'],
      ['travelLane', 'forward'],
      ['bikeLaneProtected', 'forward'],
      ['sidewalk', 'none', 1.5],
    ],
  },
  {
    id: 'one-way-protected',
    label: 'One-way, 2 lanes + protected bike',
    note: 'one-way pair',
    specs: [
      ['sidewalk', 'none'],
      ['bikeLaneProtected', 'forward'],
      ['travelLane', 'forward'],
      ['travelLane', 'forward'],
      ['parkingLaneParallel', 'none'],
      ['sidewalk', 'none'],
    ],
  },
];

export function componentsFromSpecs(specs: readonly Spec[]): SectionComponent[] {
  return specs.map(([componentType, direction, width]) => ({
    id: newId('cmp'),
    componentType,
    direction,
    widthMeters: width ?? PRIMITIVES[componentType].defaultWidthMeters,
  }));
}

export function instantiateTemplate(def: TemplateDef): CrossSection {
  return {
    id: newId('sec'),
    name: def.label,
    components: componentsFromSpecs(def.specs),
    anchorOffsetMeters: null,
  };
}

export function templateTotalWidth(def: TemplateDef): number {
  return def.specs.reduce(
    (sum, [type, , width]) => sum + (width ?? PRIMITIVES[type].defaultWidthMeters),
    0,
  );
}
