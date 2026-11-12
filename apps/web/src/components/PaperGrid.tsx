/** The 12 faint column rules behind every page (4 on a phone). Decoration only. */
export function PaperGrid() {
  return (
    <div aria-hidden className="paper-grid">
      {Array.from({ length: 12 }, (_, i) => (
        <span key={i} />
      ))}
    </div>
  );
}
