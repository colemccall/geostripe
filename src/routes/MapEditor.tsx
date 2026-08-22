import Placeholder from '../components/Placeholder';

/**
 * Route: "/" — the Map Editor.
 *
 * Streetcraft-style workspace: satellite imagery, a drawn centerline, and placed
 * cross-section assets rendered as real polygons over the top.
 *
 * ── ENTRY POINT FOR EDITOR LOGIC ────────────────────────────────────────────────
 * Replace <Placeholder/> with the three-pane workspace:
 *
 *   <TemplatePalette/>   left rail   — starter cross-sections + uploaded assets
 *   <MapCanvas/>         centre      — MapLibre GL, Terra Draw centerline authoring,
 *                                      derived band layers, measure + before/after
 *   <Inspector/>         right rail  — component stack, widths, anchor, fit check
 *   <StatusBar/>         footer      — cursor, zoom, section width, warnings
 *
 * Nothing here should own geometry. Bands come from src/geo/banding.ts, which is
 * pure and headless; this route only renders what render(doc) produces.
 * ────────────────────────────────────────────────────────────────────────────────
 */
export default function MapEditor() {
  return (
    <Placeholder
      title="Map editor"
      lead="Trace a street on satellite imagery, drop a cross-section onto it, and edit the design in place."
      slots={[
        ['Left rail', 'Cross-section template palette and uploaded custom assets'],
        ['Centre', 'MapLibre canvas, centerline drawing, derived band layers'],
        ['Right rail', 'Inspector — component widths, anchor, and right-of-way fit check'],
        ['Footer', 'Cursor position, zoom, total section width, geometry warnings'],
      ]}
    />
  );
}
