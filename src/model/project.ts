import { z } from 'zod';
import type { Feature, FeatureCollection } from 'geojson';
import { COMPONENT_TYPES, PRIMITIVES } from '../library/primitives';
import type { ComponentType, Direction } from '../library/primitives';
import { bandsForStreet } from '../geo/banding';
import { componentSchema } from './schema';
import type { Area, JunctionNode, SectionComponent, Street } from './types';
import { newId } from './types';
import type { JunctionOverride } from '../geo/derived';
import { MOVEMENTS } from '../geo/markings';
import { closeRing, resolveCenterline, resolveRing } from '../geo/curve';
import type { CurveSettings } from '../geo/curve';
import { LANDCOVER_TYPES } from '../library/landcover';

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

const curveSchema = z.object({
  mode: z.enum(['straight', 'rounded', 'smooth']),
  radiusMeters: z.number().finite().min(0).max(2000),
  sharpVertices: z.array(z.number().int().min(0).max(9999)).max(4096).optional(),
});

const streetPropertiesSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  curve: curveSchema.optional(),
  level: z.number().int().min(-5).max(5).optional(),
  visible: z.boolean().optional(),
  existingWidthMeters: z.number().finite().positive().max(300).optional(),
  sectionName: z.string().min(1).max(120).optional(),
  anchorOffsetMeters: z.number().finite().nullable().optional(),
  components: z.array(componentSchema).min(1).max(64),
});

const polygonSchema = z.object({
  type: z.literal('Polygon'),
  coordinates: z.array(z.array(positionSchema).min(4)).min(1),
});

const areaPropertiesSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  landcover: z.enum(LANDCOVER_TYPES),
  visible: z.boolean().optional(),
  curve: curveSchema.optional(),
});

const featureCollectionSchema = z.object({
  type: z.literal('FeatureCollection'),
  features: z.array(z.unknown()),
  metadata: z
    .object({
      junctions: z
        .record(
          z.string(),
          z.object({
            form: z.enum(['intersection', 'merge', 'continuation']).optional(),
            yieldLine: z.boolean().optional(),
            corners: z
              .array(
                z
                  .object({
                    radiusMeters: z.number().finite().min(0).max(60).nullable().optional(),
                    treatment: z.enum(['plain', 'bulbOut']).optional(),
                    bulbOutMeters: z.number().finite().min(0).max(20).optional(),
                    daylightMeters: z.number().finite().min(0).max(60).optional(),
                  })
                  .nullable(),
              )
              .max(24)
              .optional(),
            legs: z
              .array(
                z
                  .object({
                    crosswalk: z
                      .object({
                        style: z.enum(['transverse', 'continental', 'ladder', 'raised']),
                        widthMeters: z.number().finite().min(0.5).max(20),
                        setbackMeters: z.number().finite().min(0).max(30),
                      })
                      .nullable()
                      .optional(),
                    stopBar: z.boolean().optional(),
                    stopOffsetMeters: z.number().finite().min(0).max(300).nullable().optional(),
                    lanes: z
                      .array(z.array(z.enum(MOVEMENTS)).max(4).nullable())
                      .max(64)
                      .optional(),
                    flare: z
                      .object({
                        side: z.enum(['left', 'right']),
                        componentType: z.enum(COMPONENT_TYPES),
                        widthMeters: z.number().finite().min(0).max(20),
                        storageMeters: z.number().finite().min(0).max(400),
                        taperMeters: z.number().finite().min(0).max(200),
                        movements: z.array(z.enum(MOVEMENTS)).max(4).optional(),
                      })
                      .nullable()
                      .optional(),
                  })
                  .nullable(),
              )
              .max(24)
              .optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});

export interface ProjectMeta {
  name: string;
  generated: string;
  editorVersion: string;
}

export type ProjectParseResult =
  | {
      ok: true;
      streets: Street[];
      areas: Area[];
      junctionOverrides: Record<string, JunctionOverride>;
      nodes: JunctionNode[];
      warnings: string[];
    }
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
  junctionOverrides: Readonly<Record<string, JunctionOverride>> = {},
  areas: readonly Area[] = [],
  nodes: readonly JunctionNode[] = [],
): FeatureCollection {
  const features: Feature[] = [];

  // Land cover first, so a reader that respects document order draws the ground before
  // the streets that sit on it.
  for (const area of areas) {
    features.push({
      type: 'Feature',
      id: area.id,
      properties: {
        geostripe: 'area',
        name: area.name,
        landcover: area.landcover,
        visible: area.visible,
        ...(area.curve && area.curve.mode !== 'straight' ? { curve: area.curve } : {}),
      },
      // CONTROL points, not the resolved edge. This is the parametric truth and the only
      // thing read back, exactly as a street's geometry is its centerline rather than its
      // bands — writing the tessellated ring here would discard the control points on the
      // next load and freeze the curve.
      //
      // Closed for GeoJSON; stored unclosed, because repeating the first point would mean
      // every edit had to keep two copies of one vertex in step.
      geometry: { type: 'Polygon', coordinates: [closeRing(area.ring)] },
    });

    // The resolved edge rides along for external readers, like the band polygons do, and
    // is discarded on load. Only worth writing when it differs from the control ring.
    if (area.visible && area.curve && area.curve.mode !== 'straight') {
      features.push({
        type: 'Feature',
        id: `${area.id}:shape`,
        properties: {
          geostripe: 'areaShape',
          areaId: area.id,
          landcover: area.landcover,
          name: area.name,
        },
        geometry: { type: 'Polygon', coordinates: [closeRing(resolveRing(area))] },
      });
    }
  }

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
        // Control points plus how they are joined. The dense line is derived, exactly like
        // the bands, so a curved street stays as editable after a round-trip as before it.
        ...(street.curve && street.curve.mode !== 'straight' ? { curve: street.curve } : {}),
        ...(street.level ? { level: street.level } : {}),
        anchorOffsetMeters:
          street.section.anchorOffsetMeters === null
            ? null
            : round(street.section.anchorOffsetMeters),
        // Component ids are dropped — they are session identity and nothing refers to
        // them across a save. The street id above is written and honoured, because
        // junction keys are built from it.
        components: street.section.components.map((c) => ({
          componentType: c.componentType,
          widthMeters: round(c.widthMeters),
          direction: c.direction,
          ...(c.colorOverride ? { colorOverride: c.colorOverride } : {}),
          ...(c.glyph ? { glyph: c.glyph } : {}),
          ...(c.glyphSpacingMeters ? { glyphSpacingMeters: round(c.glyphSpacingMeters) } : {}),
          ...(c.stripeLeft ? { stripeLeft: c.stripeLeft } : {}),
        })),
      },
      geometry: { type: 'LineString', coordinates: street.centerline },
    });
  }

  // Placed intersections. Real features rather than metadata, because a node is part of
  // the design — QGIS should see it, and a plain Point with these properties can be
  // authored by hand.
  for (const node of nodes) {
    features.push({
      type: 'Feature',
      id: node.id,
      properties: {
        geostripe: 'node',
        ...(node.name ? { name: node.name } : {}),
        ...(node.reachMeters !== undefined ? { reachMeters: round(node.reachMeters) } : {}),
        ...(node.disabled ? { disabled: true } : {}),
      },
      geometry: { type: 'Point', coordinates: node.position },
    });
  }

  // Derived polygons, for anything downstream that just wants shapes.
  //
  // Built from the RESOLVED line, not the control points. A curved street whose exported
  // polygons followed its control polygon would open in QGIS as a different street from
  // the one on screen — straight where the design curves.
  for (const street of streets) {
    if (!street.visible) continue;
    for (const band of bandsForStreet(street.id, resolveCenterline(street), street.section).bands) {
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
      // Junctions are derived from where the centerlines cross, so there is nothing to
      // store about them except what somebody deliberately changed. The keys are built
      // from street ids, which is why those ids are written above and honoured on load.
      ...(Object.keys(junctionOverrides).length > 0 ? { junctions: junctionOverrides } : {}),
    },
  });
}

export function serializeProject(
  streets: readonly Street[],
  meta: Pick<ProjectMeta, 'name' | 'editorVersion'>,
  junctionOverrides: Readonly<Record<string, JunctionOverride>> = {},
  areas: readonly Area[] = [],
  nodes: readonly JunctionNode[] = [],
): string {
  return `${JSON.stringify(
    toProjectGeoJSON(streets, meta, junctionOverrides, areas, nodes),
    null,
    2,
  )}\n`;
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

type ParsedComponent = Omit<SectionComponent, 'id'>;

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
  id: string,
  name: string,
  centerline: [number, number][],
  sectionName: string,
  components: readonly ParsedComponent[],
  anchorOffsetMeters: number | null,
  existingWidthMeters: number | undefined,
  visible: boolean,
  curve?: CurveSettings,
  level?: number,
): Street {
  return {
    id,
    name,
    centerline,
    visible,
    ...(curve ? { curve } : {}),
    ...(level ? { level } : {}),
    ...(existingWidthMeters !== undefined ? { existingWidthMeters } : {}),
    section: {
      id: newId('sec'),
      name: sectionName,
      anchorOffsetMeters,
      components: components.map<SectionComponent>((c) => ({ id: newId('cmp'), ...c })),
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
  const nodes: JunctionNode[] = [];
  const areas: Area[] = [];
  const warnings: string[] = [];
  let bandsDropped = 0;
  let skipped = 0;
  let idsRebuilt = 0;

  /**
   * Street ids are read back from the file rather than minted fresh.
   *
   * They are not merely cosmetic any more: a junction's stable key is built from the ids
   * of the streets that meet there, so discarding them would silently drop every corner
   * radius on load. Loading replaces the whole project, so there is nothing already open
   * for a file id to collide with — but a file that repeats an id within itself would
   * fuse two streets into one, so uniqueness is still enforced here.
   */
  const usedIds = new Set<string>();
  const claimId = (raw: unknown): string => {
    if (typeof raw === 'string' && raw.length > 0 && raw.length <= 80 && !usedIds.has(raw)) {
      usedIds.add(raw);
      return raw;
    }
    if (raw !== undefined && raw !== null) idsRebuilt++;
    let id = newId('st');
    while (usedIds.has(id)) id = newId('st');
    usedIds.add(id);
    return id;
  };

  outer.data.features.forEach((entry, index) => {
    const feature = entry as {
      id?: unknown;
      properties?: Record<string, unknown>;
      geometry?: unknown;
    };
    const props = feature.properties ?? {};
    const kind = props['geostripe'];
    const label = `Feature ${index + 1}`;

    // Derived geometry is regenerated from the centerline, never read back.
    if (
      kind === 'band' ||
      kind === 'areaShape' ||
      props['featureClass'] === 'band' ||
      props['featureClass'] === 'marking'
    ) {
      bandsDropped++;
      return;
    }

    // A placed intersection. Read before anything geometric, because it is the one kind
    // of feature that is a Point.
    if (kind === 'node') {
      // The surrounding loop works on unvalidated features, so the geometry is unknown
      // here rather than a GeoJSON union. Narrowed by hand, once.
      const geometry = feature.geometry as { type?: string; coordinates?: unknown } | undefined;
      if (geometry?.type !== 'Point' || !Array.isArray(geometry.coordinates)) {
        warnings.push(`${label}: an intersection needs a Point geometry.`);
        skipped++;
        return;
      }
      const [lng, lat] = geometry.coordinates as number[];
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
        skipped++;
        return;
      }
      nodes.push({
        id: claimId(feature.id),
        position: [lng!, lat!],
        ...(typeof props['name'] === 'string' && props['name'] ? { name: props['name'] } : {}),
        ...(typeof props['reachMeters'] === 'number' && Number.isFinite(props['reachMeters'])
          ? { reachMeters: props['reachMeters'] }
          : {}),
        ...(props['disabled'] === true ? { disabled: true } : {}),
      });
      return;
    }

    // Land cover: a polygon that says it is one. Anything else polygonal is not ours.
    if (kind === 'area') {
      const shape = polygonSchema.safeParse(feature.geometry);
      const props2 = areaPropertiesSchema.safeParse(props);
      if (!shape.success || !props2.success) {
        if (!props2.success) warnings.push(...describe(props2.error, label));
        else warnings.push(`${label}: land cover needs a Polygon geometry.`);
        skipped++;
        return;
      }

      // Drop the repeated closing point: rings are stored open.
      const outer = shape.data.coordinates[0]!;
      const ringPoints = outer
        .slice(0, outer.length - 1)
        .map((position) => [position[0]!, position[1]!] as [number, number]);
      if (ringPoints.length < 3) {
        skipped++;
        return;
      }

      areas.push({
        id: claimId(feature.id),
        name: props2.data.name ?? `Land ${areas.length + 1}`,
        landcover: props2.data.landcover,
        ring: ringPoints,
        visible: props2.data.visible ?? true,
        ...(props2.data.curve ? { curve: props2.data.curve } : {}),
      });
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
          claimId(feature.id),
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
        claimId(feature.id),
        data.name ?? `Street ${streets.length + 1}`,
        centerline,
        data.sectionName ?? data.name ?? 'Cross-section',
        data.components.map((c) => ({
          componentType: c.componentType,
          widthMeters: c.widthMeters,
          direction: c.direction ?? PRIMITIVES[c.componentType].defaultDirection,
          ...(c.colorOverride ? { colorOverride: c.colorOverride } : {}),
          ...(c.glyph ? { glyph: c.glyph as NonNullable<SectionComponent['glyph']> } : {}),
          ...(c.glyphSpacingMeters ? { glyphSpacingMeters: c.glyphSpacingMeters } : {}),
          ...(c.stripeLeft ? { stripeLeft: c.stripeLeft } : {}),
        })),
        data.anchorOffsetMeters ?? null,
        data.existingWidthMeters,
        data.visible ?? true,
        data.curve,
        data.level,
      ),
    );
  });

  if (streets.length === 0 && areas.length === 0) {
    return {
      ok: false,
      errors: [
        'No street centerlines or land cover found in that file.',
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
  if (idsRebuilt > 0) {
    warnings.push(
      `${idsRebuilt} street id${idsRebuilt === 1 ? ' was' : 's were'} duplicated and reassigned; any saved intersection corners on them fall back to defaults.`,
    );
  }

  // An override whose streets did not load would sit in state forever, matching nothing.
  const stored = outer.data.metadata?.junctions ?? {};
  const junctionOverrides: Record<string, JunctionOverride> = {};
  let orphaned = 0;
  const nodeIds = new Set(nodes.map((node) => node.id));
  for (const [key, value] of Object.entries(stored)) {
    // Two key shapes, and they are checked against different things. A placed
    // intersection is keyed by its node id and names no street at all; running it through
    // the street check would throw away the settings on every node in the file.
    if (key.startsWith('node:')) {
      if (nodeIds.has(key.slice(5))) junctionOverrides[key] = value;
      else orphaned++;
      continue;
    }
    const ids = key.split('#')[0]?.split('~') ?? [];
    if (ids.length > 0 && ids.every((id) => usedIds.has(id))) junctionOverrides[key] = value;
    else orphaned++;
  }
  if (orphaned > 0) {
    warnings.push(
      `${orphaned} saved intersection setting${orphaned === 1 ? '' : 's'} referenced streets that are not in this file.`,
    );
  }

  return { ok: true, streets, areas, nodes, junctionOverrides, warnings };
}
