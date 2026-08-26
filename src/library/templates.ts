import type { ComponentType, Direction } from './primitives';
import { PRIMITIVES } from './primitives';
import type { CrossSection, SectionComponent } from '../model/types';
import { newId } from '../model/types';

/**
 * Starter cross-sections.
 *
 * Widths resolve from the primitive library, whose defaults are as-built typicals — what
 * you would measure on the ground. A template that is *about* narrowing therefore has to
 * state its lane widths explicitly, or a road diet would inherit 11 ft lanes and appear to
 * change nothing. The "existing" family deliberately does inherit them.
 *
 * Systematic families are generated rather than typed out. A four-lane road with parking
 * on both sides is not a design decision, it is an arrangement, and writing sixty of those
 * by hand invites exactly the sort of transposed number this whole project exists to avoid.
 * The specials below the generators are hand-authored because each one *is* a decision.
 */

type Spec = readonly [ComponentType, Direction] | readonly [ComponentType, Direction, number];

export type TemplateCategory =
  | 'existing'
  | 'diet'
  | 'bike'
  | 'transit'
  | 'downtown'
  | 'residential'
  | 'highway'
  | 'rural'
  | 'special';

export const TEMPLATE_CATEGORIES: { id: TemplateCategory; label: string }[] = [
  { id: 'existing', label: 'As built' },
  { id: 'diet', label: 'Road diet' },
  { id: 'bike', label: 'Bike' },
  { id: 'transit', label: 'Transit' },
  { id: 'downtown', label: 'Downtown' },
  { id: 'residential', label: 'Residential' },
  { id: 'highway', label: 'Highway' },
  { id: 'rural', label: 'Rural' },
  { id: 'special', label: 'Special' },
];

export interface TemplateDef {
  readonly id: string;
  readonly label: string;
  readonly note: string;
  readonly category: TemplateCategory;
  readonly specs: readonly Spec[];
}

/** A narrowed lane, the number a road diet is arguing for. */
const NARROW = 3.0;

const walk = (metres?: number): Spec =>
  metres === undefined ? ['sidewalk', 'none'] : ['sidewalk', 'none', metres];

/**
 * Build a symmetric street: footway, optional kerbside element, lanes each way, optional
 * centre element, mirrored.
 */
function symmetric(options: {
  lanes: number;
  laneWidth?: number;
  centre?: Spec;
  kerbside?: Spec;
  inner?: Spec;
  walkWidth?: number;
}): Spec[] {
  const { lanes, laneWidth, centre, kerbside, inner, walkWidth } = options;
  const lane = (direction: Direction): Spec =>
    laneWidth === undefined ? ['travelLane', direction] : ['travelLane', direction, laneWidth];

  const half = Math.max(1, Math.round(lanes / 2));
  const left: Spec[] = [];
  const right: Spec[] = [];
  for (let i = 0; i < half; i++) {
    left.push(lane('backward'));
    right.push(lane('forward'));
  }

  const mirror = (spec: Spec): Spec => {
    const [type, direction, width] = spec as [ComponentType, Direction, number | undefined];
    const flipped: Direction =
      direction === 'forward' ? 'backward' : direction === 'backward' ? 'forward' : direction;
    return width === undefined ? [type, flipped] : [type, flipped, width];
  };

  return [
    walk(walkWidth),
    ...(kerbside ? [mirror(kerbside)] : []),
    ...(inner ? [mirror(inner)] : []),
    ...left,
    ...(centre ? [centre] : []),
    ...right,
    ...(inner ? [inner] : []),
    ...(kerbside ? [kerbside] : []),
    walk(walkWidth),
  ];
}

const generated: TemplateDef[] = [];

// ---- as built. These inherit the 11 ft default on purpose: it is what is there.
for (const lanes of [2, 4, 6]) {
  generated.push({
    id: `existing-${lanes}-plain`,
    label: `${lanes} lanes`,
    note: 'as built',
    category: 'existing',
    specs: symmetric({ lanes }),
  });
  generated.push({
    id: `existing-${lanes}-parking`,
    label: `${lanes} lanes + parking both`,
    note: 'as built',
    category: 'existing',
    specs: symmetric({ lanes, kerbside: ['parkingLaneParallel', 'none'] }),
  });
  generated.push({
    id: `existing-${lanes}-turn`,
    label: `${lanes} lanes + center turn`,
    note: 'as built',
    category: 'existing',
    specs: symmetric({ lanes, centre: ['turnLane', 'both'] }),
  });
  generated.push({
    id: `existing-${lanes}-median`,
    label: `${lanes} lanes + median`,
    note: 'as built',
    category: 'existing',
    specs: symmetric({ lanes, centre: ['median', 'none'] }),
  });
}

// ---- road diets: the same widths, narrowed lanes, space handed to something else.
for (const [id, label, kerbside] of [
  ['diet-bike', 'protected bike both', ['bikeLaneProtected', 'forward'] as Spec],
  ['diet-buffered', 'buffered bike both', ['bikeLaneBuffered', 'forward'] as Spec],
  ['diet-parking', 'parking both', ['parkingLaneParallel', 'none'] as Spec],
  ['diet-planting', 'planting both', ['plantingStrip', 'none'] as Spec],
] as const) {
  generated.push({
    id: `${id}-2`,
    label: `1+1 + turn + ${label}`,
    note: 'road diet',
    category: 'diet',
    specs: symmetric({
      lanes: 2,
      laneWidth: NARROW,
      centre: ['turnLane', 'both', NARROW],
      kerbside,
    }),
  });
  generated.push({
    id: `${id}-4`,
    label: `2+2 + ${label}`,
    note: 'road diet',
    category: 'diet',
    specs: symmetric({ lanes: 4, laneWidth: NARROW, kerbside }),
  });
}

// ---- bike families.
for (const [id, label, kerbside] of [
  ['bike-conventional', 'painted bike lane', ['bikeLaneConventional', 'forward'] as Spec],
  ['bike-buffered', 'buffered bike lane', ['bikeLaneBuffered', 'forward'] as Spec],
  ['bike-protected', 'protected bike lane', ['bikeLaneProtected', 'forward'] as Spec],
] as const) {
  generated.push({
    id: `${id}-plain`,
    label: `1+1 + ${label} both`,
    note: 'bikeway',
    category: 'bike',
    specs: symmetric({ lanes: 2, laneWidth: NARROW, kerbside }),
  });
  generated.push({
    id: `${id}-parking`,
    label: `1+1 + parking + ${label} both`,
    note: 'parking as buffer',
    category: 'bike',
    specs: symmetric({
      lanes: 2,
      laneWidth: NARROW,
      inner: ['parkingLaneParallel', 'none'],
      kerbside,
    }),
  });
}

// ---- transit families.
for (const lanes of [2, 4]) {
  generated.push({
    id: `transit-side-${lanes}`,
    label: `${lanes} lanes + kerbside bus both`,
    note: 'transit',
    category: 'transit',
    specs: symmetric({ lanes, laneWidth: NARROW, kerbside: ['busLane', 'forward'] }),
  });
  generated.push({
    id: `transit-offset-${lanes}`,
    label: `${lanes} lanes + offset bus both`,
    note: 'transit',
    category: 'transit',
    specs: symmetric({
      lanes,
      laneWidth: NARROW,
      inner: ['busLaneOffset', 'forward'],
      kerbside: ['parkingLaneParallel', 'none'],
    }),
  });
}

// ---- residential families.
for (const [id, label, kerbside] of [
  ['res-parking-both', 'parking both sides', ['parkingLaneParallel', 'none'] as Spec],
  ['res-planting', 'planting strip both', ['plantingStrip', 'none'] as Spec],
] as const) {
  generated.push({
    id,
    label: `1+1 + ${label}`,
    note: 'local street',
    category: 'residential',
    specs: symmetric({ lanes: 2, laneWidth: 2.9, kerbside, walkWidth: 2.4 }),
  });
}

// ---- freeway families.
for (const lanes of [4, 6, 8]) {
  generated.push({
    id: `freeway-${lanes}-barrier`,
    label: `Freeway, ${lanes} lanes, barrier median`,
    note: 'AASHTO 12 ft lanes',
    category: 'highway',
    specs: [
      ['soundWall', 'none'],
      ['shoulder', 'none', 3.0],
      ...Array.from({ length: lanes / 2 }, () => ['freewayLane', 'backward'] as Spec),
      ['shoulderInner', 'none'],
      ['barrier', 'none'],
      ['shoulderInner', 'none'],
      ...Array.from({ length: lanes / 2 }, () => ['freewayLane', 'forward'] as Spec),
      ['shoulder', 'none', 3.0],
      ['soundWall', 'none'],
    ],
  });
  generated.push({
    id: `freeway-${lanes}-open`,
    label: `Freeway, ${lanes} lanes, open median`,
    note: 'AASHTO 12 ft lanes',
    category: 'highway',
    specs: [
      ['shoulder', 'none', 3.0],
      ...Array.from({ length: lanes / 2 }, () => ['freewayLane', 'backward'] as Spec),
      ['shoulderInner', 'none'],
      ['median', 'none', 9.0],
      ['shoulderInner', 'none'],
      ...Array.from({ length: lanes / 2 }, () => ['freewayLane', 'forward'] as Spec),
      ['shoulder', 'none', 3.0],
    ],
  });
}

/**
 * Hand-authored templates. Each of these is a decision rather than an arrangement, which
 * is why none of them is generated.
 *
 * The first eight ids are load-bearing: they are referenced by the demo, by the default
 * draw section, and by saved files. Renaming one silently changes what an existing project
 * opens as.
 */
const authored: TemplateDef[] = [
  {
    id: 'existing-stroad',
    label: 'Existing — 4 lanes + center turn',
    note: 'as built',
    category: 'existing',
    specs: [
      walk(),
      ['travelLane', 'backward'],
      ['travelLane', 'backward'],
      ['turnLane', 'both'],
      ['travelLane', 'forward'],
      ['travelLane', 'forward'],
      walk(),
    ],
  },
  {
    id: 'protected-retrofit',
    label: '1+1 + turn + protected bike both',
    note: 'road diet',
    category: 'diet',
    specs: [
      walk(),
      ['bikeLaneProtected', 'backward'],
      ['travelLane', 'backward', NARROW],
      ['turnLane', 'both', NARROW],
      ['travelLane', 'forward', NARROW],
      ['bikeLaneProtected', 'forward'],
      walk(),
    ],
  },
  {
    id: 'transit-priority',
    label: 'Bus lanes both + 1+1',
    note: 'transit',
    category: 'transit',
    specs: [
      walk(),
      ['busLane', 'backward'],
      ['travelLane', 'backward', NARROW],
      ['travelLane', 'forward', NARROW],
      ['busLane', 'forward'],
      walk(),
    ],
  },
  {
    id: 'parking-protected',
    label: '1+1 + parking-protected bike both',
    note: 'parking as buffer',
    category: 'bike',
    specs: [
      walk(),
      ['bikeLaneConventional', 'backward'],
      ['parkingLaneParallel', 'none'],
      ['travelLane', 'backward', NARROW],
      ['travelLane', 'forward', NARROW],
      ['parkingLaneParallel', 'none'],
      ['bikeLaneConventional', 'forward'],
      walk(),
    ],
  },
  {
    id: 'median-boulevard',
    label: '1+1 + planted median + bike both',
    note: 'boulevard',
    category: 'diet',
    specs: [
      walk(),
      ['bikeLaneBuffered', 'backward'],
      ['travelLane', 'backward', NARROW],
      ['median', 'none'],
      ['travelLane', 'forward', NARROW],
      ['bikeLaneBuffered', 'forward'],
      walk(),
    ],
  },
  {
    id: 'neighborhood',
    label: '1+1 + parking both sides',
    note: 'local street',
    category: 'residential',
    specs: [
      walk(),
      ['parkingLaneParallel', 'none'],
      ['travelLane', 'backward', 2.9],
      ['travelLane', 'forward', 2.9],
      ['parkingLaneParallel', 'none'],
      walk(),
    ],
  },
  {
    id: 'main-street',
    label: 'Main street — wide walk one side',
    note: 'asymmetric',
    category: 'downtown',
    specs: [
      walk(3.7),
      ['parkingLaneParallel', 'none'],
      ['travelLane', 'backward', NARROW],
      ['travelLane', 'forward', NARROW],
      ['bikeLaneProtected', 'forward'],
      walk(1.5),
    ],
  },
  {
    id: 'one-way-protected',
    label: 'One-way, 2 lanes + protected bike',
    note: 'one-way pair',
    category: 'downtown',
    specs: [
      walk(),
      ['bikeLaneProtected', 'forward'],
      ['travelLane', 'forward', NARROW],
      ['travelLane', 'forward', NARROW],
      ['parkingLaneParallel', 'none'],
      walk(),
    ],
  },

  // ---- downtown
  {
    id: 'downtown-transit-mall',
    label: 'Transit mall',
    note: 'buses and people only',
    category: 'downtown',
    specs: [
      walk(4.5),
      ['busLane', 'backward'],
      ['transitPlatform', 'none'],
      ['busLane', 'forward'],
      walk(4.5),
    ],
  },
  {
    id: 'downtown-two-way-track',
    label: 'Two-way cycle track one side',
    note: 'downtown',
    category: 'bike',
    specs: [
      walk(),
      ['cycleTrackTwoWay', 'both'],
      ['paintedBuffer', 'none'],
      ['travelLane', 'forward', NARROW],
      ['travelLane', 'forward', NARROW],
      ['parkingLaneParallel', 'none'],
      walk(),
    ],
  },
  {
    id: 'downtown-angled',
    label: 'Back-in angled parking both',
    note: 'retail street',
    category: 'downtown',
    specs: [
      walk(3.7),
      ['parkingBackInAngled', 'none'],
      ['travelLane', 'backward', NARROW],
      ['travelLane', 'forward', NARROW],
      ['parkingBackInAngled', 'none'],
      walk(3.7),
    ],
  },
  {
    id: 'downtown-loading',
    label: 'One-way + loading + bike',
    note: 'freight-friendly',
    category: 'downtown',
    specs: [
      walk(),
      ['bikeLaneProtected', 'forward'],
      ['travelLane', 'forward', NARROW],
      ['loadingZone', 'none'],
      walk(),
    ],
  },

  // ---- transit
  {
    id: 'transit-centre-busway',
    label: 'Centre busway + 1+1',
    note: 'BRT',
    category: 'transit',
    specs: [
      walk(),
      ['travelLane', 'backward', NARROW],
      ['busway', 'both'],
      ['travelLane', 'forward', NARROW],
      walk(),
    ],
  },
  {
    id: 'transit-tram-reservation',
    label: 'Tram reservation + 1+1',
    note: 'light rail',
    category: 'transit',
    specs: [
      walk(),
      ['travelLane', 'backward', NARROW],
      ['tramReservation', 'both'],
      ['travelLane', 'forward', NARROW],
      walk(),
    ],
  },
  {
    id: 'transit-tram-embedded',
    label: 'Embedded tram + shared lanes',
    note: 'streetcar',
    category: 'transit',
    specs: [
      walk(),
      ['parkingLaneParallel', 'none'],
      ['tramTrack', 'backward'],
      ['tramTrack', 'forward'],
      ['parkingLaneParallel', 'none'],
      walk(),
    ],
  },

  // ---- bike
  {
    id: 'bike-boulevard',
    label: 'Bike boulevard',
    note: 'low volume, no lanes',
    category: 'bike',
    specs: [
      walk(2.4),
      ['parkingLaneParallel', 'none'],
      ['sharedLane', 'both'],
      ['parkingLaneParallel', 'none'],
      walk(2.4),
    ],
  },
  {
    id: 'bike-contraflow',
    label: 'One-way + contraflow bike',
    note: 'undoes a one-way',
    category: 'bike',
    specs: [
      walk(),
      ['bikeLaneContraflow', 'backward'],
      ['travelLane', 'forward', NARROW],
      ['parkingLaneParallel', 'none'],
      walk(),
    ],
  },
  {
    id: 'bike-raised-track',
    label: 'Raised cycle track both',
    note: 'kerb-separated',
    category: 'bike',
    specs: [
      walk(2.4),
      ['bikeLaneProtected', 'backward'],
      ['plantingStrip', 'none'],
      ['travelLane', 'backward', NARROW],
      ['travelLane', 'forward', NARROW],
      ['plantingStrip', 'none'],
      ['bikeLaneProtected', 'forward'],
      walk(2.4),
    ],
  },

  // ---- highway
  {
    id: 'highway-ramp',
    label: 'On-ramp, single lane',
    note: 'ramp',
    category: 'highway',
    specs: [
      ['shoulder', 'none', 1.8],
      ['rampLane', 'forward'],
      ['shoulder', 'none', 3.0],
    ],
  },
  {
    id: 'highway-ramp-two',
    label: 'Ramp, two lanes',
    note: 'ramp',
    category: 'highway',
    specs: [
      ['shoulder', 'none', 1.8],
      ['rampLane', 'forward'],
      ['rampLane', 'forward'],
      ['shoulder', 'none', 3.0],
    ],
  },
  {
    id: 'highway-collector-distributor',
    label: 'Collector-distributor road',
    note: 'parallel to the mainline',
    category: 'highway',
    specs: [
      ['shoulderInner', 'none'],
      ['auxiliaryLane', 'forward'],
      ['auxiliaryLane', 'forward'],
      ['shoulder', 'none', 3.0],
    ],
  },
  {
    id: 'highway-tunnel-bore',
    label: 'Tunnel bore, 2 lanes',
    note: 'set the street level to -1',
    category: 'highway',
    specs: [
      ['barrier', 'none'],
      ['shoulderInner', 'none'],
      ['freewayLane', 'forward'],
      ['freewayLane', 'forward'],
      ['shoulder', 'none', 2.4],
      ['barrier', 'none'],
    ],
  },
  {
    id: 'highway-viaduct',
    label: 'Viaduct deck, 4 lanes',
    note: 'set the street level to +1',
    category: 'highway',
    specs: [
      ['barrier', 'none'],
      ['shoulder', 'none', 2.4],
      ['freewayLane', 'backward'],
      ['freewayLane', 'backward'],
      ['barrier', 'none'],
      ['freewayLane', 'forward'],
      ['freewayLane', 'forward'],
      ['shoulder', 'none', 2.4],
      ['barrier', 'none'],
    ],
  },

  // ---- rural
  {
    id: 'rural-two-lane',
    label: 'Rural 2-lane + shoulders',
    note: 'rural',
    category: 'rural',
    specs: [
      ['ditch', 'none'],
      ['shoulder', 'none', 2.4],
      ['travelLane', 'backward', 3.65],
      ['travelLane', 'forward', 3.65],
      ['shoulder', 'none', 2.4],
      ['ditch', 'none'],
    ],
  },
  {
    id: 'rural-two-lane-path',
    label: 'Rural 2-lane + shared use path',
    note: 'rural',
    category: 'rural',
    specs: [
      ['verge', 'none'],
      ['travelLane', 'backward', 3.35],
      ['travelLane', 'forward', 3.35],
      ['shoulder', 'none', 1.8],
      ['verge', 'none'],
      ['sharedUsePath', 'both'],
    ],
  },
  {
    id: 'rural-village',
    label: 'Village gateway',
    note: 'speed transition',
    category: 'rural',
    specs: [
      walk(2.4),
      ['plantingStrip', 'none'],
      ['travelLane', 'backward', 2.9],
      ['medianRefuge', 'none'],
      ['travelLane', 'forward', 2.9],
      ['plantingStrip', 'none'],
      walk(2.4),
    ],
  },

  // ---- special
  {
    id: 'special-woonerf',
    label: 'Woonerf / shared street',
    note: 'no kerbs',
    category: 'special',
    specs: [
      ['frontageZone', 'none'],
      ['treePit', 'none'],
      ['woonerf', 'both'],
      ['treePit', 'none'],
      ['frontageZone', 'none'],
    ],
  },
  {
    id: 'special-pedestrian-mall',
    label: 'Pedestrian mall',
    note: 'no vehicles',
    category: 'special',
    specs: [
      ['frontageZone', 'none', 1.8],
      ['pedestrianMall', 'none'],
      ['frontageZone', 'none', 1.8],
    ],
  },
  {
    id: 'special-green-street',
    label: 'Green street with bioswales',
    note: 'stormwater',
    category: 'special',
    specs: [
      walk(2.4),
      ['bioswale', 'none'],
      ['parkingLaneParallel', 'none'],
      ['travelLane', 'backward', 2.9],
      ['travelLane', 'forward', 2.9],
      ['parkingLaneParallel', 'none'],
      ['bioswale', 'none'],
      walk(2.4),
    ],
  },
  {
    id: 'special-rail-corridor',
    label: 'Rail corridor beside a street',
    note: 'shared corridor',
    category: 'special',
    specs: [
      walk(2.4),
      ['travelLane', 'backward', NARROW],
      ['travelLane', 'forward', NARROW],
      ['railBallast', 'none'],
      ['railTrack', 'backward'],
      ['railTrack', 'forward'],
      ['railBallast', 'none'],
    ],
  },
];

export const TEMPLATES: readonly TemplateDef[] = [...authored, ...generated];

export function componentsFromSpecs(specs: readonly Spec[]): SectionComponent[] {
  return specs.map(([componentType, direction, width]) => ({
    id: newId('cmp'),
    componentType,
    widthMeters: width ?? PRIMITIVES[componentType].defaultWidthMeters,
    direction,
  }));
}

export function instantiateTemplate(template: TemplateDef): CrossSection {
  return {
    id: newId('sec'),
    name: template.label,
    components: componentsFromSpecs(template.specs),
    anchorOffsetMeters: null,
  };
}

export function templateTotalWidth(template: TemplateDef): number {
  return template.specs.reduce(
    (sum, [componentType, , width]) => sum + (width ?? PRIMITIVES[componentType].defaultWidthMeters),
    0,
  );
}

/** Case-insensitive match on label, note, category, or any component it contains. */
export function searchTemplates(query: string): TemplateDef[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...TEMPLATES];
  return TEMPLATES.filter((template) => {
    if (
      template.label.toLowerCase().includes(q) ||
      template.note.toLowerCase().includes(q) ||
      template.category.toLowerCase().includes(q)
    ) {
      return true;
    }
    // Searching by what a section *contains* is how you find "the one with a busway"
    // when you cannot remember what it was called.
    return template.specs.some(([type]) => PRIMITIVES[type].label.toLowerCase().includes(q));
  });
}
