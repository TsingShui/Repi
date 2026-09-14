/**
 * The Repi brand mark: an inverted pi.
 *
 * A normal pi carries its bar on top. Reversing it — bar down, stems up — is
 * the whole idea of the product: reverse the binary. The geometry is drawn
 * rather than typeset so it stays crisp and identical at every size.
 */
export function BrandMark() {
  return (
    <span class="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        {/* base bar */}
        <rect x="3" y="18" width="18" height="3" />
        {/* stems rising from the bar, inset the way a real pi overhangs */}
        <rect x="7" y="4" width="3" height="14" />
        <rect x="14" y="4" width="3" height="14" />
      </svg>
    </span>
  );
}
