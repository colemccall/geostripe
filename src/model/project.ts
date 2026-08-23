import { z } from 'zod';
import type { Feature, FeatureCollection } from 'geojson';
import { COMPONENT_TYPES, PRIMITIVES } from '../library/primitives';
import type { ComponentType, Direction } from '../library/primitives';
import { bandsForStreet } from '../geo/banding';
import { componentSchema } from './schema';
import type { Street } from './types';
import { newId } from './types';

/**
 * The project interchange format: plain GeoJSON, editable by hand and readable by QGIS.
 *
 * Two kinds of feature share one FeatureCollection, and the distinction is the whole
 * design:
 *
 *   geostripe: "street"   a centerline LineString carrying its cross-section in
 *                         properties. This is the parametric truth, and the only thing
 *                         read back on load.
 *   geostripe: "band"     the derived polygons. Written so the file is useful to anything
 *                         that reads GeoJSON, and deliberately DISCARDED on load — they
 *                         are a render product, and regenerating them is what keeps a
 *                         reopened project editable rather than frozen.
 *
 * Loading is deliberately forgiving. A file with one bad component type loses that street
 * and reports why rather than failing whole; a bare LineString with no GeoStripe
 * properties is imported as an unstyled centerline, which is what makes it possible to
 * drop in a way traced elsewhere — OSM, a survey, QGIS — and design on top of it.
 */

export const PROJECT_VERSION = 1;

const positionSchema = z
  .array(z.number().finite())
  .min(2)
  .refine((p) => Math.abs(p[0]!) <= 180 && Math.abs(p[1]!) <= 90, {
    message: 'coordinates must be [longitude, latitude] in degrees',
  });

const lineStringSchema = z.object({
  type: z.literal('LineString'),
  coordinates: z.array(positionSchema).min(2),
});

const streetPropertiesSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  visible: z.boolean().optional(),
  existingWidthMeters: z.number().finite().positive().max(300).optional(),
  sectionName: z.string().min(1).max(120).optional(),
  anchorOffsetMeters: z.number().finite().nullable().optional(),
  components: z.array(componentSchema).min(1).max(64),
});

const featureCollectionSchema = z.object({
  type: z.literal('FeatureCollection'),
  features: z.array(z.unknown()),
});

export interface ProjectMeta {
  name: string;
  generated: string;
  editorVersion: string;
}

export type ProjectParseResult =
  | { ok: true; streets: Street[]; warnings: string[] }
  | { ok: false; errors: string[] };

/** Field-level messages that name something a person can fix, not a Zod dump. */
function describe(error: z.ZodError, prefix: string): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length ? issue.path.join('.') : 'feature';
    if (issue.code === 'invalid_value' && path.includes('componentType')) {
      return `${prefix}: unknown component type at ${path}. Known types: ${COMPONENT_TYPES.join(', ')}.`;
    }
    return `${prefix}: ${path} — ${issue.message}`;
  });
}

// ---------------------------------------------------------------------------- writing

function round(value: number): number {
  return Number(value.toFixed(4));
}

export function toProjectGeoJSON(
  streets: readonly Street[],
  meta: Pick<ProjectMeta, 'name' | 'editorVersion'>,
): FeatureCollection {
  const features: Feature[] = [];

  for (const street of streets) {
    features.push({
      type: 'Feature',
      id: street.id,
      properties: {
        geostripe: 'street',
        name: street.name,
        visible: street.visible,
        ...(street.existingWidthMeters !== undefined
          ? { existingWidthMeters: round(street.existingWidthMeters) }
          : {}),
        sectionName: street.section.name,
        anchorOffsetMeters:
          street.section.anchorOffsetMeters === null
            ? null
            : round(street.section.anchorOffsetMeters),
        // Runtime ids are dropped: they are session identity, and honouring ids from a
        // file invites collisions with whatever is already open.
        components: street.section.components.map((c) => ({
          componentType: c.componentType,
          widthMeters: round(c.widthMeters),
          direction: c.direction,
          ...(c.colorOverride ? { colorOverride: c.colorOverride } : {}),
        })),
      },
      geometry: { type: 'LineString', coordinates: street.centerline },
    });
  }

  // Derived polygons, for anything downstream that just wants shapes.
  for (const street of streets) {
    if (!street.visible) continue;
    for (const band of bandsForStreet(street.id, street.centerline, street.section).bands) {
      features.push({
        ...band,
        properties: { ...band.properties, geostripe: 'band', streetName: street.name },
      } as Feature);
    }
  }

  const collection: FeatureCollection = { type: 'FeatureCollection', features };

  // A foreign member, which RFC 7946 allows for exactly this. Not a top-level
  // `properties`, which is not part of the spec and gets dropped by strict readers.
  return Object.assign(collection, {
    metadata: {
      geostripeProject: PROJECT_VERSION,
      name: meta.name,
      editorVersion: meta.editorVersion,
      generated: new Date().toISOString(),
    },
  });
}

export function serializeProject(
  streets: readonly Street[],
  meta: Pick<ProjectMeta, 'name' | 'editorVersion'>,
): string {
  return `${JSON.stringify(toProjectGeoJSON(streets, meta), null, 2)}\n`;
}

export function projectFilename(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'geostripe-project'}.geojson`;
}

// ---------------------------------------------------------------------------- reading

interface ParsedComponent {
  componentType: ComponentType;
  widthMeters: number;
  direction: Direction;
  colorOverride?: string;
}

/** Section applied to a LineString that carries no GeoStripe properties of its own. */
export interface ImportDefaults {
  sectionName: string;
  components: readonly {
    componentType: ComponentType;
    widthMeters: number;
    direction?: Direction;
  }[];
}

function makeStreet(
  name: string,
  centerline: [number, number][],
  sectionName: string,
  components: readonly ParsedComponent[],
  anchorOffsetMeters: number | null,
  existingWidthMeters: number | undefined,
  visible: boolean,
): Street {
  return {
    id: newId('st'),
    name,
    centerline,
    visible,
    ...(existingWidthMeters !== undefined ? { existingWidthMeters } : {}),
    section: {
      id: newId('sec'),
      name: sectionName,
      anchorOffsetMeters,
      components: components.map((c) => ({ id: newId('cmp'), ...c })),
    },
  };
}

export function parseProject(text: string, defaults: ImportDefaults): ProjectParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['That file is not valid JSON.'] };
  }

  const outer = featureCollectionSchema.safeParse(raw);
  if (!outer.success) {
    return { ok: false, errors: ['That file is not a GeoJSON FeatureCollection.'] };
  }

  const streets: Street[] = [];
  const warnings: string[] = [];
  let bandsDropped = 0;
  let skipped = 0;

  outer.data.features.forEach((entry, index) => {
    const feature = entry as { properties?: Record<string, unknown>; geometry?: unknown };
    const props = feature.properties ?? {};
    const kind = props['geostripe'];
    const label = `Feature ${index + 1}`;

    // Derived geometry is regenerated from the centerline, never read back.
    if (kind === 'band' || props['featureClass'] === 'band' || props['featureClass'] === 'marking') {
      bandsDropped++;
      return;
    }

    const geometry = lineStringSchema.safeParse(feature.geometry);
    if (!geometry.success) {
      // Points and polygons that are not ours are simply not part of a project.
      skipped++;
      return;
    }

    const centerline = geometry.data.coordinates.map(
      (position) => [position[0]!, position[1]!] as [number, number],
    );

    if (kind !== 'street' && props['components'] === undefined) {
      // A plain line — import it with the default section so it can be designed on.
      const name =
        typeof props['name'] === 'string' && props['name'].trim()
          ? props['name']
          : `Imported line ${streets.length + 1}`;
      streets.push(
        makeStreet(
          name,
          centerline,
          defaults.sectionName,
          defaults.components.map((c) => ({
            componentType: c.componentType,
            widthMeters: c.widthMeters,
            direction: c.direction ?? PRIMITIVES[c.componentType].defaultDirection,
          })),
          null,
          undefined,
          true,
        ),
      );
      warnings.push(`${label}: plain LineString — imported with the ${defaults.sectionName} section.`);
      return;
    }

    const parsed = streetPropertiesSchema.safeParse(props);
    if (!parsed.success) {
      warnings.push(...describe(parsed.error, label));
      skipped++;
      return;
    }

    const data = parsed.data;
    streets.push(
      makeStreet(
        data.name ?? `Street ${streets.length + 1}`,
        centerline,
        data.sectionName ?? data.name ?? 'Cross-section',
        data.components.map((c) => ({
          componentType: c.componentType,
          widthMeters: c.widthMeters,
          direction: c.direction ?? PRIMITIVES[c.componentType].defaultDirection,
          ...(c.colorOverride ? { colorOverride: c.colorOverride } : {}),
        })),
        data.anchorOffsetMeters ?? null,
        data.existingWidthMeters,
        data.visible ?? true,
      ),
    );
  });

  if (streets.length === 0) {
    return {
      ok: false,
      errors: [
        'No street centerlines found in that file.',
        ...warnings,
        'A project needs LineString features. Polygons alone are not enough — GeoStripe rebuilds those from the centerline.',
      ],
    };
  }

  if (bandsDropped > 0) {
    warnings.push(
      `${bandsDropped} derived polygon${bandsDropped === 1 ? '' : 's'} discarded and rebuilt from the centerlines.`,
    );
  }
  if (skipped > 0) {
    warnings.push(`${skipped} feature${skipped === 1 ? '' : 's'} skipped — not a street centerline.`);
  }

  return { ok: true, streets, warnings };
}
