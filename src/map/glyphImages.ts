import { GLYPHS, GLYPH_IDS } from '../geo/glyphs';
import type { GlyphId } from '../geo/glyphs';
import { PAINT_WHITE } from '../geo/markings';

/**
 * Pavement symbols, rasterised once and handed to MapLibre as images.
 *
 * The glyphs are authored as polygons in real metres, in a lane-local frame, and that is
 * still what they are — the arrows are the right length because MUTCD says so, not because
 * they looked right. What changed is when they become pixels. The old renderer built the
 * polygons at every placement, on every frame, in world coordinates: a bike symbol every
 * twenty metres along a cycle track is a few hundred polygons for one street, rebuilt
 * whenever anything moved.
 *
 * Here each glyph is drawn once into an image at a known scale, and a symbol layer places
 * it. Repeating it a thousand times then costs a thousand points, and the GPU does the
 * rotation. `icon-size` scales the image back to metres at the current zoom by exactly the
 * arithmetic the line widths use, so a 3 m through-arrow is still 3 m long.
 *
 * The one thing that does not survive is a glyph whose shape depends on the lane it is in —
 * a few of them span the lane width. Those are rasterised at a representative width and
 * scaled, which is a real approximation and the reason the width is stated here rather than
 * hidden.
 */

/**
 * Pixels per metre in the rasterised image.
 *
 * High enough that a 3 m arrow is 96 px and stays crisp when the map is zoomed in past the
 * scale it was drawn for; low enough that nineteen of them cost little memory.
 */
export const IMAGE_PX_PER_METRE = 32;

/** Lane width the lane-spanning glyphs are drawn for. */
const REFERENCE_LANE_METRES = 3.3;

/** Padding round the image, so a rotated symbol is never clipped by its own bounds. */
const PAD_PX = 2;

export interface GlyphImage {
  id: GlyphId;
  data: ImageData;
  widthPx: number;
  heightPx: number;
}

/**
 * Draw one glyph.
 *
 * The image is oriented with the direction of travel pointing UP, so the symbol layer's
 * `icon-rotate` can be fed a compass bearing directly. The glyph's own frame has +x along
 * travel, so the two axes are swapped on the way in — which is the entire transform, and
 * worth being explicit about because getting it wrong rotates every arrow ninety degrees
 * and looks deliberate.
 */
export function renderGlyph(id: GlyphId, canvas: HTMLCanvasElement): GlyphImage | null {
  const spec = GLYPHS[id];
  const polygons = spec.build(REFERENCE_LANE_METRES);
  if (polygons.length === 0) return null;

  const widthPx = Math.ceil(spec.widthMeters * IMAGE_PX_PER_METRE) + PAD_PX * 2;
  const heightPx = Math.ceil(spec.lengthMeters * IMAGE_PX_PER_METRE) + PAD_PX * 2;

  canvas.width = widthPx;
  canvas.height = heightPx;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.clearRect(0, 0, widthPx, heightPx);
  ctx.fillStyle = PAINT_WHITE;

  const centreX = widthPx / 2;
  const centreY = heightPx / 2;

  // A glyph is a list of polygons, each an outer ring followed by its holes. Filling each
  // polygon's rings in one path with the even-odd rule is what makes a hole a hole — the
  // counter of a bicycle wheel, say — without any boolean work.
  for (const polygon of polygons) {
    ctx.beginPath();
    for (const ring of polygon) {
      ring.forEach(([along, across], i) => {
        // Travel (+x in the glyph frame) points up the image, so it becomes -y in canvas
        // coordinates; across the lane becomes x.
        const x = centreX + across * IMAGE_PX_PER_METRE;
        const y = centreY - along * IMAGE_PX_PER_METRE;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
    }
    ctx.fill('evenodd');
  }

  return { id, data: ctx.getImageData(0, 0, widthPx, heightPx), widthPx, heightPx };
}

/**
 * Render every glyph.
 *
 * Returns what it managed rather than throwing: a browser without a 2D context is not a
 * reason for the map to fail to load, and a design missing its bicycle symbols is still a
 * design. Callers add whatever comes back.
 */
export function renderAllGlyphs(): GlyphImage[] {
  if (typeof document === 'undefined') return [];
  const canvas = document.createElement('canvas');
  const out: GlyphImage[] = [];

  for (const id of GLYPH_IDS) {
    try {
      const image = renderGlyph(id, canvas);
      if (image) out.push(image);
    } catch {
      // One unbuildable glyph must not cost the other eighteen.
    }
  }

  return out;
}
