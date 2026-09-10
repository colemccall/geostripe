import { describe, expect, it } from 'vitest';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import { designLayers, metresToPixels } from './paint';

/**
 * Validate the design layers against MapLibre's own style specification.
 *
 * This guards a failure that is silent, which is the only reason it is worth a test file
 * of its own. MapLibre does not throw on a layer whose paint expression is malformed — it
 * logs and drops the layer, and the map renders as bare imagery with the design missing.
 * Every width and every offset in this editor is now an expression rather than a computed
 * polygon, so the surface for that failure is the whole renderer.
 *
 * `validateStyleMin` is the same validator MapLibre runs internally, so a style that passes
 * here is one it will accept. That makes this a real check rather than a re-implementation
 * of the rules, which would drift.
 */

const LAT = 39.1;

/** A minimal style carrying the design layers, which is what the validator wants. */
function styleWith(layers: unknown[]) {
  return {
    version: 8,
    sources: {
      areas: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      bands: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      stripes: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      stamps: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      shadows: { type: 'geojson', lineMetrics: true, data: { type: 'FeatureCollection', features: [] } },
      preview: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      snap: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      plates: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      guides: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      handles: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    },
    layers,
  };
}

describe('the design style is one MapLibre will accept', () => {
  it('validates clean, layer for layer', () => {
    const errors = validateStyleMin(styleWith(designLayers(LAT)) as never);
    expect(errors.map((e) => `${e.message}`)).toEqual([]);
  });

  it('names every source it draws from', () => {
    const sources = new Set(['areas', 'bands', 'stripes', 'stamps', 'shadows', 'plates', 'preview', 'guides', 'handles', 'snap']);
    for (const layer of designLayers(LAT)) {
      if ('source' in layer) expect(sources.has(layer.source as string)).toBe(true);
    }
  });

  it('gives every layer a unique id, or MapLibre keeps only the first', () => {
    const ids = designLayers(LAT).map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('accepts the metre-to-pixel expression as a line width', () => {
    // The expression is the whole renderer. If MapLibre rejects its shape, every road in
    // the project is invisible and nothing throws.
    const errors = validateStyleMin(
      styleWith([
        {
          id: 'probe',
          type: 'line',
          source: 'bands',
          paint: {
            'line-width': metresToPixels(LAT, ['get', 'widthM'] as never),
            'line-offset': metresToPixels(LAT, ['get', 'offsetM'] as never),
          },
        },
      ]) as never,
    );
    expect(errors.map((e) => e.message)).toEqual([]);
  });

  it('draws the junction plates after the stripes they cover', () => {
    // The stacking order IS the junction trimming. If a plate ever ends up below the paint
    // it is meant to hide, lane lines run straight through every intersection.
    const ids = designLayers(LAT).map((l) => l.id);
    for (const deck of [-1, 0, 1]) {
      const stripe = ids.indexOf(`stripe-dashed-${deck}`);
      const plate = ids.indexOf(`plate-${deck}`);
      expect(stripe).toBeGreaterThanOrEqual(0);
      expect(plate).toBeGreaterThan(stripe);
    }
  });

  it('draws the snap ring last, so what the next click will hit is never hidden', () => {
    const ids = designLayers(LAT).map((l) => l.id);
    expect(ids[ids.length - 1]).toBe('snap-ring');
    // The guide is a hint about direction and sits under the ring, which is a target.
    expect(ids.indexOf('snap-guide')).toBeLessThan(ids.indexOf('snap-ring'));
    // Handles sit just under it: a node has to stay grabbable through everything built.
    expect(ids.indexOf('handle-point')).toBeGreaterThan(ids.indexOf('plate-1'));
  });

  it('drops a raised road’s shadow before the road itself, and after the ground below', () => {
    const ids = designLayers(LAT).map((l) => l.id);
    // The shadow has to land on what is underneath and be covered by what casts it.
    expect(ids.indexOf('shadow-flat-1')).toBeGreaterThan(ids.indexOf('plate-0'));
    expect(ids.indexOf('shadow-flat-1')).toBeLessThan(ids.indexOf('band-1'));
    expect(ids.indexOf('shadow-ramp-1')).toBeLessThan(ids.indexOf('band-1'));
  });

  it('casts no shadow at or below ground, where there is nothing to cast one onto', () => {
    const ids = designLayers(LAT).map((l) => l.id);
    expect(ids).not.toContain('shadow-flat-0');
    expect(ids).not.toContain('shadow-flat--1');
  });

  it('draws the road under construction over the design but under the handles', () => {
    const ids = designLayers(LAT).map((l) => l.id);
    // A preview hidden behind the roads it is being threaded between is no preview at all,
    // and one drawn over the handles would cover the node you are aiming at.
    expect(ids.indexOf('preview-band')).toBeGreaterThan(ids.indexOf('plate-1'));
    expect(ids.indexOf('preview-band')).toBeLessThan(ids.indexOf('handle-point'));
  });

  it('puts the ground under every road', () => {
    const ids = designLayers(LAT).map((l) => l.id);
    expect(ids.indexOf('area-fill')).toBeLessThan(ids.indexOf('band-0'));
  });
});
