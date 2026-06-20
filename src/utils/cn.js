import clsx from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * tailwind-merge, taught about our custom design tokens (tailwind.config.js).
 *
 * Without this, twMerge cannot tell our custom font sizes (`text-body`, `text-h2`, …) apart
 * from text *colors* (`text-white`) — it would lump them in one group and silently drop one
 * when both appear (e.g. the primary Button would lose its white text). Registering the
 * custom scales keeps each class in the right conflict group.
 */
const twMerge = extendTailwindMerge({
    extend: {
        classGroups: {
            'font-size': [{ text: ['caption', 'body', 'body-lg', 'h3', 'h2', 'h1', 'display'] }],
            rounded: [{ rounded: ['input', 'control', 'card', 'modal'] }],
        },
    },
});

/**
 * cn — merge conditional class names and de-duplicate conflicting Tailwind utilities.
 *
 * `clsx` handles conditional/array/object inputs; `twMerge` lets a caller-supplied
 * `className` override a component's defaults (a later `p-6` wins over a default `p-4`)
 * instead of both ending up in the class list. Use this in every UI component.
 */
export function cn(...inputs) {
    return twMerge(clsx(inputs));
}

export default cn;
