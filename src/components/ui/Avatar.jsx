import { cn } from '../../utils/cn';

/**
 * Avatar — the canonical user image (DESIGN_SYSTEM §8). Shows the photo when a `src` is
 * present, otherwise a calm initials circle (never a session color). The visual circle is
 * sized below 44px on purpose: the 44px touch target belongs to the surrounding button
 * (header avatar, color swatch), not the image itself.
 *
 * @param {string} [src] - photo URL (Auth or uploaded). Falls back to initials when absent.
 * @param {string} [name] - display name; first letter seeds the initial.
 * @param {string} [email] - used for the initial only when no name is available.
 * @param {'sm'|'md'|'lg'} [size]
 */
const SIZES = {
    sm: 'h-9 w-9 text-sm',
    md: 'h-10 w-10 text-base',
    lg: 'h-20 w-20 text-2xl',
};

export default function Avatar({ src, name, email, size = 'md', className }) {
    const sizeCls = SIZES[size] || SIZES.md;

    if (src) {
        return <img src={src} alt="" className={cn('rounded-full object-cover', sizeCls, className)} />;
    }

    const initial = (name?.trim()?.[0] || email?.trim()?.[0] || '?').toUpperCase();
    return (
        <div
            aria-hidden="true"
            className={cn(
                'flex shrink-0 items-center justify-center rounded-full bg-surface-sunken font-medium text-ink-muted',
                sizeCls,
                className
            )}
        >
            {initial}
        </div>
    );
}
