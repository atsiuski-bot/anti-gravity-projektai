import {
    DndContext,
    MouseSensor,
    TouchSensor,
    KeyboardSensor,
    useSensor,
    useSensors,
    closestCenter,
} from '@dnd-kit/core';
import {
    SortableContext,
    sortableKeyboardCoordinates,
    verticalListSortingStrategy,
    arrayMove,
    useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Trash2, CheckSquare, Square } from 'lucide-react';
import clsx from 'clsx';
import IconButton from '../ui/IconButton';

/**
 * ChecklistEditorList — the drag-to-reorder editor for a task's "Eigos sąrašas" (progress list),
 * used inside TaskModal while authoring/editing a task. Split into its OWN module and lazy-loaded by
 * the modal so @dnd-kit's weight enters the bundle only when a manager actually opens the authoring
 * form — mirroring how PriorityBoard keeps the same dependency lazy.
 *
 * Each row carries a leading grip HANDLE that is the only draggable element, so the delete button
 * stays independently clickable. Pointer (mouse), touch (press-and-hold so a plain swipe still
 * scrolls the modal), and keyboard (Space picks up, arrows move, Space drops) all drive it. The
 * authored array order IS the persisted order (reconcileChecklist preserves it), so reordering here
 * carries straight through to the task document on save.
 */

function SortableChecklistRow({ item, onRemove }) {
    const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
        useSortable({ id: item.id });
    const style = {
        transform: CSS.Translate.toString(transform),
        transition,
    };

    return (
        <li
            ref={setNodeRef}
            style={style}
            className={clsx(
                'flex items-center gap-2 rounded-lg bg-surface-sunken p-2',
                isDragging && 'opacity-40'
            )}
        >
            <button
                type="button"
                ref={setActivatorNodeRef}
                className="-my-2 -ml-2 flex w-8 shrink-0 cursor-grab touch-none items-center justify-center self-stretch rounded-l-lg text-ink-muted/50 transition-colors hover:bg-surface-card hover:text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand active:cursor-grabbing"
                aria-label={`Tempti „${item.text}“ — keisti tvarką`}
                {...attributes}
                {...listeners}
            >
                <GripVertical className="h-4 w-4" aria-hidden="true" />
            </button>
            <span className="flex min-w-0 flex-1 items-center gap-2">
                {item.done
                    ? <CheckSquare className="h-4 w-4 flex-shrink-0 text-brand" aria-hidden="true" />
                    : <Square className="h-4 w-4 flex-shrink-0 text-ink-muted" aria-hidden="true" />}
                <span className={clsx('truncate text-sm', item.done ? 'text-ink-muted line-through' : 'text-ink')}>
                    {item.text}
                </span>
            </span>
            <IconButton icon={Trash2} label="Pašalinti punktą" variant="danger" onClick={() => onRemove(item.id)} />
        </li>
    );
}

export default function ChecklistEditorList({ items, onReorder, onRemove }) {
    const sensors = useSensors(
        // A small movement threshold so a plain click on the handle still reads as a click.
        useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
        // Press-and-hold on touch so a normal vertical swipe still scrolls the modal body.
        useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
    );

    const ids = items.map((i) => i.id);

    const handleDragEnd = ({ active, over }) => {
        if (!over || active.id === over.id) return;
        const from = ids.indexOf(active.id);
        const to = ids.indexOf(over.id);
        if (from === -1 || to === -1) return;
        onReorder(arrayMove(items, from, to));
    };

    return (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={ids} strategy={verticalListSortingStrategy}>
                <ul className="mt-2 space-y-2">
                    {items.map((item) => (
                        <SortableChecklistRow key={item.id} item={item} onRemove={onRemove} />
                    ))}
                </ul>
            </SortableContext>
        </DndContext>
    );
}
