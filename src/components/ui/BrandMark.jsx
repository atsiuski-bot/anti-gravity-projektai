import { cn } from '../../utils/cn';

/**
 * BrandMark — the Gildija logo on a white rounded "app-icon" tile.
 *
 * WHY a white tile (not the bare transparent mark): the mark is a single indigo glyph. On the
 * themeable surfaces it rides (login card, side rail, mobile header) it would sit on near-white in
 * light mode but on the dark slate canvas in dark mode, where indigo-on-dark loses contrast. A
 * fixed white tile pins it to a maximum-contrast field in BOTH themes — and matches the white
 * app-icon chip the iOS splash screens show, so the brand reads identically everywhere.
 *
 * Decorative by default (empty alt + aria-hidden): every placement pairs it with the visible
 * "Gildija" wordmark, so the logo must not double-announce to screen readers.
 *
 * Motion (all neutralised by the global prefers-reduced-motion guard, DESIGN_SYSTEM §7):
 *   - `animated` → a barely-there idle float (wz-float) so a quiet screen still breathes.
 *   - `loading`  → a soft breathing pulse (wz-pulse-soft) to signal work in progress; takes
 *                  precedence over the idle float.
 * Pair with a one-shot `animate-in …` on a WRAPPER (not here) for an entrance — keeping the
 * infinite idle animation off the same element avoids the two clobbering one `animation` property.
 */
const SIZES = {
  sm: 'h-7 w-7 rounded-lg p-1',
  md: 'h-10 w-10 rounded-xl p-1.5',
  lg: 'h-20 w-20 rounded-2xl p-3',
};

export default function BrandMark({ size = 'md', animated = false, loading = false, className, ...rest }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center bg-white shadow-sm ring-1 ring-black/5',
        SIZES[size] || SIZES.md,
        loading ? 'wz-pulse-soft' : animated && 'wz-float',
        className
      )}
      {...rest}
    >
      <img
        src="/logo-mark.png"
        alt=""
        aria-hidden="true"
        draggable="false"
        className="h-full w-full select-none object-contain"
      />
    </span>
  );
}
