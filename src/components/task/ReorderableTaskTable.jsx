import { DndContext } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';
import clsx from 'clsx';
import TaskTable from '../TaskTable';
import useReorderableTasks from '../../hooks/useReorderableTasks';

/**
 * ReorderableTaskTable — wraps the desktop team TaskTable with drag-to-reorder WITHOUT making
 * TaskTable itself depend on @dnd-kit. All the drag weight lives here, behind a lazy boundary, and is
 * injected into TaskTable as "slots": a body wrapper (the SortableContext) and a row wrapper (the
 * per-row sortable <tr> + its leading grip handle). TaskTable renders those slots when present and
 * stays a plain table otherwise — so the worker bundle and every other TaskTable user are untouched.
 *
 * Reordering reuses the SAME shared manual order as the priority board (see useReorderableTasks):
 * dragging a row within a priority reorders it, dragging it across a priority boundary reprioritizes
 * the task. One order, read everywhere through compareTasksCanonical.
 *
 * When `dragEnabled` is false (a free-text search puts the list in relevance order, where a manual
 * rank is ignored) it renders the plain TaskTable — no handle column, no drag.
 */

// One sortable <tr>. The grip in the leading cell is the ONLY drag activator (and a real focusable
// control for keyboard pickup), so clicking anywhere else on the row still opens the detail sheet.
function SortableTaskRow({ task, draggable, rowClassName, onRowClick, children }) {
    const {
        attributes,
        listeners,
        setNodeRef,
        setActivatorNodeRef,
        transform,
        transition,
        isDragging,
    } = useSortable({ id: task.id, disabled: !draggable });

    const style = {
        transform: CSS.Translate.toString(transform),
        transition,
    };

    return (
        <tr
            ref={setNodeRef}
            style={style}
            onClick={onRowClick}
            className={clsx(rowClassName, isDragging && 'relative z-10 opacity-80 shadow-lg')}
        >
            <td className="w-8 px-1 py-3 align-top" onClick={(e) => e.stopPropagation()}>
                {draggable && (
                    <button
                        type="button"
                        ref={setActivatorNodeRef}
                        {...attributes}
                        {...listeners}
                        aria-label={`Tempti „${task.title}“ — keisti tvarką ar prioritetą`}
                        className="flex h-8 w-6 cursor-grab touch-none items-center justify-center rounded text-ink-muted/50 transition-colors hover:bg-surface-sunken hover:text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand active:cursor-grabbing"
                    >
                        <GripVertical className="h-4 w-4" aria-hidden="true" />
                    </button>
                )}
            </td>
            {children}
        </tr>
    );
}

export default function ReorderableTaskTable({ dragEnabled = true, ...tableProps }) {
    const reorder = useReorderableTasks(tableProps.tasks, { enabled: dragEnabled });

    // Relevance-ordered (search) → no manual order to honour. Plain table, no handle column.
    if (!dragEnabled) {
        return <TaskTable {...tableProps} />;
    }

    const reorderSlots = {
        // Wraps the desktop <tbody> rows; renders no DOM of its own (SortableContext is a provider).
        BodyWrapper: ({ children }) => (
            <SortableContext items={reorder.itemIds} strategy={verticalListSortingStrategy}>
                {children}
            </SortableContext>
        ),
        RowWrapper: SortableTaskRow,
        isDraggableTask: reorder.isDraggableTask,
    };

    return (
        <div className="space-y-2">
            {reorder.error && (
                <p
                    role="alert"
                    className="rounded-control border border-feedback-danger/30 bg-feedback-danger-soft px-3 py-2 text-caption font-medium text-feedback-danger"
                >
                    {reorder.error}
                </p>
            )}
            <DndContext
                sensors={reorder.sensors}
                collisionDetection={reorder.collisionDetection}
                onDragStart={reorder.onDragStart}
                onDragEnd={reorder.onDragEnd}
                onDragCancel={reorder.onDragCancel}
            >
                <TaskTable {...tableProps} tasks={reorder.items} reorderSlots={reorderSlots} />
            </DndContext>
        </div>
    );
}
