import { z } from 'zod';
import { COMPONENT_TYPES, DIRECTIONS, PRIMITIVES } from '../library/primitives';
import { GLYPH_IDS } from '../geo/glyphs';
import { STRIPE_STYLES } from '../geo/markings';
import type { CrossSection, SectionComponent } from './types';
import { newId } from './types';

/**
 * Validation for the asset interchange format.
 *
 * Uploads are the one place untrusted data enters GeoStripe, and the brief was explicit:
 * fail gracefully on unknown types rather than crashing. Zod gives readable, path-aware
 * errors for free, and the schema doubles as the format's documentation.
 */

export const ASSET_FILE_VERSION = 1;

/** One band, as it appears in both asset files and project files. */
export const componentSchema = z.object({
  componentType: z.enum(COMPONENT_TYPES),
  widthMeters: z.number().finite().positive().max(100),
  direction: z.enum(DIRECTIONS).optional(),
  colorOverride: z.string().optional(),
  /**
   * Markings. Both are overrides of a derived default, so absent and present-but-equal to
   * the default mean different things and both have to survive a round trip: `'none'` is
   * "I removed the bicycle", not "there was never one".
   */
  glyph: z.enum(['none', ...GLYPH_IDS]).optional(),
  glyphSpacingMeters: z.number().finite().min(2).max(400).optional(),
  stripeLeft: z.enum(STRIPE_STYLES).optional(),
});

export const assetFileSchema = z.object({
  /** Version marker and format discriminator in one — a file without it is not ours. */
  geostripeAsset: z.literal(ASSET_FILE_VERSION),
  name: z.string().min(1).max(120),
  anchorOffsetMeters: z.number().finite().nullable().optional(),
  components: z.array(componentSchema).min(1).max(64),
});

export type AssetFile = z.infer<typeof assetFileSchema>;

export type ParseResult =
  | { ok: true; section: CrossSection; warnings: string[] }
  | { ok: false; errors: string[] };

/** Turn Zod's issue list into messages that name the field a person can actually fix. */
function describe(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length ? issue.path.join('.') : 'file';

    if (issue.code === 'invalid_value' && path === 'geostripeAsset') {
      return `This is not a GeoStripe asset file (missing "geostripeAsset": ${ASSET_FILE_VERSION}).`;
    }
    if (issue.code === 'invalid_value' && path.includes('componentType')) {
      return `${path}: unknown component type. Known types: ${COMPONENT_TYPES.join(', ')}.`;
    }
    return `${path}: ${issue.message}`;
  });
}

/**
 * Parse asset JSON into a CrossSection.
 *
 * Ids are minted fresh here rather than read from the file: they are runtime identity,
 * and trusting ids from an uploaded file invites collisions with what is already open.
 */
export function parseAssetFile(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['That file is not valid JSON.'] };
  }

  const result = assetFileSchema.safeParse(raw);
  if (!result.success) {
    return { ok: false, errors: describe(result.error) };
  }

  const file = result.data;
  const warnings: string[] = [];

  const components = file.components.map((c) => {
    const spec = PRIMITIVES[c.componentType];
    if (c.widthMeters < spec.minWidthMeters) {
      warnings.push(
        `${spec.label} is ${c.widthMeters.toFixed(2)} m, below the ${spec.minWidthMeters} m typical minimum. Kept as given.`,
      );
    }
    return {
      id: newId('cmp'),
      componentType: c.componentType,
      widthMeters: c.widthMeters,
      direction: c.direction ?? spec.defaultDirection,
      ...(c.colorOverride ? { colorOverride: c.colorOverride } : {}),
      ...(c.glyph ? { glyph: c.glyph as NonNullable<SectionComponent['glyph']> } : {}),
      ...(c.glyphSpacingMeters ? { glyphSpacingMeters: c.glyphSpacingMeters } : {}),
      ...(c.stripeLeft ? { stripeLeft: c.stripeLeft } : {}),
    };
  });

  return {
    ok: true,
    warnings,
    section: {
      id: newId('sec'),
      name: file.name,
      components,
      anchorOffsetMeters: file.anchorOffsetMeters ?? null,
    },
  };
}

/** Serialise a CrossSection to the interchange format, dropping runtime-only ids. */
export function toAssetFile(section: CrossSection): AssetFile {
  return {
    geostripeAsset: ASSET_FILE_VERSION,
    name: section.name,
    anchorOffsetMeters: section.anchorOffsetMeters,
    components: section.components.map((c) => ({
      componentType: c.componentType,
      widthMeters: Number(c.widthMeters.toFixed(4)),
      direction: c.direction,
      ...(c.colorOverride ? { colorOverride: c.colorOverride } : {}),
      ...(c.glyph ? { glyph: c.glyph } : {}),
      ...(c.glyphSpacingMeters ? { glyphSpacingMeters: c.glyphSpacingMeters } : {}),
      ...(c.stripeLeft ? { stripeLeft: c.stripeLeft } : {}),
    })),
  };
}
