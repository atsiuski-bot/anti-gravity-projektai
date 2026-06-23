import { useState, useEffect, useMemo } from 'react';
import { db, storage } from '../firebase';
import { ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage';
import { doc, updateDoc, addDoc, collection, getDoc } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { useUsers } from '../context/UsersContext';
import { X, Plus, Trash2, Clock, Camera, CheckSquare, Square, Check, ChevronDown, AlignLeft, MessageSquare, Sparkles, User, Pencil } from 'lucide-react';
import { formatDisplayName, isManagerRole } from '../utils/formatters';
import { scopeRoster } from '../utils/teamScope';
import { saveTaskTemplate, getTaskTemplates, updateTaskTemplate, deleteTaskTemplate } from '../utils/taskActions';
import { notify } from '../utils/notify';
import { logError } from '../utils/errorLog';
import { assignTask, humanActor, MODES } from '../domain';
import { getPriorityOptions, getPriorityColor, getPriorityTextColor, normalizePriority, DEFAULT_PRIORITY } from '../utils/priority';
import { compressImage } from '../utils/imageUtils';
import { buildChecklistItem, reconcileChecklist } from '../utils/checklistActions';
import { calculateCurrentTotalMinutes, formatMinutesToTimeString, parseTimeStringToMinutes } from '../utils/timeUtils';
import { preventEnterSubmit } from '../utils/formUtils';
import { titleStemSet, stemSetsSimilar } from '../utils/titleSimilarity';
import { TEMPLATE_CATEGORIES, getTemplateCategory, inferTemplateCategory } from '../utils/templateCategories';
import useTaskSuggestions from '../hooks/useTaskSuggestions';
import { useAssigneeAffinity } from '../hooks/useAssigneeAffinity';
import Button from './ui/Button';
import IconButton from './ui/IconButton';
import Modal from './ui/Modal';
import Select from './ui/Select';
import ConfirmDialog from './ui/ConfirmDialog';
import TaskStatusPill from './task/TaskStatusPill';
import DeletedBadge from './task/DeletedBadge';
import TitleSuggestInput from './task/TitleSuggestInput';
import TimeEstimatePicker from './TimeEstimatePicker';

// The four one-tap time chips on the form spine: the most common quick durations. Everything else
// (and a free-text custom value) lives one tap away behind the "+" button → TimeEstimatePicker.
const QUICK_TIME_CHIPS = ['15min', '30min', '1h', '2h'];

// Canonical scale used only to VALIDATE history-driven suggestions (per-title guess) so legacy
// free-text never leaks into the suggestion chip. The selectable scale itself lives in
// TimeEstimatePicker (TIME_PICKER_OPTIONS). 30h/60h were dropped from the offered options.
const ALL_TIMES = [
    '5min', '15min', '30min', '45min', '1h', '1,5h', '2h', '2,5h', '3h', '4h', '5h', '6h',
    '7,5h', '8h', '10h', '12,5h', '12h', '15h', '20h', '25h', '40h', '50h', '70h', '80h',
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

// "Suggest saving as a template" config. We nudge only once a manager has authored SIMILAR work
// (fuzzy, see titleSimilarity — exact repetition basically never happens) at least this many times
// AND no template covers it yet — so the prompt is rare, never blocks (the task is already saved),
// and is remembered as dismissed so it can't nag.
const TEMPLATE_SUGGEST_AFTER = 3;
const TEMPLATE_DISMISS_KEY = 'workz:templateSuggestDismissed';

// Dismissals are stored as distinctive-stem signatures so declining the nudge for one title
// suppresses the whole recurring THEME, not just that exact wording (the next occurrence is
// phrased differently but is the same work).
const stemSignature = (title) => [...titleStemSet(title)].sort().join('|');
const readDismissedSignatures = () => {
    try {
        return JSON.parse(localStorage.getItem(TEMPLATE_DISMISS_KEY) || '[]');
    } catch {
        return [];
    }
};
const rememberDismissedTitle = (title) => {
    const sig = stemSignature(title);
    if (!sig) return;
    try {
        const arr = readDismissedSignatures();
        if (!arr.includes(sig)) arr.push(sig);
        // Keep the list bounded — only the most recent dismissals matter.
        localStorage.setItem(TEMPLATE_DISMISS_KEY, JSON.stringify(arr.slice(-200)));
    } catch {
        // localStorage can be unavailable (private mode); the nudge just isn't remembered.
    }
};
const isThemeDismissed = (stems) =>
    readDismissedSignatures().some((sig) =>
        stemSetsSimilar(stems, new Set(sig.split('|').filter(Boolean)))
    );

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

    const [formData, setFormData] = useState({
        title: '',
        assignedUserId: '',
        managerId: '',
        priority: DEFAULT_PRIORITY,
        estimatedTime: '',
        description: '',
        status: 'pending',
        comments: [],
        completed: false,
        deadline: '',
        attachmentUrl: '',
        attachmentUrls: [], // New field for multiple attachments
        checklist: []
    });

    const [newComment, setNewComment] = useState('');
    const [newChecklistItem, setNewChecklistItem] = useState('');
    const [selectedFiles, setSelectedFiles] = useState([]); // Changed to array
    const [uploadProgress, setUploadProgress] = useState(0);

    // Estimated-time picker: common values are one-tap chips; the full scale is revealed
    // on demand (or auto-revealed when the saved value isn't one of the common ones).
    const [timePickerOpen, setTimePickerOpen] = useState(false);
    // The assignee is self for ~2/3 of all tasks, so the picker stays collapsed behind a
    // "Keisti" affordance and only opens when assigning to someone else.
    const [showAssigneePicker, setShowAssigneePicker] = useState(false);
    // Which optional ("Daugiau") sections are currently expanded.
    const [expanded, setExpanded] = useState({
        description: false,
        photos: false,
        checklist: false,
        schedule: false,
        comment: false
    });

    // Template State
    const [templates, setTemplates] = useState([]);
    const [isSavingTemplate, setIsSavingTemplate] = useState(false);
    const [templateName, setTemplateName] = useState('');
    // When set ({ title, total }) the template-save view is shown as a post-create NUDGE ("you've
    // made this N times — save it as a template?") rather than a manual save; its footer closes the
    // modal instead of returning to the form.
    const [templateSuggestion, setTemplateSuggestion] = useState(null);
    // Category chosen in the save view (empty = let it be inferred from the title on save).
    const [templateCategory, setTemplateCategory] = useState('');
    const [selectedTemplateFields, setSelectedTemplateFields] = useState({
        title: true,
        priority: true,
        estimatedTime: true,
        description: true,
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

    // Loader options grouped under category section headings (Select renders `isGroup` rows as
    // non-selectable headers). Category order follows TEMPLATE_CATEGORIES; empty ones are omitted;
    // within a category templates keep the sortedTemplates order.
    const groupedTemplateOptions = useMemo(() => {
        const byCat = new Map();
        for (const t of sortedTemplates) {
            const cat = getTemplateCategory(t);
            if (!byCat.has(cat)) byCat.set(cat, []);
            byCat.get(cat).push(t);
        }
        const opts = [];
        for (const { id, label } of TEMPLATE_CATEGORIES) {
            const items = byCat.get(id);
            if (!items || items.length === 0) continue;
            opts.push({ isGroup: true, label });
            for (const t of items) opts.push({ value: t.id, label: t.templateName });
        }
        return opts;
    }, [sortedTemplates]);

    const managers = workers.filter(w => w.role === 'manager' || w.role === 'admin' || w.role === 'seniorManager' || w.id === currentUser.uid);

    // The assignee picker is narrowed to a scoped manager's own team (plus themselves), so they
    // can only assign work to their people — mirrored by the server-side write rule. Admins and
    // unscoped managers keep the full roster. (Managers/templates list above stays full.)
    const assignableWorkers = useMemo(
        () => scopeRoster(workers, userData, currentUser?.uid),
        [workers, userData, currentUser]
    );

    // History-driven create assistance: the creator's own past titles (type-ahead), their
    // most-used times (chip personalisation) and a per-title time guess. Loaded only while
    // CREATING (a single owner-scoped read; never on edit).
    const { recentTitles, suggestTimeForTitle, countSimilarTitles } = useTaskSuggestions({
        uid: currentUser?.uid,
        enabled: isOpen && !task,
    });

    // The one-tap time chips on the spine are a FIXED quick-access subset; the full scale + a custom
    // entry live behind the "+" button (TimeEstimatePicker).
    const timeChips = QUICK_TIME_CHIPS;

    // A suggested time for the title being typed (create only), shown as a distinct chip the user
    // taps — never auto-written, so it informs without surprising. Restricted to the canonical
    // scale so a legacy free-text history value is never offered.
    const suggestedTime = useMemo(() => {
        if (task) return '';
        const t = suggestTimeForTitle(formData.title);
        return ALL_TIMES.includes(t) ? t : '';
    }, [task, formData.title, suggestTimeForTitle]);

    // Resolved display name for the current assignee (for the collapsed "Vykdytojas: …" row).
    const assigneeName = useMemo(() => {
        const w = workers.find((x) => x.id === formData.assignedUserId);
        return w ? formatDisplayName(w.displayName || w.email) : '';
    }, [workers, formData.assignedUserId]);
    const isSelfAssignee = !!currentUser && formData.assignedUserId === currentUser.uid;

    // Manager flag — defined here (not just before the early return) so the suggestions memo can
    // gate templates on it. Templates carry an assignee/manager preset, so they are a manager tool.
    const isManager = isManagerRole(role) || isManagerRole(userRole);

    // "Who usually does this kind of job?" — learn the title-root → assignee routing from history and
    // offer it as one-tap suggestions above the picker. Manager-only, new-task-only; the hook reads
    // scoped archived history once while this modal is mounted (open).
    const { suggestAssignees } = useAssigneeAffinity({ currentUser, userData, userRole, enabled: isManager && !task });
    const assigneeSuggestions = (isManager && !task)
        ? suggestAssignees(formData.title)
            .filter((id) => id !== formData.assignedUserId && assignableWorkers.some((w) => w.id === id))
            .map((id) => {
                const w = assignableWorkers.find((x) => x.id === id);
                return { id, name: formatDisplayName(w.displayName || w.email) };
            })
        : [];

    // The unified title type-ahead source: curated templates first (manager-only), then the
    // creator's own past titles each with its typical time. TitleSuggestInput filters this to the
    // typed text; picking a template applies its full preset, picking a history title fills time.
    const titleSuggestions = useMemo(() => {
        const items = [];
        if (isManager) {
            for (const t of templates) {
                const tTitle = t.data?.title || t.templateName || '';
                if (!t.templateName && !tTitle) continue;
                // Search a template by its name, task title, description AND assignee — a manager
                // may recall "the one assigned to Giedrius" or a word from its instructions.
                const desc = t.data?.description || '';
                const aId = t.data?.assignedUserId || t.data?.assignedWorkerId || '';
                const w = aId ? workers.find((x) => x.id === aId) : null;
                const aName = w ? formatDisplayName(w.displayName || w.email) : '';
                items.push({
                    value: t.templateName || tTitle,
                    kind: 'template',
                    time: t.data?.estimatedTime || '',
                    matchText: `${t.templateName || ''} ${tTitle} ${desc} ${aName}`,
                    template: t,
                });
            }
        }
        for (const title of recentTitles) {
            items.push({ value: title, kind: 'history', time: suggestTimeForTitle(title), matchText: title });
        }
        return items;
    }, [isManager, templates, recentTitles, suggestTimeForTitle, workers]);

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
                status: task.status || 'pending',
                comments: task.comments || [],
                completed: task.completed || false,
                deadline: task.deadline || '',
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
                    status: 'pending',
                    comments: [],
                    completed: false,
                    deadline: '',
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

    // Clear any stale error / pending confirmations from a previous open.
    useEffect(() => {
        if (!isOpen) return;
        setFormError('');
        setTemplateToDelete(null);
        setOverwriteTemplate(null);
        setTemplateSuggestion(null);
        setIsSavingTemplate(false);
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
                schedule: !!task.managerId,
                comment: (task.comments?.length || 0) > 0
            });
            setTimePickerOpen(false);
            // Reveal the assignee picker up-front when the task is already assigned to someone
            // other than the current user, so the manager can see/keep who it's on.
            setShowAssigneePicker(!!task.assignedUserId && task.assignedUserId !== currentUser?.uid);
        } else {
            setExpanded({ description: false, photos: false, checklist: false, schedule: false, comment: false });
            setTimePickerOpen(false);
            setShowAssigneePicker(false);
        }
    }, [task, isOpen, currentUser]);

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

    // Apply a template's preset to the form. The single place template data enters the form, so
    // every load path (header dropdown + the in-title suggestion) gets the same fixes:
    //  - strip tag/links (the form no longer manages them);
    //  - map the legacy `assignedWorkerId` the form never read onto `assignedUserId` (otherwise a
    //    template's assignee was silently dropped on load);
    //  - normalise any legacy priority casing to the canonical key.
    const handleApplyTemplate = (template) => {
        if (!template) return;
        const data = { ...(template.data || {}) };
        delete data.tag;
        delete data.links;
        if (!data.assignedUserId && data.assignedWorkerId) data.assignedUserId = data.assignedWorkerId;
        delete data.assignedWorkerId;
        if (data.priority) data.priority = normalizePriority(data.priority);
        setFormData(prev => ({ ...prev, ...data }));
        // Surface the assignee picker when the template puts the work on someone other than me.
        if (data.assignedUserId && data.assignedUserId !== currentUser?.uid) setShowAssigneePicker(true);
    };

    const handleLoadTemplate = (templateId) => {
        const template = templates.find(t => t.id === templateId);
        handleApplyTemplate(template);
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
            assignedUserId: !!formData.assignedUserId,
            managerId: !!formData.managerId,
            deadline: !!formData.deadline
        });
        // Pre-pick a category inferred from the title; the manager can override it.
        setTemplateCategory(inferTemplateCategory({ templateName: formData.title, data: { title: formData.title } }));
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
            await saveTaskTemplate(templateName, buildTemplateData(), currentUser, templateCategory || inferTemplateCategory({ templateName, data: { title: formData.title } }));
            await fetchTemplates();
            setIsSavingTemplate(false);
            // If this save came from the post-create nudge, the task is already created — close.
            if (templateSuggestion) {
                setTemplateSuggestion(null);
                onClose();
            }
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
            await updateTaskTemplate(overwriteTemplate.id, templateName, buildTemplateData(), currentUser, templateCategory || inferTemplateCategory({ templateName, data: { title: formData.title } }));
            await fetchTemplates();
            setOverwriteTemplate(null);
            setIsSavingTemplate(false);
            if (templateSuggestion) {
                setTemplateSuggestion(null);
                onClose();
            }
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

        // Title is the one field every task truly needs; the combobox input has no native
        // `required`, so guard it here (analysis: 100% of real tasks carry a title).
        if (!formData.title.trim()) {
            setFormError('Įveskite pavadinimą.');
            return;
        }

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
                // Canonicalize at the write boundary so the stored priority is ALWAYS one of the
                // UPPERCASE PRIORITIES tokens, regardless of which entry path set it (chip,
                // default seed, loaded legacy value). Read-side already normalizes; this stops
                // new mixed-casing from being minted. Idempotent (normalizePriority('MEDIUM')==='MEDIUM').
                priority: normalizePriority(formData.priority),
                // Persist the parsed numeric estimate alongside the human string so the time-limit
                // monitor and every report read a clean number instead of re-parsing free text.
                // estimatedTime is required (guarded above), so this is always a real value here.
                estimatedTimeMinutes: parseTimeStringToMinutes(formData.estimatedTime),
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
            // True only if the EDIT's separate assignee-move (assignTask) failed AFTER the content
            // save already committed — gates the assignment notification + the modal close below so a
            // non-atomic partial failure is surfaced precisely, not as the generic "nothing saved".
            let reassignmentFailed = false;
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

                // Reassignment is now a FIRST-CLASS, audited command (ADR 0015): when an edit hands
                // the task to a different, non-empty worker, the assignTask command OWNS the assignee
                // write + its decision-log entry — so keep assignedUserId/assignedAt OUT of this
                // content save and let the command apply them. (Clearing the assignee, or a self-edit
                // that doesn't move it, still flows through the content save unchanged; routing the
                // whole create/edit through commands is a later increment.)
                const nextAssignee = formData.assignedUserId;
                const reassignViaCommand = task.assignedUserId !== nextAssignee && !!nextAssignee;
                const contentData = { ...taskDataNoChecklist };
                if (reassignViaCommand) {
                    delete contentData.assignedUserId;
                    delete contentData.assignedAt;
                }

                await updateDoc(docRef, contentData);
                await reconcileChecklist(
                    task.id,
                    (task.checklist || []).map(item => item.id),
                    authoredChecklist || []
                );

                if (reassignViaCommand) {
                    const w = assignableWorkers.find((x) => x.id === nextAssignee);
                    try {
                        const result = await assignTask(
                            { task, worker: { id: nextAssignee, name: w ? formatDisplayName(w.displayName || w.email) : null } },
                            {
                                actor: humanActor({ uid: currentUser.uid, displayName: currentUser.displayName, email: currentUser.email, role: userRole }),
                                mode: MODES.COMMIT,
                                reason: 'reassigned via task editor',
                            },
                        );
                        // A human reassignment is never policy-refused (only an agent commit is);
                        // handle a soft refusal defensively all the same.
                        if (result && result.ok === false) {
                            reassignmentFailed = true;
                            console.warn('assignTask declined the reassignment:', result.reason);
                        }
                    } catch (assignErr) {
                        // The content edit already committed in the write above; this SECOND write (the
                        // assignee move + its audit) is non-atomic with it (routing the whole edit
                        // through one command is increment 3). A failure here must NOT masquerade as the
                        // generic "nothing saved" — surface a precise message, keep the modal open for a
                        // retry, and suppress the assignment notification below so the worker is not
                        // told of an assignment that did not land.
                        reassignmentFailed = true;
                        logError(assignErr, { source: 'TaskModal.handleSubmit.reassign' });
                        setFormError('Turinys išsaugotas, bet nepavyko priskirti vykdytojo. Bandykite priskyrimą dar kartą.');
                    }
                }

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
                    // The task was (re)assigned to a new worker — but only notify if the reassignment
                    // write actually landed (a failed assignTask must not announce a non-existent move).
                    if (task.assignedUserId !== assignee && !reassignmentFailed) {
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

            // For a freshly created task, offer to save it as a template if it's clearly recurring;
            // that keeps the modal open on the nudge. Otherwise close as usual.
            if (!task && maybeEnterTemplateSuggestion()) {
                return;
            }
            // A failed reassignment kept the content edit but not the assignee move; keep the modal
            // open (the precise error is already set) so the user can retry just the assignment.
            if (reassignmentFailed) {
                return;
            }
            onClose();
        } catch (error) {
            console.error("Error saving task:", error);
            setFormError('Nepavyko išsaugoti užduoties. Bandykite dar kartą.');
        } finally {
            setLoading(false);
        }
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

    // A pick from the title type-ahead. A template applies its full preset; a history title sets
    // the name and, only if no time is chosen yet, its typical time (an explicit time is kept).
    const handleSuggestionSelect = (item) => {
        if (!item) return;
        if (item.kind === 'template' && item.template) {
            handleApplyTemplate(item.template);
            return;
        }
        setFormData((prev) => {
            if (prev.estimatedTime) return { ...prev, title: item.value };
            return item.time
                ? { ...prev, title: item.value, estimatedTime: item.time }
                : { ...prev, title: item.value };
        });
    };

    const toggleSection = (key) => setExpanded(prev => ({ ...prev, [key]: !prev[key] }));

    // Closing while the template nudge is showing counts as "no thanks" — remember it so the same
    // recurring title is not offered again. Used by the header X and Escape.
    const handleClose = () => {
        if (templateSuggestion) {
            rememberDismissedTitle(templateSuggestion.title);
            setTemplateSuggestion(null);
        }
        onClose();
    };

    // After creating a task, decide whether to OFFER saving it as a template. High-precision so it
    // rarely fires: the same title authored ≥ TEMPLATE_SUGGEST_AFTER times, manager only, not
    // already templated, not previously dismissed. Returns true when the nudge is shown (caller
    // then keeps the modal open instead of closing). The task itself is already saved by now.
    const maybeEnterTemplateSuggestion = () => {
        if (!isManager) return false;
        const title = formData.title.trim();
        if (!title) return false;
        const newStems = titleStemSet(title);
        if (newStems.size === 0) return false;
        const total = countSimilarTitles(title) + 1; // prior similar + the new one
        if (total < TEMPLATE_SUGGEST_AFTER) return false;
        // Skip if an existing template already covers this work (fuzzy, not exact, so a
        // differently-worded near-duplicate template isn't proposed again).
        const alreadyTemplated = templates.some(
            (t) => stemSetsSimilar(newStems, titleStemSet(t.templateName)) || stemSetsSimilar(newStems, titleStemSet(t.data?.title))
        );
        if (alreadyTemplated) return false;
        if (isThemeDismissed(newStems)) return false;

        // Pre-fill the (reused) template-save view with this task's useful fields.
        setTemplateName(formData.title);
        setSelectedTemplateFields({
            title: true,
            priority: true,
            estimatedTime: !!formData.estimatedTime,
            description: !!formData.description,
            assignedUserId: !!formData.assignedUserId && formData.assignedUserId !== currentUser?.uid,
            managerId: false,
            deadline: !!formData.deadline,
        });
        setTemplateCategory(inferTemplateCategory({ templateName: title, data: { title } }));
        setTemplateSuggestion({ title: formData.title, total });
        setIsSavingTemplate(true);
        return true;
    };

    if (!isOpen) return null;

    // Worker viewing an already-created task can't edit the structured fields; the spine
    // controls and section bodies fall back to a read-only/locked state via this flag.
    // (isManager is defined above, near the suggestions memo.)
    const fieldsLocked = !isManager && !!task;

    // Filter to only allow Managers, Admins, and the current user (so they can assign to themselves).
    // This excludes other 'regular' workers.

    // The shell (scrim, centered card, focus-trap, Escape, portal) is the canonical Modal in
    // `bare` mode, so this form keeps its bespoke compact header/body/footer while inheriting
    // the shared a11y plumbing. `closeOnBackdrop={false}` keeps a stray backdrop tap from
    // discarding unsaved task input; Escape and the header `X` still close it.
    return (
        <Modal
            bare
            size="xl"
            closeOnBackdrop={false}
            ariaLabelledby="task-modal-title"
            onClose={handleClose}
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
                                options={groupedTemplateOptions}
                                label="Šablonai"
                                placeholder="Užkrauti šabloną..."
                                ariaLabel="Užkrauti šabloną"
                                alwaysSheet
                                className="min-w-0 max-w-[10rem]"
                            />
                        )}
                        <IconButton icon={X} label="Uždaryti" onClick={handleClose} className="-mr-1.5" />
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
                            {templateSuggestion && (
                                <div className="rounded-control bg-brand/10 border border-brand/30 p-3">
                                    <p className="flex items-center gap-2 text-body font-medium text-ink-strong">
                                        <Check className="h-4 w-4 text-feedback-success" aria-hidden="true" />
                                        Darbas sukurtas
                                    </p>
                                    <p className="mt-1 text-sm text-ink-muted">
                                        Panašų darbą kūrėte jau {templateSuggestion.total} kartą. Išsaugoti kaip šabloną, kad kitą kartą būtų greičiau? (Galite ir praleisti.)
                                    </p>
                                </div>
                            )}
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
                                                        className="min-h-touch text-sm text-left flex-1 truncate text-ink hover:text-brand font-medium rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
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
                                <span className="mb-1 block text-body font-medium text-ink">Kategorija</span>
                                <Select
                                    value={templateCategory}
                                    onChange={setTemplateCategory}
                                    options={TEMPLATE_CATEGORIES.map((c) => ({ value: c.id, label: c.label }))}
                                    label="Kategorija"
                                    placeholder="Pasirinkti kategoriją..."
                                    ariaLabel="Šablono kategorija"
                                    alwaysSheet
                                />
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
                                                className="w-4 h-4 text-brand rounded"
                                            />
                                            <span className="capitalize">{
                                                key === 'assignedUserId' ? 'Priskirtas vykdytojas' :
                                                    key === 'managerId' ? 'Priskirtas vadovas' :
                                                        key === 'estimatedTime' ? 'Planuojamas laikas' :
                                                            key === 'deadline' ? 'Terminas' :
                                                                key === 'title' ? 'Pavadinimas' :
                                                                    key === 'description' ? 'Aprašymas' :
                                                                        key === 'priority' ? 'Prioritetas' : key
                                            }</span>
                                        </label>
                                    ))}
                                </div>
                            </div>
                        </div>
                    ) : (
                        <form id="task-form" onSubmit={handleSubmit} onKeyDown={preventEnterSubmit} className="space-y-5">
                            {/* ─────────────── Spine: the few fields set on every task ─────────────── */}
                            {/* Title — a type-ahead over the creator's OWN past titles. Each row shows that
                                job's typical time; picking it fills both name and (if unset) the time. Free
                                text is always allowed for a brand-new job. */}
                            <div>
                                <span className="mb-1 block text-body font-medium text-ink">Ką reikia padaryti?</span>
                                <TitleSuggestInput
                                    value={formData.title}
                                    onChange={(val) => setFormData((prev) => ({ ...prev, title: val }))}
                                    onSelect={handleSuggestionSelect}
                                    suggestions={titleSuggestions}
                                    disabled={fieldsLocked}
                                    placeholder="Pavadinimas"
                                    ariaLabel="Pavadinimas"
                                />
                            </div>

                            {/* Estimated time — a per-title suggestion (when history has one) leads as a
                                distinct chip; then four one-tap quick durations; the full scale and a
                                free-text custom value live one tap away behind the "+" picker. */}
                            <div>
                                <span className="mb-1 block text-body font-medium text-ink">Planuojamas laikas</span>
                                <div className="flex flex-wrap items-center gap-2">
                                    {suggestedTime && formData.estimatedTime !== suggestedTime && (
                                        <button
                                            type="button"
                                            onClick={() => { setFormData((prev) => ({ ...prev, estimatedTime: suggestedTime })); setTimePickerOpen(false); }}
                                            disabled={fieldsLocked}
                                            aria-label={`Siūloma trukmė: ${suggestedTime}`}
                                            className="inline-flex items-center gap-1 min-h-touch rounded-full border border-brand bg-brand/10 px-4 text-base font-medium text-brand transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50"
                                        >
                                            <Sparkles className="h-4 w-4" aria-hidden="true" />
                                            Siūloma {suggestedTime}
                                        </button>
                                    )}
                                    {timeChips
                                        .filter((t) => !(suggestedTime && formData.estimatedTime !== suggestedTime && t === suggestedTime))
                                        .map((t) => {
                                            const active = formData.estimatedTime === t;
                                            return (
                                                <button
                                                    key={t}
                                                    type="button"
                                                    onClick={() => { setFormData((prev) => ({ ...prev, estimatedTime: t })); setTimePickerOpen(false); }}
                                                    disabled={fieldsLocked}
                                                    aria-pressed={active}
                                                    className={`min-h-touch rounded-full border px-4 text-base transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50 ${active ? 'border-brand bg-brand/10 font-medium text-brand' : 'border-line text-ink hover:bg-surface-sunken'}`}
                                                >
                                                    {t}
                                                </button>
                                            );
                                        })}
                                    {/* The current value when it is off the four quick chips (a "+"-picked or
                                        custom duration) — shown as its own active chip so the choice stays visible;
                                        tapping it reopens the picker. */}
                                    {(() => {
                                        const v = formData.estimatedTime;
                                        const covered = !v || timeChips.includes(v) || (suggestedTime && v === suggestedTime);
                                        if (covered) return null;
                                        return (
                                            <button
                                                type="button"
                                                onClick={() => setTimePickerOpen(true)}
                                                disabled={fieldsLocked}
                                                aria-pressed="true"
                                                className="min-h-touch rounded-full border border-brand bg-brand/10 px-4 text-base font-medium text-brand transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50"
                                            >
                                                {v}
                                            </button>
                                        );
                                    })()}
                                    {/* "+" opens the full scrollable scale + custom entry. */}
                                    <button
                                        type="button"
                                        onClick={() => setTimePickerOpen(true)}
                                        disabled={fieldsLocked}
                                        aria-label="Pasirinkti kitą planuojamą laiką"
                                        title="Daugiau…"
                                        className="inline-flex min-h-touch min-w-touch items-center justify-center rounded-full border border-line text-ink-muted transition hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50"
                                    >
                                        <Plus className="h-5 w-5" aria-hidden="true" />
                                    </button>
                                </div>
                            </div>

                            <TimeEstimatePicker
                                open={timePickerOpen}
                                value={formData.estimatedTime}
                                onSelect={(val) => setFormData((prev) => ({ ...prev, estimatedTime: val }))}
                                onClose={() => setTimePickerOpen(false)}
                            />

                            {/* Deadline — promoted onto the spine, directly under the planned time (was buried
                                in the collapsed "Daugiau" section). The text→date type swap keeps the native
                                picker's placeholder readable until the field is focused. */}
                            <div>
                                <span className="mb-1 block text-body font-medium text-ink">Atlikti iki</span>
                                <input
                                    type={formData.deadline ? "date" : "text"}
                                    value={formData.deadline}
                                    onChange={(e) => setFormData({ ...formData, deadline: e.target.value })}
                                    onFocus={(e) => e.target.type = 'date'}
                                    onBlur={(e) => !e.target.value && (e.target.type = 'text')}
                                    aria-label="Atlikti iki"
                                    placeholder="Atlikti iki"
                                    disabled={fieldsLocked}
                                    className="w-full px-3 py-3 border border-line rounded-lg focus:ring-2 focus:ring-brand disabled:bg-surface-sunken text-base"
                                />
                            </div>

                            {/* Worker (assignee) — defaults to self and stays collapsed (~2/3 of tasks are
                                self-assigned); a manager opens the picker only to hand work to someone else.
                                A non-manager only ever sees themselves, shown read-only. */}
                            <div>
                                <span className="mb-1 block text-body font-medium text-ink">Vykdytojas</span>
                                {/* History-learned "who usually does this kind of job" — one tap assigns. */}
                                {assigneeSuggestions.length > 0 && (
                                    <div className="mb-2 flex flex-wrap items-center gap-2">
                                        <span className="text-caption text-ink-muted">Siūloma:</span>
                                        {assigneeSuggestions.map((s) => (
                                            <button
                                                key={s.id}
                                                type="button"
                                                onClick={() => { setFormData({ ...formData, assignedUserId: s.id }); setShowAssigneePicker(true); }}
                                                className="inline-flex min-h-touch items-center rounded-full border border-line bg-surface-card px-3 text-body text-ink-muted hover:bg-surface-sunken hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                                            >
                                                {s.name}
                                            </button>
                                        ))}
                                    </div>
                                )}
                                {isManager ? (
                                    (showAssigneePicker || !isSelfAssignee) ? (
                                        <Select
                                            value={formData.assignedUserId}
                                            onChange={(val) => setFormData({ ...formData, assignedUserId: val })}
                                            options={assignableWorkers.map((worker) => ({ value: worker.id, label: formatDisplayName(worker.displayName || worker.email) }))}
                                            label="Vykdytojas"
                                            placeholder="Priskirti vykdytoją..."
                                            ariaLabel="Vykdytojas"
                                            alwaysSheet
                                        />
                                    ) : (
                                        <button
                                            type="button"
                                            onClick={() => setShowAssigneePicker(true)}
                                            className="flex w-full min-h-touch items-center gap-2 rounded-lg border border-line px-3 text-left text-base text-ink transition hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                                        >
                                            <User className="h-5 w-5 flex-shrink-0 text-ink-muted" aria-hidden="true" />
                                            <span className="flex-1 truncate">{assigneeName || 'Aš'}</span>
                                            <span className="inline-flex items-center gap-1 text-caption text-brand">
                                                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                                                Keisti
                                            </span>
                                        </button>
                                    )
                                ) : (
                                    <div className="flex min-h-touch items-center gap-2 rounded-lg border border-line bg-surface-sunken px-3 text-base text-ink-muted">
                                        <User className="h-5 w-5 flex-shrink-0 text-ink-muted" aria-hidden="true" />
                                        <span className="flex-1 truncate">{assigneeName || 'Aš'}</span>
                                    </div>
                                )}
                            </div>

                            {/* Priority — kept as the signature colour swatches but demoted below the two
                                real decisions: ~65% of tasks never move it off the default (Vidutinis). */}
                            <div>
                                <div className="mb-1 flex items-center">
                                    <span className="text-body font-medium text-ink">Prioritetas</span>
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
                                                className={`flex h-9 items-center justify-center gap-1 rounded-md px-2 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1 disabled:opacity-50 ${active ? 'flex-[2] ring-2 ring-brand' : 'flex-1 ring-1 ring-line'}`}
                                                style={{ backgroundColor: getPriorityColor(p.id) }}
                                            >
                                                {active && (
                                                    <>
                                                        <Check className="h-4 w-4 shrink-0" style={{ color: getPriorityTextColor(p.id) }} aria-hidden="true" />
                                                        <span className="truncate text-caption font-medium" style={{ color: getPriorityTextColor(p.id) }}>
                                                            {p.label}
                                                        </span>
                                                    </>
                                                )}
                                            </button>
                                        );
                                    })}
                                </div>
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
                                                            <img src={url} alt={`Priedas ${index + 1}`} className="w-full h-24 object-cover rounded" />
                                                        </a>
                                                        <button
                                                            type="button"
                                                            onClick={() => removeExistingAttachment(index)}
                                                            aria-label="Pašalinti nuotrauką"
                                                            className="absolute top-1 right-1 inline-flex items-center justify-center min-h-touch min-w-touch bg-surface-card rounded-full text-feedback-danger shadow transition-colors hover:bg-feedback-danger-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
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
                                                                className="inline-flex items-center justify-center min-h-touch min-w-touch shrink-0 text-ink-muted hover:text-feedback-danger rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
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

                                    {/* Manager / auditor — has a sensible default, so it stays here rather
                                        than on the spine. (The deadline was promoted up next to the planned
                                        time.) */}
                                    <AdvancedSection icon={User} label="Vadovas" count={formData.managerId ? 1 : 0} open={expanded.schedule} onToggle={() => toggleSection('schedule')}>
                                        <span className="mb-1 block text-body font-medium text-ink">Vadovas</span>
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
                                            <button type="button" onClick={addComment} className="min-h-touch bg-brand-soft text-brand px-4 rounded-lg hover:bg-brand-soft font-medium whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2">
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
                                                    <div className="flex items-center gap-1 font-bold text-feedback-info mt-1">
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
                            <Button
                                variant="secondary"
                                size="md"
                                onClick={() => (templateSuggestion ? handleClose() : setIsSavingTemplate(false))}
                            >
                                {templateSuggestion ? 'Ne, ačiū' : 'Atšaukti'}
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
        </Modal>
    );
}
