import Placeholder from '../components/Placeholder';

/**
 * Route: "/builder" — the Asset Builder.
 *
 * Streetmix-style cross-section assembler. No satellite imagery and no centerline:
 * an asset is a geometry-agnostic stack of components and widths that becomes real
 * geometry only when it is placed on a street in the Map Editor.
 *
 * ── ENTRY POINT FOR EDITOR LOGIC ────────────────────────────────────────────────
 * Replace <Placeholder/> with:
 *
 *   <PrimitiveLibrary/>  left rail   — the lane primitives, click to append
 *   <CrossSectionSvg/>   centre      — elevation view with dimension lines.
 *                                      SHARED with the Map Editor inspector preview;
 *                                      keep it a pure function of (components, opts).
 *   <AssetPanel/>        right rail  — name, stack reorder, download / upload JSON
 * ────────────────────────────────────────────────────────────────────────────────
 */
export default function AssetBuilder() {
  return (
    <Placeholder
      title="Asset builder"
      lead="Stack lane primitives into a reusable cross-section, then download it as a single JSON file anyone can load."
      slots={[
        ['Left rail', 'Lane primitive library with NACTO-derived default widths'],
        ['Centre', 'Cross-section elevation with dimension lines and total width'],
        ['Right rail', 'Asset name, component stack, download / upload asset JSON'],
      ]}
    />
  );
}
