import { forwardRef } from 'react';
import { cn } from '../../utils/cn';

/**
 * Card — the one panel wrapper (DESIGN_SYSTEM §8): white surface, card radius, a subtle
 * border and shadow. Replaces the `rounded-lg`-vs-`rounded-xl` split across the
 * summary / stat / table files. Pass `as` to change the element (e.g. `as="section"`).
 */
const Card = forwardRef(function Card({ as: Tag = 'div', className, children, ...rest }, ref) {
    return (
        <Tag
            ref={ref}
            className={cn('bg-surface-card rounded-card border border-line shadow-sm', className)}
            {...rest}
        >
            {children}
        </Tag>
    );
});

export default Card;
