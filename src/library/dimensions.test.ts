import { describe, expect, it } from 'vitest';
import { COMPONENT_TYPES, PRIMITIVES } from './primitives';
import { TEMPLATES, instantiateTemplate, templateTotalWidth } from './templates';
import { bandsForStreet } from '../geo/banding';
import { totalWidth, travelwayWidth } from '../model/section';
import { METRES_PER_FOOT, metresToDisplay } from '../lib/units';
import { createDemoStreets } from '../demo/washingtonPark';
import type { LngLat } from '../geo/projection';
import type { CrossSection } from '../model/types';

/**
 * A dimensional audit: does every primitive, template and demo street measure on screen
 * what it claims to measure?
 *
 * The banding engine is already proven to put a 3.0 m band at 3.0 m, on any bearing. This
 * suite tests the other half of the question, which is just as easy to get wrong and much
 * harder to notice: whether the *numbers themselves* are the right numbers. A geometrically
 * perfect 9 ft lane traced over a real 11 ft one is still wrong, and it is wrong in the
 * direction that flatters a redesign — the design looks like it fits when it does not.
 *
 * Widths are measured independently, with a haversine rather than the projection under
 * test, so a scale error in the projection cannot hide by being applied to both sides.
 */

const R = 6371008.8;
const D2R = Math.PI / 180;

function haversine(a: LngLat, b: LngLat): number {
  const dLat = (b[1] - a[1]) * D2R;
  const dLng = (b[0] - a[0]) * D2R;
  const lat1 = a[1] * D2R;
  const lat2 = b[1] * D2R;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function frameAt(origin: LngLat) {
  const d = 0.001;
  const mLat = haversine(origin, [origin[0], origin[1] + d]) / d;
  const mLng = haversine(origin, [origin[0] + d, origin[1]]) / d;
  return (p: LngLat) => ({ x: (p[0] - origin[0]) * mLng, y: (p[1] - origin[1]) * mLat });
}

function ringAreaM2(ring: readonly LngLat[], origin: LngLat): number {
  const f = frameAt(origin);
  const pts = ring.map(f);
  let sum = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    sum += pts[i]!.x * pts[i + 1]!.y - pts[i + 1]!.x * pts[i]!.y;
  }
  return Math.abs(sum / 2);
}

const CINCY: LngLat = [-84.5194, 39.1096];
/** A 400 m line, deliberately not axis-aligned, so an axis-only bug cannot pass. */
const LINE: LngLat[] = [CINCY, [-84.5194 + 0.0026, 39.1096 + 0.0026]];

/** Area over length: robust to vertex order, unlike picking two corners. */
function renderedWidths(section: CrossSection): number[] {
  const { bands } = bandsForStreet('audit', LINE, section);
  const length = haversine(LINE[0]!, LINE[1]!);
  return bands.map((band) => {
    const ring =
      band.geometry.type === 'Polygon'
        ? (band.geometry.coordinates[0] as LngLat[])
        : (band.geometry.coordinates[0]![0] as LngLat[]);
    return ringAreaM2(ring, CINCY) / length;
  });
}

const ft = (metres: number) => metresToDisplay(metres, 'ft');

describe('every primitive renders at the width it claims', () => {
  for (const type of COMPONENT_TYPES) {
    const spec = PRIMITIVES[type];

    it(`${spec.label} draws ${ft(spec.defaultWidthMeters).toFixed(1)} ft`, () => {
      const section: CrossSection = {
        id: 's',
        name: 't',
        anchorOffsetMeters: null,
        components: [
          { id: 'c', componentType: type, widthMeters: spec.defaultWidthMeters, direction: 'none' },
        ],
      };
      const [width] = renderedWidths(section);
      expect(width).toBeDefined();
      // 0.5% absorbs the haversine sphere against the WGS84 ellipsoid, nothing more.
      expect(Math.abs(width! - spec.defaultWidthMeters) / spec.defaultWidthMeters).toBeLessThan(
        0.005,
      );
    });
  }
});

describe('every default is a number you would actually measure', () => {
  // The audit proper. These ranges are as-built typicals, not design recommendations:
  // the neutral starting value has to match what is under the imagery, or tracing a real
  // street produces bands narrower than the pavement and the fit check lies in the
  // redesign's favour.
  for (const type of COMPONENT_TYPES) {
    const spec = PRIMITIVES[type];

    it(`${spec.label} sits inside its ${spec.typicalRangeFeet[0]}–${spec.typicalRangeFeet[1]} ft typical range`, () => {
      const feet = ft(spec.defaultWidthMeters);
      expect(feet).toBeGreaterThanOrEqual(spec.typicalRangeFeet[0] - 0.05);
      expect(feet).toBeLessThanOrEqual(spec.typicalRangeFeet[1] + 0.05);
    });

    it(`${spec.label} has a minimum below its default and above zero`, () => {
      expect(spec.minWidthMeters).toBeGreaterThan(0);
      expect(spec.minWidthMeters).toBeLessThanOrEqual(spec.defaultWidthMeters);
    });
  }

  it('puts a US travel lane at 11 ft, not at the 10 ft a guide would recommend', () => {
    // The specific number this whole audit exists for. NACTO recommends 10 ft; almost
    // every street you will trace was built at 11.
    expect(ft(PRIMITIVES.travelLane.defaultWidthMeters)).toBeCloseTo(11, 1);
  });

  it('treats a footway as the whole zone, not just the walking lane', () => {
    // 5 ft is the clear-width minimum on its own. A footway that measured 5 ft total
    // would leave a strip of imagery showing between the band and the buildings.
    expect(ft(PRIMITIVES.sidewalk.defaultWidthMeters)).toBeGreaterThanOrEqual(8);
  });
});

describe('templates add up', () => {
  for (const template of TEMPLATES) {
    it(`${template.label} renders the width it advertises`, () => {
      const section = instantiateTemplate(template);
      const widths = renderedWidths(section);
      const measured = widths.reduce((sum, w) => sum + w, 0);

      expect(widths).toHaveLength(section.components.length);
      expect(Math.abs(measured - templateTotalWidth(template)) / measured).toBeLessThan(0.005);
      expect(Math.abs(measured - totalWidth(section.components)) / measured).toBeLessThan(0.005);
    });
  }

  it('makes the existing stroad wider than every redesign of it', () => {
    // If a road diet did not come out narrower than what it replaces, the tool would be
    // making an argument it cannot support.
    const existing = TEMPLATES.find((t) => t.id === 'existing-stroad')!;
    const retrofit = TEMPLATES.find((t) => t.id === 'protected-retrofit')!;
    expect(templateTotalWidth(retrofit)).toBeLessThan(templateTotalWidth(existing));
  });

  it('gives the existing stroad a realistic five-lane roadway', () => {
    // Five 11 ft lanes is 55 ft kerb to kerb. A stroad that measured 49 ft would be
    // quietly arguing that there is less to reclaim than there is.
    const section = instantiateTemplate(TEMPLATES.find((t) => t.id === 'existing-stroad')!);
    expect(ft(travelwayWidth(section.components))).toBeCloseTo(55, 0);
  });
});

describe('the demo streets are internally honest', () => {
  for (const street of createDemoStreets()) {
    it(`${street.name} fits the right-of-way it claims`, () => {
      const designed = totalWidth(street.section.components);
      expect(street.existingWidthMeters).toBeDefined();
      expect(designed).toBeLessThanOrEqual(street.existingWidthMeters!);
      // And not absurdly under: a design using half the street would be a modelling slip,
      // not a redesign.
      expect(designed).toBeGreaterThan(street.existingWidthMeters! * 0.85);
    });

    it(`${street.name} renders to its stated total`, () => {
      const { bands } = bandsForStreet(street.id, street.centerline, street.section);
      expect(bands).toHaveLength(street.section.components.length);

      const length = haversine(
        street.centerline[0]!,
        street.centerline[street.centerline.length - 1]!,
      );
      const measured = bands.reduce((sum, band) => {
        const ring =
          band.geometry.type === 'Polygon'
            ? (band.geometry.coordinates[0] as LngLat[])
            : (band.geometry.coordinates[0]![0] as LngLat[]);
        return sum + ringAreaM2(ring, street.centerline[0]!) / length;
      }, 0);

      const declared = totalWidth(street.section.components);
      expect(Math.abs(measured - declared) / declared).toBeLessThan(0.01);
    });
  }
});

describe('unit conversion at the display boundary', () => {
  it('is exact, so a width does not drift by round-tripping through feet', () => {
    // Every width in the UI is entered in feet and stored in metres. A lossy conversion
    // would make 11.0 ft become 3.3528 m become 10.999 ft and creep on every edit.
    expect(METRES_PER_FOOT).toBe(0.3048);
    for (const type of COMPONENT_TYPES) {
      const metres = PRIMITIVES[type].defaultWidthMeters;
      expect(ft(metres) * METRES_PER_FOOT).toBeCloseTo(metres, 12);
    }
  });
});
