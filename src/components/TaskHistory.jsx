import { useState, useEffect, useRef } from 'react';
import { db } from '../firebase';
import { collection, query, orderBy, onSnapshot, deleteDoc, doc, setDoc, where, addDoc, getDocs, updateDoc } from 'firebase/firestore';
import { FileText, Download, RotateCcw, Calendar, UserCheck, Filter, Trash2, MessageCircle, Pencil, AlertCircle, ChevronDown, ChevronUp } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { getPriorityLabel } from '../utils/priority';
import clsx from 'clsx';
import { startOfWeek, subWeeks } from 'date-fns';
import { formatDisplayName, isManagerRole, resolveUserId, resolveUserName } from '../utils/formatters';
import { privateScopeConstraints, isScopedOverseer } from '../utils/teamScope';
import { TASK_TAGS } from '../utils/taskUtils';
import { getLithuanianDateString, getLithuanianNow, calculateCurrentTotalMinutes, formatMinutesToTimeString, formatMinutesToHHMM } from '../utils/timeUtils';
import { deleteTask } from '../utils/taskActions';
import { DeleteConfirmationModal, CommentsModal, TimeAdjustmentsModal } from './TaskDetailsModals';
import SessionTypeIcon from './SessionTypeIcon';
import { addComment } from '../utils/commentActions';
import IconButton from './ui/IconButton';
import InfoPopover from './ui/InfoPopover';
import ConfirmDialog from './ui/ConfirmDialog';
import TaskStatusPill from './task/TaskStatusPill';
import PriorityBadge from './task/PriorityBadge';
import DeletedBadge from './task/DeletedBadge';
import CompletedMarker from './task/CompletedMarker';
import TimeChangedWarning from './task/TimeChangedWarning';
import AssigneeChip from './task/AssigneeChip';
import UserChip from './UserChip';

// Filter field label — shared by every filter control. 12px floor (§5): was text-[10px].
const FILTER_LABEL_CLASS = 'text-caption uppercase font-bold text-ink-muted';
const SELECT_CLASS =
    'bg-surface-card border border-line text-ink text-body rounded-input block w-full px-2.5 py-1.5 ' +
    'focus:border-brand focus:outline-none focus-visible:ring-2 focus-visible:ring-brand';

// `canExport` gates the CSV / AI-JSON download buttons. It is OFF by default so personal
// report views (a worker's own "Ataskaitos", and a manager's personal "Ataskaitos") never
// expose a self-export. Only the manager team report ("Kom. ataskaitos") opts in.
export default function TaskHistory({ userId, users = [], canExport = false, approvalManagerUid = null }) {
    const { userRole, currentUser, userData } = useAuth();
    const isManagerOrAdmin = isManagerRole(userRole);
    // Scoped managers only ever read their team's archived tasks (array-contains); this surface
    // is manager/admin-only (rendered when "all" is selected), so the effective role is never 'worker'.
    const scoped = isScopedOverseer(userData);
    const [tasks, setTasks] = useState([]);
    const [loading, setLoading] = useState(true);
    const [expandedTasks, setExpandedTasks] = useState(new Set());
    const [deleteModalTask, setDeleteModalTask] = useState(null);
    const [activeModal, setActiveModal] = useState({ type: null, taskId: null });
    const [commentsModalTask, setCommentsModalTask] = useState(null);

    // Confirm dialogs (replace window.confirm — §8) and friendly error banner (replace alert — §10)
    const [restoreTarget, setRestoreTarget] = useState(null);
    const [restoring, setRestoring] = useState(false);
    const [adjustmentDeleteTarget, setAdjustmentDeleteTarget] = useState(null);
    const [error, setError] = useState('');

    // Filter States
    const [dateFrom, setDateFrom] = useState('');
    const [dateTo, setDateTo] = useState('');
    const [filterUser, setFilterUser] = useState('all');
    const [filterTag, setFilterTag] = useState('all');
    const [sortBy, setSortBy] = useState('date'); // 'date' | 'status'

    // Two nested accordions: the whole history panel collapses (closed by default — it is an
    // archive, secondary to the live daily report above it), and inside it the filter controls
    // collapse independently (also closed by default so the panel opens compact).
    const [historyOpen, setHistoryOpen] = useState(false);
    const [filtersOpen, setFiltersOpen] = useState(false);
    // Date range lives behind a single field; tapping it opens the from/to pickers in a popover.
    const [dateRangeOpen, setDateRangeOpen] = useState(false);
    const dateRangeRef = useRef(null);

    useEffect(() => {
        if (!dateRangeOpen) return undefined;
        const onPointerDown = (e) => {
            if (dateRangeRef.current && !dateRangeRef.current.contains(e.target)) {
                setDateRangeOpen(false);
            }
        };
        const onKeyDown = (e) => { if (e.key === 'Escape') setDateRangeOpen(false); };
        document.addEventListener('pointerdown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('pointerdown', onPointerDown);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [dateRangeOpen]);

    const toggleExpand = (taskId) => {
        const newExpanded = new Set(expandedTasks);
        if (newExpanded.has(taskId)) {
            newExpanded.delete(taskId);
        } else {
            newExpanded.add(taskId);
        }
        setExpandedTasks(newExpanded);
    };

    // Initialize dates on mount (Last 2 weeks)
    useEffect(() => {
        const now = getLithuanianNow();
        const startOfCurrentWeek = startOfWeek(now, { weekStartsOn: 1 });
        const start = subWeeks(startOfCurrentWeek, 1); // Current week + 1 previous

        setDateFrom(getLithuanianDateString(start));
        setDateTo(getLithuanianDateString(now));
    }, []);

    // Fetch tasks based on filters
    useEffect(() => {
        if (!dateFrom || !dateTo) return;

        setLoading(true);

        const start = new Date(dateFrom);
        start.setHours(0, 0, 0, 0); // Start of day

        const end = new Date(dateTo);
        end.setHours(23, 59, 59, 999); // End of day

        const startIso = start.toISOString();
        const endIso = end.toISOString();

        // Determine effective user ID to query
        // If explicit 'userId' prop is passed (e.g. from Worker view), use it.
        // If 'userId' prop is 'all' (Manager view), use the local 'filterUser' state.
        let targetUserId = 'all';
        if (userId && userId !== 'all') {
            targetUserId = userId; // Worker view or specific user prop
        } else {
            targetUserId = filterUser; // Manager view dropdown selection
        }

        let q;

        // Base Query constraints. A scoped manager constrains to their team (array-contains) so
        // the read is allowed once the rules tighten; admins/unscoped managers read broadly.
        const scope = privateScopeConstraints({
            userData, uid: currentUser?.uid, effectiveRole: userData?.role, ownerField: 'assignedUserId'
        });
        const constraints = [
            where('archivedAt', '>=', startIso),
            where('archivedAt', '<=', endIso),
            orderBy('archivedAt', 'desc'),
            ...scope
        ];

        q = query(collection(db, 'archived_tasks'), ...constraints);

        const mapDoc = (docSnap) => {
            const data = docSnap.data();
            return {
                id: docSnap.id,
                ...data,
                assignedUserId: resolveUserId(data),
                assignedUserName: resolveUserName(data)
            };
        };

        // Two result sets merged by id: the team-scoped base query, plus (scoped managers only) a
        // supplement of tasks this manager owns as the named vadovas. See vadovasQ below.
        let teamRows = [];
        let vadovasRows = [];

        const recompute = () => {
            // Merge + dedupe by id (a task can match BOTH sets when the worker is on the team AND
            // this manager is its vadovas).
            const byId = new Map();
            [...teamRows, ...vadovasRows].forEach(t => { if (t.id) byId.set(t.id, t); });

            // Client-side filtering for Tag (Firestore limitation on multiple inequality/array-contains with inequalities)
            // And any other refinement
            const filteredTasks = Array.from(byId.values()).filter(task => {
                // The vadovas supplement carries no archivedAt range (single-field equality, no
                // composite index), so bound it to the selected window here; base rows are already
                // server-bounded and pass trivially.
                if (task.archivedAt && (task.archivedAt < startIso || task.archivedAt > endIso)) return false;
                if (targetUserId !== 'all' && task.assignedUserId !== targetUserId) return false;
                if (filterTag !== 'all' && task.tag !== filterTag) return false;
                // Approval surface: restrict the archive to this manager's tasks — ones they own
                // as vadovas (managerId), or whose worker they manage. "Managers of the doer" comes
                // from the task's denormalized teamManagerIds, with the worker's user doc as a
                // fallback for any legacy row written before that denormalization.
                if (approvalManagerUid) {
                    const ownsAsManager = task.managerId === approvalManagerUid;
                    let managesDoer = Array.isArray(task.teamManagerIds) && task.teamManagerIds.includes(approvalManagerUid);
                    if (!managesDoer) {
                        const doer = users.find(u => u.id === task.assignedUserId);
                        managesDoer = !!doer && Array.isArray(doer.teamManagerIds) && doer.teamManagerIds.includes(approvalManagerUid);
                    }
                    if (!ownsAsManager && !managesDoer) return false;
                }
                return true;
            });

            // Sort manually ensuring robust timestamp handling
            const sortedTasks = filteredTasks.sort((a, b) => {
                if (sortBy === 'status') {
                    const getStatusRank = (task) => {
                        if (task.isDeleted || task.status === 'deleted') return 3;
                        if (task.status === 'confirmed') return 2;
                        return 1; // 'completed' / unconfirmed
                    };
                    const rankA = getStatusRank(a);
                    const rankB = getStatusRank(b);
                    if (rankA !== rankB) return rankA - rankB; // Ascending rank
                }

                const getTimestamp = (task) => {
                    const dateStr = task.completedAt || task.archivedAt || task.updatedAt;
                    if (!dateStr) return 0;
                    const timestamp = new Date(dateStr).getTime();
                    return isNaN(timestamp) ? 0 : timestamp;
                };

                const timeA = getTimestamp(a);
                const timeB = getTimestamp(b);

                return timeB - timeA;
            });

            setTasks(sortedTasks);
            setLoading(false);
        };

        const unsubscribe = onSnapshot(q, (snapshot) => {
            teamRows = snapshot.docs.map(mapDoc);
            recompute();
        }, (error) => {
            console.error("Error subscribing to archived tasks:", error);
            setLoading(false);
        });

        // Vadovas supplement (scoped managers only): the team array-contains query above misses
        // archived tasks where this manager is the named vadovas (managerId) but the worker is NOT
        // on their team. The rules already permit reading those (canReadOwnedTask's managerId
        // clause), so this requests exactly them — no widening to the worker's other data. No
        // archivedAt range / orderBy, so it stays on the automatic single-field index (no composite);
        // the date window is applied client-side in recompute. Whole-team viewers already read these
        // via their broad query, so this is skipped for them.
        let unsubVadovas = () => { };
        if (scoped && currentUser?.uid) {
            const vadovasQ = query(collection(db, 'archived_tasks'), where('managerId', '==', currentUser.uid));
            unsubVadovas = onSnapshot(vadovasQ, (snapshot) => {
                vadovasRows = snapshot.docs.map(mapDoc);
                recompute();
            }, (error) => {
                console.error("Error subscribing to vadovas archived tasks:", error);
            });
        }

        return () => { unsubscribe(); unsubVadovas(); };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- userData is read via the stable `scoped` flag; depending on the whole object would re-subscribe on each live-session user-doc update
    }, [dateFrom, dateTo, filterUser, userId, filterTag, sortBy, scoped, currentUser, approvalManagerUid]);

    const handleExport = async () => {
        try {
            const exportDataPromises = tasks.map(async (task) => {
                const realTimeMinutes = calculateCurrentTotalMinutes(task);
                
                // Fetch work sessions to get session times
                const sessionsQuery = query(collection(db, 'work_sessions'), where('taskId', '==', task.id));
                const sessionsSnap = await getDocs(sessionsQuery);
                const sessionTimes = sessionsSnap.docs
                    // Manual adjustments are reported separately under `timeAdjustments`;
                    // excluding them here stops the same correction appearing twice in the
                    // export (once as a session, once as an adjustment).
                    .filter(doc => !doc.data().isManualAdjustment)
                    .map(doc => {
                        const data = doc.data();
                        return {
                            date: data.date,
                            durationMinutes: data.durationMinutes ? Math.round(data.durationMinutes) : 0,
                            formattedDuration: data.durationMinutes ? formatMinutesToTimeString(data.durationMinutes) : '0h 0m'
                        };
                    }).filter(s => s.durationMinutes > 0);

                const cleanedAdjustments = (task.timeAdjustments || []).map(adj => ({
                    date: adj.date,
                    durationMinutes: adj.durationMinutes,
                    formattedDuration: adj.durationMinutes ? formatMinutesToTimeString(adj.durationMinutes) : '0h 0m',
                    reason: adj.reason || ''
                }));

                const cleanedComments = (task.comments || []).map(c => `${c.user}: ${c.text}`);

                return {
                    id: task.id,
                    title: task.title,
                    description: task.description || '',
                    priority: getPriorityLabel(task.priority),
                    tag: task.tag || '',
                    status: task.status === 'confirmed' ? 'Patvirtinta' : (task.isDeleted || task.status === 'deleted' ? 'Ištrinta' : 'Atlikta'),
                    assignedWorker: task.assignedUserName || '',
                    manager: task.managerName || '',
                    creator: task.creatorName || '',
                    deadline: task.deadline || '',
                    estimatedTime: task.estimatedTime || '0h 0m',
                    totalWorkedTimeFormatted: realTimeMinutes !== 0 ? formatMinutesToTimeString(realTimeMinutes) : '0h 0m',
                    totalWorkedMinutes: Math.round(realTimeMinutes),
                    sessionTimes: sessionTimes,
                    timeAdjustments: cleanedAdjustments,
                    comments: cleanedComments,
                    createdAt: task.createdAt ? new Date(task.createdAt).toLocaleString('lt-LT') : null,
                    assignedAt: task.assignedAt ? new Date(task.assignedAt).toLocaleString('lt-LT') : null,
                    startedAt: task.startedAt ? new Date(task.startedAt).toLocaleString('lt-LT') : null,
                    completedAt: task.completedAt ? new Date(task.completedAt).toLocaleString('lt-LT') : null,
                    approvedAt: task.approvedAt ? new Date(task.approvedAt).toLocaleString('lt-LT') : (task.confirmedAt ? new Date(task.confirmedAt).toLocaleString('lt-LT') : null)
                };
            });

            const exportData = await Promise.all(exportDataPromises);

            const dataStr = JSON.stringify(exportData, null, 2);
            const blob = new Blob([dataStr], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `ai_task_analysis_${dateFrom}_to_${dateTo}.json`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        } catch (err) {
            console.error("Error generating AI export:", err);
            setError("Nepavyko paruošti AI analizės duomenų. Bandykite dar kartą.");
        }
    };

    const handleExportCSV = () => {
        const escapeCSV = (str) => {
            if (str === null || str === undefined) return '""';
            const s = String(str);
            if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
                return `"${s.replace(/"/g, '""')}"`;
            }
            return s;
        };

        const headers = [
            "Pavadinimas",
            "Aprašymas",
            "Vykdytojas",
            "Vadovas",
            "Sukūrė",
            "Būsena",
            "Prioritetas",
            "Žyma",
            "Terminas",
            "Planuotas laikas",
            "Faktinis laikas",
            "Komentarai",
            "Sukūrimo data",
            "Priskyrimo data",
            "Pradžios data",
            "Užbaigimo data",
            "Patvirtinimo data",
            "Archyvavimo data"
        ];

        const rows = tasks.map(task => {
            const realTimeMinutes = calculateCurrentTotalMinutes(task);
            const realTimeFormatted = realTimeMinutes !== 0 ? formatMinutesToHHMM(realTimeMinutes) : '00:00';
            const commentsText = task.comments ? task.comments.map(c => `${c.user}: ${c.text}`).join('; ') : '';

            return [
                escapeCSV(task.title),
                escapeCSV(task.description),
                escapeCSV(task.assignedUserName),
                escapeCSV(task.managerName),
                escapeCSV(task.creatorName),
                escapeCSV(task.status),
                escapeCSV(getPriorityLabel(task.priority)),
                escapeCSV(task.tag),
                escapeCSV(task.deadline),
                escapeCSV(task.estimatedTime),
                escapeCSV(realTimeFormatted),
                escapeCSV(commentsText),
                escapeCSV(task.createdAt ? new Date(task.createdAt).toLocaleString('lt-LT') : ''),
                escapeCSV(task.assignedAt ? new Date(task.assignedAt).toLocaleString('lt-LT') : ''),
                escapeCSV(task.startedAt ? new Date(task.startedAt).toLocaleString('lt-LT') : ''),
                escapeCSV(task.completedAt ? new Date(task.completedAt).toLocaleString('lt-LT') : ''),
                escapeCSV(task.approvedAt ? new Date(task.approvedAt).toLocaleString('lt-LT') : (task.confirmedAt ? new Date(task.confirmedAt).toLocaleString('lt-LT') : '')),
                escapeCSV(task.archivedAt ? new Date(task.archivedAt).toLocaleString('lt-LT') : '')
            ].join(',');
        });

        const csvContent = [headers.join(','), ...rows].join('\n');
        // Add BOM for Excel UTF-8 recognition
        const blob = new Blob(['\uFEFF' + csvContent], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `task_history_${dateFrom}_to_${dateTo}.csv`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };



    const handleRestore = (task) => {
        setError('');
        setRestoreTarget(task);
    };

    const confirmRestore = async () => {
        const task = restoreTarget;
        if (!task) return;
        setRestoring(true);
        try {
            const restoredTask = {
                ...task,
                status: 'in-progress',
                timerStatus: 'paused',
                completed: false,
                completedAt: null,
                confirmedAt: null,
                confirmedBy: null,
                archivedAt: null,
                archivedBy: null,
                isDeleted: false,
                deletedAt: null,
                deletedBy: null,
                updatedAt: new Date().toISOString()
            };

            await setDoc(doc(db, 'tasks', task.id), restoredTask);
            await deleteDoc(doc(db, 'archived_tasks', task.id));
            setRestoreTarget(null);
        } catch (err) {
            console.error("Error restoring task:", err);
            setError("Nepavyko grąžinti užduoties. Bandykite dar kartą.");
            setRestoreTarget(null);
        } finally {
            setRestoring(false);
        }
    };

    const handleDelete = (task) => {
        setDeleteModalTask(task);
    };

    const confirmDelete = async ({ keepWorkHours }) => {
        if (!deleteModalTask) return;
        try {
            await deleteTask(deleteModalTask, currentUser.uid, { keepWorkHours });
            setDeleteModalTask(null);
        } catch (err) {
            console.error("Error deleting task:", err);
            setError("Nepavyko ištrinti užduoties. Bandykite dar kartą.");
        }
    };

    const handleConfirm = async (task) => {
        try {
            await updateDoc(doc(db, 'archived_tasks', task.id), {
                status: 'confirmed',
                timerStatus: 'stopped',
                confirmedAt: new Date().toISOString()
            });
        } catch (error) {
            console.error("Error confirming task:", error);
        }
    };

    const handleAddArchivedComment = async (text) => {
        if (!commentsModalTask) return;
        try {
            await addComment(commentsModalTask.id, text, currentUser, commentsModalTask.comments, 'archived_tasks');
            const newCommentObj = {
                text: text,
                user: currentUser.displayName || currentUser.email,
                userId: currentUser.uid,
                createdAt: new Date().toISOString()
            };

            // Update tasks array to reflect in the list immediately if expanded
            setTasks(prev => prev.map(t =>
                t.id === commentsModalTask.id
                    ? { ...t, comments: [...(t.comments || []), newCommentObj] }
                    : t
            ));

            // Update modal task so it has the new comment reference immediately
            setCommentsModalTask(prev => ({
                ...prev,
                comments: [...(prev.comments || []), newCommentObj]
            }));

        } catch (err) {
            console.error("Error adding comment to archived task:", err);
            setError("Nepavyko pridėti komentaro. Bandykite dar kartą.");
        }
    };

    const resetFilters = () => {
        const now = getLithuanianNow();
        const startOfCurrentWeek = startOfWeek(now, { weekStartsOn: 1 });
        const start = subWeeks(startOfCurrentWeek, 1);
        setDateFrom(getLithuanianDateString(start));
        setDateTo(getLithuanianDateString(now));
        setFilterUser('all');
        setFilterTag('all');
    };

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

            const collectionName = task.archivedAt ? 'archived_tasks' : 'tasks';
            await updateDoc(doc(db, collectionName, task.id), {
                timeAdjustments: [...(task.timeAdjustments || []), newAdj],
                updatedAt: new Date().toISOString()
            });

            setTasks(prev => prev.map(t =>
                t.id === task.id ? { ...t, timeAdjustments: [...(t.timeAdjustments || []), newAdj] } : t
            ));
        } catch (err) {
            console.error('Error adding adjustment:', err);
            setError('Nepavyko pridėti laiko korekcijos. Bandykite dar kartą.');
        }
    };

    const handleDeleteAdjustment = (taskId, adj) => {
        setError('');
        setAdjustmentDeleteTarget({ taskId, adj });
    };

    const confirmDeleteAdjustment = async () => {
        if (!adjustmentDeleteTarget) return;
        const { taskId, adj } = adjustmentDeleteTarget;
        try {
            const task = tasks.find(t => t.id === taskId);
            if (!task) {
                setAdjustmentDeleteTarget(null);
                return;
            }

            await deleteDoc(doc(db, 'work_sessions', adj.id));

            const newAdjustments = (task.timeAdjustments || []).filter(a => a.id !== adj.id);
            const collectionName = task.archivedAt ? 'archived_tasks' : 'tasks';
            await updateDoc(doc(db, collectionName, task.id), {
                timeAdjustments: newAdjustments,
                updatedAt: new Date().toISOString()
            });

            setTasks(prev => prev.map(t =>
                t.id === task.id ? { ...t, timeAdjustments: newAdjustments } : t
            ));
            setAdjustmentDeleteTarget(null);
        } catch (err) {
            console.error('Error deleting adjustment:', err);
            setError('Nepavyko ištrinti korekcijos. Bandykite dar kartą.');
            setAdjustmentDeleteTarget(null);
        }
    };

    // Comments IconButton with an always-visible count badge. The count is bumped to the 12px
    // floor (§5); the badge stays inside the 44px IconButton target.
    const CommentsButton = ({ task }) => (
        <span className="relative inline-flex">
            <IconButton
                icon={MessageCircle}
                label="Komentarai"
                onClick={() => setCommentsModalTask(task)}
            />
            {task.comments?.length > 0 && (
                <span className="absolute top-0 right-0 min-w-[18px] h-[18px] px-1 bg-brand text-white text-caption font-bold flex items-center justify-center rounded-full leading-none">
                    {task.comments.length}
                </span>
            )}
        </span>
    );

    // Shared action cluster — always-visible 44px targets (no hover dependency, so it works on
    // touch). Same controls + role gating in both the desktop table and the mobile card (§7/§9).
    const TaskActions = ({ task }) => (
        <div className="flex items-center gap-1">
            {task.status !== 'confirmed' && isManagerOrAdmin && (
                <IconButton
                    icon={UserCheck}
                    label="Patvirtinti"
                    onClick={() => handleConfirm(task)}
                    className="text-feedback-success hover:bg-feedback-success/10"
                />
            )}
            <CommentsButton task={task} />
            <IconButton
                icon={RotateCcw}
                label="Grąžinti"
                onClick={() => handleRestore(task)}
            />
            {isManagerOrAdmin && (
                <IconButton
                    icon={Trash2}
                    label="Ištrinti"
                    variant="danger"
                    onClick={() => handleDelete(task)}
                />
            )}
        </div>
    );

    // Admin-only inline time-adjustment trigger — 44px IconButton with an accessible name,
    // replacing the bare <svg> button (§7). Shown in both the table and the mobile card.
    const TimeEditButton = ({ task }) =>
        userRole === 'admin' ? (
            <IconButton
                icon={Pencil}
                label="Koreguoti laiką"
                onClick={() => setActiveModal({ type: 'timeAdjustments', taskId: task.id })}
            />
        ) : null;

    if (loading && tasks.length === 0) {
        return <div className="p-8 text-center text-ink-muted">Kraunama istorija...</div>;
    }

    return (
        <div className="space-y-4">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                {/* Accordion toggle: the chevron + title is the clickable header. The scope note
                    now lives behind an info popover beside the title (sibling, not nested — an
                    interactive trigger can't sit inside another button). */}
                <div className="flex items-center gap-1">
                    <button
                        type="button"
                        onClick={() => setHistoryOpen((o) => !o)}
                        aria-expanded={historyOpen}
                        className="flex items-center gap-2 text-left rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                    >
                        {historyOpen
                            ? <ChevronUp className="w-5 h-5 text-ink-muted shrink-0" aria-hidden="true" />
                            : <ChevronDown className="w-5 h-5 text-ink-muted shrink-0" aria-hidden="true" />}
                        <h2 className="text-h3 font-semibold text-ink-strong flex items-center gap-2">
                            Užduočių istorija <span className="text-ink-muted text-body font-normal">({tasks.length})</span>
                        </h2>
                    </button>
                    {/* Scope clarity (audit #3): this panel is the ARCHIVE only. Just-finished tasks
                        stay in the daily report above until the nightly automation archives them, so
                        an absence here is expected, not a bug — say so instead of duplicating them. */}
                    <InfoPopover label="Apie užduočių istoriją">
                        Rodomos tik suarchyvuotos užduotys (archyvuojama automatiškai naktį). Ką tik
                        užbaigtos užduotys matomos dienos ataskaitoje viršuje, kol nebus suarchyvuotos.
                    </InfoPopover>
                </div>
                {/* Export is manager-only (team report). Workers — and managers viewing their
                    own personal report — never get a self-export button (canExport=false). */}
                {canExport && historyOpen && (
                    <div className="flex items-center gap-2">
                        <button
                            onClick={handleExportCSV}
                            className="inline-flex items-center justify-center gap-2 min-h-touch px-4 py-2 bg-green-600 text-white rounded-control hover:bg-green-700 transition-colors text-body font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                        >
                            <FileText className="w-4 h-4" aria-hidden="true" />
                            Atsisiųsti (CSV)
                        </button>
                        <button
                            onClick={handleExport}
                            className="inline-flex items-center justify-center gap-2 min-h-touch px-4 py-2 bg-green-600 text-white rounded-control hover:bg-green-700 transition-colors text-body font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                        >
                            <Download className="w-4 h-4" aria-hidden="true" />
                            Atsisiųsti AI analizei (JSON)
                        </button>
                    </div>
                )}
            </div>

            {historyOpen && (
            <>
            {/* Friendly error banner — replaces the banned alert() with mapped LT copy (§10) */}
            {error && (
                <div className="flex items-start gap-3 rounded-control border-l-4 border-feedback-danger bg-feedback-danger/10 p-4" role="alert">
                    <AlertCircle className="h-5 w-5 shrink-0 text-feedback-danger" aria-hidden="true" />
                    <p className="text-body text-feedback-danger">{error}</p>
                    <button
                        onClick={() => setError('')}
                        className="ml-auto text-body font-medium text-feedback-danger underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand rounded"
                    >
                        Uždaryti
                    </button>
                </div>
            )}

            {/* Filters — a nested accordion inside the history panel. Collapsed by default so
                the panel stays compact; the chevron reveals the date/user/tag/sort controls. */}
            <div className="bg-surface-sunken rounded-card border border-line">
              <button
                type="button"
                onClick={() => setFiltersOpen((o) => !o)}
                aria-expanded={filtersOpen}
                className="w-full min-h-touch flex items-center justify-between gap-3 px-4 py-3 text-left rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              >
                <span className="flex items-center gap-2 text-caption uppercase font-bold tracking-wide text-ink-muted">
                    <Filter className="w-4 h-4" aria-hidden="true" />
                    Filtravimas
                </span>
                {filtersOpen
                    ? <ChevronUp className="w-4 h-4 text-ink-muted shrink-0" aria-hidden="true" />
                    : <ChevronDown className="w-4 h-4 text-ink-muted shrink-0" aria-hidden="true" />}
              </button>

              {filtersOpen && (
              <div className="border-t border-line p-3 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">

                {/* Date range — a single field; tapping it opens the from/to pickers in a popover,
                    so the two date inputs no longer eat a whole row each. */}
                <div className="relative flex flex-col gap-1 min-w-[200px]" ref={dateRangeRef}>
                    <label className={FILTER_LABEL_CLASS}>Laikotarpis</label>
                    <button
                        type="button"
                        onClick={() => setDateRangeOpen((o) => !o)}
                        aria-expanded={dateRangeOpen}
                        aria-label="Pasirinkti laikotarpį"
                        className={clsx(SELECT_CLASS, 'flex items-center gap-2 text-left')}
                    >
                        <Calendar className="w-3.5 h-3.5 text-ink-muted shrink-0" aria-hidden="true" />
                        <span className="truncate">{dateFrom} – {dateTo}</span>
                        <ChevronDown className="w-3.5 h-3.5 text-ink-muted shrink-0 ml-auto" aria-hidden="true" />
                    </button>
                    {dateRangeOpen && (
                        <div
                            role="dialog"
                            aria-label="Laikotarpis"
                            className="absolute top-full left-0 z-toast mt-1 w-72 max-w-[80vw] rounded-card border border-line bg-surface-card p-3 shadow-lg space-y-3"
                        >
                            <div className="flex flex-col gap-1">
                                <label htmlFor="hist-date-from" className={FILTER_LABEL_CLASS}>Nuo</label>
                                <input
                                    id="hist-date-from"
                                    type="date"
                                    value={dateFrom}
                                    max={dateTo}
                                    onChange={(e) => setDateFrom(e.target.value)}
                                    className={SELECT_CLASS}
                                />
                            </div>
                            <div className="flex flex-col gap-1">
                                <label htmlFor="hist-date-to" className={FILTER_LABEL_CLASS}>Iki</label>
                                <input
                                    id="hist-date-to"
                                    type="date"
                                    value={dateTo}
                                    min={dateFrom}
                                    max={getLithuanianDateString()}
                                    onChange={(e) => setDateTo(e.target.value)}
                                    className={SELECT_CLASS}
                                />
                            </div>
                        </div>
                    )}
                </div>

                {/* User Filter (Manager Only) */}
                {(isManagerOrAdmin && userId === 'all') && (
                    <div className="flex flex-col gap-1 min-w-[150px]">
                        <label className={FILTER_LABEL_CLASS}>Vykdytojas</label>
                        <select
                            value={filterUser}
                            onChange={(e) => setFilterUser(e.target.value)}
                            aria-label="Vykdytojas"
                            className={SELECT_CLASS}
                        >
                            <option value="all">Visi</option>
                            {users.map(u => (
                                <option key={u.id} value={u.id}>
                                    {formatDisplayName(u.displayName || u.email)}
                                </option>
                            ))}
                        </select>
                    </div>
                )}

                {/* Tag Filter */}
                <div className="flex flex-col gap-1 min-w-[120px]">
                    <label className={FILTER_LABEL_CLASS}>Žyma</label>
                    <select
                        value={filterTag}
                        onChange={(e) => setFilterTag(e.target.value)}
                        aria-label="Žyma"
                        className={SELECT_CLASS}
                    >
                        <option value="all">Visos</option>
                        {TASK_TAGS.map(tag => (
                            <option key={tag} value={tag}>{tag}</option>
                        ))}
                    </select>
                </div>

                {/* Sort — a segmented switch (Pagal datą / Pagal būseną) rather than a dropdown,
                    so both choices are visible at once and it reads at a glance. */}
                <div className="flex flex-col gap-1">
                    <label className={FILTER_LABEL_CLASS}>Rūšiuoti</label>
                    <div
                        className="flex w-fit items-center bg-surface-card rounded-input overflow-hidden border border-line"
                        role="group"
                        aria-label="Rūšiuoti"
                    >
                        <button
                            type="button"
                            onClick={() => setSortBy('date')}
                            aria-pressed={sortBy === 'date'}
                            className={clsx(
                                "px-3 py-1.5 text-body font-semibold transition-colors",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset",
                                sortBy === 'date' ? "bg-brand text-white" : "text-ink hover:bg-surface-sunken"
                            )}
                        >
                            Pagal datą
                        </button>
                        <div className="w-px self-stretch bg-line" aria-hidden="true" />
                        <button
                            type="button"
                            onClick={() => setSortBy('status')}
                            aria-pressed={sortBy === 'status'}
                            className={clsx(
                                "px-3 py-1.5 text-body font-semibold transition-colors",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset",
                                sortBy === 'status' ? "bg-brand text-white" : "text-ink hover:bg-surface-sunken"
                            )}
                        >
                            Pagal būseną
                        </button>
                    </div>
                </div>

                {/* Reset Button */}
                <div className="sm:ml-auto">
                    <IconButton
                        icon={RotateCcw}
                        label="Išvalyti filtrus"
                        onClick={resetFilters}
                    />
                </div>
              </div>
              )}
            </div>

            {/* Mobile / touch: one card per task — never a horizontally-scrolling table (§9).
                Hover-only table actions are surfaced here as always-visible 44px buttons. */}
            <ul className="space-y-3 md:hidden">
                {tasks.map((task) => {
                    const deleted = task.isDeleted || task.status === 'deleted';
                    const actualMinutes = calculateCurrentTotalMinutes(task);
                    const actualLabel = actualMinutes !== 0 ? formatMinutesToTimeString(actualMinutes) : '-';
                    return (
                        <li
                            key={task.id}
                            className="bg-surface-card rounded-card shadow-sm border border-line p-4 space-y-3"
                        >
                            {/* Title row + priority */}
                            <div className="flex items-start justify-between gap-2">
                                <button
                                    type="button"
                                    onClick={() => toggleExpand(task.id)}
                                    aria-expanded={expandedTasks.has(task.id)}
                                    className="min-w-0 flex-1 text-left rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                                >
                                    <span className={clsx(
                                        "text-body-lg font-bold break-words",
                                        deleted ? "line-through text-ink-muted" : task.completed ? "text-ink" : "text-ink-strong"
                                    )}>
                                        {!deleted && <CompletedMarker task={task} className="mr-1.5" />}
                                        {task.title}
                                    </span>
                                    {task.tag && (
                                        <span className="ml-2 inline-block px-2 py-0.5 text-caption font-medium bg-brand-soft text-brand-hover rounded align-middle">
                                            {task.tag}
                                        </span>
                                    )}
                                </button>
                                <PriorityBadge priority={task.priority} />
                            </div>

                            {/* Meta chips: worker + deadline + archive date */}
                            <div className="flex flex-wrap items-center gap-2">
                                {task.assignedUserName && (
                                    <AssigneeChip userId={task.assignedUserId} name={task.assignedUserName} firstNameOnly showIcon={false} />
                                )}
                                {task.deadline && (
                                    <span className="inline-flex items-center gap-1 text-caption text-ink-muted">
                                        <Calendar className="w-3.5 h-3.5" aria-hidden="true" />
                                        {task.deadline}
                                    </span>
                                )}
                                <span className="text-caption text-ink-muted">
                                    Archyvuota: {new Date(task.archivedAt).toLocaleDateString()}
                                </span>
                            </div>

                            {/* Est. / Actual time — the core metric, read at a glance */}
                            <div className="flex items-center gap-2">
                                <span className="text-caption text-ink-muted">Plan. / Tikras:</span>
                                <span className="text-body-lg font-mono font-semibold text-ink-strong">
                                    <span className="text-brand">{task.estimatedTime || '-'}</span>
                                    <span className="text-ink-muted mx-1">/</span>
                                    <span>{actualLabel}</span>
                                </span>
                                <TimeEditButton task={task} />
                            </div>
                            <TimeChangedWarning task={task} />

                            {/* Description */}
                            {task.description && (
                                <div className={clsx(
                                    "text-caption text-ink-muted flex items-start gap-1 break-words",
                                    expandedTasks.has(task.id) ? "whitespace-pre-wrap" : ""
                                )}>
                                    <SessionTypeIcon
                                        type={task.isSystemTask ? 'call' : (task.isQuickWork ? 'quickWork' : 'task')}
                                        className="w-3.5 h-3.5 flex-shrink-0 mt-0.5"
                                    />
                                    {task.description}
                                </div>
                            )}

                            {/* Manager */}
                            {(task.managerName || task.creatorName) && (
                                <div className="text-caption text-ink-muted flex items-center gap-1">
                                    <UserCheck className="w-3.5 h-3.5" aria-hidden="true" />
                                    <span>Vadovas: <UserChip userId={task.managerId || task.creatorId} name={task.managerName || task.creatorName} /></span>
                                </div>
                            )}

                            {/* Expanded comments */}
                            {expandedTasks.has(task.id) && task.comments && task.comments.length > 0 && (
                                <div className="pl-4 border-l-2 border-line">
                                    <div className="text-caption font-semibold text-ink-muted mb-1">Komentarai:</div>
                                    {task.comments.map((comment, idx) => (
                                        <div key={idx} className="text-caption text-ink mb-1">
                                            <UserChip userId={comment.userId} name={comment.user} className="font-medium" />: {comment.text}
                                        </div>
                                    ))}
                                </div>
                            )}

                            {/* Footer: status + always-visible action buttons */}
                            <div className="flex items-center justify-between gap-2 pt-2 border-t border-line">
                                {deleted ? <DeletedBadge /> : <TaskStatusPill task={task} />}
                                <TaskActions task={task} />
                            </div>
                        </li>
                    );
                })}
                {tasks.length === 0 && (
                    <li className="bg-surface-card rounded-card border border-line px-6 py-12 text-center text-body text-ink-muted">
                        Istorija tuščia pagal pasirinktus filtrus.
                    </li>
                )}
            </ul>

            {/* Desktop / wide: the denser table is allowed (§9) */}
            <div className="hidden md:block bg-surface-card rounded-card shadow-sm border border-line overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-line table-fixed">
                        <thead className="bg-surface-sunken">
                            <tr>
                                <th className="px-2 py-2 text-left text-caption font-bold text-ink-muted uppercase tracking-wider min-w-[200px] w-auto">UŽDUOTIS</th>
                                <th className="px-1 py-2 text-left text-caption font-bold text-ink-muted uppercase tracking-wider w-16">DARB.</th>
                                <th className="px-1 py-2 text-right text-caption font-bold text-ink-muted uppercase tracking-wider w-24">PLAN. / TIKRAS</th>
                                <th className="px-1 py-2 text-left text-caption font-bold text-ink-muted uppercase tracking-wider w-16">PRIO</th>
                                <th className="px-1 py-2 text-left text-caption font-bold text-ink-muted uppercase tracking-wider w-20">BŪSENA</th>
                                <th className="px-1 py-2 text-right text-caption font-bold text-ink-muted uppercase tracking-wider w-44"></th>
                            </tr>
                        </thead>
                        <tbody className="bg-surface-card divide-y divide-line">
                            {tasks.map((task) => (
                                <tr key={task.id} className="hover:bg-surface-sunken transition-colors border-b border-line last:border-0">
                                    <td className="px-2 py-2" onClick={() => toggleExpand(task.id)}>
                                        <div
                                            role="button"
                                            tabIndex={0}
                                            aria-expanded={expandedTasks.has(task.id)}
                                            onClick={(e) => { e.stopPropagation(); toggleExpand(task.id); }}
                                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpand(task.id); } }}
                                            className={clsx(
                                            "text-body font-bold whitespace-normal break-words cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
                                            (task.isDeleted || task.status === 'deleted') ? "line-through text-ink-muted" : task.completed ? "text-ink" : "text-ink-strong"
                                        )}>
                                            {!(task.isDeleted || task.status === 'deleted') && <CompletedMarker task={task} className="mr-1.5" />}
                                            {task.title}
                                            {task.tag && (
                                                <span className="ml-2 inline-block px-1.5 py-0.5 text-caption font-medium bg-brand-soft text-brand-hover rounded align-middle">
                                                    {task.tag}
                                                </span>
                                            )}
                                        </div>
                                        {task.deadline && (
                                            <div className="text-caption text-ink-muted flex items-center gap-1 mt-0.5 whitespace-nowrap">
                                                <Calendar className="w-3.5 h-3.5" aria-hidden="true" />
                                                <span>{task.deadline}</span>
                                                <span className="text-line">|</span>
                                                <span>Archyvuota: {new Date(task.archivedAt).toLocaleDateString()}</span>
                                            </div>
                                        )}
                                        {!task.deadline && (
                                            <div className="text-caption text-ink-muted flex items-center gap-1 mt-0.5 whitespace-nowrap">
                                                <span>Archyvuota: {new Date(task.archivedAt).toLocaleDateString()}</span>
                                            </div>
                                        )}
                                        {task.description && (
                                            <div className={clsx(
                                                "text-caption text-ink-muted mt-0.5 flex items-start gap-1 cursor-pointer hover:text-ink whitespace-normal break-words",
                                                expandedTasks.has(task.id) ? "whitespace-pre-wrap" : ""
                                            )}>
                                                <SessionTypeIcon
                                                    type={task.isSystemTask ? 'call' : (task.isQuickWork ? 'quickWork' : 'task')}
                                                    className="w-3.5 h-3.5 flex-shrink-0 mt-0.5"
                                                />
                                                {task.description}
                                            </div>
                                        )}
                                        {expandedTasks.has(task.id) && task.comments && task.comments.length > 0 && (
                                            <div className="mt-2 pl-4 border-l-2 border-line">
                                                <div className="text-caption font-semibold text-ink-muted mb-1">Komentarai:</div>
                                                {task.comments.map((comment, idx) => (
                                                    <div key={idx} className="text-caption text-ink mb-1">
                                                        <UserChip userId={comment.userId} name={comment.user} className="font-medium" />: {comment.text}
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                        {(task.managerName || task.creatorName) && (
                                            <div className="text-caption text-ink-muted mt-1 flex items-center gap-1">
                                                <UserCheck className="w-3.5 h-3.5" aria-hidden="true" />
                                                <span>Vadovas: <UserChip userId={task.managerId || task.creatorId} name={task.managerName || task.creatorName} /></span>
                                            </div>
                                        )}
                                    </td>
                                    <td className="px-1 py-2 whitespace-nowrap align-top">
                                        {task.assignedUserName && (
                                            <AssigneeChip userId={task.assignedUserId} name={task.assignedUserName} firstNameOnly showIcon={false} />
                                        )}
                                    </td>
                                    <td className="px-1 py-2 whitespace-nowrap text-right text-body font-medium text-ink-strong align-top font-mono">
                                        <div className="inline-flex items-center justify-end gap-1">
                                            <span>
                                                <span className="text-brand">{task.estimatedTime || '-'}</span>
                                                <span className="text-ink-muted mx-1">/</span>
                                                <span className="text-ink-strong">{calculateCurrentTotalMinutes(task) !== 0 ? formatMinutesToTimeString(calculateCurrentTotalMinutes(task)) : '-'}</span>
                                            </span>
                                            <TimeEditButton task={task} />
                                        </div>
                                        <TimeChangedWarning task={task} alignEnd className="mt-0.5" />
                                    </td>
                                    <td className="px-1 py-2 whitespace-nowrap align-top">
                                        <PriorityBadge priority={task.priority} />
                                    </td>
                                    <td className="px-1 py-2 whitespace-nowrap align-top">
                                        {(task.isDeleted || task.status === 'deleted') ? <DeletedBadge /> : <TaskStatusPill task={task} />}
                                    </td>
                                    <td className="px-1 py-2 whitespace-nowrap text-right align-top">
                                        <div className="flex items-center justify-end">
                                            <TaskActions task={task} />
                                        </div>
                                    </td>
                                </tr>
                            ))}
                            {tasks.length === 0 && (
                                <tr>
                                    <td colSpan="6" className="px-6 py-12 text-center text-ink-muted text-body">
                                        <span>Istorija tuščia pagal pasirinktus filtrus.</span>
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
            </>
            )}
            <DeleteConfirmationModal
                isOpen={!!deleteModalTask}
                onClose={() => setDeleteModalTask(null)}
                onConfirm={confirmDelete}
                taskTitle={deleteModalTask?.title}
            />
            <CommentsModal
                isOpen={!!commentsModalTask}
                onClose={() => setCommentsModalTask(null)}
                comments={commentsModalTask?.comments || []}
                onAddComment={handleAddArchivedComment}
            />
            {activeModal.taskId && (() => {
                const task = tasks.find(t => t.id === activeModal.taskId);
                if (!task) return null;
                return (
                    <TimeAdjustmentsModal
                        isOpen={activeModal.type === 'timeAdjustments'}
                        onClose={() => setActiveModal({ type: null, taskId: null })}
                        task={task}
                        onAddAdjustment={handleAddAdjustment}
                        onDeleteAdjustment={handleDeleteAdjustment}
                    />
                );
            })()}

            {/* Restore confirmation — replaces window.confirm (§8) */}
            {restoreTarget && (
                <ConfirmDialog
                    open
                    title="Grąžinti užduotį?"
                    message={`Užduotis „${restoreTarget.title}" bus grąžinta į aktyvius sąrašus.`}
                    confirmLabel="Grąžinti"
                    cancelLabel="Atšaukti"
                    variant="primary"
                    loading={restoring}
                    onConfirm={confirmRestore}
                    onCancel={() => setRestoreTarget(null)}
                />
            )}

            {/* Time-adjustment delete confirmation — replaces window.confirm (§8) */}
            {adjustmentDeleteTarget && (
                <ConfirmDialog
                    open
                    title="Ištrinti korekciją?"
                    message="Ši laiko korekcija bus negrąžinamai ištrinta."
                    warning="Veiksmo atšaukti nebus galima."
                    confirmLabel="Ištrinti"
                    cancelLabel="Atšaukti"
                    variant="danger"
                    onConfirm={confirmDeleteAdjustment}
                    onCancel={() => setAdjustmentDeleteTarget(null)}
                />
            )}
        </div>
    );
}
