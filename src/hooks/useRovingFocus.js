import { useCallback, useEffect, useRef } from 'react';

/**
 * useRovingFocus — the keyboard behaviour that `role="tablist"` and `role="radiogroup"` PROMISE.
 *
 * Declaring those roles tells a screen reader "this is a tab list, use the arrow keys". Our
 * segmented controls declared them but implemented neither half of the pattern: every item was a
 * separate Tab stop, and the arrow keys did nothing. So the announcement and the behaviour
 * disagreed, and a keyboard user had to Tab through six tabs to leave a toolbar.
 *
 * This restores both halves (WAI-ARIA APG, tabs & radio group):
 *
 *  - **Roving tabindex** — only the SELECTED item is in the Tab order; the rest are `tabIndex=-1`.
 *    The control becomes one stop, and Tab moves past it instead of through it. Recomputed after
 *    every render (the container re-renders whenever selection changes), read from the DOM so
 *    call sites need no per-item props.
 *  - **Arrow keys / Home / End** — move focus AND activate, which is the APG default for tabs and
 *    is mandatory for radios. Activation is a real `.click()`, so the existing `onClick` stays the
 *    single source of truth for what a selection does.
 *
 * Attach the returned `ref` + `onKeyDown` to the element that carries `role="tablist"` /
 * `role="radiogroup"` — which must also be the items' own container, since ARIA requires the
 * tabs/radios to be its children.
 *
 * @param {object} [opts]
 * @param {'tab'|'radio'} [opts.itemRole='tab'] - the role of the items being roved over.
 * @param {'horizontal'|'vertical'|'both'} [opts.orientation='horizontal'] - which arrows move.
 * @returns {{ ref: React.RefObject<HTMLElement>, onKeyDown: (e: React.KeyboardEvent) => void }}
 */
export function useRovingFocus({ itemRole = 'tab', orientation = 'horizontal' } = {}) {
    const ref = useRef(null);
    // `aria-selected` for tabs, `aria-checked` for radios — the attribute that marks the one item
    // which should hold the group's single Tab stop.
    const selectedAttr = itemRole === 'radio' ? 'aria-checked' : 'aria-selected';

    const items = useCallback(() => {
        const root = ref.current;
        if (!root) return [];
        // `offsetParent === null` drops items in a `hidden` responsive branch — these controls
        // render a mobile and a desktop variant of their labels, and a hidden one must not
        // swallow an arrow press.
        return Array.prototype.filter.call(
            root.querySelectorAll(`[role="${itemRole}"]:not([disabled])`),
            (el) => el.offsetParent !== null
        );
    }, [itemRole]);

    // No dependency array on purpose: selection lives in the caller's state, so the container
    // re-renders on every change and this stays in sync without the caller telling us what changed.
    useEffect(() => {
        const list = items();
        if (!list.length) return;
        const selected = list.findIndex((el) => el.getAttribute(selectedAttr) === 'true');
        const stop = selected === -1 ? 0 : selected;
        list.forEach((el, i) => {
            el.tabIndex = i === stop ? 0 : -1;
        });
    });

    const onKeyDown = useCallback(
        (e) => {
            const next = orientation === 'vertical' ? ['ArrowDown'] : ['ArrowRight'];
            const prev = orientation === 'vertical' ? ['ArrowUp'] : ['ArrowLeft'];
            if (orientation === 'both') {
                next.push('ArrowDown');
                prev.push('ArrowUp');
            }

            const list = items();
            const current = list.indexOf(document.activeElement);
            if (current === -1) return;

            let target = -1;
            if (next.includes(e.key)) target = (current + 1) % list.length;
            else if (prev.includes(e.key)) target = (current - 1 + list.length) % list.length;
            else if (e.key === 'Home') target = 0;
            else if (e.key === 'End') target = list.length - 1;
            else return;

            e.preventDefault();
            list[target].focus();
            // Follow-focus activation (APG default for tabs, required for radios). Clicking rather
            // than calling a handler keeps `onClick` the only place that knows what selection means.
            list[target].click();
        },
        [items, orientation]
    );

    return { ref, onKeyDown };
}

export default useRovingFocus;
