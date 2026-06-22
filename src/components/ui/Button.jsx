import { forwardRef } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '../../utils/cn';

/**
 * Button — the canonical action control (DESIGN_SYSTEM §8).
 *
 * Variants: `primary` (brand-filled, the dominant action), `secondary` (neutral outline),
 * `success` (positive confirm/approve — green), `danger` (destructive), `ghost` (text-only).
 * Sizes: `md` (default, >= 44px) and `lg` (near-full-width mobile CTAs). Every button gets a
 * visible focus ring and a >= 44px target.
 *
 * Rule (§8): the primary action must always outweigh a destructive/secondary action beside
 * it — express that with `variant`/`size`, never by rendering two identical buttons.
 */
const VARIANTS = {
    primary: 'bg-brand text-white hover:bg-brand-hover shadow-sm',
    secondary: 'bg-surface-card text-ink border border-line hover:bg-surface-sunken',
    success: 'bg-feedback-success text-white hover:bg-feedback-success-hover shadow-sm',
    danger: 'bg-feedback-danger text-white hover:bg-feedback-danger-hover shadow-sm',
    ghost: 'text-ink-muted hover:text-ink hover:bg-surface-sunken',
};

const SIZES = {
    md: 'min-h-touch px-4 py-2.5 text-body',
    lg: 'min-h-[52px] px-6 py-3 text-body-lg',
};

const Button = forwardRef(function Button(
    {
        variant = 'primary',
        size = 'md',
        fullWidth = false,
        loading = false,
        disabled = false,
        icon: Icon,
        iconRight: IconRight,
        type = 'button',
        className,
        children,
        ...rest
    },
    ref
) {
    return (
        <button
            ref={ref}
            type={type}
            disabled={disabled || loading}
            aria-busy={loading || undefined}
            className={cn(
                'inline-flex items-center justify-center gap-2 rounded-control font-semibold',
                // `transition` (not `transition-colors`) so the press scale eases too. The
                // utility's property set is GPU-safe (transform/opacity/color), never layout.
                'transition duration-base active:scale-[0.98]',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2',
                'disabled:opacity-50 disabled:pointer-events-none',
                VARIANTS[variant] || VARIANTS.primary,
                SIZES[size] || SIZES.md,
                fullWidth && 'w-full',
                className
            )}
            {...rest}
        >
            {loading ? (
                <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
            ) : (
                Icon && <Icon className="w-5 h-5" aria-hidden="true" />
            )}
            {children}
            {!loading && IconRight && <IconRight className="w-5 h-5" aria-hidden="true" />}
        </button>
    );
});

export default Button;
