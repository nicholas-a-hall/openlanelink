import { K } from "./theme.jsx";

/* One tap target in the terminal's action grid. Deliberately large and
   two-line (glyph over label): this is used standing up, at arm's length,
   sometimes by someone holding a bowling ball.

   `accent` marks the one button in a group that's the expected next tap.
   It takes a { fill, ink } pair rather than a bare colour so the label is
   always legible against it in both schemes -- a bare colour meant the
   caller had to remember to set a matching text colour, and in practice
   didn't. Everything else stays a plain surface, so the accent means
   something. */
export default function ActionButton({ glyph, label, sublabel, accent, disabled, onClick }) {
  const accented = accent && !disabled;
  return (
    <button
      className="k-btn"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      style={{
        width: "100%",
        minHeight: "clamp(96px, 13vmin, 132px)",
        padding: "16px 10px",
        borderRadius: 14,
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 7,
        ...(accented
          ? {
              background: accent.fill,
              borderColor: accent.fill,
              color: accent.ink,
              /* Faint emissive edge, in the FILL colour -- a console glows.
                 currentColor would be wrong here: on a filled button that's
                 the ink, so the halo would come out dark. The negative
                 spread keeps it a hint rather than a bloom, which is also
                 what stops it reading as a smudge in light mode. */
              boxShadow: `0 0 18px -6px ${accent.fill}`,
            }
          : { background: K.panel, color: K.text }),
      }}
    >
      <span style={{ fontSize: "clamp(22px, 3.4vmin, 30px)", lineHeight: 1 }} aria-hidden="true">{glyph}</span>
      <span style={{
        fontSize: "clamp(13px, 1.7vmin, 16px)", fontWeight: 800, letterSpacing: 0.4,
        textAlign: "center", lineHeight: 1.2,
      }}>{label}</span>
      {sublabel && (
        /* Full-strength ink, not a faded version of it. The sublabel used
           to be dimmed to 0.82 on a filled button, which quietly undid the
           contrast the fill/ink pair was chosen for — and it is the
           smallest text on the screen, so it was the one line that could
           least afford it. Weight and size carry the hierarchy instead. */
        <span style={{
          fontSize: "clamp(12px, 1.45vmin, 14px)", fontWeight: 600,
          textAlign: "center", lineHeight: 1.25,
          color: accented ? "inherit" : K.textDim,
        }}>{sublabel}</span>
      )}
    </button>
  );
}
