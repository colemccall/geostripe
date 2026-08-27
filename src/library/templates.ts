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
  /** Sections you built in the Asset Builder and kept. Always listed first. */
  | 'saved'
  | 'existing'
  | 'diet'
  | 'bike'
  | 'transit'
  | 'path'
  | 'downtown'
  | 'residential'
  | 'highway'
  | 'rural'
  | 'special';

export const TEMPLATE_CATEGORIES: { id: TemplateCategory; label: string }[] = [
  { id: 'saved', label: 'Yours' },
  { id: 'existing', label: 'As built' },
  { id: 'diet', label: 'Road diet' },
  { id: 'bike', label: 'Bike' },
  { id: 'transit', label: 'Transit' },
  { id: 'path', label: 'Paths' },
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
  /**
   * The group this preset sits in within its category.
   *
   * A plain label rather than an enum, for the same reason the primitives have one: it is
   * how the library divides for a person browsing it, and a generated family should be
   * able to name itself without a type change.
   */
  readonly family: string;
  readonly specs: readonly Spec[];
  /**
   * A whole cross-section, for presets that came out of the Asset Builder.
   *
   * `specs` can only say type, direction and width. A section somebody built by hand can
   * also carry a pavement glyph, a stripe on one side, a colour override — everything the
   * builder can set. Rebuilding one from specs would silently drop all of it, so a saved
   * preset carries the section itself and this takes precedence.
   */
  readonly section?: CrossSection;
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

/**
 * A one-way street: every lane in the same direction, optional kerbside element on each
 * side. Not a special case of `symmetric` — mirroring the directions is exactly what makes
 * a street two-way, so a one-way needs its own builder rather than a flag.
 */
function oneWay(options: {
  lanes: number;
  laneWidth?: number;
  left?: Spec;
  right?: Spec;
  walkWidth?: number;
}): Spec[] {
  const { lanes, laneWidth, left, right, walkWidth } = options;
  const lane: Spec =
    laneWidth === undefined ? ['travelLane', 'forward'] : ['travelLane', 'forward', laneWidth];
  return [
    walk(walkWidth),
    ...(left ? [left] : []),
    ...Array.from({ length: lanes }, () => lane),
    ...(right ? [right] : []),
    walk(walkWidth),
  ];
}

/**
 * An off-street path: a running surface with a graded strip either side and, optionally,
 * a verge beyond that.
 *
 * There is no footway here and no kerb, which is the whole difference. A path is not a
 * narrow street — it has no roadway at all, so the anchor falls back to the geometric
 * centre and nothing in the junction code treats it as carriageway.
 */
function pathway(options: {
  surface: Spec;
  shoulder?: number;
  verge?: number;
  extra?: Spec[];
}): Spec[] {
  const { surface, shoulder = 0.6, verge, extra = [] } = options;
  const edge: Spec[] = shoulder > 0 ? [['pathShoulder', 'none', shoulder]] : [];
  const green: Spec[] = verge ? [['verge', 'none', verge]] : [];
  return [...green, ...edge, surface, ...extra, ...edge, ...green];
}

const generated: TemplateDef[] = [];

// ---- as built. These inherit the 11 ft default on purpose: it is what is there.
for (const lanes of [2, 4, 6]) {
  generated.push({
    id: `existing-${lanes}-plain`,
    label: `${lanes} lanes`,
    note: 'as built',
    category: 'existing',
    family: `${lanes} lanes`,
    specs: symmetric({ lanes }),
  });
  generated.push({
    id: `existing-${lanes}-parking`,
    label: `${lanes} lanes + parking both`,
    note: 'as built',
    category: 'existing',
    family: `${lanes} lanes`,
    specs: symmetric({ lanes, kerbside: ['parkingLaneParallel', 'none'] }),
  });
  generated.push({
    id: `existing-${lanes}-turn`,
    label: `${lanes} lanes + center turn`,
    note: 'as built',
    category: 'existing',
    family: `${lanes} lanes`,
    specs: symmetric({ lanes, centre: ['turnLane', 'both'] }),
  });
  generated.push({
    id: `existing-${lanes}-median`,
    label: `${lanes} lanes + median`,
    note: 'as built',
    category: 'existing',
    family: `${lanes} lanes`,
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
    family: `Two lanes + turn`,
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
    family: `Four lanes`,
    specs: symmetric({ lanes: 4, laneWidth: NARROW, kerbside }),
  });
}

// ---- bike families.
for (const [id, label, kerbside, family] of [
  ['bike-conventional', 'painted bike lane', ['bikeLaneConventional', 'forward'] as Spec, 'Painted'],
  ['bike-buffered', 'buffered bike lane', ['bikeLaneBuffered', 'forward'] as Spec, 'Buffered'],
  ['bike-protected', 'protected bike lane', ['bikeLaneProtected', 'forward'] as Spec, 'Protected'],
] as const) {
  generated.push({
    id: `${id}-plain`,
    label: `1+1 + ${label} both`,
    note: 'bikeway',
    category: 'bike',
    family,
    specs: symmetric({ lanes: 2, laneWidth: NARROW, kerbside }),
  });
  generated.push({
    id: `${id}-parking`,
    label: `1+1 + parking + ${label} both`,
    note: 'parking as buffer',
    category: 'bike',
    family,
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
    family: `Kerbside`,
    specs: symmetric({ lanes, laneWidth: NARROW, kerbside: ['busLane', 'forward'] }),
  });
  generated.push({
    id: `transit-offset-${lanes}`,
    label: `${lanes} lanes + offset bus both`,
    note: 'transit',
    category: 'transit',
    family: `Offset`,
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
    family: 'Local street',
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
    family: `Freeway`,
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
    family: `Freeway`,
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


// ---- as built, two more arrangements that are extremely common and never designed.
for (const lanes of [2, 4, 6]) {
  generated.push({
    id: `existing-${lanes}-shoulder`,
    label: `${lanes} lanes + shoulder both`,
    note: 'as built',
    category: 'existing',
    family: `${lanes} lanes`,
    specs: symmetric({ lanes, kerbside: ['shoulder', 'none'] }),
  });
  generated.push({
    id: `existing-${lanes}-bike`,
    label: `${lanes} lanes + painted bike both`,
    note: 'as built',
    category: 'existing',
    family: `${lanes} lanes`,
    specs: symmetric({ lanes, kerbside: ['bikeLaneConventional', 'forward'] }),
  });
}

// ---- more road diets: the same argument, other things to spend the width on.
for (const [id, label, kerbside] of [
  ['diet-bus', 'kerbside bus both', ['busLane', 'forward'] as Spec],
  ['diet-path', 'shared use path both', ['sharedUsePath', 'both'] as Spec],
  ['diet-raingarden', 'rain garden both', ['rainGarden', 'none'] as Spec],
  ['diet-dining', 'outdoor dining both', ['outdoorDining', 'none'] as Spec],
] as const) {
  generated.push({
    id: `${id}-2`,
    label: `1+1 + turn + ${label}`,
    note: 'road diet',
    category: 'diet',
    family: `Two lanes + turn`,
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
    family: `Four lanes`,
    specs: symmetric({ lanes: 4, laneWidth: NARROW, kerbside }),
  });
}

// ---- bikeways: every separation type, and the buffer that turns paint into protection.
for (const [id, label, kerbside, family] of [
  ['bike-raised', 'raised cycle track', ['cycleTrackRaised', 'forward'] as Spec, 'Raised'],
] as const) {
  generated.push({
    id: `${id}-plain`,
    label: `1+1 + ${label} both`,
    note: 'bikeway',
    category: 'bike',
    family,
    specs: symmetric({ lanes: 2, laneWidth: NARROW, kerbside }),
  });
  generated.push({
    id: `${id}-parking`,
    label: `1+1 + parking + ${label} both`,
    note: 'parking as buffer',
    category: 'bike',
    family,
    specs: symmetric({
      lanes: 2,
      laneWidth: NARROW,
      inner: ['parkingLaneParallel', 'none'],
      kerbside,
    }),
  });
}

for (const [id, label, kerbside, family] of [
  ['bike-conventional', 'painted bike lane', ['bikeLaneConventional', 'forward'] as Spec, 'Painted'],
  ['bike-buffered', 'buffered bike lane', ['bikeLaneBuffered', 'forward'] as Spec, 'Buffered'],
  ['bike-protected', 'protected bike lane', ['bikeLaneProtected', 'forward'] as Spec, 'Protected'],
  ['bike-raised', 'raised cycle track', ['cycleTrackRaised', 'forward'] as Spec, 'Raised'],
] as const) {
  generated.push({
    id: `${id}-buffer`,
    label: `1+1 + buffer + ${label} both`,
    note: 'painted separation',
    category: 'bike',
    family,
    specs: symmetric({
      lanes: 2,
      laneWidth: NARROW,
      inner: ['paintedBuffer', 'none'],
      kerbside,
    }),
  });
}

// ---- transit: kerbside, offset, and the two centre-running forms.
generated.push({
  id: 'transit-side-6',
  label: '6 lanes + kerbside bus both',
  note: 'transit',
  category: 'transit',
  family: 'Kerbside',
  specs: symmetric({ lanes: 6, laneWidth: NARROW, kerbside: ['busLane', 'forward'] }),
});
generated.push({
  id: 'transit-offset-6',
  label: '6 lanes + offset bus both',
  note: 'transit',
  category: 'transit',
  family: 'Offset',
  specs: symmetric({
    lanes: 6,
    laneWidth: NARROW,
    inner: ['busLaneOffset', 'forward'],
    kerbside: ['parkingLaneParallel', 'none'],
  }),
});

for (const lanes of [2, 4]) {
  generated.push({
    id: `transit-busway-${lanes}`,
    label: `${lanes} lanes + centre busway`,
    note: 'centre-running BRT',
    category: 'transit',
    family: `Centre-running`,
    specs: [
      walk(),
      ...Array.from({ length: lanes / 2 || 1 }, () => ['travelLane', 'backward', NARROW] as Spec),
      ['busway', 'backward'],
      ['brtStation', 'none'],
      ['busway', 'forward'],
      ...Array.from({ length: lanes / 2 || 1 }, () => ['travelLane', 'forward', NARROW] as Spec),
      walk(),
    ],
  });
  generated.push({
    id: `transit-tram-${lanes}`,
    label: `${lanes} lanes + tram reservation`,
    note: 'tram on its own alignment',
    category: 'transit',
    family: `Centre-running`,
    specs: [
      walk(),
      ...Array.from({ length: lanes / 2 || 1 }, () => ['travelLane', 'backward', NARROW] as Spec),
      ['tramReservation', 'both'],
      ...Array.from({ length: lanes / 2 || 1 }, () => ['travelLane', 'forward', NARROW] as Spec),
      walk(),
    ],
  });
}

// ---- one-way streets. A whole family the library was missing, and half of any downtown.
for (const lanes of [1, 2, 3]) {
  for (const [suffix, label, left, right] of [
    ['plain', 'no kerbside', undefined, undefined],
    ['parking', 'parking both', ['parkingLaneParallel', 'none'] as Spec, ['parkingLaneParallel', 'none'] as Spec],
    ['bike', 'protected bike', ['bikeLaneProtected', 'backward'] as Spec, undefined],
    ['bus', 'kerbside bus', undefined, ['busLane', 'forward'] as Spec],
  ] as const) {
    generated.push({
      id: `oneway-${lanes}-${suffix}`,
      label: `One-way, ${lanes} lane${lanes === 1 ? '' : 's'} + ${label}`,
      note: 'one-way street',
      category: 'downtown',
      family: 'One-way',
      specs: oneWay({ lanes, laneWidth: NARROW, left, right }),
    });
  }
}

// ---- boulevards, by how much median there is to work with.
for (const lanes of [4, 6]) {
  for (const [suffix, width, label] of [
    ['narrow', 2.4, 'refuge-width median'],
    ['planted', 4.8, 'planted median'],
    ['wide', 9.0, 'boulevard median'],
  ] as const) {
    generated.push({
      id: `boulevard-${lanes}-${suffix}`,
      label: `${lanes} lanes + ${label}`,
      note: 'divided street',
      category: 'downtown',
      family: 'Boulevard',
      specs: symmetric({
        lanes,
        laneWidth: NARROW,
        centre: [width >= 4 ? 'medianPlanted' : 'median', 'none', width],
      }),
    });
  }
}

// ---- residential: the same street, different things at the kerb.
for (const [id, label, kerbside] of [
  ['res-plain', 'nothing at the kerb', undefined],
  ['res-trees', 'street trees both', ['treePit', 'none'] as Spec],
  ['res-raingarden', 'rain garden both', ['rainGarden', 'none'] as Spec],
] as const) {
  generated.push({
    id,
    label: `1+1 + ${label}`,
    note: 'local street',
    category: 'residential',
    family: 'Local street',
    specs: symmetric({ lanes: 2, laneWidth: 2.9, kerbside, walkWidth: 2.4 }),
  });
}

// ---- freeways: two more sizes, and the collector-distributor form.
for (const lanes of [10]) {
  generated.push({
    id: `freeway-${lanes}-barrier`,
    label: `Freeway, ${lanes} lanes, barrier median`,
    note: 'AASHTO 12 ft lanes',
    category: 'highway',
    family: `Freeway`,
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
}

for (const lanes of [4, 6, 8]) {
  generated.push({
    id: `freeway-${lanes}-cd`,
    label: `Freeway, ${lanes} lanes + collector-distributor`,
    note: 'weaving taken off the mainline',
    category: 'highway',
    family: `Collector-distributor`,
    specs: [
      ['shoulder', 'none', 3.0],
      ['collectorLane', 'backward'],
      ['barrier', 'none'],
      ['shoulderInner', 'none'],
      ...Array.from({ length: lanes / 2 }, () => ['freewayLane', 'backward'] as Spec),
      ['shoulderInner', 'none'],
      ['barrier', 'none'],
      ['shoulderInner', 'none'],
      ...Array.from({ length: lanes / 2 }, () => ['freewayLane', 'forward'] as Spec),
      ['shoulderInner', 'none'],
      ['barrier', 'none'],
      ['collectorLane', 'forward'],
      ['shoulder', 'none', 3.0],
    ],
  });
}

// ---- rural, by how much shoulder there is.
for (const [suffix, width, label] of [
  ['none', 0.6, 'no real shoulder'],
  ['narrow', 1.2, 'narrow shoulder'],
  ['wide', 2.4, 'full shoulder'],
] as const) {
  generated.push({
    id: `rural-2-${suffix}`,
    label: `Rural 2 lane, ${label}`,
    note: 'rural highway',
    category: 'rural',
    family: `Two lane`,
    specs: [
      ['ditch', 'none'],
      ['verge', 'none'],
      ['shoulder', 'none', width],
      ['travelLane', 'backward', 3.35],
      ['travelLane', 'forward', 3.35],
      ['shoulder', 'none', width],
      ['verge', 'none'],
      ['ditch', 'none'],
    ],
  });
}

// ---- grade separation. Both of these are drawn with `level` set on the street.
generated.push({
  id: 'tunnel-2',
  label: 'Tunnel, 1+1',
  note: 'set the street level to tunnel',
  category: 'special',
  family: 'Grade separated',
  specs: [
    ['retainingWall', 'none'],
    ['gutter', 'none'],
    ['travelLane', 'backward', NARROW],
    ['travelLane', 'forward', NARROW],
    ['gutter', 'none'],
    ['retainingWall', 'none'],
  ],
});
generated.push({
  id: 'tunnel-4',
  label: 'Tunnel, 2+2',
  note: 'set the street level to tunnel',
  category: 'special',
  family: 'Grade separated',
  specs: [
    ['retainingWall', 'none'],
    ['shoulder', 'none', 1.2],
    ['travelLane', 'backward', NARROW],
    ['travelLane', 'backward', NARROW],
    ['barrier', 'none'],
    ['travelLane', 'forward', NARROW],
    ['travelLane', 'forward', NARROW],
    ['shoulder', 'none', 1.2],
    ['retainingWall', 'none'],
  ],
});
for (const lanes of [4, 6]) {
  generated.push({
    id: `viaduct-${lanes}`,
    label: `Viaduct, ${lanes} lanes`,
    note: 'set the street level to overpass',
    category: 'special',
    family: `Grade separated`,
    specs: [
      ['barrier', 'none'],
      ['shoulder', 'none', 1.5],
      ...Array.from({ length: lanes / 2 }, () => ['freewayLane', 'backward'] as Spec),
      ['barrier', 'none'],
      ...Array.from({ length: lanes / 2 }, () => ['freewayLane', 'forward'] as Spec),
      ['shoulder', 'none', 1.5],
      ['barrier', 'none'],
    ],
  });
}

// ---- paths, by running width. The four widths are the ones that actually get built:
// 8 ft is a minimum nobody enjoys, 10 ft is the standard, 12 ft handles real volume, and
// 14 ft is what a busy urban greenway needs before it has to be split by mode.
for (const [suffix, width, label] of [
  ['8', 2.4, '8 ft — minimum'],
  ['10', 3.0, '10 ft — standard'],
  ['12', 3.6, '12 ft — busy'],
  ['14', 4.3, '14 ft — high volume'],
] as const) {
  generated.push({
    id: `path-shared-${suffix}`,
    label: `Shared use path, ${label}`,
    note: 'AASHTO shared use path',
    category: 'path',
    family: `Shared use path`,
    specs: pathway({ surface: ['sharedUsePath', 'both', width], verge: 1.2 }),
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
  // ------------------------------------------------------------------------ paths
  {
    id: 'path-greenway',
    label: 'Greenway',
    note: 'off-street path on its own corridor',
    category: 'path',
    family: `Greenway and trail`,
    specs: [
      ['verge', 'none', 2.0],
      ['pathShoulder', 'none', 0.6],
      ['greenway', 'both'],
      ['pathShoulder', 'none', 0.6],
      ['verge', 'none', 2.0],
    ],
  },
  {
    id: 'path-separated',
    label: 'Separated path — walking and cycling apart',
    note: 'the Dutch answer to a busy shared path',
    category: 'path',
    family: `Walking`,
    specs: [
      ['verge', 'none', 1.2],
      ['footpath', 'both', 2.4],
      ['plantingStrip', 'none', 0.9],
      ['cycleTrackTwoWay', 'both', 3.6],
      ['pathShoulder', 'none', 0.6],
      ['verge', 'none', 1.2],
    ],
  },
  {
    id: 'path-sidepath',
    label: 'Side path beside a road',
    note: 'two-way path on one side; watch the driveways',
    category: 'path',
    family: `Beside a road or railway`,
    specs: [
      ['travelLane', 'backward'],
      ['travelLane', 'forward'],
      ['shoulder', 'none', 1.2],
      ['verge', 'none', 1.8],
      ['sidepath', 'both'],
      ['pathShoulder', 'none', 0.6],
    ],
  },
  {
    id: 'path-rail-trail',
    label: 'Rail trail',
    note: 'a disused rail corridor, already flat and continuous',
    category: 'path',
    family: `Greenway and trail`,
    specs: [
      ['verge', 'none', 3.0],
      ['pathShoulder', 'none', 0.9],
      ['greenway', 'both', 3.6],
      ['pathShoulder', 'none', 0.9],
      ['verge', 'none', 3.0],
    ],
  },
  {
    id: 'path-rail-with-trail',
    label: 'Rail with trail',
    note: 'a path beside a live railway, with the separation that needs',
    category: 'path',
    family: `Beside a road or railway`,
    specs: [
      ['railBallast', 'none'],
      ['railTrack', 'none'],
      ['railBallast', 'none'],
      ['guardrail', 'none'],
      ['verge', 'none', 3.0],
      ['sharedUsePath', 'both', 3.0],
      ['pathShoulder', 'none', 0.6],
    ],
  },
  {
    id: 'path-boardwalk',
    label: 'Boardwalk',
    note: 'over wetland or dune; width is a cost decision',
    category: 'path',
    family: `Structure and lane`,
    specs: [['boardwalk', 'both', 3.0]],
  },
  {
    id: 'path-trail',
    label: 'Unpaved trail',
    note: 'crushed stone; cheaper, softer, and not reliably accessible',
    category: 'path',
    family: `Greenway and trail`,
    specs: [
      ['verge', 'none', 1.5],
      ['trailUnpaved', 'both'],
      ['verge', 'none', 1.5],
    ],
  },
  {
    id: 'path-towpath',
    label: 'Canal towpath',
    note: 'flat, continuous and already a corridor',
    category: 'path',
    family: `Greenway and trail`,
    specs: [
      ['verge', 'none', 1.2],
      ['towpath', 'both'],
      ['verge', 'none', 0.9],
    ],
  },
  {
    id: 'path-bridleway',
    label: 'Bridleway and path',
    note: 'a soft horse route beside a sealed path',
    category: 'path',
    family: `Greenway and trail`,
    specs: [
      ['verge', 'none', 1.2],
      ['bridleway', 'both'],
      ['plantingStrip', 'none', 0.9],
      ['footpath', 'both', 2.0],
      ['verge', 'none', 1.2],
    ],
  },
  {
    id: 'path-park',
    label: 'Park path',
    note: 'walking only, planted both sides',
    category: 'path',
    family: `Walking`,
    specs: [
      ['plantingStrip', 'none', 1.8],
      ['footpath', 'both', 2.4],
      ['plantingStrip', 'none', 1.8],
    ],
  },
  {
    id: 'path-promenade',
    label: 'Promenade',
    note: 'a walking street in its own right, not a route between two places',
    category: 'path',
    family: `Walking`,
    specs: [
      ['verge', 'none', 1.2],
      ['footpath', 'both', 6.0],
      ['furnitureZone', 'none', 2.4],
      ['verge', 'none', 1.2],
    ],
  },
  {
    id: 'path-quiet-lane',
    label: 'Quiet lane',
    note: 'a single-track lane where walking and cycling take priority over the car',
    category: 'path',
    family: `Structure and lane`,
    specs: [
      ['verge', 'none', 1.2],
      ['woonerf', 'both', 4.0],
      ['verge', 'none', 1.2],
    ],
  },

  // -------------------------------------------------------------------- downtown
  {
    id: 'downtown-cafe-street',
    label: 'Cafe street',
    note: 'one lane, wide walking zones, dining in the old parking bays',
    category: 'downtown',
    family: `Named downtown streets`,
    specs: [
      walk(3.6),
      ['outdoorDining', 'none'],
      ['travelLane', 'forward', 3.0],
      ['loadingZone', 'none'],
      ['outdoorDining', 'none'],
      walk(3.6),
    ],
  },
  {
    id: 'downtown-shared-space',
    label: 'Shared space',
    note: 'no kerb line, no markings; works only where speeds are genuinely low',
    category: 'downtown',
    family: `Named downtown streets`,
    specs: [
      ['frontageZone', 'none'],
      ['sharedSpace', 'both', 7.0],
      ['frontageZone', 'none'],
    ],
  },
  {
    id: 'downtown-arcade',
    label: 'Arcaded street',
    note: 'sheltered footway that costs no street width',
    category: 'downtown',
    family: `Named downtown streets`,
    specs: [
      ['arcade', 'both'],
      ['furnitureZone', 'none'],
      ['parkingLaneParallel', 'none'],
      ['travelLane', 'backward', NARROW],
      ['travelLane', 'forward', NARROW],
      ['parkingLaneParallel', 'none'],
      ['furnitureZone', 'none'],
      ['arcade', 'both'],
    ],
  },

  // --------------------------------------------------------------------- special
  {
    id: 'special-school-street',
    label: 'School street',
    note: 'closed to through traffic at drop-off and pick-up',
    category: 'special',
    family: `One of a kind`,
    specs: [
      walk(3.0),
      ['playStreet', 'both'],
      walk(3.0),
    ],
  },
  {
    id: 'special-freight',
    label: 'Freight street',
    note: 'wide lanes and real loading, because the deliveries happen either way',
    category: 'special',
    family: `One of a kind`,
    specs: [
      walk(2.4),
      ['loadingZone', 'none', 3.6],
      ['travelLane', 'backward', 3.65],
      ['travelLane', 'forward', 3.65],
      ['loadingZone', 'none', 3.6],
      walk(2.4),
    ],
  },
  {
    id: 'special-floating-stop',
    label: 'Floating bus stop',
    note: 'the bike lane passes behind the stop instead of through it',
    category: 'special',
    family: `One of a kind`,
    specs: [
      walk(),
      ['bikeLaneProtected', 'backward'],
      ['busIsland', 'none'],
      ['busLane', 'backward'],
      ['travelLane', 'backward', NARROW],
      ['travelLane', 'forward', NARROW],
      ['busLane', 'forward'],
      ['busIsland', 'none'],
      ['bikeLaneProtected', 'forward'],
      walk(),
    ],
  },
  {
    id: 'special-advisory',
    label: 'Advisory bike lanes',
    note: 'dashed lanes either side of one shared space; drivers yield to enter',
    category: 'special',
    family: `One of a kind`,
    specs: [
      walk(2.4),
      ['bikeLaneAdvisory', 'backward'],
      ['sharedLane', 'both', 4.2],
      ['bikeLaneAdvisory', 'forward'],
      walk(2.4),
    ],
  },
  {
    id: 'special-bike-boulevard',
    label: 'Bicycle boulevard',
    note: 'a local street where through traffic is filtered out and bikes are the priority',
    category: 'special',
    family: `One of a kind`,
    specs: [
      walk(2.4),
      ['parkingLaneParallel', 'none'],
      ['sharedLane', 'both', 5.5],
      ['parkingLaneParallel', 'none'],
      walk(2.4),
    ],
  },
  {
    id: 'special-frontage',
    label: 'Highway with frontage roads',
    note: 'the arrangement that doubles the crossings a pedestrian faces',
    category: 'highway',
    family: `Frontage`,
    specs: [
      walk(2.4),
      ['frontageRoad', 'both'],
      ['verge', 'none', 3.0],
      ['shoulder', 'none', 3.0],
      ['freewayLane', 'backward'],
      ['freewayLane', 'backward'],
      ['shoulderInner', 'none'],
      ['barrier', 'none'],
      ['shoulderInner', 'none'],
      ['freewayLane', 'forward'],
      ['freewayLane', 'forward'],
      ['shoulder', 'none', 3.0],
      ['verge', 'none', 3.0],
      ['frontageRoad', 'both'],
      walk(2.4),
    ],
  },
  {
    id: 'ramp-1',
    label: 'Ramp, single lane',
    note: 'a diamond ramp; the shoulder either side is not optional',
    category: 'highway',
    family: `Ramps`,
    specs: [
      ['guardrail', 'none'],
      ['shoulder', 'none', 1.2],
      ['rampLane', 'forward'],
      ['shoulder', 'none', 2.4],
      ['guardrail', 'none'],
    ],
  },
  {
    id: 'ramp-2',
    label: 'Ramp, two lanes',
    note: 'a two-lane exit, usually where the ramp meets a signalised arterial',
    category: 'highway',
    family: `Ramps`,
    specs: [
      ['guardrail', 'none'],
      ['shoulder', 'none', 1.2],
      ['rampLane', 'forward'],
      ['rampLane', 'forward'],
      ['shoulder', 'none', 2.4],
      ['guardrail', 'none'],
    ],
  },
  {
    id: 'ramp-diverge',
    label: 'Exit with gore',
    note: 'the deceleration lane and the painted gore beside it',
    category: 'highway',
    family: `Ramps`,
    specs: [
      ['shoulderInner', 'none'],
      ['freewayLane', 'forward'],
      ['freewayLane', 'forward'],
      ['decelerationLane', 'forward'],
      ['gore', 'none'],
      ['rampLane', 'forward'],
      ['shoulder', 'none', 2.4],
    ],
  },
  {
    id: 'ramp-weave',
    label: 'Weaving section',
    note: 'an entrance and the next exit sharing a length of road',
    category: 'highway',
    family: `Ramps`,
    specs: [
      ['shoulderInner', 'none'],
      ['freewayLane', 'forward'],
      ['freewayLane', 'forward'],
      ['weavingLane', 'forward'],
      ['auxiliaryLane', 'forward'],
      ['shoulder', 'none', 3.0],
    ],
  },
  {
    id: 'rural-climbing',
    label: 'Rural 2 lane + climbing lane',
    note: 'an extra uphill lane so slow vehicles do not hold up the rest',
    category: 'rural',
    family: `Two lane`,
    specs: [
      ['ditch', 'none'],
      ['shoulder', 'none', 1.2],
      ['travelLane', 'backward', 3.35],
      ['travelLane', 'forward', 3.35],
      ['climbingLane', 'forward'],
      ['shoulder', 'none', 1.2],
      ['ditch', 'none'],
    ],
  },
  {
    id: 'rural-alley',
    label: 'Alley',
    note: 'the cheapest space left in most cities',
    category: 'residential',
    family: `Local street`,
    specs: [['alley', 'both']],
  },
  {
    id: 'existing-stroad',
    label: 'Existing — 4 lanes + center turn',
    note: 'as built',
    category: 'existing',
    family: `Named streets`,
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
    family: `Named diets`,
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
    family: `Named transit streets`,
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
    family: `Named bikeways`,
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
    family: `Named diets`,
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
    family: `Local street`,
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
    family: `Named downtown streets`,
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
    family: `Named downtown streets`,
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
    family: `Named downtown streets`,
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
    family: `Named bikeways`,
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
    family: `Named downtown streets`,
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
    family: `Named downtown streets`,
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
    family: `Named transit streets`,
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
    family: `Centre-running`,
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
    family: `Centre-running`,
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
    family: `Named bikeways`,
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
    family: `Named bikeways`,
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
    family: `Named bikeways`,
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
    family: `Named highways`,
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
    family: `Named highways`,
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
    family: `Named highways`,
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
    family: `Named highways`,
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
    family: `Named highways`,
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
    family: `Two lane`,
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
    family: `Two lane`,
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
    family: `Two lane`,
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
    family: `One of a kind`,
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
    family: `One of a kind`,
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
    family: `One of a kind`,
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
    family: `One of a kind`,
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
  // A saved section is copied whole, with fresh component ids so two streets sharing a
  // preset never alias each other's bands — the same guarantee `componentsFromSpecs` gives
  // for a generated one.
  if (template.section) {
    return {
      id: newId('sec'),
      name: template.section.name || template.label,
      anchorOffsetMeters: template.section.anchorOffsetMeters,
      components: template.section.components.map((component) => ({
        ...component,
        id: newId('cmp'),
      })),
    };
  }

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
/**
 * The presets as a two-level tree: category, then family.
 *
 * Derived from the data for the same reason the primitive tree is — a preset that belongs
 * to no listed family would simply vanish from the browser, and nothing would say so.
 */
export function templateTree(
  templates: readonly TemplateDef[] = TEMPLATES,
): { category: TemplateCategory; label: string; groups: { label: string; items: TemplateDef[] }[] }[] {
  return TEMPLATE_CATEGORIES.map((category) => {
    const members = templates.filter((template) => template.category === category.id);
    const groups: { label: string; items: TemplateDef[] }[] = [];
    for (const template of members) {
      const existing = groups.find((group) => group.label === template.family);
      if (existing) existing.items.push(template);
      else groups.push({ label: template.family, items: [template] });
    }
    return { category: category.id, label: category.label, groups };
  }).filter((entry) => entry.groups.length > 0);
}

export function searchTemplates(
  query: string,
  templates: readonly TemplateDef[] = TEMPLATES,
): TemplateDef[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...templates];
  return templates.filter((template) => {
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
