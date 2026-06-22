import { useState, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { db, storage } from '../firebase';
import { ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage';
import { doc, updateDoc, addDoc, collection, getDoc } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { useUsers } from '../context/UsersContext';
import { X, Plus, Trash2, Clock, Camera, CheckSquare, Square, Check, ChevronDown, AlignLeft, Link2, Calendar, MessageSquare } from 'lucide-react';
import { formatDisplayName, isManagerRole } from '../utils/formatters';
import { scopeRoster } from '../utils/teamScope';
import { saveTaskTemplate, getTaskTemplates, updateTaskTemplate, deleteTaskTemplate } from '../utils/taskActions';
import { notify } from '../utils/notify';
import { getPriorityOptions, getPriorityLabel, getPriorityTextColor, normalizePriority, DEFAULT_PRIORITY } from '../utils/priority';
import { compressImage } from '../utils/imageUtils';
import { buildChecklistItem, reconcileChecklist } from '../utils/checklistActions';
import { calculateCurrentTotalMinutes, formatMinutesToTimeString } from '../utils/timeUtils';
import { TASK_TAGS } from '../utils/taskUtils';
import { preventEnterSubmit } from '../utils/formUtils';
import Button from './ui/Button';
import IconButton from './ui/IconButton';
import Select from './ui/Select';
import ConfirmDialog from './ui/ConfirmDialog';
import TaskStatusPill from './task/TaskStatusPill';
import DeletedBadge from './task/DeletedBadge';
import { useModalA11y } from '../hooks/useModalA11y';

// Persistent field label — fields previously had only placeholders, which vanish on input
// and leave a picked <select> value meaningless (DESIGN_SYSTEM §8, audit per-screen).
const fieldLabel = 'mt-4 mb-1 block text-body font-medium text-ink';

// The handful of estimated-time values that cover the vast majority of tasks. Shown as
// one-tap chips on the spine; the full scale stays one tap away behind "Kita…" so the
// common case is fast and the long tail is still reachable. (Replaces a 30-option dropdown.)
const COMMON_TIMES = ['15min', '30min', '1h', '2h', '4h', '8h'];

// Full estimated-time scale, preserved from the original picker — revealed on demand.
const ALL_TIMES = [
    '5min', '15min', '30min', '45min', '1h', '1,5h', '2h', '2,5h', '3h', '4h', '5h', '6h',
    '8h', '10h', '12h', '15h', '20h', '25h', '30h', '40h', '50h', '60h', '70h', '80h',
    '90h', '100h', '110h', '120h', '150h', '200h'
];

// Human-readable file size — the "before upload" signal a field worker needs to judge
// how much mobile data a batch of phone photos will cost.
const formatBytes = (bytes) => {
    if (!bytes || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const value = bytes / Math.pow(1024, i);
    return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
};

// One collapsible row in the optional "Daugiau" block. Keeps the create card short by
// hiding low-frequency fields behind a labelled, keyboard-reachable disclosure (icon +
// text label + optional count badge — count never relies on color). DESIGN_SYSTEM §8/§11.
function AdvancedSection({ icon: Icon, label, count = 0, open, onToggle, children }) {
    return (
        <div className="rounded-lg border border-line">
            <button
                type="button"
                onClick={onToggle}
                aria-expanded={open}
                className="flex w-full min-h-touch items-center gap-3 rounded-lg px-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
                <Icon className="h-5 w-5 flex-shrink-0 text-ink-muted" aria-hidden="true" />
                <span className="flex-1 text-base text-ink">{label}</span>
                {count > 0 && (
                    <span className="min-w-[1.5rem] rounded-full bg-surface-sunken px-2 text-center text-caption text-ink-muted tabular-nums">{count}</span>
                )}
                <ChevronDown className={`h-5 w-5 flex-shrink-0 text-ink-muted transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
            </button>
            {open && <div className="px-3 pb-3 pt-1">{children}</div>}
        </div>
    );
}

export default function TaskModal({ isOpen, onClose, task, role }) {
    const { currentUser, userRole, userData } = useAuth();
    const { activeUsers } = useUsers();
    const workers = useMemo(() => activeUsers || [], [activeUsers]);
    const [loading, setLoading] = useState(false);

    // Inline accessible error region (replaces banned window.alert popups).
    const [formError, setFormError] = useState('');
    // State-gated confirmations (replace banned window.confirm).
    const [templateToDelete, setTemplateToDelete] = useState(null); // { id, name }
    const [overwriteTemplate, setOverwriteTemplate] = useState(null); // existing template pending overwrite
    // Dialog panel ref for focus management.
    const panelRef = useRef(null);

    const [formData, setFormData] = useState({
        title: '',
        assignedUserId: '',
        managerId: '',
        priority: 'Medium',
        estimatedTime: '',
        description: '',
        links: [],
        status: 'pending',
        comments: [],
        completed: false,
        deadline: '',
        tag: '',
        attachmentUrl: '',
        attachmentUrls: [], // New field for multiple attachments
        checklist: []
    });

    const [newLink, setNewLink] = useState('');
    const [newComment, setNewComment] = useState('');
    const [newChecklistItem, setNewChecklistItem] = useState('');
    const [selectedFiles, setSelectedFiles] = useState([]); // Changed to array
    const [uploadProgress, setUploadProgress] = useState(0);

    // Estimated-time picker: common values are one-tap chips; the full scale is revealed
    // on demand (or auto-revealed when the saved value isn't one of the common ones).
    const [showTimeOther, setShowTimeOther] = useState(false);
    // Which optional ("Daugiau") sections are currently expanded.
    const [expanded, setExpanded] = useState({
        description: false,
        photos: false,
        checklist: false,
        schedule: false,
        extra: false,
        comment: false
    });

    // Template State
    const [templates, setTemplates] = useState([]);
    const [isSavingTemplate, setIsSavingTemplate] = useState(false);
    const [templateName, setTemplateName] = useState('');
    const [selectedTemplateFields, setSelectedTemplateFields] = useState({
        title: true,
        priority: true,
        estimatedTime: true,
        description: true,
        tag: true,
        links: true,
        assignedUserId: false,
        managerId: false,
        deadline: false
    });

    const sortedTemplates = useMemo(() => {
        return [...templates].sort((a, b) => {
            const getWorkerName = (tmpl) => {
                const userId = tmpl.data?.assignedUserId;
                if (!userId) return null;
                const worker = workers.find(w => w.id === userId);
                if (!worker) return null;
                return formatDisplayName(worker.displayName || worker.email);
            };

            const nameA = getWorkerName(a);
            const nameB = getWorkerName(b);

            if (nameA && !nameB) return -1;
            if (!nameA && nameB) return 1;
            if (nameA && nameB) {
                const cmp = nameA.localeCompare(nameB);
                if (cmp !== 0) return cmp;
            }

            // Secondary sort: Template Name
            return (a.templateName || '').localeCompare(b.templateName || '');
        });
    }, [templates, workers]);

    const managers = workers.filter(w => w.role === 'manager' || w.role === 'admin' || w.role === 'seniorManager' || w.id === currentUser.uid);

    // The assignee picker is narrowed to a scoped manager's own team (plus themselves), so they
    // can only assign work to their people — mirrored by the server-side write rule. Admins and
    // unscoped managers keep the full roster. (Managers/templates list above stays full.)
    const assignableWorkers = useMemo(
        () => scopeRoster(workers, userData, currentUser?.uid),
        [workers, userData, currentUser]
    );

    useEffect(() => {
        if (task) {
            // Backward compatibility: If attachmentUrls missing but attachmentUrl exists, wrap it.
            let existingUrls = task.attachmentUrls || [];
            if (existingUrls.length === 0 && task.attachmentUrl) {
                existingUrls = [task.attachmentUrl];
            }

            setFormData({
                title: task.title || '',
                assignedUserId: task.assignedUserId || '',
                managerId: task.managerId || '',
                priority: normalizePriority(task.priority),
                estimatedTime: task.estimatedTime || '',
                description: task.description || '',
                links: task.links || [],
                status: task.status || 'pending',
                comments: task.comments || [],
                completed: task.completed || false,
                deadline: task.deadline || '',
                tag: task.tag || '',
                attachmentUrl: task.attachmentUrl || '', // Keep for legacy
                attachmentUrls: existingUrls,
                checklist: task.checklist || []
            });
        } else {
            // Reset for new task
            // Fetch current user's default manager if they're a worker
            (async () => {
                let defaultManagerId = currentUser.uid;
                if (role === 'worker') {
                    try {
                        const userDoc = await getDoc(doc(db, 'users', currentUser.uid));
                        if (userDoc.exists() && userDoc.data().defaultManager) {
                            defaultManagerId = userDoc.data().defaultManager;
                        }
                    } catch (error) {
                        console.error('Error fetching default manager:', error);
                    }
                }

                setFormData({
                    title: '',
                    assignedUserId: currentUser.uid,
                    managerId: defaultManagerId,
                    priority: DEFAULT_PRIORITY,
                    estimatedTime: '',
                    description: '',
                    links: [],
                    status: 'pending',
                    comments: [],
                    completed: false,
                    deadline: '',
                    tag: '',
                    attachmentUrl: '',
                    attachmentUrls: [],
                    checklist: []
                });
            })();
        }
        setSelectedFiles([]);
    }, [task, role, currentUser]);

    useEffect(() => {
        if (isManagerRole(role)) {
            fetchTemplates();
        }
    }, [role, isOpen]);

    // Focus-in, focus restore, Escape, and a Tab focus-trap — all shared (WCAG 2.4.3).
    useModalA11y(panelRef, { open: isOpen, onClose, dismissible: true });

    // Clear any stale error / pending confirmations from a previous open.
    useEffect(() => {
        if (!isOpen) return;
        setFormError('');
        setTemplateToDelete(null);
        setOverwriteTemplate(null);
    }, [isOpen]);

    // When opening an existing task, auto-expand only the optional sections that actually
    // hold data (so nothing is silently hidden); keep them all collapsed for a new task.
    // Likewise reveal the full time list when the saved value isn't one of the common chips.
    useEffect(() => {
        if (!isOpen) return;
        if (task) {
            const photoCount = (task.attachmentUrls?.length || 0) || (task.attachmentUrl ? 1 : 0);
            setExpanded({
                description: !!task.description,
                photos: photoCount > 0,
                checklist: (task.checklist?.length || 0) > 0,
                schedule: !!task.deadline,
                extra: (task.links?.length || 0) > 0 || !!task.tag,
                comment: (task.comments?.length || 0) > 0
            });
            setShowTimeOther(!!task.estimatedTime && !COMMON_TIMES.includes(task.estimatedTime));
        } else {
            setExpanded({ description: false, photos: false, checklist: false, schedule: false, extra: false, comment: false });
            setShowTimeOther(false);
        }
    }, [task, isOpen]);

    const fetchTemplates = async () => {
        try {

            const temps = await getTaskTemplates();

            setTemplates(temps);
        } catch (error) {
            console.error("Failed to fetch templates:", error);
            // Optional: alert only if it's critical, or just log.
            // alert("Nepavyko užkrauti šablonų: " + error.message);
        }
    };

    const handleLoadTemplate = (templateId) => {
        const template = templates.find(t => t.id === templateId);
        if (!template) return;

        setFormData(prev => ({
            ...prev,
            ...template.data
        }));
    };

    const handleSaveTemplateClick = () => {
        setIsSavingTemplate(true);
        // IMPORTANT: Clear the template name so users can type a new one or select existing
        setTemplateName('');

        // Reset fields to default or current form state
        setSelectedTemplateFields({
            title: !!formData.title,
            priority: true,
            estimatedTime: !!formData.estimatedTime,
            description: !!formData.description,
            tag: !!formData.tag,
            links: formData.links.length > 0,
            assignedUserId: !!formData.assignedUserId,
            managerId: !!formData.managerId,
            deadline: !!formData.deadline
        });
    };

    const handleDeleteTemplate = (templateId, name) => {
        setFormError('');
        setTemplateToDelete({ id: templateId, name });
    };

    const confirmDeleteTemplate = async () => {
        if (!templateToDelete) return;
        try {
            await deleteTaskTemplate(templateToDelete.id);
            setTemplates(prev => prev.filter(t => t.id !== templateToDelete.id));
            setTemplateToDelete(null);
        } catch (error) {
            console.error('Failed to delete template', error);
            setTemplateToDelete(null);
            setFormError('Nepavyko ištrinti šablono. Bandykite dar kartą.');
        }
    };

    const buildTemplateData = () => {
        const dataToSave = {};
        // Copy only selected fields
        Object.keys(selectedTemplateFields).forEach(key => {
            if (selectedTemplateFields[key]) {
                dataToSave[key] = formData[key];
            }
        });
        return dataToSave;
    };

    const handleConfirmSaveTemplate = async () => {
        setFormError('');
        if (!templateName.trim()) {
            setFormError('Prašome įvesti šablono pavadinimą!');
            return;
        }

        // Check for existing template to overwrite — gate behind an explicit confirmation.
        const existingTemplate = templates.find(t => t.templateName.toLowerCase() === templateName.trim().toLowerCase());
        if (existingTemplate) {
            setOverwriteTemplate(existingTemplate);
            return;
        }

        setLoading(true);
        try {
            await saveTaskTemplate(templateName, buildTemplateData(), currentUser);
            await fetchTemplates();
            setIsSavingTemplate(false);
        } catch (error) {
            console.error("Failed to save template", error);
            setFormError('Nepavyko išsaugoti šablono. Bandykite dar kartą.');
        } finally {
            setLoading(false);
        }
    };

    const confirmOverwriteTemplate = async () => {
        if (!overwriteTemplate) return;
        setLoading(true);
        try {
            await updateTaskTemplate(overwriteTemplate.id, templateName, buildTemplateData(), currentUser);
            await fetchTemplates();
            setOverwriteTemplate(null);
            setIsSavingTemplate(false);
        } catch (error) {
            console.error("Failed to save template", error);
            setOverwriteTemplate(null);
            setFormError('Nepavyko išsaugoti šablono. Bandykite dar kartą.');
        } finally {
            setLoading(false);
        }
    };

    // workers is provided by context

    const handleFileSelect = (e) => {
        const files = Array.from(e.target.files);
        const currentCount = (formData.attachmentUrls?.length || 0) + selectedFiles.length + files.length;

        if (currentCount > 8) {
            setFormError(`Maksimalus nuotraukų kiekis: 8. Jūs jau turite ${(formData.attachmentUrls?.length || 0) + selectedFiles.length}, bandote pridėti ${files.length}.`);
            return;
        }

        setFormError('');
        setSelectedFiles(prev => [...prev, ...files]);
    };

    const removeSelectedFile = (index) => {
        setSelectedFiles(prev => prev.filter((_, i) => i !== index));
    };

    const removeExistingAttachment = (index) => {
        setFormData(prev => ({
            ...prev,
            attachmentUrls: prev.attachmentUrls.filter((_, i) => i !== index)
        }));
    };

    const uploadFile = (file, onProgress) => {
        return new Promise((resolve, reject) => {
            const fileId = `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
            // Store under a per-uploader folder so Storage rules can scope direct
            // SDK access (read/list/overwrite/delete) to the owner. Task viewers still
            // see the file via the tokenized download URL saved on the task document.
            const storageRef = ref(storage, `attachments/${currentUser.uid}/${fileId}_${file.name}`);
            const metadata = { contentType: file.type };
            const uploadTask = uploadBytesResumable(storageRef, file, metadata);

            uploadTask.on('state_changed',
                (snapshot) => {
                    // Report transferred bytes so the caller can aggregate a combined
                    // progress bar across all parallel uploads (field workers on slow
                    // mobile networks need to see that something is happening).
                    onProgress?.(snapshot.bytesTransferred);
                },
                (error) => {
                    console.error("Upload failed:", error);
                    switch (error.code) {
                        case 'storage/unauthorized':
                            reject(new Error(`Neturite teisių įkelti failo ${file.name}`));
                            break;
                        case 'storage/canceled':
                            reject(new Error(`Įkėlimas atšauktas failui ${file.name}`));
                            break;
                        default:
                            reject(new Error(`Nepavyko įkelti ${file.name}: ${error.message}`));
                    }
                },
                () => {
                    getDownloadURL(uploadTask.snapshot.ref).then((downloadURL) => {

                        resolve(downloadURL);
                    });
                }
            );
        });
    };

    const handleSubmit = async (e) => {
        e.preventDefault();

        // Estimated time is required but is now chosen via chips (no native <select required>
        // is guaranteed to be in the DOM), so guard it explicitly with a friendly message.
        if (!formData.estimatedTime) {
            setFormError('Pasirinkite planuojamą laiką.');
            setExpanded(prev => ({ ...prev }));
            return;
        }

        setLoading(true);
        setUploadProgress(0);

        try {
            const selectedManager = workers.find(w => w.id === formData.managerId);
            let currentAttachmentUrls = [...(formData.attachmentUrls || [])];

            // 1. Upload all new selected files
            if (selectedFiles.length > 0) {
                // Compress files first
                const compressionPromises = selectedFiles.map(file => compressImage(file));
                const compressedFiles = await Promise.all(compressionPromises);

                // Aggregate a single combined progress percentage across the parallel
                // uploads: track each file's transferred bytes and divide by the grand total.
                const totalBytes = compressedFiles.reduce((sum, f) => sum + (f.size || 0), 0) || 1;
                const transferred = new Array(compressedFiles.length).fill(0);
                const reportProgress = (index, bytes) => {
                    transferred[index] = bytes;
                    const sum = transferred.reduce((a, b) => a + b, 0);
                    setUploadProgress(Math.min(100, Math.round((sum / totalBytes) * 100)));
                };

                // Then upload compressed files
                const uploadPromises = compressedFiles.map((file, index) =>
                    uploadFile(file, (bytes) => reportProgress(index, bytes))
                );
                const newUrls = await Promise.all(uploadPromises);

                currentAttachmentUrls = [...currentAttachmentUrls, ...newUrls];
            }


            // Keep the first URL as 'attachmentUrl' for backward compatibility, if any
            const primaryAttachmentUrl = currentAttachmentUrls.length > 0 ? currentAttachmentUrls[0] : '';

            let activeAuditorId = formData.managerId;
            // Check if user assigned THEMSELVES as the manager (Auditor)
            // If so, and they have a default manager, the Default Manager becomes the Auditor (for approval purposes)
            // BUT we keep the visible managerId as the user themselves (as requested).
            if (activeAuditorId === currentUser.uid && userData?.defaultManager) {
                console.log("User selected themselves as auditor. Routing approval to default manager:", userData.defaultManager);
                activeAuditorId = userData.defaultManager;
            }

            const taskData = {
                ...formData,
                attachmentUrl: primaryAttachmentUrl,
                attachmentUrls: currentAttachmentUrls,
                managerName: selectedManager ? (selectedManager.displayName || selectedManager.email) : '',
                updatedAt: new Date().toISOString()
            };

            // Capture assignment time if the worker changed or is newly set
            if (!task || task.assignedUserId !== formData.assignedUserId) {
                taskData.assignedAt = new Date().toISOString();
            }

            let docRef;
            if (task) {
                docRef = doc(db, 'tasks', task.id);

                // If estimated time is altered by manager, lift any time blocking flags
                if (task.estimatedTime !== formData.estimatedTime) {
                    taskData.timeLimitReached = false;
                    taskData.warningShown80 = false;
                    taskData.warningShown70 = false;
                }

                // The whole-document save would clobber a worker's concurrent live
                // checklist ticks (this form holds a snapshot from when it opened). Write
                // every OTHER field here, then reconcile the checklist atomically (three-way
                // merge: manager's items/text + worker's live done-state + worker's adds).
                const { checklist: authoredChecklist, ...taskDataNoChecklist } = taskData;
                await updateDoc(docRef, taskDataNoChecklist);
                await reconcileChecklist(
                    task.id,
                    (task.checklist || []).map(item => item.id),
                    authoredChecklist || []
                );

                // Tell the worker about manager-side edits that concern them. Both are gated on
                // "assignee is someone other than me" so a self-edit never notifies the author.
                const assignee = formData.assignedUserId;
                const actor = { actorUid: currentUser.uid, actorName: currentUser.displayName || currentUser.email };
                if (assignee && assignee !== currentUser.uid) {
                    // The estimate was lifted on a task whose limit the worker had already hit →
                    // their time-extension request was effectively granted.
                    if (task.timeLimitReached && task.estimatedTime !== formData.estimatedTime) {
                        await notify({ recipientId: assignee, type: 'extension_granted', taskId: task.id, taskTitle: formData.title, estimatedTime: formData.estimatedTime, ...actor });
                    }
                    // The task was (re)assigned to a new worker.
                    if (task.assignedUserId !== assignee) {
                        await notify({ recipientId: assignee, type: 'task_assigned', taskId: task.id, taskTitle: formData.title, ...actor });
                    }
                }
            } else {
                // Determine if user is a manager/admin based on Context OR Prop
                const isManagerOrAdmin = isManagerRole(userRole) || isManagerRole(role);
                // const isSelfAssigned = formData.assignedUserId === currentUser.uid; // Unused
                // const isOtherManagerAssigned = formData.managerId && formData.managerId !== currentUser.uid; // Unused



                // Determine initial status:
                // - If manager/admin creates: pending (no approval needed)
                let initialStatus = 'pending';
                if (!isManagerOrAdmin) {
                    initialStatus = 'unapproved';

                }

                docRef = await addDoc(collection(db, 'tasks'), {
                    ...taskData,
                    status: initialStatus,
                    taskAuditor: activeAuditorId, // Store activeAuditorId as taskAuditor for approval/confirmation visibility
                    createdAt: new Date().toISOString(),
                    createdBy: currentUser.uid,
                    creatorName: currentUser.displayName || currentUser.email
                });

                // Create notification if task needs approval
                // Use activeAuditorId here to ensure the notification goes to the CORRECT person (Default Manager)
                if (initialStatus === 'unapproved' && activeAuditorId) {
                    try {
                        await addDoc(collection(db, 'request_notifications'), {
                            recipientId: activeAuditorId,
                            type: 'task_approval',
                            taskId: docRef.id,
                            taskTitle: taskData.title,
                            estimatedTime: taskData.estimatedTime || null,
                            description: taskData.description || null,
                            isRead: false,
                            createdAt: new Date().toISOString(),
                            createdBy: currentUser.uid,
                            createdByName: currentUser.displayName || currentUser.email
                        });

                    } catch (notifError) {
                        console.error('Error creating notification:', notifError);
                    }
                }

                // A manager created a task FOR a worker → tell that worker it landed in their list.
                // (A worker self-creating, or assigning to themselves, gets no echo.)
                if (isManagerOrAdmin && formData.assignedUserId && formData.assignedUserId !== currentUser.uid) {
                    await notify({
                        recipientId: formData.assignedUserId,
                        type: 'task_assigned',
                        taskId: docRef.id,
                        taskTitle: taskData.title,
                        estimatedTime: taskData.estimatedTime || null,
                        actorUid: currentUser.uid,
                        actorName: currentUser.displayName || currentUser.email,
                    });
                }
            }

            onClose();
        } catch (error) {
            console.error("Error saving task:", error);
            setFormError('Nepavyko išsaugoti užduoties. Bandykite dar kartą.');
        } finally {
            setLoading(false);
        }
    };

    const addLink = () => {
        if (newLink) {
            let linkToAdd = newLink.trim();
            if (!/^https?:\/\//i.test(linkToAdd)) {
                linkToAdd = 'https://' + linkToAdd;
            }
            setFormData(prev => ({ ...prev, links: [...prev.links, linkToAdd] }));
            setNewLink('');
        }
    };

    const removeLink = (index) => {
        setFormData(prev => ({ ...prev, links: prev.links.filter((_, i) => i !== index) }));
    };

    const addComment = () => {
        if (newComment) {
            const comment = {
                text: newComment,
                user: currentUser.displayName,
                userId: currentUser.uid,
                createdAt: new Date().toISOString()
            };
            setFormData(prev => ({ ...prev, comments: [...prev.comments, comment] }));
            setNewComment('');
        }
    };

    // Checklist items are composed locally and persisted with the task on save
    // (same array-on-the-doc pattern as links/comments). Live ticking happens on
    // the card via checklistActions; this section is for authoring the item list.
    const addChecklistItemLocal = () => {
        const text = newChecklistItem.trim();
        if (!text) return;
        setFormData(prev => ({ ...prev, checklist: [...(prev.checklist || []), buildChecklistItem(text)] }));
        setNewChecklistItem('');
    };

    const removeChecklistItemLocal = (id) => {
        setFormData(prev => ({ ...prev, checklist: (prev.checklist || []).filter(item => item.id !== id) }));
    };

    const toggleSection = (key) => setExpanded(prev => ({ ...prev, [key]: !prev[key] }));

    if (!isOpen) return null;

    const isManager = isManagerRole(role) || isManagerRole(userRole);
    // Worker viewing an already-created task can't edit the structured fields; the spine
    // controls and section bodies fall back to a read-only/locked state via this flag.
    const fieldsLocked = !isManager && !!task;

    // Filter to only allow Managers, Admins, and the current user (so they can assign to themselves).
    // This excludes other 'regular' workers.

    return createPortal(
        <div className="fixed inset-0 z-modal flex items-center justify-center bg-feedback-scrim p-4">
            <div
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="task-modal-title"
                tabIndex={-1}
                className="bg-surface-card rounded-modal shadow-xl w-full max-w-2xl max-h-[calc(100dvh-2rem)] flex flex-col relative focus:outline-none overflow-hidden"
            >
                {/* Header - Fixed (vertically compact: tighter padding, X pinned hard right) */}
                <div className="flex justify-between items-center gap-2 px-4 py-2.5 border-b border-line flex-shrink-0">
                    <div className="flex items-center gap-2 min-w-0">
                        <h2 id="task-modal-title" className="text-lg font-bold text-ink-strong truncate min-w-0">
                            {isSavingTemplate ? 'Išsaugoti šabloną' : (task ? 'Redaguoti užduotį' : 'Naujas darbas')}
                        </h2>
                        {/* Read-only status — the form previously showed none; now it carries the same
                            Patvirtinta / Nepatvirtinta / Ištrinta the task shows on every other surface. */}
                        {task && !isSavingTemplate && (
                            (task.isDeleted || task.status === 'deleted')
                                ? <DeletedBadge />
                                : <TaskStatusPill task={task} />
                        )}
                    </div>
                    <div className="flex items-center gap-1 min-w-0">
                        {!isSavingTemplate && !task && isManagerRole(role) && templates.length > 0 && (
                            <Select
                                value=""
                                onChange={handleLoadTemplate}
                                options={sortedTemplates.map((t) => ({ value: t.id, label: t.templateName }))}
                                label="Šablonai"
                                placeholder="Užkrauti šabloną..."
                                ariaLabel="Užkrauti šabloną"
                                alwaysSheet
                                className="min-w-0 max-w-[10rem]"
                            />
                        )}
                        <IconButton icon={X} label="Uždaryti" onClick={onClose} className="-mr-1.5" />
                    </div>
                </div>

                {/* Scrollable Content — min-h-0 lets this flex child shrink below its content
                    height so the inner scroll engages instead of pushing the footer off-screen. */}
                <div className="flex-1 min-h-0 overflow-y-auto p-4">
                    {formError && (
                        <div
                            role="alert"
                            aria-live="assertive"
                            className="mb-4 rounded-control bg-feedback-danger/10 border border-feedback-danger/30 p-3 text-body text-feedback-danger"
                        >
                            {formError}
                        </div>
                    )}
                    {isSavingTemplate ? (
                        <div className="space-y-6">
                            <div>
                                <input
                                    type="text"
                                    value={templateName}
                                    onChange={(e) => setTemplateName(e.target.value)}
                                    placeholder="Šablono pavadinimas"
                                    aria-label="Šablono pavadinimas"
                                    className="w-full px-3 py-3 border border-line rounded-lg focus:ring-2 focus:ring-brand"
                                />
                                {templates.length > 0 && (
                                    <div className="mt-3">
                                        <p className="text-xs text-ink-muted mb-1">Egzistuojantys šablonai (paspauskite norėdami pasirinkti):</p>
                                        <div className="max-h-40 overflow-y-auto border border-line rounded-lg bg-surface-sunken">
                                            {sortedTemplates.map(t => (
                                                <div key={t.id} className="flex justify-between items-center p-2 hover:bg-surface-sunken border-b last:border-b-0 border-line transition-colors">
                                                    <button
                                                        type="button"
                                                        onClick={() => setTemplateName(t.templateName)}
                                                        className="min-h-touch text-sm text-left flex-1 truncate text-ink hover:text-blue-600 font-medium rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                                                    >
                                                        {t.templateName}
                                                    </button>
                                                    <IconButton
                                                        icon={Trash2}
                                                        label="Ištrinti šabloną"
                                                        variant="danger"
                                                        onClick={() => handleDeleteTemplate(t.id, t.templateName)}
                                                    />
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                            <div>
                                <h4 className="font-medium mb-3">Pasirinkite laukus, kuriuos išsaugoti:</h4>
                                <div className="grid grid-cols-2 gap-3">
                                    {Object.keys(selectedTemplateFields).map(key => (
                                        <label key={key} className="flex items-center gap-2 p-2 border border-line rounded hover:bg-surface-sunken cursor-pointer">
                                            <input
                                                type="checkbox"
                                                checked={selectedTemplateFields[key]}
                                                onChange={(e) => setSelectedTemplateFields(prev => ({ ...prev, [key]: e.target.checked }))}
                                                className="w-4 h-4 text-blue-600 rounded"
                                            />
                                            <span className="capitalize">{
                                                key === 'assignedUserId' ? 'Priskirtas vykdytojas' :
                                                    key === 'managerId' ? 'Priskirtas vadovas' :
                                                        key === 'estimatedTime' ? 'Planuojamas laikas' :
                                                            key === 'deadline' ? 'Terminas' :
                                                                key === 'title' ? 'Pavadinimas' :
                                                                    key === 'description' ? 'Aprašymas' :
                                                                        key === 'priority' ? 'Prioritetas' :
                                                                            key === 'tag' ? 'Žyma' :
                                                                                key === 'links' ? 'Nuorodos' : key
                                            }</span>
                                        </label>
                                    ))}
                                </div>
                            </div>
                        </div>
                    ) : (
                        <form id="task-form" onSubmit={handleSubmit} onKeyDown={preventEnterSubmit} className="space-y-5">
                            {/* ─────────────── Spine: the few fields set on every task ─────────────── */}
                            {/* Title — label removed; the word "Pavadinimas" now lives in the
                                placeholder to save vertical space. aria-label keeps it accessible. */}
                            <div>
                                <input
                                    type="text"
                                    value={formData.title}
                                    onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                                    disabled={fieldsLocked}
                                    placeholder="Pavadinimas"
                                    aria-label="Pavadinimas"
                                    className="w-full px-3 py-3 border border-line rounded-lg focus:ring-2 focus:ring-brand focus:border-brand disabled:bg-surface-sunken text-base"
                                    required
                                />
                            </div>

                            {/* Priority — five one-tap swatches; the selected name is shown as text so
                                color is never the sole signal (DESIGN_SYSTEM §6). */}
                            <div>
                                <div className="mb-1 flex items-center justify-between">
                                    <span className="text-body font-medium text-ink">Prioritetas</span>
                                    <span className="text-sm text-ink-muted">{getPriorityLabel(formData.priority)}</span>
                                </div>
                                <div role="group" aria-label="Prioritetas" className="flex gap-1 rounded-lg border border-line p-1">
                                    {[...getPriorityOptions()].reverse().map((p) => {
                                        const active = normalizePriority(formData.priority) === p.id;
                                        return (
                                            <button
                                                key={p.id}
                                                type="button"
                                                onClick={() => !fieldsLocked && setFormData({ ...formData, priority: p.id })}
                                                disabled={fieldsLocked}
                                                aria-label={p.label}
                                                aria-pressed={active}
                                                title={p.label}
                                                className={`flex h-9 flex-1 items-center justify-center rounded-md transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1 disabled:opacity-50 ${active ? 'ring-2 ring-brand' : 'ring-1 ring-line'}`}
                                                style={{ backgroundColor: p.color }}
                                            >
                                                {active && <Check className="h-4 w-4" style={{ color: getPriorityTextColor(p.id) }} aria-hidden="true" />}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>

                            {/* Estimated time — common values are one tap; the full scale is one more. */}
                            <div>
                                <span className="mb-1 block text-body font-medium text-ink">Planuojamas laikas</span>
                                <div className="flex flex-wrap gap-2">
                                    {COMMON_TIMES.map((t) => {
                                        const active = formData.estimatedTime === t;
                                        return (
                                            <button
                                                key={t}
                                                type="button"
                                                onClick={() => { setFormData({ ...formData, estimatedTime: t }); setShowTimeOther(false); }}
                                                disabled={fieldsLocked}
                                                aria-pressed={active}
                                                className={`min-h-touch rounded-full border px-4 text-base transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50 ${active ? 'border-brand bg-brand/10 font-medium text-brand' : 'border-line text-ink hover:bg-surface-sunken'}`}
                                            >
                                                {t}
                                            </button>
                                        );
                                    })}
                                    {(() => {
                                        const otherActive = showTimeOther || (!!formData.estimatedTime && !COMMON_TIMES.includes(formData.estimatedTime));
                                        const showsValue = otherActive && !!formData.estimatedTime && !COMMON_TIMES.includes(formData.estimatedTime);
                                        return (
                                            <button
                                                type="button"
                                                onClick={() => setShowTimeOther((v) => !v)}
                                                disabled={fieldsLocked}
                                                aria-expanded={otherActive}
                                                className={`min-h-touch rounded-full border px-4 text-base transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50 ${otherActive ? 'border-brand bg-brand/10 font-medium text-brand' : 'border-line text-ink-muted hover:bg-surface-sunken'}`}
                                            >
                                                {showsValue ? formData.estimatedTime : 'Kita…'}
                                            </button>
                                        );
                                    })()}
                                </div>
                                {(showTimeOther || (!!formData.estimatedTime && !COMMON_TIMES.includes(formData.estimatedTime))) && (
                                    <Select
                                        value={formData.estimatedTime}
                                        onChange={(val) => setFormData({ ...formData, estimatedTime: val })}
                                        disabled={fieldsLocked}
                                        options={ALL_TIMES.map((t) => ({ value: t, label: t }))}
                                        label="Planuojamas laikas"
                                        placeholder="Planuojamas laikas..."
                                        ariaLabel="Planuojamas laikas (visi)"
                                        alwaysSheet
                                        className="mt-2"
                                    />
                                )}
                            </div>

                            {/* Worker (assignee) — managers choose; a worker sees themselves, locked. */}
                            <div>
                                <span className="mb-1 block text-body font-medium text-ink">Vykdytojas</span>
                                <Select
                                    value={formData.assignedUserId}
                                    onChange={(val) => setFormData({ ...formData, assignedUserId: val })}
                                    disabled={!isManager}
                                    options={assignableWorkers.map((worker) => ({ value: worker.id, label: formatDisplayName(worker.displayName || worker.email) }))}
                                    label="Vykdytojas"
                                    placeholder="Priskirti vykdytoją..."
                                    ariaLabel="Vykdytojas"
                                    alwaysSheet
                                />
                            </div>

                            {/* ─────────────── "Daugiau" — optional, collapsed by default ─────────────── */}
                            <div className="border-t border-line pt-4">
                                <p className="mb-2 text-caption text-ink-muted">Daugiau (neprivaloma)</p>
                                <div className="space-y-2">
                                    {/* Description */}
                                    <AdvancedSection icon={AlignLeft} label="Aprašymas" count={formData.description ? 1 : 0} open={expanded.description} onToggle={() => toggleSection('description')}>
                                        <textarea
                                            value={formData.description}
                                            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                                            disabled={fieldsLocked}
                                            rows={3}
                                            placeholder="Užduoties aprašymas..."
                                            aria-label="Aprašymas"
                                            className="w-full px-3 py-3 border border-line rounded-lg focus:ring-2 focus:ring-brand disabled:bg-surface-sunken text-base"
                                        />
                                    </AdvancedSection>

                                    {/* Photos — direct-camera button (workers photograph work on-site)
                                        alongside a gallery picker. capture="environment" opens the rear
                                        camera on phones and is ignored on desktop. */}
                                    <AdvancedSection icon={Camera} label="Nuotraukos" count={(formData.attachmentUrls?.length || 0) + selectedFiles.length} open={expanded.photos} onToggle={() => toggleSection('photos')}>
                                        <p className="mb-2 text-caption text-ink-muted">Maksimaliai 8 nuotraukos.</p>
                                        <div className="grid grid-cols-2 gap-2">
                                            <label className="flex items-center justify-center gap-2 px-3 py-3 border border-line border-dashed rounded-lg text-center cursor-pointer hover:bg-surface-sunken text-ink-muted focus-within:ring-2 focus-within:ring-brand">
                                                <Camera className="w-5 h-5 flex-shrink-0" aria-hidden="true" />
                                                <span className="text-base text-ink-muted">Fotografuoti</span>
                                                <input
                                                    type="file"
                                                    accept="image/*"
                                                    capture="environment"
                                                    onChange={handleFileSelect}
                                                    className="hidden"
                                                />
                                            </label>
                                            <label className="flex items-center justify-center gap-2 px-3 py-3 border border-line border-dashed rounded-lg text-center cursor-pointer hover:bg-surface-sunken text-ink-muted focus-within:ring-2 focus-within:ring-brand">
                                                <Plus className="w-5 h-5 flex-shrink-0" aria-hidden="true" />
                                                <span className="text-base text-ink-muted">Iš galerijos</span>
                                                <input
                                                    type="file"
                                                    accept="image/*"
                                                    multiple // Allow multiple files
                                                    onChange={handleFileSelect}
                                                    className="hidden"
                                                />
                                            </label>
                                        </div>

                                        {/* Display Existing Attachments */}
                                        {formData.attachmentUrls && formData.attachmentUrls.length > 0 && (
                                            <div className="mt-4 grid grid-cols-2 gap-2">
                                                {formData.attachmentUrls.map((url, index) => (
                                                    <div key={`existing-${index}`} className="relative group border rounded-lg p-1">
                                                        <a href={url} target="_blank" rel="noopener noreferrer">
                                                            <img src={url} alt={`Attachment ${index + 1}`} className="w-full h-24 object-cover rounded" />
                                                        </a>
                                                        <button
                                                            type="button"
                                                            onClick={() => removeExistingAttachment(index)}
                                                            aria-label="Pašalinti nuotrauką"
                                                            className="absolute top-1 right-1 inline-flex items-center justify-center min-h-touch min-w-touch bg-white rounded-full text-red-500 shadow transition-colors hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                                                        >
                                                            <Trash2 className="w-4 h-4" aria-hidden="true" />
                                                        </button>
                                                    </div>
                                                ))}
                                            </div>
                                        )}

                                        {/* Display Selected (Proposed) Attachments — with original size
                                            so the worker can judge the mobile-data cost before uploading. */}
                                        {selectedFiles.length > 0 && (
                                            <div className="mt-4">
                                                <p className="text-xs font-semibold text-ink-muted mb-2">Naujai pasirinktos:</p>
                                                <div className="space-y-2">
                                                    {selectedFiles.map((file, index) => (
                                                        <div key={`selected-${index}`} className="flex items-center justify-between gap-2 text-sm text-ink bg-surface-sunken p-2 rounded">
                                                            <span className="truncate min-w-0 flex-1">{file.name}</span>
                                                            <span className="shrink-0 text-caption text-ink-muted tabular-nums">{formatBytes(file.size)}</span>
                                                            <button
                                                                type="button"
                                                                onClick={() => removeSelectedFile(index)}
                                                                aria-label={`Pašalinti ${file.name}`}
                                                                className="inline-flex items-center justify-center min-h-touch min-w-touch shrink-0 text-ink-muted hover:text-red-500 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                                                            >
                                                                <X className="w-4 h-4" aria-hidden="true" />
                                                            </button>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}

                                        {/* Combined upload progress (slow mobile networks) */}
                                        {loading && selectedFiles.length > 0 && (
                                            <div className="mt-3" aria-live="polite">
                                                <div className="mb-1 flex items-center justify-between text-caption text-ink-muted">
                                                    <span>Keliama…</span>
                                                    <span className="tabular-nums">{uploadProgress}%</span>
                                                </div>
                                                <div
                                                    className="h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken"
                                                    role="progressbar"
                                                    aria-valuenow={uploadProgress}
                                                    aria-valuemin={0}
                                                    aria-valuemax={100}
                                                    aria-label="Nuotraukų įkėlimo eiga"
                                                >
                                                    <div className="h-full rounded-full bg-brand transition-all duration-base" style={{ width: `${uploadProgress}%` }} />
                                                </div>
                                            </div>
                                        )}
                                    </AdvancedSection>

                                    {/* Checklist (sub-tasks) authoring. Stored on the task doc; workers
                                        tick items live from the card. Editable here when creating, or by
                                        a manager editing an existing task — otherwise shown read-only. */}
                                    <AdvancedSection icon={CheckSquare} label="Kontrolinis sąrašas" count={formData.checklist?.length || 0} open={expanded.checklist} onToggle={() => toggleSection('checklist')}>
                                        {(isManager || !task) && (
                                            <div className="flex gap-2">
                                                <input
                                                    type="text"
                                                    value={newChecklistItem}
                                                    onChange={(e) => setNewChecklistItem(e.target.value)}
                                                    placeholder="Pridėti punktą..."
                                                    className="flex-1 px-3 py-3 border border-line rounded-lg focus:ring-2 focus:ring-brand text-base"
                                                />
                                                <IconButton icon={Plus} label="Pridėti punktą" variant="primary" onClick={addChecklistItemLocal} />
                                            </div>
                                        )}
                                        {formData.checklist && formData.checklist.length > 0 && (
                                            <ul className="mt-2 space-y-2">
                                                {formData.checklist.map((item) => (
                                                    <li key={item.id} className="flex items-center justify-between gap-2 bg-surface-sunken p-2 rounded-lg">
                                                        <span className="flex items-center gap-2 min-w-0 flex-1">
                                                            {item.done
                                                                ? <CheckSquare className="w-4 h-4 flex-shrink-0 text-brand" aria-hidden="true" />
                                                                : <Square className="w-4 h-4 flex-shrink-0 text-ink-muted" aria-hidden="true" />}
                                                            <span className={`truncate text-sm ${item.done ? 'text-ink-muted line-through' : 'text-ink'}`}>{item.text}</span>
                                                        </span>
                                                        {(isManager || !task) && (
                                                            <IconButton icon={Trash2} label="Pašalinti punktą" variant="danger" onClick={() => removeChecklistItemLocal(item.id)} />
                                                        )}
                                                    </li>
                                                ))}
                                            </ul>
                                        )}
                                    </AdvancedSection>

                                    {/* Schedule — deadline + the manager/auditor. Both have sensible
                                        defaults, so they live here rather than on the spine. */}
                                    <AdvancedSection icon={Calendar} label="Terminas ir vadovas" count={formData.deadline ? 1 : 0} open={expanded.schedule} onToggle={() => toggleSection('schedule')}>
                                        <span className="mb-1 block text-body font-medium text-ink">Atlikti iki</span>
                                        <input
                                            type={formData.deadline ? "date" : "text"}
                                            value={formData.deadline}
                                            onChange={(e) => setFormData({ ...formData, deadline: e.target.value })}
                                            onFocus={(e) => e.target.type = 'date'}
                                            aria-label="Atlikti iki"
                                            onBlur={(e) => !e.target.value && (e.target.type = 'text')}
                                            placeholder="Atlikti iki"
                                            disabled={fieldsLocked}
                                            className="w-full px-3 py-3 border border-line rounded-lg focus:ring-2 focus:ring-brand disabled:bg-surface-sunken text-base"
                                        />

                                        <span className={fieldLabel}>Vadovas</span>
                                        <Select
                                            value={formData.managerId}
                                            onChange={(val) => setFormData({ ...formData, managerId: val })}
                                            disabled={fieldsLocked}
                                            options={managers.map((manager) => ({ value: manager.id, label: formatDisplayName(manager.displayName || manager.email) }))}
                                            label="Vadovas"
                                            placeholder="Priskirti vadovą..."
                                            ariaLabel="Vadovas"
                                            alwaysSheet
                                        />
                                    </AdvancedSection>

                                    {/* Links + tag */}
                                    <AdvancedSection icon={Link2} label="Nuorodos ir žyma" count={formData.links.length} open={expanded.extra} onToggle={() => toggleSection('extra')}>
                                        <div className="flex gap-2">
                                            <input
                                                type="url"
                                                value={newLink}
                                                onChange={(e) => setNewLink(e.target.value)}
                                                placeholder="https://..."
                                                aria-label="Nuoroda"
                                                inputMode="url"
                                                className="flex-1 px-3 py-3 border border-line rounded-lg focus:ring-2 focus:ring-brand text-base"
                                            />
                                            <IconButton
                                                icon={Plus}
                                                label="Pridėti nuorodą"
                                                variant="primary"
                                                onClick={addLink}
                                            />
                                        </div>

                                        {formData.links.length > 0 && (
                                            <div className="mt-2 space-y-2">
                                                {formData.links.map((link, index) => (
                                                    <div key={index} className="flex items-center justify-between bg-surface-sunken p-2 rounded-lg">
                                                        <a href={link} target="_blank" rel="noopener noreferrer" className="text-sm text-blue-600 truncate hover:underline flex-1 mr-2">
                                                            {link}
                                                        </a>
                                                        <IconButton
                                                            icon={Trash2}
                                                            label="Pašalinti nuorodą"
                                                            variant="danger"
                                                            onClick={() => removeLink(index)}
                                                        />
                                                    </div>
                                                ))}
                                            </div>
                                        )}

                                        <span className={fieldLabel}>Žyma</span>
                                        <Select
                                            value={formData.tag || ''}
                                            onChange={(val) => setFormData({ ...formData, tag: val })}
                                            disabled={fieldsLocked}
                                            options={TASK_TAGS.map((tag) => ({ value: tag, label: tag }))}
                                            label="Žyma"
                                            placeholder="Pasirinkti žymą..."
                                            ariaLabel="Žyma"
                                            alwaysSheet
                                        />
                                    </AdvancedSection>

                                    {/* Comment */}
                                    <AdvancedSection icon={MessageSquare} label="Komentaras" count={formData.comments?.length || 0} open={expanded.comment} onToggle={() => toggleSection('comment')}>
                                        <div className="flex items-end gap-2">
                                            <textarea
                                                value={newComment}
                                                onChange={(e) => setNewComment(e.target.value)}
                                                placeholder="Rašyti komentarą..."
                                                aria-label="Rašyti komentarą"
                                                rows={2}
                                                className="flex-1 px-3 py-3 border border-line rounded-lg focus:ring-2 focus:ring-brand text-base resize-y"
                                            />
                                            <button type="button" onClick={addComment} className="min-h-touch bg-blue-50 text-blue-600 px-4 rounded-lg hover:bg-blue-100 font-medium whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2">
                                                Skelbti
                                            </button>
                                        </div>
                                    </AdvancedSection>
                                </div>
                            </div>

                            {/* Timestamps - Read Only */}
                            {
                                task && (
                                    <div className="text-xs text-ink-muted border-t border-line pt-4 flex flex-col gap-1.5">
                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                            {task.createdAt && <div><span className="font-semibold text-ink">Sukurta:</span> {new Date(task.createdAt).toLocaleString('lt-LT')}{task.creatorName && <span className="ml-1 text-ink-muted">({task.creatorName})</span>}</div>}
                                            {task.assignedAt && <div><span className="font-semibold text-ink">Priskirta:</span> {new Date(task.assignedAt).toLocaleString('lt-LT')}</div>}
                                            {task.startedAt && <div><span className="font-semibold text-ink">Pradėta:</span> {new Date(task.startedAt).toLocaleString('lt-LT')}</div>}
                                            {task.completedAt && <div><span className="font-semibold text-ink">Užbaigta:</span> {new Date(task.completedAt).toLocaleString('lt-LT')}</div>}
                                            {task.approvedAt && <div><span className="font-semibold text-ink">Patvirtinta:</span> {new Date(task.approvedAt).toLocaleString('lt-LT')}</div>}
                                            {task.confirmedAt && !task.approvedAt && <div><span className="font-semibold text-ink">Patvirtinta:</span> {new Date(task.confirmedAt).toLocaleString('lt-LT')}</div>}
                                        </div>
                                        {(() => {
                                            const spent = calculateCurrentTotalMinutes(task);
                                            if (spent > 0) {
                                                return (
                                                    <div className="flex items-center gap-1 font-bold text-blue-600 mt-1">
                                                        <Clock className="w-3.5 h-3.5" />
                                                        Praleistas laikas: {formatMinutesToTimeString(spent)}
                                                    </div>
                                                );
                                            }
                                            return null;
                                        })()}
                                        {task.id && <div className="font-mono text-caption text-ink-muted mt-1">ID: {task.id}</div>}
                                    </div>
                                )
                            }
                        </form>
                    )}
                </div>

                {/* Footer - Fixed */}
                <div className="flex justify-end gap-3 p-4 border-t border-line flex-shrink-0 bg-surface-sunken rounded-b-xl">
                    {isSavingTemplate ? (
                        <>
                            <Button variant="secondary" size="md" onClick={() => setIsSavingTemplate(false)}>
                                Atšaukti
                            </Button>
                            <Button variant="primary" size="md" onClick={handleConfirmSaveTemplate} loading={loading}>
                                Išsaugoti šabloną
                            </Button>
                        </>
                    ) : (
                        <>
                            <div className="flex flex-1 items-center justify-start">
                                {!task && isManagerRole(role) && (
                                    <Button
                                        variant="ghost"
                                        size="md"
                                        onClick={handleSaveTemplateClick}
                                        title="Išsaugoti, keisti ar ištrinti šabloną"
                                    >
                                        Šablonai
                                    </Button>
                                )}
                            </div>
                            <Button variant="secondary" size="md" onClick={onClose}>
                                Atšaukti
                            </Button>
                            <Button type="submit" form="task-form" variant="primary" size="md" loading={loading}>
                                {loading ? (selectedFiles.length > 0 ? 'Keliama…' : 'Saugoma…') : (task ? 'Išsaugoti' : 'Sukurti')}
                            </Button>
                        </>
                    )}
                </div>

                <ConfirmDialog
                    open={!!templateToDelete}
                    onConfirm={confirmDeleteTemplate}
                    onCancel={() => setTemplateToDelete(null)}
                    title="Ištrinti šabloną"
                    message={templateToDelete ? `Ar tikrai norite ištrinti šabloną „${templateToDelete.name}“?` : ''}
                    confirmLabel="Ištrinti"
                    cancelLabel="Atšaukti"
                    variant="danger"
                />

                <ConfirmDialog
                    open={!!overwriteTemplate}
                    onConfirm={confirmOverwriteTemplate}
                    onCancel={() => setOverwriteTemplate(null)}
                    title="Perrašyti šabloną"
                    message={overwriteTemplate ? `Šablonas „${overwriteTemplate.templateName}“ jau egzistuoja. Ar norite jį perrašyti?` : ''}
                    confirmLabel="Perrašyti"
                    cancelLabel="Atšaukti"
                    variant="primary"
                    loading={loading}
                />
            </div>
        </div>,
        document.body
    );
}
