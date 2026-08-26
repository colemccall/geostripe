/**
 * What can be switched on and off, and which MapLibre layers each switch owns.
 *
 * Grouped by what a person would think of as one thing rather than by how the style is
 * built: "markings" is two layers only because `line-dasharray` cannot be data-driven, and
 * nobody should have to know that to turn the paint off.
 *
 * The list lives here rather than inside the canvas so the toggle UI and the code that
 * applies the toggle read from the same place — a group in one and not the other is a
 * switch that does nothing, which is worse than no switch.
 */

export const LAYER_GROUPS = [
  {
    id: 'landcover',
    label: 'Land cover',
    hint: 'Grass, water, plaza and the rest, drawn under the design.',
    layers: ['area-fill', 'area-outline'],
  },
  {
    id: 'junctions',
    label: 'Intersections',
    hint: 'The paved box and footway corner at every crossing.',
    layers: [
      'junction-footprint-fill',
      'junction-paved-fill',
      'junction-paved-outline',
      'junction-point',
    ],
  },
  {
    id: 'bands',
    label: 'Lanes',
    hint: 'Every band of every cross-section. The design itself.',
    layers: ['band-fill', 'band-outline'],
  },
  {
    id: 'markings',
    label: 'Stripes',
    hint: 'Lane lines, centre lines and edge lines.',
    layers: ['marking-solid', 'marking-dashed'],
  },
  {
    id: 'stamps',
    label: 'Symbols',
    hint: 'Arrows, bicycles and diamonds painted along the lanes.',
    layers: ['stamp-fill'],
  },
  {
    id: 'crossings',
    label: 'Crossings',
    hint: 'Crosswalks, stop bars, raised tables and gores.',
    layers: ['crossing-fill'],
  },
  {
    id: 'handles',
    label: 'Editing handles',
    hint: 'Centerlines, vertices and stop lines — the parts that are not on the ground.',
    layers: ['centerline-line', 'vertex-point', 'midpoint-point', 'stop-line'],
  },
] as const;

export type LayerGroupId = (typeof LAYER_GROUPS)[number]['id'];

/** Everything visible by default. Turning a group off is always a deliberate act. */
export function allLayersVisible(): Record<LayerGroupId, boolean> {
  return Object.fromEntries(LAYER_GROUPS.map((group) => [group.id, true])) as Record<
    LayerGroupId,
    boolean
  >;
}
