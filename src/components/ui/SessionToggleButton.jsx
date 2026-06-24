import { forwardRef } from 'react';
import { sessionToggleClasses } from './sessionToggleClasses';

/**
 * SessionToggleButton — the canonical START/STOP control for a secondary session
 * (break / call / quick-work). It is a DISTINCT affordance from the action `Button`:
 * a toggle that, when `active`, paints itself in the session's signature color
 * (DESIGN_SYSTEM §4 — the loud session identity), and otherwise sits quiet.
 *
 * Before this component the three timer components (BreakTimer, CallTimer, QuickWorkTimer)
 * each hand-rolled the same scaffold — `min-h-touch`, the brand focus ring, the
 * disabled/active/rest tri-state, `active:scale` — three+ times over. That duplication is
 * what this consolidates (the class mapping lives in ./sessionToggleClasses, proven
 * byte-equivalent to the old buttons by SessionToggleButton.test.js).
 *
 * Two `variant`s cover every plain toggle:
 *   - `compact`  — the icon-only square in the mobile work-controls pill / side rail.
 *   - `labeled`  — the icon+text pill (BreakTimer's wide variant).
 *
 * The richer DESKTOP composites in CallTimer/QuickWorkTimer (icon + label column + a LIVE
 * mono timer readout + an active sub-status line) are intentionally NOT migrated here: they
 * are status panels with an embedded readout, not buttons, so folding them in would bloat
 * this API for two cohesive call sites. They stay as-is.
 *
 * Content (the state-dependent icon, and the label for `labeled`) is passed as `children`
 * by the parent, because it is inherently per-button and never duplicated — only the
 * styling scaffold was. aria-label / title / type flow through `...rest`.
 */
const SessionToggleButton = forwardRef(function SessionToggleButton(
    {
        session,
        variant = 'compact',
        active = false,
        disabled = false,
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
            disabled={disabled}
            className={sessionToggleClasses({ session, variant, active, disabled, className })}
            {...rest}
        >
            {children}
        </button>
    );
});

export default SessionToggleButton;
