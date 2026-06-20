import React from 'react';
import clsx from 'clsx';

/**
 * IconButton — the canonical icon-only control (DESIGN_SYSTEM §8).
 *
 * Guarantees a >= 44x44px touch target (WCAG AA, §7) and a visible focus ring, and requires
 * an accessible name via `label` (mapped to aria-label). This replaces the ad-hoc
 * `p-1.5` (~28px) and `p-0.5` (~20px) icon buttons scattered across the app.
 *
 * Pass either a lucide-react `icon` component or arbitrary `children`.
 *
 * @param {React.ElementType} [icon] - a lucide-react icon component.
 * @param {string} label - accessible name; also the tooltip when `title` is omitted.
 * @param {'default'|'primary'|'danger'|'ghost'} [variant]
 */
const VARIANTS = {
    default: 'text-ink-muted hover:text-ink hover:bg-surface-sunken',
    primary: 'bg-brand text-white hover:bg-brand-hover',
    danger: 'text-feedback-danger hover:bg-red-50',
    ghost: 'text-ink-muted hover:text-ink',
};

const IconButton = React.forwardRef(function IconButton(
    { icon: Icon, label, title, onClick, variant = 'default', type = 'button', disabled = false, className, children, ...rest },
    ref
) {
    return (
        <button
            ref={ref}
            type={type}
            onClick={onClick}
            disabled={disabled}
            aria-label={label}
            title={title ?? label}
            className={clsx(
                'inline-flex items-center justify-center min-h-touch min-w-touch rounded-control',
                'transition-colors duration-base',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2',
                'disabled:opacity-50 disabled:pointer-events-none',
                VARIANTS[variant] || VARIANTS.default,
                className
            )}
            {...rest}
        >
            {Icon ? <Icon className="w-5 h-5" aria-hidden="true" /> : children}
        </button>
    );
});

export default IconButton;
