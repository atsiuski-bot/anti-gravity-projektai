import { useState, useEffect, useMemo, useRef } from 'react';
import {
    DndContext,
    DragOverlay,
    PointerSensor,
    KeyboardSensor,
    useSensor,
    useSensors,
    useDroppable,
    closestCorners,
} from '@dnd-kit/core';
import {
    SortableContext,
    sortableKeyboardCoordinates,
    verticalListSortingStrategy,
    arrayMove,
    useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';
import clsx from 'clsx';
import { useAuth } from '../../context/AuthContext';
import TaskCard from '../TaskCard';
import { getPriorityLabel, getPriorityColor } from '../../utils/priority';
import { sortTasksCanonical } from '../../utils/taskUtils';
import {
    BOARD_COLUMNS,
    groupTasksByPriority,
    persistColumnOrder,
    moveTaskToColumn,
} from '../../utils/boardOrder';
import { logError } from '../../utils/errorLog';

/**
 * PriorityBoard — the desktop-only, four-column priority view of the team task list (founder
 * 2026-06-26). Each column is one priority (Skubus / Aukštas / Vidutinis / Žemas), left → right by
 * urgency. The SAME mobile TaskCard renders inside every column, reached for its richer glance
 * signals; here a drag HANDLE (grip) is added on its left so the card body stays fully interactive
 * (tap to open, timer, sign-off) while only the handle starts a drag.
 *
 * Dragging a card to another column reprioritizes the task (an audited change shared with everyone);
 * dragging it within a column reorders it (a shared `boardRank`). Both are persisted through
 * utils/boardOrder, then re-read by every surface via the canonical comparator — so the board is the
 * single place a manual order is created, and the whole app reflects it. Keyboard drag is supported
 * (the handle is a focusable control; Space picks up, arrows move, Space drops).
 */

/** A short, glanceable hint under each column title — mirrors the reference board (Do first / …). */
const COLUMN_HINTS = {
    URGENT: 'Daryti pirma',
    HIGH: 'Greitu metu',
    MEDIUM: 'Kai bus laiko',
    LOW: 'Atidėta',
};

function SortableTaskCard({ task, onEdit }) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id });
    const style = {
        transform: CSS.Translate.toString(transform),
        transition,
    };
    return (
        <div
            ref={setNodeRef}
            style={style}
            className={clsx('flex items-stretch gap-1', isDragging && 'opacity-40')}
        >
            {/* Drag handle — the ONLY draggable element, so the card keeps its own click/buttons.
                A real focusable control: pointer drags it, keyboard (Space + arrows) drives it too. */}
            <button
                type="button"
                className="flex w-6 shrink-0 cursor-grab touch-none items-center justify-center self-stretch rounded-control text-ink-muted hover:bg-surface-sunken hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand active:cursor-grabbing"
                aria-label={`Tempti „${task.title}“ — keisti prioritetą ar tvarką`}
                {...attributes}
                {...listeners}
            >
                <GripVertical className="h-4 w-4" aria-hidden="true" />
            </button>
            <div className="min-w-0 flex-1">
                <TaskCard task={task} onEdit={onEdit} role="manager" />
            </div>
        </div>
    );
}

function BoardColumn({ priority, taskIds, tasksById, onEdit }) {
    // Each column is a droppable so an EMPTY column still accepts a card (over.id becomes the
    // column's priority token, handled by findColumnOfId).
    const { setNodeRef, isOver } = useDroppable({ id: priority });
    const accent = getPriorityColor(priority);
    return (
        <section
            className="flex min-w-[16rem] flex-1 basis-0 flex-col rounded-card border border-line bg-surface-sunken/60"
            aria-label={`${getPriorityLabel(priority)} prioritetas`}
        >
            {/* Header: a priority-coloured accent bar + label + live count. */}
            <div className="rounded-t-card border-b border-line px-3 pt-2.5 pb-2">
                <span className="mb-2 block h-1 w-full rounded-full" style={{ backgroundColor: accent }} aria-hidden="true" />
                <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: accent }} aria-hidden="true" />
                        <h3 className="truncate text-body font-bold text-ink-strong">{getPriorityLabel(priority)}</h3>
                        <span className="truncate text-caption text-ink-muted">{COLUMN_HINTS[priority]}</span>
                    </div>
                    <span className="inline-flex min-w-[1.5rem] items-center justify-center rounded-full bg-surface-card px-2 py-0.5 text-caption font-bold text-ink-muted">
                        {taskIds.length}
                    </span>
                </div>
            </div>

            {/* Body: the sortable list. min-height keeps an empty column a visible drop target. */}
            <div
                ref={setNodeRef}
                className={clsx(
                    'flex-1 space-y-2 p-2 transition-colors',
                    isOver && 'bg-brand-soft/40'
                )}
            >
                <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
                    {taskIds.length === 0 ? (
                        <p className="select-none py-8 text-center text-caption text-ink-muted">
                            Tempkite užduotį čia
                        </p>
                    ) : (
                        taskIds.map((id) => (
                            tasksById[id] ? <SortableTaskCard key={id} task={tasksById[id]} onEdit={onEdit} /> : null
                        ))
                    )}
                </SortableContext>
            </div>
        </section>
    );
}

export default function PriorityBoard({ tasks, onEditTask }) {
    const { currentUser, userRole } = useAuth();

    // Map id → task, and the canonical grouping into the four columns. We re-sort canonically here
    // so the board is independent of the parent's "Daugiau rūšiavimo" choice — the board always
    // shows the canonical/manual order, only the parent's FILTERS narrow which tasks arrive.
    const tasksById = useMemo(() => {
        const map = {};
        for (const t of tasks) map[t.id] = t;
        return map;
    }, [tasks]);

    const baseColumns = useMemo(() => {
        const grouped = groupTasksByPriority(sortTasksCanonical(tasks));
        const cols = {};
        for (const col of BOARD_COLUMNS) cols[col] = grouped[col].map((t) => t.id);
        return cols;
    }, [tasks]);

    // Local, drag-mutable copy of the column→ids map. Re-synced from props whenever the underlying
    // data changes AND no drag is in flight (so a Firestore snapshot can't yank a card mid-drag).
    const [columns, setColumns] = useState(baseColumns);
    const [activeId, setActiveId] = useState(null);
    const [error, setError] = useState('');

    // A render-time mirror so the drag handlers always read the freshest ordering (the dragEnd that
    // fires right after dragOver must see dragOver's result before React re-renders).
    const columnsRef = useRef(columns);
    columnsRef.current = columns;
    const dragStartColumnRef = useRef(null);

    const baseSignature = useMemo(
        () => BOARD_COLUMNS.map((c) => `${c}:${baseColumns[c].join(',')}`).join('|'),
        [baseColumns]
    );
    useEffect(() => {
        if (activeId) return; // never re-sync mid-drag
        setColumns(baseColumns);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [baseSignature, activeId]);

    const sensors = useSensors(
        // A small movement threshold so a plain click on the handle still reads as a click, and a
        // press without drag never hijacks the card's own controls.
        useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
    );

    const findColumnOfId = (id) => {
        if (BOARD_COLUMNS.includes(id)) return id;
        return BOARD_COLUMNS.find((col) => columnsRef.current[col].includes(id)) || null;
    };

    const handleDragStart = ({ active }) => {
        setError('');
        setActiveId(active.id);
        dragStartColumnRef.current = findColumnOfId(active.id);
    };

    // Cross-column live preview: while hovering a different column, splice the active id into it so
    // the card visibly crosses over. (Within-column shifting is handled by the sortable strategy.)
    const handleDragOver = ({ active, over }) => {
        if (!over) return;
        const activeCol = findColumnOfId(active.id);
        const overCol = findColumnOfId(over.id);
        if (!activeCol || !overCol || activeCol === overCol) return;

        setColumns((prev) => {
            const activeItems = prev[activeCol];
            const overItems = prev[overCol];
            const overIsColumn = BOARD_COLUMNS.includes(over.id);
            const overIndex = overIsColumn ? overItems.length : overItems.indexOf(over.id);

            let insertAt = overItems.length;
            if (!overIsColumn && overIndex >= 0) {
                const isBelow =
                    over.rect &&
                    active.rect.current.translated &&
                    active.rect.current.translated.top > over.rect.top + over.rect.height / 2;
                insertAt = overIndex + (isBelow ? 1 : 0);
            }

            const next = {
                ...prev,
                [activeCol]: activeItems.filter((id) => id !== active.id),
                [overCol]: [...overItems.slice(0, insertAt), active.id, ...overItems.slice(insertAt)],
            };
            columnsRef.current = next; // keep the ref hot for the dragEnd that follows
            return next;
        });
    };

    const persist = (movedId, sourceCol, targetCol, targetIds) => {
        const targetTasks = targetIds.map((id) => tasksById[id]).filter(Boolean);
        const onFail = (err) => {
            logError(err, { source: 'PriorityBoard.persist' });
            setError('Nepavyko išsaugoti pakeitimo. Atstatyta ankstesnė tvarka.');
            setColumns(baseColumns); // revert optimistic state to the last confirmed snapshot
        };
        if (sourceCol === targetCol) {
            persistColumnOrder(targetTasks).catch(onFail);
        } else {
            moveTaskToColumn(
                tasksById[movedId],
                targetCol,
                targetTasks,
                { uid: currentUser?.uid, displayName: currentUser?.displayName, email: currentUser?.email, role: userRole }
            ).catch(onFail);
        }
    };

    const handleDragEnd = ({ active, over }) => {
        const movedId = active.id;
        const sourceCol = dragStartColumnRef.current;
        dragStartColumnRef.current = null;
        setActiveId(null);
        if (!over) return;

        const targetCol = findColumnOfId(movedId); // column AFTER any cross-column splice in dragOver
        if (!targetCol) return;

        const currentIds = columnsRef.current[targetCol];
        const fromIndex = currentIds.indexOf(movedId);
        const overIsColumn = BOARD_COLUMNS.includes(over.id);
        const toIndex = overIsColumn ? currentIds.length - 1 : currentIds.indexOf(over.id);

        let finalIds = currentIds;
        if (fromIndex !== -1 && toIndex !== -1 && fromIndex !== toIndex) {
            finalIds = arrayMove(currentIds, fromIndex, toIndex);
            const next = { ...columnsRef.current, [targetCol]: finalIds };
            columnsRef.current = next;
            setColumns(next);
        }

        // Nothing actually moved (same column, same slot) → no write.
        if (sourceCol === targetCol && finalIds === currentIds && fromIndex === toIndex) return;
        persist(movedId, sourceCol, targetCol, finalIds);
    };

    const handleDragCancel = () => {
        dragStartColumnRef.current = null;
        setActiveId(null);
        setColumns(baseColumns);
    };

    const activeTask = activeId ? tasksById[activeId] : null;

    return (
        <div>
            {error && (
                <p role="alert" className="mb-3 rounded-control border border-feedback-danger/30 bg-feedback-danger-soft px-3 py-2 text-caption font-medium text-feedback-danger">
                    {error}
                </p>
            )}
            <DndContext
                sensors={sensors}
                collisionDetection={closestCorners}
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDragEnd={handleDragEnd}
                onDragCancel={handleDragCancel}
            >
                <div className="flex gap-4 overflow-x-auto pb-2">
                    {BOARD_COLUMNS.map((priority) => (
                        <BoardColumn
                            key={priority}
                            priority={priority}
                            taskIds={columns[priority] || []}
                            tasksById={tasksById}
                            onEdit={onEditTask}
                        />
                    ))}
                </div>
                <DragOverlay>
                    {activeTask ? (
                        <div className="w-[20rem] max-w-[80vw] cursor-grabbing opacity-95 shadow-lg">
                            <TaskCard task={activeTask} onEdit={onEditTask} role="manager" />
                        </div>
                    ) : null}
                </DragOverlay>
            </DndContext>
        </div>
    );
}
