import { DndContext } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';
import clsx from 'clsx';
import TaskCard from '../TaskCard';
import useReorderableTasks from '../../hooks/useReorderableTasks';

/**
 * SortableTaskCardList — the mobile team list with drag-to-reorder. The WHOLE card is the drag
 * activator: a press-and-hold (long-press) picks it up, a quick tap still opens the card, and an
 * immediate swipe still scrolls (the touch sensor's delay+tolerance distinguishes the three). The
 * card body keeps its own controls because activation only fires after the hold, never on a tap.
 *
 * Reordering reuses the SAME shared manual order as the desktop priority board (see
 * useReorderableTasks): within a priority it reorders, across a priority it reprioritizes. Lazy-only
 * importer of the reorder engine, so @dnd-kit stays out of the eager/worker bundle.
 *
 * When `dragEnabled` is false (a free-text search is active, so the list is in relevance order rather
 * than the manual canonical order) the cards render plain and static — a manual rank would be ignored.
 */

function SortableCard({ task, onEdit, role, draggable }) {
    const {
        attributes,
        listeners,
        setNodeRef,
        setActivatorNodeRef,
        transform,
        transition,
        isDragging,
    } = useSortable({ id: task.id, disabled: !draggable });

    // Drop the `role: 'button'` dnd-kit puts on the activator: the activator here is the whole card,
    // which itself contains buttons, and a button-around-buttons is a nested-interactive a11y fault.
    // The remaining aria (roledescription/describedby) + tabIndex still give keyboard pickup.
    const a11y = { ...attributes };
    delete a11y.role;

    const style = {
        transform: CSS.Translate.toString(transform),
        transition,
        // Suppress the iOS long-press callout / text selection so the hold reads only as a pickup.
        WebkitTouchCallout: 'none',
    };

    return (
        <div
            ref={(node) => {
                setNodeRef(node);
                setActivatorNodeRef(node);
            }}
            style={style}
            {...(draggable ? { ...a11y, ...listeners } : {})}
            aria-label={draggable ? `Tempti „${task.title}“ — palaikykite, kad pertvarkytumėte` : undefined}
            className={clsx(
                'relative rounded-card outline-none',
                draggable && 'cursor-grab select-none focus-visible:ring-2 focus-visible:ring-brand',
                isDragging && 'z-10 opacity-70 shadow-xl ring-2 ring-brand/50'
            )}
        >
            <TaskCard task={task} onEdit={onEdit} role={role} />
            {draggable && (
                <span
                    className="pointer-events-none absolute right-2.5 top-2.5 text-ink-muted/40"
                    aria-hidden="true"
                >
                    <GripVertical className="h-4 w-4" />
                </span>
            )}
        </div>
    );
}

export default function SortableTaskCardList({ tasks, onEditTask, role, dragEnabled = true }) {
    const reorder = useReorderableTasks(tasks, { enabled: dragEnabled });

    // No drag (relevance-ordered search results): a plain, static card list.
    if (!dragEnabled) {
        return (
            <div className="space-y-4">
                {tasks.map((task) => (
                    <TaskCard key={task.id} task={task} onEdit={() => onEditTask(task)} role={role} />
                ))}
            </div>
        );
    }

    return (
        <div className="space-y-3">
            {reorder.error && (
                <p
                    role="alert"
                    className="rounded-control border border-feedback-danger/30 bg-feedback-danger-soft px-3 py-2 text-caption font-medium text-feedback-danger"
                >
                    {reorder.error}
                </p>
            )}
            <p className="px-1 text-caption text-ink-muted">
                Palaikykite užduotį, kad pertvarkytumėte. Pernešus virš kito prioriteto, prioritetas pasikeis.
            </p>
            <DndContext
                sensors={reorder.sensors}
                collisionDetection={reorder.collisionDetection}
                onDragStart={reorder.onDragStart}
                onDragEnd={reorder.onDragEnd}
                onDragCancel={reorder.onDragCancel}
            >
                <SortableContext items={reorder.itemIds} strategy={verticalListSortingStrategy}>
                    <div className="space-y-4">
                        {reorder.items.map((task) => (
                            <SortableCard
                                key={task.id}
                                task={task}
                                onEdit={() => onEditTask(task)}
                                role={role}
                                draggable={reorder.isDraggableTask(task)}
                            />
                        ))}
                    </div>
                </SortableContext>
            </DndContext>
        </div>
    );
}
