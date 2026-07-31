/**
 * Lithuanian screen-reader copy for @dnd-kit (WCAG 3.1.2 Language of Parts).
 *
 * dnd-kit ships English defaults and wires them into the DOM for real: the instructions are
 * `aria-describedby`-ed onto EVERY draggable item (on the team task list that is ~130 cards), and
 * each drag step is pushed into a live region. In a `<html lang="lt">` document a Lithuanian voice
 * then reads English words phonetically — for the one instruction a keyboard user needs in order to
 * reorder anything at all.
 *
 * Pass both to `<DndContext accessibility={...}>`. Every drag surface must use the same object, so
 * the phrasing a worker hears cannot drift between the task list, the priority board and the
 * checklist editor.
 *
 * `announcements` receives dnd-kit's `{ active, over }`; `active.data.current.a11yName` is our own
 * optional hint for a human-readable item name, falling back to the item id.
 */
const nameOf = (item) => item?.data?.current?.a11yName || item?.id;

export const dndScreenReaderInstructions = {
    draggable:
        'Norėdami paimti elementą, paspauskite tarpo klavišą. ' +
        'Tempdami naudokite rodyklių klavišus elementui perkelti. ' +
        'Paspauskite tarpą dar kartą, kad padėtumėte elementą naujoje vietoje, arba Esc, kad atšauktumėte.',
};

export const dndAnnouncements = {
    onDragStart({ active }) {
        return `Paimta: ${nameOf(active)}.`;
    },
    onDragOver({ active, over }) {
        if (!over) return `${nameOf(active)} nebėra virš tinkamos vietos.`;
        return `${nameOf(active)} perkelta virš ${nameOf(over)}.`;
    },
    onDragEnd({ active, over }) {
        if (!over) return `${nameOf(active)} padėta. Vieta nepakeista.`;
        return `${nameOf(active)} padėta virš ${nameOf(over)}.`;
    },
    onDragCancel({ active }) {
        return `Atšaukta. ${nameOf(active)} grąžinta į pradinę vietą.`;
    },
};

export default { dndScreenReaderInstructions, dndAnnouncements };
