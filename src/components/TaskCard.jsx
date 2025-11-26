import React, { useState } from 'react';
import { Clock, AlertCircle, CheckCircle2, Circle, Link as LinkIcon, MessageCircle, FileText, Check } from 'lucide-react';
import clsx from 'clsx';
import { db } from '../firebase';
import { doc, updateDoc, getDoc } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { useSwipeable } from 'react-swipeable';
import { LinksModal, CommentsModal, DescriptionModal } from './TaskDetailsModals';
import { InlineEditModal } from './InlineEditModal';

// Time Entry Modal Component
function TimeEntryModal({ isOpen, onClose, onSubmit, direction }) {
    const [time, setTime] = useState('');

    if (!isOpen) return null;

    const handleSubmit = () => {
        if (time) {
            onSubmit(time);
            setTime('');
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
            <div className="bg-white rounded-xl shadow-xl max-w-sm w-full p-6" onClick={(e) => e.stopPropagation()}>
                <h3 className="text-lg font-semibold text-gray-900 mb-4">
                    {direction === 'right' ? 'Pažymėti kaip užbaigtą' : 'Pažymėti kaip pradėtą'}
                </h3>
                <p className="text-sm text-gray-600 mb-4">Įveskite faktinį laiką:</p>

                <select
                    value={time}
                    onChange={(e) => setTime(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 mb-4"
                    autoFocus
                >
                    <option value="">Pasirinkite...</option>
                    <option value="15m">15 min</option>
                    <option value="30m">30 min</option>
                    <option value="45m">45 min</option>
                    <option value="1h">1 val</option>
                    <option value="1h 15m">1 val 15 min</option>
                    <option value="1h 30m">1 val 30 min</option>
                    <option value="1h 45m">1 val 45 min</option>
                    <option value="2h">2 val</option>
                    <option value="2h 30m">2 val 30 min</option>
                    <option value="3h">3 val</option>
                    <option value="4h">4 val</option>
                    <option value="5h">5 val</option>
                    <option value="6h">6 val</option>
                    <option value="7h">7 val</option>
                    <option value="8h">8 val</option>
                </select>

                <div className="flex gap-3">
                    <button
                        onClick={onClose}
                        className="flex-1 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200"
                    >
                        Atšaukti
                    </button>
                    <button
                        onClick={handleSubmit}
                        disabled={!time}
                        className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                    >
                        <Check className="w-4 h-4" />
                        Patvirtinti
                    </button>
                </div>
            </div>
        </div>
    );
}

export default function TaskCard({ task, onEdit, role }) {
    const { currentUser } = useAuth();
    const [activeModal, setActiveModal] = useState(null);
    const [showTimeModal, setShowTimeModal] = useState(null); // 'left' or 'right'
    const [workerColor, setWorkerColor] = useState(null);
    const [lastTap, setLastTap] = useState(0);
    const [editingField, setEditingField] = useState(null); // { field: 'title' | 'description' | 'dayOfWeek', label: string }

    const displayColor = task.assignedWorkerColor || workerColor;
    const isWorker = role === 'worker';
    const isManager = role === 'manager' || role === 'admin';

    React.useEffect(() => {
        if (!task.assignedWorkerColor && task.assignedWorkerId && !workerColor) {
            const fetchWorkerColor = async () => {
                try {
                    const userDoc = await getDoc(doc(db, 'users', task.assignedWorkerId));
                    if (userDoc.exists()) {
                        setWorkerColor(userDoc.data().color);
                    }
                } catch (err) {
                    console.error("Error fetching worker color:", err);
                }
            };
            fetchWorkerColor();
        }
    }, [task.assignedWorkerId, task.assignedWorkerColor]);

    const priorityColors = {
        Low: 'bg-green-100 text-green-800',
        Medium: 'bg-yellow-100 text-yellow-800',
        High: 'bg-orange-100 text-orange-800',
        Urgent: 'bg-red-100 text-red-800'
    };

    const statusStyles = {
        'pending': 'bg-white border-gray-200',
        'in-progress': 'bg-white border-gray-200',
        'completed': 'bg-gray-200 border-gray-300',
        'confirmed': 'bg-green-100 border-green-300'
    };

    const taskStatus = task.status || 'pending';

    // Parse time to add
    const addTime = (existing, newTime) => {
        const parseTime = (str) => {
            if (!str) return 0;
            let total = 0;
            const hMatch = str.match(/(\d+\.?\d*)\s*h/);
            const mMatch = str.match(/(\d+)\s*m/);
            if (hMatch) total += parseFloat(hMatch[1]) * 60;
            if (mMatch) total += parseInt(mMatch[1]);
            return total;
        };

        const formatTime = (minutes) => {
            const h = Math.floor(minutes / 60);
            const m = minutes % 60;
            if (h === 0) return `${m}m`;
            if (m === 0) return `${h}h`;
            return `${h}h ${m}m`;
        };

        const totalMinutes = parseTime(existing) + parseTime(newTime);
        return formatTime(totalMinutes);
    };

    // Swipe handlers
    const handleSwipeLeft = () => {
        if (isWorker && taskStatus !== 'confirmed') {
            setShowTimeModal('left');
        }
    };

    const handleSwipeRight = () => {
        if (isWorker && taskStatus !== 'confirmed') {
            setShowTimeModal('right');
        }
    };

    const handleTimeSubmit = async (time) => {
        try {
            const newActualTime = addTime(task.actualTime, time);

            if (showTimeModal === 'right') {
                // Swipe right: Mark as completed
                await updateDoc(doc(db, 'tasks', task.id), {
                    status: 'completed',
                    actualTime: newActualTime,
                    completed: true,
                    completedAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                });
            } else if (showTimeModal === 'left') {
                // Swipe left: Mark as in-progress
                await updateDoc(doc(db, 'tasks', task.id), {
                    status: 'in-progress',
                    actualTime: newActualTime,
                    updatedAt: new Date().toISOString()
                });
            }

            setShowTimeModal(null);
        } catch (error) {
            console.error('Error updating task:', error);
        }
    };

    // Double-tap handler for touch events
    const handleDoubleTap = async (e) => {
        // Only handle if it's a touch event or if we're on desktop
        if (e.type !== 'touchend' && e.type !== 'click') return;

        const now = Date.now();
        const DOUBLE_TAP_DELAY = 300;

        if (now - lastTap < DOUBLE_TAP_DELAY && isWorker && taskStatus !== 'confirmed') {
            // Double tap detected
            e.preventDefault();
            e.stopPropagation();

            if (taskStatus === 'pending') {
                await updateDoc(doc(db, 'tasks', task.id), {
                    status: 'in-progress',
                    updatedAt: new Date().toISOString()
                });
            } else if (taskStatus === 'in-progress') {
                await updateDoc(doc(db, 'tasks', task.id), {
                    status: 'pending',
                    updatedAt: new Date().toISOString()
                });
            }
        }

        setLastTap(now);
    };

    const swipeHandlers = useSwipeable({
        onSwipedLeft: handleSwipeLeft,
        onSwipedRight: handleSwipeRight,
        trackMouse: false,
        trackTouch: true,
        delta: 50
    });

    const handleToggleComplete = async (e) => {
        e.stopPropagation();
        if (!isWorker) return;

        try {
            const taskRef = doc(db, 'tasks', task.id);
            await updateDoc(taskRef, {
                completed: !task.completed,
                completedAt: !task.completed ? new Date().toISOString() : null,
                updatedAt: new Date().toISOString()
            });
        } catch (error) {
            console.error('Error toggling completion:', error);
        }
    };

    return (
        <>
            <div
                {...(isWorker ? swipeHandlers : {})}
                onTouchEnd={isWorker ? handleDoubleTap : undefined}
                className={clsx(
                    "rounded-lg border-2 shadow-sm p-4 transition-all duration-200",
                    statusStyles[taskStatus],
                    taskStatus !== 'confirmed' && !task.completed && "cursor-pointer hover:shadow-md",
                    task.completed && "opacity-75"
                )}
            >
                <div className="flex items-start gap-3">
                    <div className="flex-1" onClick={!task.completed ? onEdit : undefined}>
                        {/* Header */}
                        <div className="flex justify-between items-start mb-3">
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    if (!task.completed && isWorker) {
                                        setEditingField({ field: 'title', label: 'Redaguoti pavadinimą' });
                                    }
                                }}
                                className={clsx(
                                    "font-semibold line-clamp-1 flex-1 px-2 py-1 rounded text-left",
                                    task.completed ? "line-through text-gray-500" : "text-gray-900",
                                    !task.completed && isWorker && "hover:bg-gray-100"
                                )}
                            >
                                {task.title}
                            </button>
                            {task.priority && (
                                <span className={clsx(
                                    "px-2 py-1 text-xs font-medium rounded ml-2 whitespace-nowrap",
                                    priorityColors[task.priority]
                                )}>
                                    {task.priority === 'Low' ? 'Žemas' : task.priority === 'Medium' ? 'Vidutinis' : task.priority === 'High' ? 'Aukštas' : 'Skubus'}
                                </span>
                            )}
                        </div>

                        {/* Day and Worker */}
                        <div className="flex flex-wrap gap-2 mb-2">
                            {task.dayOfWeek && (
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        if (!task.completed && isWorker) {
                                            setEditingField({ field: 'dayOfWeek', label: 'Redaguoti savaitės dieną' });
                                        }
                                    }}
                                    className={clsx(
                                        "inline-flex items-center px-2 py-1 rounded-md text-xs font-medium bg-blue-50 text-blue-700",
                                        !task.completed && isWorker && "hover:bg-blue-100"
                                    )}
                                >
                                    {task.dayOfWeek}
                                </button>
                            )}
                            {task.assignedWorkerName && (
                                <div
                                    className="inline-flex items-center justify-center p-[4px] rounded-full"
                                    style={{ backgroundColor: displayColor || '#3b82f6' }}
                                >
                                    <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-white text-gray-800 border border-white/50">
                                        👤 {task.assignedWorkerName}
                                    </span>
                                </div>
                            )}
                        </div>

                        {/* Description Button */}
                        {task.description && (
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setActiveModal('description');
                                }}
                                className={clsx(
                                    "text-sm text-left line-clamp-2 mb-3 hover:underline w-full",
                                    task.completed ? "text-gray-400" : "text-gray-600"
                                )}
                            >
                                <FileText className="w-3 h-3 inline mr-1" />
                                {task.description}
                            </button>
                        )}

                        {/* Time Info */}
                        <div className="flex items-center justify-between text-sm mb-3">
                            <span className={clsx("flex items-center gap-2", task.completed ? "text-gray-400" : "text-gray-600")}>
                                <Clock className="w-4 h-4" />
                                {task.estimatedTime || 'Nepriskirta'}
                                {task.actualTime && ` / Faktas: ${task.actualTime}`}
                            </span>
                        </div>

                        {/* Links and Comments */}
                        <div className="flex gap-3 text-xs">
                            {task.links && task.links.length > 0 && (
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setActiveModal('links');
                                    }}
                                    className="flex items-center gap-1 text-blue-600 hover:text-blue-800"
                                >
                                    <LinkIcon className="w-3 h-3" />
                                    {task.links.length}
                                </button>
                            )}
                            {task.comments && task.comments.length > 0 && (
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setActiveModal('comments');
                                    }}
                                    className="flex items-center gap-1 text-gray-600 hover:text-gray-800"
                                >
                                    <MessageCircle className="w-3 h-3" />
                                    {task.comments.length}
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            <TimeEntryModal
                isOpen={!!showTimeModal}
                onClose={() => setShowTimeModal(null)}
                onSubmit={handleTimeSubmit}
                direction={showTimeModal}
            />

            <LinksModal
                isOpen={activeModal === 'links'}
                onClose={() => setActiveModal(null)}
                links={task.links}
            />

            <CommentsModal
                isOpen={activeModal === 'comments'}
                onClose={() => setActiveModal(null)}
                comments={task.comments}
            />

            <DescriptionModal
                isOpen={activeModal === 'description'}
                onClose={() => setActiveModal(null)}
                description={task.description}
            />

            <InlineEditModal
                isOpen={!!editingField}
                onClose={() => setEditingField(null)}
                task={task}
                field={editingField?.field}
                label={editingField?.label}
            />
        </>
    );
}
