import React, { useState, useEffect } from 'react';
import clsx from 'clsx';
import { db } from '../firebase';
import { doc, updateDoc, addDoc, collection, deleteDoc } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { Link as LinkIcon, MessageCircle, CheckCircle2, MessageSquare, Trash2, ArrowUp, ArrowDown, ImageIcon, Undo2 } from 'lucide-react';
import { LinksModal, CommentsModal, DescriptionModal, ImageModal, DeleteConfirmationModal, TimeAdjustmentsModal } from './TaskDetailsModals';
import TaskTimerControls from './TaskTimerControls';
import { formatMinutesToTimeString, calculateCurrentTotalMinutes, getLithuanianNow } from '../utils/timeUtils';
import { deleteTask, revertTask } from '../utils/taskActions';
import { toggleTaskCompletion } from '../utils/taskCompletionActions';
import { formatDisplayName, isManagerRole } from '../utils/formatters';
import { WORKER_FALLBACK_COLOR } from '../utils/colors';
import { getPriorityColor, getPriorityLabel, getPriorityTextColor } from '../utils/priority';
import { addComment, updateComment, deleteComment } from '../utils/commentActions';
import { STATUS_LABELS, STATUS_COLORS } from '../utils/taskConstants';
import SessionTypeIcon from './SessionTypeIcon';

const TaskTable = ({ tasks, onEdit, role, showReorderControls, onMoveUp, onMoveDown, hideCheckboxes }) => {
    const { currentUser, userRole, userData } = useAuth();
    const [activeModal, setActiveModal] = useState({ type: null, taskId: null }); // { type: 'description'|'links'|'comments', taskId: string }
    const [, setRefreshTick] = useState(0);
    const [deleteModalTask, setDeleteModalTask] = useState(null);

    // Comment Editing State
    const [editingComment, setEditingComment] = useState({ taskId: null, index: null });
    const [editCommentText, setEditCommentText] = useState('');

    // Auto-refresh timer for running tasks (every 60 seconds)
    useEffect(() => {
        const interval = setInterval(() => {
            setRefreshTick(prev => prev + 1);
        }, 60000); // 60 seconds
        return () => clearInterval(interval);
    }, []);



    const handleAddAdjustment = async (taskId, date, h, m, reason) => {
        try {
            const task = tasks.find(t => t.id === taskId);
            if (!task) return;
            const durationMinutes = (parseInt(h) || 0) * 60 + (parseInt(m) || 0);

            const now = getLithuanianNow();
            const newSessionRef = await addDoc(collection(db, 'work_sessions'), {
                taskId: task.id,
                taskTitle: `🕒 Korekcija: ${task.title}${reason ? ` - ${reason}` : ''}`,
                userId: task.assignedUserId || task.creatorId || 'unknown',
                userName: task.assignedUserName || task.creatorName || 'Nežinomas',
                startTime: new Date(date + 'T12:00:00').toISOString(),
                endTime: new Date(date + 'T12:00:00').toISOString(),
                durationMinutes: durationMinutes,
                date: date,
                createdAt: now.toISOString(),
                isManualAdjustment: true
            });

            const newAdj = {
                id: newSessionRef.id,
                date: date,
                durationMinutes: durationMinutes,
                reason: reason,
                createdAt: now.toISOString()
            };

            await updateDoc(doc(db, 'tasks', task.id), {
                timeAdjustments: [...(task.timeAdjustments || []), newAdj],
                updatedAt: new Date().toISOString()
            });
        } catch (err) {
            console.error('Error adding adjustment:', err);
            alert('Nepavyko pridėti laiko korekcijos: ' + err.message);
        }
    };

    const handleDeleteAdjustment = async (taskId, adj) => {
        if (!window.confirm("Ar tikrai norite ištrinti šią korekciją?")) return;
        try {
            const task = tasks.find(t => t.id === taskId);
            if (!task) return;

            await deleteDoc(doc(db, 'work_sessions', adj.id));

            const newAdjustments = (task.timeAdjustments || []).filter(a => a.id !== adj.id);
            await updateDoc(doc(db, 'tasks', task.id), {
                timeAdjustments: newAdjustments,
                updatedAt: new Date().toISOString()
            });
        } catch (err) {
            console.error('Error deleting adjustment:', err);
            alert('Nepavyko ištrinti korekcijos.');
        }
    };

    const handleUpdateComment = async (taskId, index, newText) => {
        try {
            const task = tasks.find(t => t.id === taskId);
            await updateComment(taskId, index, newText, task?.comments);
            setEditingComment({ taskId: null, index: null });
            setEditCommentText('');
        } catch (err) {
            alert("Nepavyko atnaujinti komentaro.");
        }
    };

    const handleDeleteComment = async (taskId, index) => {
        if (!window.confirm("Ar tikrai norite ištrinti komentarą?")) return;
        try {
            const task = tasks.find(t => t.id === taskId);
            await deleteComment(taskId, index, task?.comments);
        } catch (err) {
            // Error managed in utility
        }
    };

    const formatDeadline = (dateStr) => {
        if (!dateStr) return '-';
        try {
            const date = new Date(dateStr);
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return `${month}.${day}d`;
        } catch (e) {
            return dateStr;
        }
    };

    const handleToggleComplete = async (taskId, currentStatus) => {
        try {
            const task = tasks.find(t => t.id === taskId);
            if (!task) return;

            if (!currentStatus && !window.confirm("Ar tikrai norite užbaigti užduotį?")) {
                return;
            }

            await toggleTaskCompletion(task, currentUser.uid, userRole, task.managerId);
        } catch (err) {
            console.error("Error toggling task completion:", err);
        }
    };

    const handleConfirmTask = async (taskId) => {
        // PERMISSION CHECK: Only explicit Managers or Admins can confirm tasks.
        // Task-level managers (who are not system managers) cannot confirm.
        if (!isManagerRole(userRole)) {
            alert("Tik vadovai gali patvirtinti užduotis.");
            return;
        }

        try {
            const task = tasks.find(t => t.id === taskId);
            if (!task) return;

            const taskData = {
                ...task,
                status: 'confirmed',
                confirmedBy: currentUser.uid,
                confirmedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };

            // Sanitize data to remove undefined values
            Object.keys(taskData).forEach(key => taskData[key] === undefined && delete taskData[key]);

            // Do NOT archive immediately
            await updateDoc(doc(db, 'tasks', taskId), taskData);
        } catch (err) {
            console.error("Error confirming task:", err);
        }
    };

    // Manual archiving removed per request. Archive only via nightly automation.

    const handleApproveTask = async (taskId) => {
        try {
            const task = tasks.find(t => t.id === taskId);
            if (!task) return;
            await updateDoc(doc(db, 'tasks', taskId), {
                status: 'pending',
                updatedAt: new Date().toISOString()
            });
        } catch (err) {
            // alert("Nepavyko patvirtinti užduoties.");
        }
    };

    const handleDeleteTask = (taskId, taskTitle) => {
        const taskToDelete = tasks.find(t => t.id === taskId) || { id: taskId, title: taskTitle };
        setDeleteModalTask(taskToDelete);
    };

    const confirmDeleteTask = async ({ keepWorkHours }) => {
        if (!deleteModalTask) return;
        try {
            await deleteTask(deleteModalTask, currentUser.uid, { keepWorkHours });
            setDeleteModalTask(null);
        } catch (err) {
            console.error("Error deleting task:", err);
            alert("Nepavyko ištrinti užduoties: " + err.message);
        }
    };

    const isTaskRunning = (task) => {
        if (currentUser?.uid !== task.assignedUserId || task.timerStatus !== 'running') return false;
        const activeSession = userData?.activeSession;
        if (activeSession) return activeSession.type === 'task' && activeSession.taskId === task.id;
        if (userData?.workStatus?.status === 'running') return userData.workStatus.activeTaskId === task.id;
        if (userData?.workStatus?.status === 'idle' || userData?.workStatus?.status === 'paused') return false;
        return false;
    };

    const getStatusStyle = (task) => {
        if (isTaskRunning(task)) return 'bg-green-200 border-green-300';

        const status = task.status || 'pending';
        if (status === 'confirmed') return 'bg-gray-50';
        if (status === 'completed') return 'bg-gray-100';
        if (status === 'unapproved') return 'bg-amber-50';
        return 'bg-white';
    };



    const handleAddComment = async (taskId, text) => {
        try {
            const task = tasks.find(t => t.id === taskId);
            // Optimization: if commentActions is robust to null comments, we can simplify, 
            // but fetching task here is safe if we don't have it passed fully.
            // However, tasks prop usually has comments.
            await addComment(taskId, text, currentUser, task?.comments);
        } catch (err) {
            alert("Nepavyko pridėti komentaro.");
        }
    };

    const isWorker = role === 'worker';
    const canManage = isManagerRole(userRole);

    return (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
            <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200 table-fixed">
                    <thead className="bg-gray-50">
                        <tr>
                            {showReorderControls && (
                                <th className="px-2 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider w-10">
                                    #
                                </th>
                            )}
                            {!hideCheckboxes && (
                                <th className="px-2 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider w-10">
                                    ✓
                                </th>
                            )}
                            <th className={`px-1 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider ${!isWorker ? 'w-72' : ''}`}>Užduotis</th>
                            <th className="px-1 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-24">Darb.</th>
                            <th className="px-1 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-16">Žyma</th>
                            <th className="px-1 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-16">Atlikti iki</th>
                            <th className="px-1 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-16">Prior.</th>
                            <th className="px-1 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-20">Būsena</th>
                            <th className="px-1 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-14" title="Numatytas laikas">Num.</th>
                            <th className="px-1 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-16">Nuorodos</th>
                            <th className="px-1 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-10 text-center">Kom.</th>
                            {canManage && <th className="px-1 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider w-12">Patv.</th>}
                            <th className="px-1 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider w-24">Veik.</th>
                        </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                        {tasks.map((task) => {
                            const isAssignedToMe = currentUser?.uid === task.assignedUserId;
                            return (
                                <React.Fragment key={task.id}>
                                    <tr className={clsx(
                                        "transition-colors",
                                        getStatusStyle(task),
                                        !task.completed && "hover:opacity-90"
                                    )}>
                                        {showReorderControls && (
                                            <td className="px-2 py-3 text-center">
                                                <div className="flex flex-col items-center gap-1">
                                                    <button
                                                        onClick={(e) => { e.stopPropagation(); onMoveUp(task.id); }}
                                                        className="text-gray-400 hover:text-blue-600 transition-colors p-0.5 hover:bg-gray-100 rounded"
                                                        title="Perkelti aukštyn"
                                                    >
                                                        <ArrowUp className="w-3.5 h-3.5" />
                                                    </button>
                                                    <button
                                                        onClick={(e) => { e.stopPropagation(); onMoveDown(task.id); }}
                                                        className="text-gray-400 hover:text-blue-600 transition-colors p-0.5 hover:bg-gray-100 rounded"
                                                        title="Perkelti žemyn"
                                                    >
                                                        <ArrowDown className="w-3.5 h-3.5" />
                                                    </button>
                                                </div>
                                            </td>
                                        )}
                                        {!hideCheckboxes && (
                                            <td className="px-1 py-3 text-center">
                                                <input
                                                    type="checkbox"
                                                    checked={task.completed || false}
                                                    onChange={() => {
                                                        if (isAssignedToMe) {
                                                            handleToggleComplete(task.id, task.completed);
                                                        }
                                                    }}
                                                    disabled={!isAssignedToMe || task.status === 'confirmed' || task.status === 'unapproved'}
                                                    className={clsx(
                                                        "w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500",
                                                        isAssignedToMe && task.status !== 'confirmed' && task.status !== 'unapproved' ? "cursor-pointer" : "cursor-not-allowed opacity-50"
                                                    )}
                                                />
                                            </td>
                                        )}
                                        <td className="px-1 py-3">
                                            <div className={clsx(
                                                "text-sm font-medium break-words rounded px-2 py-1",
                                                (task.completed || task.isDeleted) ? "text-gray-500 line-through" : "text-gray-900",
                                                task.status === 'unapproved' ? "bg-gray-200 text-gray-700" : ""
                                            )}>
                                                {task.title}
                                                {task.isDeleted && (
                                                    <span className="ml-2 inline-block no-underline px-1.5 py-0.5 text-[9px] font-bold bg-red-100 text-red-600 rounded border border-red-200 align-middle" style={{ textDecoration: 'none' }}>
                                                        Ištrintas
                                                    </span>
                                                )}
                                            </div>
                                            {(task.managerName || task.creatorName) && (
                                                <div className="text-[9px] text-purple-600 font-medium mt-0.5 opacity-80">
                                                    Vadovas: {formatDisplayName(task.managerName || task.creatorName)}
                                                </div>
                                            )}
                                            {/* Deadline removed from here, moving to own column */}
                                            {task.description && (
                                                <button
                                                    onClick={() => setActiveModal({ type: 'description', taskId: task.id })}
                                                    className="text-xs text-gray-600 hover:text-blue-600 hover:bg-blue-50/50 p-1 rounded-md transition-colors line-clamp-3 text-left w-full mt-1 border border-transparent hover:border-blue-100 whitespace-pre-wrap flex items-start gap-1"
                                                >
                                                    <SessionTypeIcon
                                                        type={task.isSystemTask ? 'call' : (task.isQuickWork ? 'quickWork' : 'task')}
                                                        className="w-3.5 h-3.5 flex-shrink-0 mt-0.5"
                                                    />
                                                    {task.description}
                                                </button>
                                            )}

                                            {/* Comments List */}
                                            {task.comments && task.comments.length > 0 && (
                                                <div className="mt-2 space-y-1.5 pl-2 border-l-2 border-indigo-100">
                                                    {task.comments.map((comment, index) => {
                                                        const isEditing = editingComment.taskId === task.id && editingComment.index === index;
                                                        const canEdit = canManage || comment.userId === currentUser.uid;

                                                        return (
                                                            <div key={index} className="text-[11px] bg-indigo-50/30 rounded p-1.5 group hover:bg-indigo-50/60 transition-colors">
                                                                <div className="flex justify-between items-start mb-0.5">
                                                                    <div className="flex items-center gap-1.5 text-[10px]">
                                                                        <MessageCircle className="w-2.5 h-2.5 text-indigo-400" />
                                                                        <span className="font-semibold text-indigo-700">{formatDisplayName(comment.user)}</span>
                                                                        <span className="text-gray-400">{new Date(comment.createdAt).toLocaleDateString()}</span>
                                                                    </div>
                                                                    {canEdit && !isEditing && (
                                                                        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                                                            <button
                                                                                onClick={(e) => {
                                                                                    e.stopPropagation();
                                                                                    setEditingComment({ taskId: task.id, index });
                                                                                    setEditCommentText(comment.text);
                                                                                }}
                                                                                className="text-gray-400 hover:text-blue-600"
                                                                                title="Redaguoti"
                                                                            >
                                                                                <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                                                                            </button>
                                                                            <button
                                                                                onClick={(e) => {
                                                                                    e.stopPropagation();
                                                                                    handleDeleteComment(task.id, index);
                                                                                }}
                                                                                className="text-gray-400 hover:text-red-600"
                                                                                title="Ištrinti"
                                                                            >
                                                                                <Trash2 className="w-2.5 h-2.5" />
                                                                            </button>
                                                                        </div>
                                                                    )}
                                                                </div>

                                                                {isEditing ? (
                                                                    <div onClick={(e) => e.stopPropagation()}>
                                                                        <textarea
                                                                            value={editCommentText}
                                                                            onChange={(e) => setEditCommentText(e.target.value)}
                                                                            className="w-full text-[11px] p-1 border rounded resize-none focus:ring-1 focus:ring-blue-500"
                                                                            rows={2}
                                                                            autoFocus
                                                                        />
                                                                        <div className="flex justify-end gap-1 mt-1">
                                                                            <button
                                                                                onClick={() => setEditingComment({ taskId: null, index: null })}
                                                                                className="px-1.5 py-0.5 text-[10px] text-gray-500 hover:text-gray-700 bg-white border border-gray-200 rounded"
                                                                            >
                                                                                Atšaukti
                                                                            </button>
                                                                            <button
                                                                                onClick={() => handleUpdateComment(task.id, index, editCommentText)}
                                                                                className="px-1.5 py-0.5 text-[10px] text-white bg-blue-600 hover:bg-blue-700 rounded"
                                                                            >
                                                                                Išsaugoti
                                                                            </button>
                                                                        </div>
                                                                    </div>
                                                                ) : (
                                                                    <div className="text-gray-600 leading-snug break-words pl-4">
                                                                        {comment.text}
                                                                    </div>
                                                                )}
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            )}
                                            {task.completed && task.completedAt && (
                                                <div className="text-[10px] text-gray-400 mt-1">
                                                    {new Date(task.completedAt).toLocaleDateString()}
                                                </div>
                                            )}
                                        </td>
                                        <td className="px-1 py-3 whitespace-nowrap">
                                            {task.assignedUserName && (
                                                <div
                                                    className="inline-flex items-center justify-center p-[3px] rounded-full"
                                                    style={{ backgroundColor: task.assignedWorkerColor || WORKER_FALLBACK_COLOR }}
                                                >
                                                    <span className="px-1.5 py-0.5 rounded-full text-[11px] font-bold bg-white text-gray-800 border border-white/50 max-w-[120px] truncate block">
                                                        👤 {formatDisplayName(task.assignedUserName)}
                                                    </span>
                                                </div>
                                            )}
                                        </td>
                                        <td className="px-1 py-3 whitespace-nowrap">
                                            {task.tag && (
                                                <span className="px-1.5 py-0.5 inline-flex text-[10px] leading-4 font-semibold rounded-md bg-purple-100 text-purple-800 border border-purple-200">
                                                    {task.tag}
                                                </span>
                                            )}
                                        </td>
                                        <td className="px-1 py-3 whitespace-nowrap text-xs text-gray-600">
                                            {formatDeadline(task.deadline)}
                                        </td>
                                        <td className="px-1 py-3 whitespace-nowrap">
                                            <span
                                                className={clsx(
                                                    "px-1.5 py-0.5 inline-flex text-[10px] leading-4 font-semibold rounded-md border border-black/5"
                                                )}
                                                style={{
                                                    backgroundColor: getPriorityColor(task.priority),
                                                    color: getPriorityTextColor(task.priority)
                                                }}
                                            >
                                                {getPriorityLabel(task.priority)}
                                            </span>
                                        </td>
                                        <td className="px-1 py-3 whitespace-nowrap">
                                            <div className="flex flex-col gap-0.5">
                                                <span className={clsx(
                                                    "px-1.5 py-0.5 inline-flex text-[10px] leading-4 font-semibold rounded-full max-w-[100px] truncate",
                                                    STATUS_COLORS[task.status || 'pending']
                                                )}>
                                                    {STATUS_LABELS[task.status || 'pending']}
                                                </span>
                                                {(() => {
                                                    const totalMinutes = calculateCurrentTotalMinutes(task);
                                                    const hasStarted = task.status && task.status !== 'pending';
                                                    if (totalMinutes > 0 || hasStarted) {
                                                        return (
                                                            <div className="flex items-center gap-1 mt-0.5 min-h-[14px]">
                                                                <span className="text-[10px] text-blue-600 font-bold whitespace-nowrap">
                                                                    {formatMinutesToTimeString(totalMinutes)}
                                                                </span>
                                                                {canManage && (
                                                                    <button onClick={(e) => { e.stopPropagation(); setActiveModal({ type: 'timeAdjustments', taskId: task.id }); }} className="text-blue-500 hover:text-blue-700" title="Koreguoti laiką">
                                                                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                                                                    </button>
                                                                )}
                                                            </div>
                                                        );
                                                    } else if (canManage && task.status === 'pending') {
                                                        return (
                                                            <div className="flex items-center gap-1 mt-0.5 min-h-[14px]">
                                                                <button onClick={(e) => { e.stopPropagation(); setActiveModal({ type: 'timeAdjustments', taskId: task.id }); }} className="text-blue-500 hover:text-blue-700" title="Koreguoti laiką">
                                                                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21036H3v-3.572L16.732 3.732z" /></svg>
                                                                </button>
                                                            </div>
                                                        );
                                                    }
                                                    return null;
                                                })()}
                                                {task.timeChanged && (
                                                    <span className="text-red-600 font-bold text-[9px] uppercase tracking-wide">⚠ Pakeistas laikas</span>
                                                )}
                                            </div>
                                        </td>
                                        <td className="px-1 py-3 whitespace-nowrap text-xs text-gray-500">
                                            {task.estimatedTime || '-'}
                                        </td>
                                        <td className="px-1 py-3 text-xs">
                                            <div className="flex flex-wrap gap-1.5 min-w-[60px]">
                                                {(() => {
                                                    const allLinks = (task.links || []).flatMap(l => l.split('\n')).filter(l => l.trim().length > 0);
                                                    return allLinks.slice(0, 4).map((link, idx) => (
                                                        <a
                                                            key={idx}
                                                            href={link.trim().startsWith('http') ? link.trim() : `https://${link.trim()}`}
                                                            target="_blank"
                                                            rel="noopener noreferrer"
                                                            className="text-blue-600 hover:text-blue-800 transition-transform active:scale-90"
                                                            title={link.trim()}
                                                            onClick={(e) => e.stopPropagation()}
                                                        >
                                                            <LinkIcon className="w-4 h-4" />
                                                        </a>
                                                    ));
                                                })()}
                                            </div>
                                            {((task.attachmentUrls && task.attachmentUrls.length > 0) || task.attachmentUrl) && (
                                                <div className="mt-1 flex justify-center">
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            setActiveModal({ type: 'image', taskId: task.id });
                                                        }}
                                                        className="text-pink-600 hover:text-pink-800 transition-transform active:scale-90"
                                                        title="Peržiūrėti nuotrauką"
                                                    >
                                                        <ImageIcon className="w-4 h-4" />
                                                    </button>
                                                </div>
                                            )}
                                        </td>
                                        <td className="px-1 py-3 text-center">
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    setActiveModal({ type: 'comments', taskId: task.id });
                                                }}
                                                className="inline-flex items-center gap-1 text-green-600 hover:text-green-800 transition-colors"
                                                title="Komentarai"
                                            >
                                                <MessageSquare className="w-4 h-4" />
                                                {task.comments?.length > 0 && (
                                                    <span className="text-[10px] font-bold">{task.comments.length}</span>
                                                )}
                                            </button>
                                        </td>
                                        {canManage && (
                                            <td className="px-1 py-3 text-center">
                                                {task.status === 'completed' && task.status !== 'confirmed' && (
                                                    canManage ? (
                                                        <input
                                                            type="checkbox"
                                                            checked={false}
                                                            onChange={() => handleConfirmTask(task.id)}
                                                            className="w-4 h-4 rounded border-gray-300 text-green-600 focus:ring-green-500 cursor-pointer"
                                                            title="Patvirtinti atlikimą"
                                                        />
                                                    ) : null
                                                )}
                                                {task.status === 'unapproved' && (
                                                    <button
                                                        onClick={() => handleApproveTask(task.id)}
                                                        className="text-[10px] bg-green-100 text-green-700 px-2 py-1 rounded border border-green-200 hover:bg-green-200 transition-colors"
                                                        title="Patvirtinti užduotį (leisti vykdyti)"
                                                    >
                                                        Patvirtinti
                                                    </button>
                                                )}
                                                {task.status === 'confirmed' && (
                                                    <span className="inline-flex items-center text-green-600">
                                                        <CheckCircle2 className="w-4 h-4" />
                                                    </span>
                                                )}
                                            </td>
                                        )}
                                        <td className="px-1 py-3 text-right text-xs font-medium valign-top">
                                            <div className="flex flex-col items-end gap-2">
                                                {onEdit && (
                                                    <button
                                                        onClick={() => onEdit(task)}
                                                        className="text-blue-600 hover:text-blue-900 font-medium"
                                                    >
                                                        Redaguoti
                                                    </button>
                                                )}
                                                {(task.completed || task.isDeleted) && canManage && (
                                                    <button
                                                        onClick={async () => {
                                                            if (!window.confirm('Ar tikrai norite grąžinti šią užduotį?')) return;
                                                            try {
                                                                await revertTask(task);
                                                            } catch (err) {
                                                                alert('Nepavyko grąžinti užduoties: ' + err.message);
                                                            }
                                                        }}
                                                        className="text-amber-600 hover:text-amber-800 font-medium flex items-center justify-end gap-1"
                                                        title="Grąžinti užduotį"
                                                    >
                                                        <Undo2 className="w-3 h-3" />
                                                        Grąžinti
                                                    </button>
                                                )}
                                                {(canManage || !isWorker) && (
                                                    <button
                                                        onClick={() => handleDeleteTask(task.id, task.title)}
                                                        className="text-red-500 hover:text-red-700 font-medium flex items-center justify-end gap-1"
                                                        title="Ištrinti"
                                                    >
                                                        <Trash2 className="w-3 h-3" />
                                                        Ištrinti
                                                    </button>
                                                )}
                                                {/* Manual Archive button removed */}
                                                <div className="w-full">
                                                    <TaskTimerControls
                                                        task={task}
                                                        role={role}
                                                    />
                                                </div>
                                            </div>
                                        </td>
                                    </tr>
                                </React.Fragment>
                            );
                        })}
                    </tbody>
                </table>
            </div>
            {/* Modals */}
            {
                activeModal.taskId && (() => {
                    const task = tasks.find(t => t.id === activeModal.taskId);
                    if (!task) return null;

                    return (
                        <>
                            <DescriptionModal
                                isOpen={activeModal.type === 'description'}
                                onClose={() => setActiveModal({ type: null, taskId: null })}
                                description={task.description}
                            />
                            <LinksModal
                                isOpen={activeModal.type === 'links'}
                                onClose={() => setActiveModal({ type: null, taskId: null })}
                                links={task.links}
                            />
                            <CommentsModal
                                isOpen={activeModal.type === 'comments'}
                                onClose={() => setActiveModal({ type: null, taskId: null })}
                                comments={task.comments}
                                onAddComment={(text) => handleAddComment(task.id, text)}
                            />
                            <ImageModal
                                isOpen={activeModal.type === 'image'}
                                onClose={() => setActiveModal({ type: null, taskId: null })}
                                imageUrls={task.attachmentUrls && task.attachmentUrls.length > 0 ? task.attachmentUrls : (task.attachmentUrl ? [task.attachmentUrl] : [])}
                            />
                            <TimeAdjustmentsModal
                                isOpen={activeModal.type === 'timeAdjustments'}
                                onClose={() => setActiveModal({ type: null, taskId: null })}
                                task={task}
                                onAddAdjustment={handleAddAdjustment}
                                onDeleteAdjustment={handleDeleteAdjustment}
                            />
                        </>
                    );
                })()
            }

            <DeleteConfirmationModal
                isOpen={!!deleteModalTask}
                onClose={() => setDeleteModalTask(null)}
                onConfirm={confirmDeleteTask}
                taskTitle={deleteModalTask?.title || ''}
            />
        </div >
    );
};

export default React.memo(TaskTable, (prevProps, nextProps) => {
    if (prevProps.role !== nextProps.role) return false;
    if (prevProps.showReorderControls !== nextProps.showReorderControls) return false;
    if (prevProps.tasks?.length !== nextProps.tasks?.length) return false;

    // Fast check by reference and updatedAt
    for (let i = 0; i < (prevProps.tasks?.length || 0); i++) {
        const prevTask = prevProps.tasks[i];
        const nextTask = nextProps.tasks[i];
        if (prevTask.id !== nextTask.id) return false; // order changed
        if (prevTask.updatedAt !== nextTask.updatedAt) return false;
        if (prevTask.status !== nextTask.status) return false;
        if (prevTask.comments?.length !== nextTask.comments?.length) return false;
        if (prevTask.timeChanged !== nextTask.timeChanged) return false;
    }
    return true;
});
