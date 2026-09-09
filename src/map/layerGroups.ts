/**
 * What can be switched on and off, and which MapLibre layers each switch owns.
 *
 * Grouped by what a person would think of as one thing rather than by how the style is
 * built. "Roads" is nine layers only because there is a set per deck and because a dashed
 * line cannot share a layer with a solid one, and nobody should have to know that to turn
 * the paint off.
 *
 * The list lives here rather than in the canvas so the toggle UI and the code applying the
 * toggle read from the same place — a group in one and not the other is a switch that does
 * nothing, which is worse than no switch.
 */

const DECKS = [-1, 0, 1] as const;

const perDeck = (prefix: string): string[] => DECKS.map((deck) => `${prefix}-${deck}`);

export const LAYER_GROUPS = [
  {
    id: 'ground',
    label: 'Ground',
    hint: 'Parks, plazas, water and the rest, drawn under everything.',
    layers: ['area-fill'],
  },
  {
    id: 'roads',
    label: 'Roads',
    hint: 'Every band of every road, at every level.',
    layers: perDeck('band'),
  },
  {
    id: 'markings',
    label: 'Markings',
    hint: 'Lane lines, centre lines and edge lines.',
    layers: [...perDeck('stripe-solid'), ...perDeck('stripe-dashed')],
  },
  {
    id: 'symbols',
    label: 'Symbols',
    hint: 'Arrows, bicycles and diamonds painted along the lanes.',
    layers: perDeck('stamp'),
  },
  {
    id: 'junctions',
    label: 'Junctions',
    hint: 'The paved ground each node owns, drawn over the road ends that meet there.',
    layers: perDeck('plate'),
  },
  {
    id: 'handles',
    label: 'Editing handles',
    hint: 'Nodes, shape points and centerlines — the parts that are not on the ground.',
    layers: ['guide-line', 'handle-point'],
  },
] as const;

export type LayerGroupId = (typeof LAYER_GROUPS)[number]['id'];

/**
 * Everything on.
 *
 * Nothing starts hidden any more. The two groups that used to default off were the old
 * model's bands and junctions, kept switchable while both renderers existed; there is one
 * renderer now, and a design with a layer missing by default is a design somebody has to
 * discover a switch to see.
 */
export function allLayersVisible(): Record<LayerGroupId, boolean> {
  return Object.fromEntries(LAYER_GROUPS.map((group) => [group.id, true])) as Record<
    LayerGroupId,
    boolean
  >;
}

export function groupVisibleByDefault(_id: LayerGroupId): boolean {
  return true;
}
