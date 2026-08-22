interface PlaceholderProps {
  title: string;
  lead: string;
  /** [region, what will live there] — the layout each route is being built toward. */
  slots: readonly (readonly [string, string])[];
}

/**
 * Scaffold-only. Every route renders this until its real workspace is built; each
 * route's doc comment names the components that replace it. Delete this file once
 * both routes are implemented.
 */
export default function Placeholder({ title, lead, slots }: PlaceholderProps) {
  return (
    <section className="placeholder">
      <div className="placeholder-inner">
        <p className="eyebrow">Scaffold</p>
        <h1>{title}</h1>
        <p className="lead">{lead}</p>

        <ul className="slots">
          {slots.map(([region, detail]) => (
            <li key={region}>
              <span className="slot-region">{region}</span>
              <span className="slot-detail">{detail}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
