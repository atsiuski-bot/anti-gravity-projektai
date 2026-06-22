// Keyboard behaviour shared across every form in the app.
//
// App-wide rule: pressing Enter while typing should compose text (a new line),
// it must never implicitly "finish" — submit a form, post a comment, or add a
// list item. Submission only ever happens through an explicit button, so a
// physical-keyboard user can write multi-line content without accidentally
// firing the primary action.
//
// Attach to a <form> via `onKeyDown={preventEnterSubmit}`. Multi-line controls
// keep their native Enter = newline; on every other control Enter becomes a
// no-op. Activation of buttons/links and IME composition are left untouched.
export function preventEnterSubmit(e) {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;

    const el = e.target;
    if (!el) return;

    const tag = el.tagName;
    // Multi-line text: Enter inserts a newline — that is the whole point.
    if (tag === 'TEXTAREA') return;
    // Explicit activation targets: let Enter trigger the button / link itself.
    if (tag === 'BUTTON' || tag === 'A') return;
    if (typeof el.getAttribute === 'function' && el.getAttribute('role') === 'button') return;

    // Single-line input (or anything else): swallow Enter so it cannot submit.
    e.preventDefault();
}
