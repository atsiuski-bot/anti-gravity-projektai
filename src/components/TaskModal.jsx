import { useState, useEffect, useMemo, useRef, useLayoutEffect, Fragment, lazy, Suspense } from 'react';
import { db, storage } from '../firebase';
import { ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage';
import { doc, updateDoc, getDoc } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { useUsers } from '../context/UsersContext';
import { X, Plus, Trash2, Camera, CheckSquare, Square, Check, Sparkles, Pencil, LayoutTemplate, Tag, EyeOff, Eye, ZoomIn } from 'lucide-react';
import { formatDisplayName, isManagerRole, isAdminRole } from '../utils/formatters';
import { TASK_TAGS } from '../utils/taskUtils';
import { scopeRoster } from '../utils/teamScope';
import { saveTaskTemplate, getTaskTemplates, updateTaskTemplate, deleteTaskTemplate, hideTemplateForUser, unhideTemplateForUser } from '../utils/taskActions';
import { parseTaskText } from '../utils/aiActions';
import { notify } from '../utils/notify';
import { logError } from '../utils/errorLog';
import { assignTask, createTask, humanActor, MODES } from '../domain';
import { getPriorityOptions, getPriorityColor, getPriorityTextColor, normalizePriority, DEFAULT_PRIORITY } from '../utils/priority';
import { compressImage } from '../utils/imageUtils';
import { buildChecklistItem, reconcileChecklist } from '../utils/checklistActions';
import { parseTimeStringToMinutes } from '../utils/timeUtils';
import { preventEnterSubmit } from '../utils/formUtils';
import { titleStemSet, stemSetsSimilar } from '../utils/titleSimilarity';
import { resolveInitialTaskStatus } from '../utils/taskStatus';
import { TEMPLATE_CATEGORIES, getTemplateCategory, inferTemplateCategory } from '../utils/templateCategories';
import useTaskSuggestions from '../hooks/useTaskSuggestions';
import { useAssigneeAffinity } from '../hooks/useAssigneeAffinity';
import Button from './ui/Button';
import IconButton from './ui/IconButton';
import Modal from './ui/Modal';
import Select from './ui/Select';
import DatePicker from './ui/DatePicker';
import PersonSelect from './ui/PersonSelect';
import Avatar from './ui/Avatar';
import ConfirmDialog from './ui/ConfirmDialog';
import TaskStatusPill from './task/TaskStatusPill';
import DeletedBadge from './task/DeletedBadge';
import TitleSuggestInput from './task/TitleSuggestInput';
import TimeEstimatePicker from './TimeEstimatePicker';

// Drag-to-reorder editor for the "Eigos sąrašas" — lazy so @dnd-kit's weight enters the bundle only
// when a manager actually authors/edits a task, not for every modal viewer (mirrors PriorityBoard).
const ChecklistEditorList = lazy(() => import('./task/ChecklistEditorList'));

// The four one-tap time chips on the form spine: the most common quick durations. Everything else
// (and a free-text custom value) lives one tap away behind the "+" button → TimeEstimatePicker.
const QUICK_TIME_CHIPS = ['15min', '30min', '1h', '2h'];

// Canonical scale used only to VALIDATE history-driven suggestions (per-title guess) so legacy
// free-text never leaks into the suggestion chip. It extends past 20h (25h..200h) to still
// recognize old estimates from before the offered popup scale — TimeEstimatePicker
// (TIME_PICKER_OPTIONS) — was capped at 20h.
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

// Grow a textarea to fit its content so the description never needs an inner scrollbar — it
// extends downward as more lines are typed (a CSS min-height keeps a comfortable starting size).
const autoGrowTextarea = (el) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
};

// Lays the quick time-pick chips out on a SINGLE line that never wraps. A zero-size, off-screen
// measurement copy reports each chip's natural width; we then show only as many chips as fit
// before the always-visible trailing control ("+"). Chips that don't fit aren't dropped — the
// "+" picker holds the full scale, so the row "compresses to one line and the overflow collapses
// into the plus" (product rule). Re-measures on container resize and whenever `signature` changes.
function OneLineChips({ items, more, signature }) {
    const rowRef = useRef(null);
    const measureRef = useRef(null);
    const moreRef = useRef(null);
    const [visible, setVisible] = useState(items.length);

    useLayoutEffect(() => {
        const recompute = () => {
            const row = rowRef.current;
            const measure = measureRef.current;
            if (!row || !measure) return;
            const gap = 8; // matches gap-2
            const moreWidth = moreRef.current ? moreRef.current.offsetWidth + gap : 0;
            const available = row.clientWidth - moreWidth;
            let used = 0;
            let count = 0;
            for (const chip of Array.from(measure.children)) {
                const need = (count > 0 ? gap : 0) + chip.offsetWidth;
                if (used + need <= available) {
                    used += need;
                    count += 1;
                } else {
                    break;
                }
            }
            setVisible(count);
        };
        recompute();
        const row = rowRef.current;
        if (!row || typeof ResizeObserver === 'undefined') return undefined;
        const observer = new ResizeObserver(recompute);
        observer.observe(row);
        return () => observer.disconnect();
    }, [signature]);

    return (
        <div ref={rowRef} className="relative flex min-w-0 flex-nowrap items-center gap-2">
            {/* Off-screen, zero-size measurement copy: children report true offsetWidth even though
                the wrapper is clipped, so it costs no layout space and can't push the modal wider. */}
            <div aria-hidden="true" className="pointer-events-none absolute h-0 w-0 overflow-hidden">
                <div ref={measureRef} className="flex w-max flex-nowrap gap-2">
                    {items.map((it) => <Fragment key={it.key}>{it.node}</Fragment>)}
                </div>
            </div>
            {items.slice(0, visible).map((it) => <Fragment key={it.key}>{it.node}</Fragment>)}
            <span ref={moreRef} className="flex-shrink-0">{more}</span>
        </div>
    );
}

export default function TaskModal({ isOpen, onClose, task, role, editTemplate = null }) {
    const { currentUser, userRole, userData } = useAuth();
    const { activeUsers } = useUsers();
    const workers = useMemo(() => activeUsers || [], [activeUsers]);
    const [loading, setLoading] = useState(false);

    // Inline accessible error region (replaces banned window.alert popups).
    const [formError, setFormError] = useState('');
    // AI draft-fill: "✨ AI" beside the title turns the typed natural-language line into the
    // structured fields (server callable → OpenRouter/gemini-2.5-flash returns a DRAFT only; it
    // never creates the task). aiMsg is the inline status/result note.
    const [aiBusy, setAiBusy] = useState(false);
    const [aiMsg, setAiMsg] = useState(null); // { text, tone: 'ok' | 'err' }
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
        tag: '',
        attachmentUrl: '',
        attachmentUrls: [], // New field for multiple attachments
        checklist: []
    });

    const [newChecklistItem, setNewChecklistItem] = useState('');
    const [selectedFiles, setSelectedFiles] = useState([]); // Changed to array
    const [uploadProgress, setUploadProgress] = useState(0);
    // When checked on the create form, pressing the primary button saves a TEMPLATE built from the
    // filled fields instead of creating a task (the button relabels to "Sukurti šabloną").
    const [createAsTemplate, setCreateAsTemplate] = useState(false);
    // The description textarea auto-grows to fit its content; this ref lets us resize it when the
    // value changes programmatically (AI fill, template apply) as well as on each keystroke.
    const descriptionRef = useRef(null);

    // Estimated-time picker: common values are one-tap chips; the full scale is revealed
    // on demand (or auto-revealed when the saved value isn't one of the common ones).
    const [timePickerOpen, setTimePickerOpen] = useState(false);

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
    // Visibility of the template being saved: 'personal' (private to me, the default for everyone)
    // or 'team' (the shared, admin-curated library). The "Visai komandai" option is offered only
    // to admins; the Firestore rules enforce the same boundary on write.
    const [templateScope, setTemplateScope] = useState('personal');
    // The browse/manage hub: lists existing templates (apply / edit / delete) and offers
    // "save current as template". Replaces the old header loader + the inline list in the save view.
    const [isPickingTemplate, setIsPickingTemplate] = useState(false);
    // When set, the save view is editing THIS existing template (update by id) rather than
    // creating a new one; `templateEditData` holds that template's stored field values so the
    // field checkboxes act on the template's own data, not the in-progress task form.
    const [editingTemplateId, setEditingTemplateId] = useState(null);
    const [templateEditData, setTemplateEditData] = useState(null);
    const [selectedTemplateFields, setSelectedTemplateFields] = useState({
        title: true,
        priority: true,
        estimatedTime: true,
        description: true,
        assignedUserId: false,
        managerId: false,
        deadline: false
    });

    // Templates that CONCERN the current user at all: the whole shared team library plus this
    // user's OWN personal templates. Other people's personal templates never surface. Legacy
    // templates carry no `scope` and count as 'team'. This is what the management HUB lists — so a
    // template the user hid can still be un-hidden there. (Declared BEFORE the sort/suggest memos
    // that read it — a useMemo factory runs during render, so a later `const` would be a TDZ crash.)
    const hiddenTemplateIds = useMemo(
        () => new Set(userData?.hiddenTemplateIds || []),
        [userData]
    );
    const manageableTemplates = useMemo(
        () => templates.filter((t) => {
            const scope = t.scope || 'team';
            if (scope === 'personal') return t.createdBy === currentUser?.uid;
            return true; // team templates (hidden or not) — the hub shows them so they can be un-hidden
        }),
        [templates, currentUser]
    );
    // The everyday quick-pick set: the same, minus team templates this user hid from their view.
    // Drives the title type-ahead — hiding declutters the suggestions without losing the template.
    const visibleTemplates = useMemo(
        () => manageableTemplates.filter((t) => {
            const scope = t.scope || 'team';
            return scope === 'personal' || !hiddenTemplateIds.has(t.id);
        }),
        [manageableTemplates, hiddenTemplateIds]
    );

    const sortedTemplates = useMemo(() => {
        return [...manageableTemplates].sort((a, b) => {
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
    }, [manageableTemplates, workers]);

    // Templates grouped under their category for the picker hub. Category order follows
    // TEMPLATE_CATEGORIES; empty categories are omitted; within a category templates keep the
    // sortedTemplates order. Full template objects are kept so each row can apply / edit / delete.
    const groupedTemplates = useMemo(() => {
        const byCat = new Map();
        for (const t of sortedTemplates) {
            const cat = getTemplateCategory(t);
            if (!byCat.has(cat)) byCat.set(cat, []);
            byCat.get(cat).push(t);
        }
        const groups = [];
        for (const { id, label } of TEMPLATE_CATEGORIES) {
            const items = byCat.get(id);
            if (!items || items.length === 0) continue;
            groups.push({ id, label, items });
        }
        return groups;
    }, [sortedTemplates]);

    // A Meistras (worker) may never coordinate their own task — the coordinator picker lists ONLY
    // real coordinators (managers/admins/senior managers), never the worker themselves. A manager
    // keeps self in the list because a manager legitimately self-coordinates.
    const selfIsCoordinator = isManagerRole(userRole) || isManagerRole(role);
    const managers = workers.filter(w => w.role === 'manager' || w.role === 'admin' || w.role === 'seniorManager' || (selfIsCoordinator && w.id === currentUser.uid));

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

    // Resolved record + display name for the current assignee (read-only self box shows the avatar).
    const assigneeUser = useMemo(
        () => workers.find((x) => x.id === formData.assignedUserId) || null,
        [workers, formData.assignedUserId]
    );
    const assigneeName = assigneeUser ? formatDisplayName(assigneeUser.displayName || assigneeUser.email) : '';

    // Manager flag — defined here (not just before the early return) so the suggestions memo can
    // read it. Both role sources are checked because the prop and the AuthContext value can differ.
    const isManager = isManagerRole(role) || isManagerRole(userRole);
    // Admin flag — only an admin may CREATE or re-scope a SHARED ("team") template. Everyone else
    // (managers + workers) can still keep their own personal templates.
    const isAdmin = isAdminRole(role) || isAdminRole(userRole);

    // Who may EDIT/DELETE a given template — mirrors the Firestore write rule so the UI only offers
    // actions that will actually succeed: a personal template only by its owner; a team template by
    // an admin OR its creator. Everyone else can merely HIDE a team template from their own list.
    const canEditTemplate = (t) => {
        if (!t) return false;
        const scope = t.scope || 'team';
        if (scope === 'personal') return t.createdBy === currentUser?.uid;
        return isAdmin || t.createdBy === currentUser?.uid;
    };

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

    // The unified title type-ahead source: templates first (the user's visible set — team library
    // + own personal), then the creator's own past titles each with its typical time.
    // TitleSuggestInput filters this to the typed text; picking a template applies its preset,
    // picking a history title fills time. Templates surface for EVERYONE now (workers self-create
    // tasks too); the per-user `visibleTemplates` filter already hid other people's personal ones.
    const titleSuggestions = useMemo(() => {
        const items = [];
        for (const t of visibleTemplates) {
            const tTitle = t.data?.title || t.templateName || '';
            if (!t.templateName && !tTitle) continue;
            // Search a template by its name, task title, description AND assignee — a user may
            // recall "the one assigned to Giedrius" or a word from its instructions.
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
        for (const title of recentTitles) {
            items.push({ value: title, kind: 'history', time: suggestTimeForTitle(title), matchText: title });
        }
        return items;
    }, [visibleTemplates, recentTitles, suggestTimeForTitle, workers]);

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
                tag: task.tag || '',
                attachmentUrl: task.attachmentUrl || '', // Keep for legacy
                attachmentUrls: existingUrls,
                checklist: task.checklist || []
            });
        } else if (editTemplate) {
            // Editing a TEMPLATE as if it were a task: seed the standard form from the template's
            // stored values so the manager edits title/priority/deadline/people/time in the normal
            // dialog. Heal the legacy assignedWorkerId→assignedUserId drift on the way in.
            const d = { ...(editTemplate.data || {}) };
            if (!d.assignedUserId && d.assignedWorkerId) d.assignedUserId = d.assignedWorkerId;
            setFormData({
                title: d.title || '',
                assignedUserId: d.assignedUserId || '',
                managerId: d.managerId || '',
                priority: normalizePriority(d.priority),
                estimatedTime: d.estimatedTime || '',
                description: d.description || '',
                status: 'pending',
                comments: [],
                completed: false,
                deadline: d.deadline || '',
                tag: '',
                attachmentUrl: '',
                attachmentUrls: [],
                checklist: []
            });
            setTemplateName(editTemplate.templateName || '');
        } else {
            // Reset for new task
            // Fetch current user's default manager if they're a worker
            (async () => {
                let defaultManagerId = currentUser.uid;
                if (role === 'worker') {
                    // A worker never self-coordinates: default to their main coordinator
                    // (defaultManager); if none is set, leave empty so the picker shows the
                    // placeholder rather than pre-selecting the worker themselves.
                    defaultManagerId = '';
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
                    tag: '',
                    attachmentUrl: '',
                    attachmentUrls: [],
                    checklist: []
                });
            })();
        }
        setSelectedFiles([]);
    }, [task, editTemplate, role, currentUser]);

    // Load templates whenever the CREATE form is open — for everyone, not just managers. Workers
    // now have their own personal templates plus the shared team library, so the old manager-only
    // gate is gone. Skipped on task-edit and template-edit (the list isn't shown there).
    useEffect(() => {
        if (isOpen && !task && !editTemplate) {
            fetchTemplates();
        }
    }, [isOpen, task, editTemplate]);

    // Clear any stale error / pending confirmations from a previous open.
    useEffect(() => {
        if (!isOpen) return;
        setFormError('');
        setTemplateToDelete(null);
        setOverwriteTemplate(null);
        setTemplateSuggestion(null);
        setIsSavingTemplate(false);
        setTimePickerOpen(false);
        setCreateAsTemplate(false);
        setTemplateScope('personal');
    }, [isOpen]);

    // The description is always shown (no longer collapsed); size it to its content whenever the
    // value changes — including programmatic fills (AI / template / editTemplate) — and when the
    // modal opens.
    useLayoutEffect(() => {
        if (!isOpen || isSavingTemplate) return;
        autoGrowTextarea(descriptionRef.current);
    }, [formData.description, isOpen, isSavingTemplate]);

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
        // A non-manager self-assigns, so drop a template's preset WHO (assignee/manager) for them —
        // keep only the WHAT (title/priority/time/description/checklist). Otherwise a shared team
        // template's named assignee would land in the form and the create rule would reject it.
        if (!isManager) {
            delete data.assignedUserId;
            delete data.managerId;
        }
        setFormData(prev => ({ ...prev, ...data }));
    };

    const handleSaveTemplateClick = () => {
        setFormError('');
        // Saving the CURRENT task as a brand-new template — not editing an existing one.
        setEditingTemplateId(null);
        setTemplateEditData(null);
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
        // New templates start PERSONAL (private). An admin can switch to "Visai komandai" in the
        // save view; non-admins only ever save personal ones.
        setTemplateScope('personal');
    };

    const handleDeleteTemplate = (templateId, name) => {
        setFormError('');
        setTemplateToDelete({ id: templateId, name });
    };

    // Hide a shared team template from THIS user's own list (it stays for everyone else). The hidden
    // set lives on the user's own doc; AuthContext re-emits userData, so `visibleTemplates`
    // recomputes and the row disappears. No confirmation — it is reversible and low-stakes.
    const handleHideTemplate = async (templateId) => {
        if (!currentUser?.uid || !templateId) return;
        setFormError('');
        try {
            await hideTemplateForUser(currentUser.uid, templateId);
        } catch (error) {
            console.error('Failed to hide template', error);
            setFormError('Nepavyko paslėpti šablono. Bandykite dar kartą.');
        }
    };

    // Bring a previously hidden team template back into this user's list. Mirror of the hide above.
    const handleUnhideTemplate = async (templateId) => {
        if (!currentUser?.uid || !templateId) return;
        setFormError('');
        try {
            await unhideTemplateForUser(currentUser.uid, templateId);
        } catch (error) {
            console.error('Failed to un-hide template', error);
            setFormError('Nepavyko grąžinti šablono. Bandykite dar kartą.');
        }
    };

    // Open the save view in EDIT mode for an existing template: seed the name, category and
    // field checkboxes from the template's own stored data. The checkboxes act on
    // `templateEditData` (the template's values), so the manager re-chooses which parts the
    // template carries without touching the in-progress task form.
    const handleEditTemplate = (template) => {
        if (!template) return;
        setFormError('');
        const data = template.data || {};
        // Legacy templates stored the assignee under `assignedWorkerId`; normalise so the
        // checkbox + saved value both use the canonical key.
        const editData = { ...data };
        if (editData.assignedUserId === undefined && editData.assignedWorkerId !== undefined) {
            editData.assignedUserId = editData.assignedWorkerId;
        }
        delete editData.assignedWorkerId;
        const has = (v) => v !== undefined && v !== '' && v !== null;
        setEditingTemplateId(template.id);
        setTemplateEditData(editData);
        setTemplateName(template.templateName || '');
        setTemplateCategory(getTemplateCategory(template));
        // Reflect the template's current scope so the toggle shows where it lives (legacy = team).
        setTemplateScope((template.scope || 'team') === 'personal' ? 'personal' : 'team');
        setSelectedTemplateFields({
            title: has(editData.title),
            priority: has(editData.priority),
            estimatedTime: has(editData.estimatedTime),
            description: has(editData.description),
            assignedUserId: has(editData.assignedUserId),
            managerId: has(editData.managerId),
            deadline: has(editData.deadline),
        });
        setIsPickingTemplate(false);
        setIsSavingTemplate(true);
    };

    // Leave the save view, clearing any edit context, and return to the task form.
    const closeTemplateSaveView = () => {
        setIsSavingTemplate(false);
        setEditingTemplateId(null);
        setTemplateEditData(null);
        setFormError('');
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

    // Build the template's `data` from the checked fields. The source is the in-progress task
    // form when creating, or the template's own stored values when editing. Undefined values are
    // skipped so Firestore never receives an undefined field.
    const buildTemplateData = (source = formData) => {
        const dataToSave = {};
        Object.keys(selectedTemplateFields).forEach(key => {
            if (selectedTemplateFields[key] && source[key] !== undefined) {
                dataToSave[key] = source[key];
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

        // EDIT mode — update the same template in place (a rename to an existing name is allowed;
        // it simply renames this one). Field values come from the template's own stored data.
        if (editingTemplateId) {
            setLoading(true);
            try {
                await updateTaskTemplate(
                    editingTemplateId,
                    templateName,
                    buildTemplateData(templateEditData || {}),
                    currentUser,
                    templateCategory || inferTemplateCategory({ templateName, data: { title: templateName } }),
                    // Only an admin may re-scope on edit; for everyone else leave scope untouched.
                    isAdmin ? templateScope : undefined
                );
                await fetchTemplates();
                closeTemplateSaveView();
            } catch (error) {
                console.error("Failed to update template", error);
                setFormError('Nepavyko atnaujinti šablono. Bandykite dar kartą.');
            } finally {
                setLoading(false);
            }
            return;
        }

        // Check for an existing template to overwrite — but only one the user can actually write
        // (their own, or a team one if admin/creator); otherwise a worker naming a personal template
        // after a shared one would hit a permission-denied. Same-name personal vs team can coexist.
        const existingTemplate = templates.find(
            t => canEditTemplate(t) && (t.templateName || '').toLowerCase() === templateName.trim().toLowerCase()
        );
        if (existingTemplate) {
            setOverwriteTemplate(existingTemplate);
            return;
        }

        setLoading(true);
        try {
            await saveTaskTemplate(templateName, buildTemplateData(), currentUser, templateCategory || inferTemplateCategory({ templateName, data: { title: formData.title } }), templateScope);
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
            await updateTaskTemplate(overwriteTemplate.id, templateName, buildTemplateData(), currentUser, templateCategory || inferTemplateCategory({ templateName, data: { title: formData.title } }), isAdmin ? templateScope : undefined);
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

    // Save the in-progress create form as a template (the "Kurti kaip šabloną" path). The template
    // carries exactly the fields the user filled — empty values are skipped so Firestore never
    // receives a blank field — and the title doubles as the template name. No task is created.
    // This quick path always makes a PERSONAL template; sharing one to the whole team is a
    // deliberate admin action done from the template hub's save view (with the scope toggle).
    const handleCreateTemplateFromForm = async () => {
        const templateFields = ['title', 'priority', 'estimatedTime', 'description', 'assignedUserId', 'managerId', 'deadline'];
        const data = {};
        for (const key of templateFields) {
            const value = formData[key];
            if (value !== undefined && value !== null && value !== '') data[key] = value;
        }
        const name = formData.title.trim();
        setLoading(true);
        try {
            await saveTaskTemplate(
                name,
                data,
                currentUser,
                inferTemplateCategory({ templateName: name, data: { title: name } }),
                'personal',
            );
            onClose();
        } catch (error) {
            logError(error, { source: 'TaskModal.handleCreateTemplateFromForm' });
            setFormError('Nepavyko išsaugoti šablono. Bandykite dar kartą.');
        } finally {
            setLoading(false);
        }
    };

    const handleSubmit = async (e) => {
        e.preventDefault();

        // Title is the one field every task truly needs; the combobox input has no native
        // `required`, so guard it here (analysis: 100% of real tasks carry a title). The title
        // also doubles as the template name in the "create as template" path below.
        if (!formData.title.trim()) {
            setFormError('Įveskite pavadinimą.');
            return;
        }

        // TEMPLATE-EDIT mode: this dialog is editing a template's content, not creating/updating a
        // task. Write the edited spine fields back to the template (preserving any extra stored keys
        // like tag/links the form doesn't surface) and close — no image upload / task write / nudge.
        if (editTemplate) {
            setLoading(true);
            setFormError('');
            try {
                const data = { ...(editTemplate.data || {}) };
                delete data.assignedWorkerId; // normalise legacy key
                data.title = formData.title.trim();
                data.priority = normalizePriority(formData.priority);
                data.estimatedTime = formData.estimatedTime || '';
                data.description = formData.description || '';
                data.assignedUserId = formData.assignedUserId || '';
                data.managerId = formData.managerId || '';
                data.deadline = formData.deadline || '';
                // In this mode the task IS the template, so its title doubles as the template's
                // display name — keep them in sync so the recurring-tab row reflects the edit.
                await updateTaskTemplate(
                    editTemplate.id,
                    formData.title.trim(),
                    data,
                    currentUser,
                    getTemplateCategory(editTemplate)
                );
                onClose();
            } catch (error) {
                console.error('Failed to save template from task form', error);
                setFormError('Nepavyko išsaugoti šablono. Bandykite dar kartą.');
            } finally {
                setLoading(false);
            }
            return;
        }

        // "Kurti kaip šabloną" — save a TEMPLATE from the currently-filled fields instead of
        // creating a task. Templates may carry partial data, so the estimated-time guard below is
        // intentionally skipped on this path. Create-only (the checkbox is hidden when editing).
        if (!task && createAsTemplate) {
            await handleCreateTemplateFromForm();
            return;
        }

        // Estimated time is required but is now chosen via chips (no native <select required>
        // is guaranteed to be in the DOM), so guard it explicitly with a friendly message.
        if (!formData.estimatedTime) {
            setFormError('Pasirinkite planuojamą laiką.');
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
                        setFormError('Turinys išsaugotas, bet nepavyko priskirti meistro. Bandykite priskyrimą dar kartą.');
                    }
                }

                // Tell the worker(s) about a manager-side edit that concerns them — ONE notice per
                // save, chosen by precedence so a single edit never fans out into several pings:
                //   1. reassigned        → the NEW assignee gets "assigned", the OLD one "unassigned";
                //   2. estimate lifted after the limit was hit → "time extended" (the specific story);
                //   3. any other field   → "edited".
                // All are gated on "the affected person isn't the editor" so a self-edit is silent,
                // and the whole branch is skipped when handleEditAndApprove already sent the combined
                // "approved + edited" notice (__suppressEditNotice), so approve-and-edit stays one ping.
                const newAssignee = formData.assignedUserId;
                const oldAssignee = task.assignedUserId;
                const editorUid = currentUser.uid;
                const actor = { actorUid: editorUid, actorName: currentUser.displayName || currentUser.email };
                const reassigned = oldAssignee !== newAssignee && !reassignmentFailed;

                if (reassigned) {
                    if (newAssignee && newAssignee !== editorUid) {
                        await notify({ recipientId: newAssignee, type: 'task_assigned', taskId: task.id, taskTitle: formData.title, ...actor });
                    }
                    if (oldAssignee && oldAssignee !== editorUid) {
                        await notify({ recipientId: oldAssignee, type: 'task_unassigned', taskId: task.id, taskTitle: formData.title, ...actor });
                    }
                } else if (newAssignee && newAssignee !== editorUid) {
                    if (task.timeLimitReached && task.estimatedTime !== formData.estimatedTime) {
                        await notify({ recipientId: newAssignee, type: 'extension_granted', taskId: task.id, taskTitle: formData.title, estimatedTime: formData.estimatedTime, ...actor });
                    } else if (!task.__suppressEditNotice) {
                        await notify({ recipientId: newAssignee, type: 'task_edited', taskId: task.id, taskTitle: formData.title, ...actor });
                    }
                }
            } else {
                // Initial status — decided purely by WHO creates and FOR WHOM (resolveInitialTaskStatus,
                // unit-locked): non-manager -> 'unapproved'; manager-for-others -> 'pending'; manager
                // self-assigning -> 'approved'. Role comes from Context OR the surface prop.
                const isManagerOrAdmin = isManagerRole(userRole) || isManagerRole(role);
                const isSelfAssigned = formData.assignedUserId === currentUser.uid;
                const initialStatus = resolveInitialTaskStatus({ isManagerOrAdmin, isSelfAssigned });

                // For a manager's own (auto-approved) task, stamp the full approval shape so the stored
                // doc matches what approveTask would have written. Starting the timer overwrites status to
                // 'in-progress', so the green "Patvirtintas" only shows in the not-yet-started window.
                const approvalStamp = initialStatus === 'approved'
                    ? { isApproved: true, approvedBy: currentUser.uid, approvedAt: new Date().toISOString() }
                    : {};

                // Create through the audited createTask command (ADR 0015, increment 3): it
                // canonicalizes, stamps provenance from the actor, writes the tasks doc, and records
                // one decision_log entry — replacing the inline addDoc so creation has a single,
                // audited path. The caller still owns the role-derived status + auditor.
                const createResult = await createTask(
                    { fields: { ...taskData, status: initialStatus, ...approvalStamp, taskAuditor: activeAuditorId } },
                    {
                        actor: humanActor({ uid: currentUser.uid, displayName: currentUser.displayName, email: currentUser.email, role: userRole }),
                        mode: MODES.COMMIT,
                        reason: 'created via task editor',
                    },
                );
                docRef = { id: createResult.targetId };

                // Create notification if task needs approval
                // Use activeAuditorId here to ensure the notification goes to the CORRECT person (Default Manager)
                if (initialStatus === 'unapproved' && activeAuditorId) {
                    // Creator-authored (actorUid → createdBy); notify() stamps provenance + the registry
                    // category and swallows its own write errors.
                    await notify({
                        recipientId: activeAuditorId,
                        type: 'task_approval',
                        taskId: docRef.id,
                        taskTitle: taskData.title,
                        estimatedTime: taskData.estimatedTime || null,
                        description: taskData.description || null,
                        actorUid: currentUser.uid,
                        actorName: currentUser.displayName || currentUser.email,
                    });
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

    // Drag-reorder commits the new array order; reconcileChecklist preserves authored order on save.
    const reorderChecklistLocal = (nextChecklist) => {
        setFormData(prev => ({ ...prev, checklist: nextChecklist }));
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

    // "✨ AI" — parse the typed natural-language title into the structured spine fields for review.
    // The server callable returns a DRAFT (title/priority/estimatedTime/assignedUserId/deadline);
    // it never creates the task. Filled values are merged into the form so the manager can verify
    // and adjust before pressing Sukurti. Available on create only (the assignee roster is scoped).
    const handleAiParse = async () => {
        const text = (formData.title || '').trim();
        if (!text) { setAiMsg({ text: 'Įrašykite sakinį, pvz. „rytoj Giedriui 2 val. kostiumų patikra“.', tone: 'err' }); return; }
        setAiBusy(true);
        setAiMsg(null);
        try {
            const roster = assignableWorkers.map((u) => ({ id: u.id, name: formatDisplayName(u.displayName || u.email) }));
            const d = await parseTaskText(text, roster);
            // Smarter fill, in priority order: time STATED in the sentence → THIS title's historical
            // typical time → the model's best guess. History (real data about how long the manager
            // actually spends on this job) always beats a generic guess. Auto-writing is acceptable
            // here because pressing AI is an explicit "fill it for me" intent — the manager still
            // reviews the draft before Sukurti. Everything is clamped to the canonical chip scale.
            let fillTime = (d.estimatedTime || '').trim();
            if (!fillTime) {
                const histTime = suggestTimeForTitle(d.title || text);
                if (ALL_TIMES.includes(histTime)) fillTime = histTime;
            }
            if (!fillTime) {
                const guess = (d.estimatedGuess || '').trim();
                if (ALL_TIMES.includes(guess)) fillTime = guess;
            }
            setFormData((prev) => ({
                ...prev,
                ...(d.title ? { title: d.title } : {}),
                ...(d.priority ? { priority: normalizePriority(d.priority) } : {}),
                ...(fillTime ? { estimatedTime: fillTime } : {}),
                assignedUserId: d.assignedUserId || prev.assignedUserId,
                ...(d.deadline ? { deadline: d.deadline } : {}),
            }));
            // Create defaults the assignee to the creator, so one almost always exists already;
            // only flag the worker when NOTHING resolves it. Keying the message off the AI's
            // returned name (not the effective assignee) was the bug behind the misleading red
            // "patikslinkite vykdytoją" shown even when a worker was clearly selected. (The redesign
            // dropped the old showAssigneePicker collapse — the assignee is always visible now.)
            const hasAssignee = Boolean(d.assignedUserId || formData.assignedUserId);
            setAiMsg(
                hasAssignee
                    ? { text: 'Užpildyta — peržiūrėkite ir sukurkite.', tone: 'ok' }
                    : { text: 'Užpildyta — pasirinkite meistrą.', tone: 'err' },
            );
        } catch {
            setAiMsg({ text: 'AI nepavyko (ar funkcija/raktas įdiegti?).', tone: 'err' });
        } finally {
            setAiBusy(false);
        }
    };

    // Closing while the template nudge is showing counts as "no thanks" — remember it so the same
    // recurring title is not offered again. Used by the header X and Escape.
    const handleClose = () => {
        if (templateSuggestion) {
            rememberDismissedTitle(templateSuggestion.title);
            setTemplateSuggestion(null);
        }
        // Drop any open template hub / edit context so it never reappears on the next open.
        setIsPickingTemplate(false);
        setEditingTemplateId(null);
        setTemplateEditData(null);
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
                            {isSavingTemplate ? (editingTemplateId ? 'Redaguoti šabloną' : 'Išsaugoti šabloną') : (editTemplate ? 'Redaguoti šabloną' : (task ? 'Redaguoti užduotį' : 'Nauja veikla'))}
                        </h2>
                        {/* Template-edit badge — makes it unmistakable that saving updates the TEMPLATE,
                            not a one-off task. */}
                        {editTemplate && !isSavingTemplate && (
                            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-brand/10 px-2 py-0.5 text-caption font-semibold text-brand">
                                <LayoutTemplate className="h-3.5 w-3.5" aria-hidden="true" />
                                Šablonas
                            </span>
                        )}
                        {/* Read-only status — the form previously showed none; now it carries the same
                            Priimtas / Laukia priėmimo / Ištrinta the task shows on every other surface. */}
                        {task && !isSavingTemplate && (
                            (task.isDeleted || task.status === 'deleted')
                                ? <DeletedBadge />
                                : <TaskStatusPill task={task} />
                        )}
                    </div>
                    <div className="flex items-center gap-1 min-w-0">
                        {!isSavingTemplate && !task && !editTemplate && manageableTemplates.length > 0 && (
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setIsPickingTemplate(true)}
                                title="Peržiūrėti, užkrauti, keisti ar ištrinti šablonus"
                            >
                                <LayoutTemplate className="h-4 w-4" aria-hidden="true" />
                                Šablonai
                            </Button>
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
                                        Veikla sukurta
                                    </p>
                                    <p className="mt-1 text-sm text-ink-muted">
                                        Panašią veiklą kūrėte jau {templateSuggestion.total} kartą. Išsaugoti kaip šabloną, kad kitą kartą būtų greičiau? (Galite ir praleisti.)
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
                                    className="w-full px-3 py-3 border border-line rounded-lg focus-visible:ring-2 focus-visible:ring-brand"
                                />
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
                            {/* Visibility: personal (private) vs team (shared). Only an admin may pick
                                "Visai komandai"; everyone else sees a read-only note of where it lives. */}
                            <div>
                                <span className="mb-1 block text-body font-medium text-ink">Kam matomas</span>
                                {isAdmin ? (
                                    <>
                                        <div role="group" aria-label="Šablono matomumas" className="flex gap-1 rounded-lg border border-line p-1">
                                            <button
                                                type="button"
                                                onClick={() => setTemplateScope('personal')}
                                                aria-pressed={templateScope === 'personal'}
                                                className={`min-h-touch flex-1 rounded-md px-3 py-2 text-body transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${templateScope === 'personal' ? 'bg-brand/10 font-semibold text-brand ring-2 ring-brand' : 'text-ink ring-1 ring-line'}`}
                                            >
                                                Tik man
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setTemplateScope('team')}
                                                aria-pressed={templateScope === 'team'}
                                                className={`min-h-touch flex-1 rounded-md px-3 py-2 text-body transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${templateScope === 'team' ? 'bg-brand/10 font-semibold text-brand ring-2 ring-brand' : 'text-ink ring-1 ring-line'}`}
                                            >
                                                Visai komandai
                                            </button>
                                        </div>
                                        <p className="mt-1 text-caption text-ink-muted">
                                            {templateScope === 'team'
                                                ? 'Komandinį šabloną matys visa komanda.'
                                                : 'Asmeninį šabloną matote tik jūs.'}
                                        </p>
                                    </>
                                ) : (
                                    <p className="text-body text-ink-muted">
                                        {templateScope === 'team'
                                            ? 'Komandinis šablonas — tvarko administratorius.'
                                            : 'Asmeninis šablonas — matomas tik jums.'}
                                    </p>
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
                                                className="w-4 h-4 text-brand rounded"
                                            />
                                            <span className="capitalize">{
                                                key === 'assignedUserId' ? 'Priskirtas meistras' :
                                                    key === 'managerId' ? 'Priskirtas koordinatorius' :
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
                        <form id="task-form" onSubmit={handleSubmit} onKeyDown={preventEnterSubmit} className="space-y-4">
                            {/* ─────────────── Spine: the few fields set on every task ─────────────── */}
                            {/* Title — the placeholder carries the prompt (no separate label above); the
                                ✨ AI parse button shares the title's own row. Type-ahead over the creator's
                                own past titles + templates; free text is always allowed. */}
                            <div>
                                <div className="flex items-stretch gap-2">
                                    <TitleSuggestInput
                                        value={formData.title}
                                        onChange={(val) => setFormData((prev) => ({ ...prev, title: val }))}
                                        onSelect={handleSuggestionSelect}
                                        suggestions={titleSuggestions}
                                        disabled={fieldsLocked}
                                        placeholder="Ką reikia padaryti?"
                                        ariaLabel="Ką reikia padaryti?"
                                        className="flex-1"
                                    />
                                    {!task && !editTemplate && (
                                        <Button
                                            type="button"
                                            variant="secondary"
                                            icon={Sparkles}
                                            loading={aiBusy}
                                            disabled={fieldsLocked}
                                            onClick={handleAiParse}
                                            title="AI: paversti tekstą veikla"
                                            className="shrink-0"
                                        >
                                            AI
                                        </Button>
                                    )}
                                </div>
                                {aiMsg && (
                                    <p className={`mt-1 text-caption ${aiMsg.tone === 'err' ? 'text-feedback-danger' : 'text-feedback-success'}`} role="status">
                                        {aiMsg.text}
                                    </p>
                                )}
                                {!task && !editTemplate && !aiMsg && (
                                    <p className="mt-1 text-caption text-ink-muted">
                                        Su AI parašykite sakinį, pvz. „rytoj Giedriui 2 val. kostiumų patikra“ — užpildys meistrą, laiką ir terminą.
                                    </p>
                                )}
                            </div>

                            {/* Priority — directly under the title. Signature colour swatches; the active
                                one carries its text label so colour is never the only signal. Its caption
                                is intentionally dropped (the active swatch's own label names it). */}
                            <div>
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

                            {/* Deadline + tag — one row (deadline left, tag right). */}
                            <div className="grid grid-cols-2 gap-3">
                                {/* Deadline — optional. Canonical DatePicker (DESIGN_SYSTEM §8): renders its own
                                    calendar via date-fns + the lt locale, so month/weekday names are ALWAYS
                                    Lithuanian regardless of the browser's UI language (a native <input type="date">
                                    draws its drop-down in the browser language). Same yyyy-MM-dd value contract, and
                                    the trigger opens the calendar in a single click. */}
                                <div className="min-w-0">
                                    <DatePicker
                                        value={formData.deadline}
                                        onChange={(val) => setFormData({ ...formData, deadline: val })}
                                        placeholder="Atlikti iki…"
                                        aria-label="Atlikti iki"
                                        disabled={fieldsLocked}
                                    />
                                </div>
                                {/* Žyma — optional single tag from the canonical list. Opens a list panel
                                    (Select sheet) just like the other pickers; "Be žymos" clears it. */}
                                <Select
                                    value={formData.tag}
                                    onChange={(val) => setFormData({ ...formData, tag: val })}
                                    options={[
                                        { value: '', label: 'Be žymos' },
                                        ...TASK_TAGS.map((t) => ({ value: t, label: t })),
                                    ]}
                                    label="Žyma"
                                    placeholder="Žyma"
                                    ariaLabel="Žyma"
                                    icon={Tag}
                                    alwaysSheet
                                    disabled={fieldsLocked}
                                    className="min-w-0"
                                />
                            </div>

                            {/* People — who does it (Vykdytojas) and who oversees it (Vadovas), side by side.
                                Each is both SHOWN and CHOSEN as avatar + name (PersonSelect, DESIGN_SYSTEM §8
                                "Task people"). Defaults: assignee = self; manager = the creator's default
                                manager, or the creating manager themselves. */}
                            <div>
                                {/* History-learned "who usually does this kind of job" — one tap assigns. */}
                                {assigneeSuggestions.length > 0 && (
                                    <div className="mb-2 flex flex-wrap items-center gap-2">
                                        <span className="text-caption text-ink-muted">Siūloma:</span>
                                        {assigneeSuggestions.map((s) => (
                                            <button
                                                key={s.id}
                                                type="button"
                                                onClick={() => setFormData({ ...formData, assignedUserId: s.id })}
                                                className="inline-flex min-h-touch items-center rounded-full border border-line bg-surface-card px-3 text-body text-ink-muted hover:bg-surface-sunken hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                                            >
                                                {s.name}
                                            </button>
                                        ))}
                                    </div>
                                )}
                                <div className="grid grid-cols-2 gap-3">
                                    {/* Vykdytojas — manager picks from the scoped roster; a non-manager only
                                        ever does their own work, shown read-only in the same box shape. */}
                                    <div className="min-w-0">
                                        <span className="mb-1 block text-caption font-medium text-ink-muted">Meistras</span>
                                        {isManager ? (
                                            <PersonSelect
                                                value={formData.assignedUserId}
                                                onChange={(val) => setFormData({ ...formData, assignedUserId: val })}
                                                users={assignableWorkers}
                                                label="Meistras"
                                                placeholder="Priskirti…"
                                                ariaLabel="Meistras"
                                                disabled={fieldsLocked}
                                            />
                                        ) : (
                                            <div className="flex min-h-touch items-center gap-2 rounded-input border border-line bg-surface-sunken px-3 text-base text-ink">
                                                <Avatar src={assigneeUser?.photoURL || null} name={assigneeUser?.displayName || assigneeName} email={assigneeUser?.email} size="xs" />
                                                <span className="min-w-0 flex-1 truncate">{assigneeName || 'Aš'}</span>
                                            </div>
                                        )}
                                    </div>
                                    {/* Vadovas — the overseer/auditor; same picker, listing the managers. */}
                                    <div className="min-w-0">
                                        <span className="mb-1 block text-caption font-medium text-ink-muted">Koordinatorius</span>
                                        <PersonSelect
                                            value={formData.managerId}
                                            onChange={(val) => setFormData({ ...formData, managerId: val })}
                                            users={managers}
                                            label="Koordinatorius"
                                            placeholder="Priskirti…"
                                            ariaLabel="Koordinatorius"
                                            disabled={fieldsLocked}
                                        />
                                    </div>
                                </div>
                            </div>

                            {/* Estimated time — a per-title suggestion (when history has one) leads as a
                                distinct chip; then four one-tap quick durations; the full scale and a
                                free-text custom value live one tap away behind the "+" picker. The chips
                                are laid out on a single line that never wraps: any that don't fit collapse
                                into the "+" (OneLineChips), which holds the full scale anyway. */}
                            <div>
                                <span className="mb-1 block text-caption font-medium text-ink-muted">Planuojamas laikas</span>
                                {(() => {
                                    const showSuggested = suggestedTime && formData.estimatedTime !== suggestedTime;
                                    const items = [];
                                    if (showSuggested) {
                                        items.push({
                                            key: `suggested-${suggestedTime}`,
                                            node: (
                                                <button
                                                    type="button"
                                                    onClick={() => { setFormData((prev) => ({ ...prev, estimatedTime: suggestedTime })); setTimePickerOpen(false); }}
                                                    disabled={fieldsLocked}
                                                    aria-label={`Siūloma trukmė: ${suggestedTime}`}
                                                    className="inline-flex items-center gap-1 min-h-touch whitespace-nowrap rounded-full border border-brand bg-brand/10 px-4 text-base font-medium text-brand transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50"
                                                >
                                                    <Sparkles className="h-4 w-4" aria-hidden="true" />
                                                    Siūloma {suggestedTime}
                                                </button>
                                            ),
                                        });
                                    }
                                    timeChips
                                        .filter((t) => !(showSuggested && t === suggestedTime))
                                        .forEach((t) => {
                                            const active = formData.estimatedTime === t;
                                            items.push({
                                                key: `chip-${t}`,
                                                node: (
                                                    <button
                                                        type="button"
                                                        onClick={() => { setFormData((prev) => ({ ...prev, estimatedTime: t })); setTimePickerOpen(false); }}
                                                        disabled={fieldsLocked}
                                                        aria-pressed={active}
                                                        className={`min-h-touch whitespace-nowrap rounded-full border px-4 text-base transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50 ${active ? 'border-brand bg-brand/10 font-medium text-brand' : 'border-line text-ink hover:bg-surface-sunken'}`}
                                                    >
                                                        {t}
                                                    </button>
                                                ),
                                            });
                                        });
                                    // The current value when it is off the four quick chips (a "+"-picked or
                                    // custom duration) — shown as its own active chip so the choice stays visible.
                                    const v = formData.estimatedTime;
                                    const covered = !v || timeChips.includes(v) || (suggestedTime && v === suggestedTime);
                                    if (!covered) {
                                        items.push({
                                            key: `custom-${v}`,
                                            node: (
                                                <button
                                                    type="button"
                                                    onClick={() => setTimePickerOpen(true)}
                                                    disabled={fieldsLocked}
                                                    aria-pressed="true"
                                                    className="min-h-touch whitespace-nowrap rounded-full border border-brand bg-brand/10 px-4 text-base font-medium text-brand transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50"
                                                >
                                                    {v}
                                                </button>
                                            ),
                                        });
                                    }
                                    return (
                                        <OneLineChips
                                            items={items}
                                            signature={`${formData.estimatedTime}|${suggestedTime}|${fieldsLocked}|${items.map((i) => i.key).join(',')}`}
                                            more={
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
                                            }
                                        />
                                    );
                                })()}
                            </div>

                            <TimeEstimatePicker
                                open={timePickerOpen}
                                value={formData.estimatedTime}
                                onSelect={(val) => setFormData((prev) => ({ ...prev, estimatedTime: val }))}
                                onClose={() => setTimePickerOpen(false)}
                            />

                            {/* Description — always shown and auto-growing: the field extends downward as
                                more lines are typed instead of scrolling inside a fixed box. The placeholder
                                carries the label (no separate caption). */}
                            <div>
                                <textarea
                                    ref={descriptionRef}
                                    value={formData.description}
                                    onChange={(e) => { setFormData({ ...formData, description: e.target.value }); autoGrowTextarea(e.target); }}
                                    disabled={fieldsLocked}
                                    placeholder="Užduoties aprašymas..."
                                    aria-label="Aprašymas"
                                    className="w-full min-h-[6rem] resize-none overflow-hidden px-3 py-3 border border-line rounded-lg focus-visible:ring-2 focus-visible:ring-brand disabled:bg-surface-sunken text-base"
                                />
                            </div>

                            {/* Photos — always shown as two direct actions (no section heading): a rear-camera
                                capture and a gallery picker. capture="environment" opens the rear camera on
                                phones and is ignored on desktop. The "max 8" note appears only once at least
                                one photo is attached. */}
                            <div>
                                {(formData.attachmentUrls?.length || 0) + selectedFiles.length > 0 && (
                                    <p className="mb-2 text-caption text-ink-muted">Maksimaliai 8 nuotraukos.</p>
                                )}
                                <div className="grid grid-cols-2 gap-2">
                                    <label className="flex items-center justify-center gap-2 px-3 py-3 border border-line border-dashed rounded-lg text-center cursor-pointer hover:bg-surface-sunken text-ink-muted focus-within:ring-2 focus-within:ring-brand">
                                        <Camera className="w-5 h-5 flex-shrink-0" aria-hidden="true" />
                                        <span className="text-base text-ink-muted">Fotografuoti</span>
                                        <input
                                            type="file"
                                            accept="image/*"
                                            capture="environment"
                                            onChange={handleFileSelect}
                                            disabled={fieldsLocked}
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
                                            disabled={fieldsLocked}
                                            className="hidden"
                                        />
                                    </label>
                                </div>

                                {/* Display Existing Attachments */}
                                {formData.attachmentUrls && formData.attachmentUrls.length > 0 && (
                                    <div className="mt-4 grid grid-cols-2 gap-2">
                                        {formData.attachmentUrls.map((url, index) => (
                                            <div key={`existing-${index}`} className="relative group border rounded-lg p-1">
                                                <a href={url} target="_blank" rel="noopener noreferrer" className="block">
                                                    {/* object-contain + sunken canvas so a tall photo shows whole,
                                                        not just its middle; ZoomIn badge marks it openable full-size. */}
                                                    <img src={url} alt={`Priedas ${index + 1}`} className="w-full h-24 object-contain rounded bg-surface-sunken" />
                                                </a>
                                                <span className="pointer-events-none absolute bottom-1.5 right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white">
                                                    <ZoomIn className="h-3 w-3" aria-hidden="true" />
                                                </span>
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
                            </div>

                            {/* Eigos sąrašas (progress list / sub-tasks) — always open. Stored on the task
                                doc; workers tick items live from the card. Editable here when creating, or by
                                a manager editing an existing task — otherwise shown read-only. */}
                            <div>
                                <span className="mb-1 block text-caption font-medium text-ink-muted">Eigos sąrašas</span>
                                {(isManager || !task) && (
                                    <div className="flex gap-2">
                                        <input
                                            type="text"
                                            value={newChecklistItem}
                                            onChange={(e) => setNewChecklistItem(e.target.value)}
                                            placeholder="Pridėti punktą..."
                                            className="flex-1 px-3 py-3 border border-line rounded-lg focus-visible:ring-2 focus-visible:ring-brand text-base"
                                        />
                                        <IconButton icon={Plus} label="Pridėti punktą" variant="primary" onClick={addChecklistItemLocal} />
                                    </div>
                                )}
                                {formData.checklist && formData.checklist.length > 0 && (
                                    (isManager || !task) ? (
                                        // Editable: drag-to-reorder list (lazy — pulls @dnd-kit on demand).
                                        <Suspense fallback={
                                            <ul className="mt-2 space-y-2">
                                                {formData.checklist.map((item) => (
                                                    <li key={item.id} className="flex items-center gap-2 rounded-lg bg-surface-sunken p-2">
                                                        <span className="flex min-w-0 flex-1 items-center gap-2">
                                                            {item.done
                                                                ? <CheckSquare className="w-4 h-4 flex-shrink-0 text-brand" aria-hidden="true" />
                                                                : <Square className="w-4 h-4 flex-shrink-0 text-ink-muted" aria-hidden="true" />}
                                                            <span className={`truncate text-sm ${item.done ? 'text-ink-muted line-through' : 'text-ink'}`}>{item.text}</span>
                                                        </span>
                                                    </li>
                                                ))}
                                            </ul>
                                        }>
                                            <ChecklistEditorList
                                                items={formData.checklist}
                                                onReorder={reorderChecklistLocal}
                                                onRemove={removeChecklistItemLocal}
                                            />
                                        </Suspense>
                                    ) : (
                                        // Read-only viewer: no drag, no delete.
                                        <ul className="mt-2 space-y-2">
                                            {formData.checklist.map((item) => (
                                                <li key={item.id} className="flex items-center justify-between gap-2 bg-surface-sunken p-2 rounded-lg">
                                                    <span className="flex items-center gap-2 min-w-0 flex-1">
                                                        {item.done
                                                            ? <CheckSquare className="w-4 h-4 flex-shrink-0 text-brand" aria-hidden="true" />
                                                            : <Square className="w-4 h-4 flex-shrink-0 text-ink-muted" aria-hidden="true" />}
                                                        <span className={`truncate text-sm ${item.done ? 'text-ink-muted line-through' : 'text-ink'}`}>{item.text}</span>
                                                    </span>
                                                </li>
                                            ))}
                                        </ul>
                                    )
                                )}
                            </div>

                            {/* Create-as-template — when checked, the primary button saves a template built
                                from the filled fields instead of creating a task (manager tool, create only;
                                hidden while editing an existing template — that path already saves to it). */}
                            {!task && !editTemplate && isManager && (
                                <div className="border-t border-line pt-4">
                                    <label className="flex min-h-touch cursor-pointer items-center gap-3">
                                        <input
                                            type="checkbox"
                                            checked={createAsTemplate}
                                            onChange={(e) => setCreateAsTemplate(e.target.checked)}
                                            className="h-5 w-5 rounded text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                                        />
                                        <span className="text-base text-ink">Kurti kaip šabloną</span>
                                    </label>
                                    {createAsTemplate && (
                                        <p className="mt-1 pl-8 text-caption text-ink-muted">
                                            Bus sukurtas šablonas su užpildytais laukais (veikla nebus sukurta).
                                        </p>
                                    )}
                                </div>
                            )}
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
                                onClick={() => (templateSuggestion ? handleClose() : closeTemplateSaveView())}
                            >
                                {templateSuggestion ? 'Ne, ačiū' : 'Atšaukti'}
                            </Button>
                            <Button variant="primary" size="md" onClick={handleConfirmSaveTemplate} loading={loading}>
                                {editingTemplateId ? 'Atnaujinti šabloną' : 'Išsaugoti šabloną'}
                            </Button>
                        </>
                    ) : (
                        <>
                            <Button variant="secondary" size="md" onClick={onClose}>
                                Atšaukti
                            </Button>
                            <Button type="submit" form="task-form" variant="primary" size="md" loading={loading}>
                                {loading
                                    ? (selectedFiles.length > 0 ? 'Keliama…' : 'Saugoma…')
                                    : (editTemplate ? 'Išsaugoti šabloną' : (!task && createAsTemplate ? 'Sukurti šabloną' : (task ? 'Išsaugoti' : 'Sukurti')))}
                            </Button>
                        </>
                    )}
                </div>

                {/* Template hub — browse existing templates (apply / edit / delete) and save the
                    current task as a new one. Rendered as a sibling portal after the task modal, so
                    its scrim layers above the task card; the delete confirm renders after it in turn
                    and so stacks above the hub (same z-level, later in the DOM wins). */}
                <Modal
                    open={isPickingTemplate}
                    onClose={() => setIsPickingTemplate(false)}
                    title="Šablonai"
                    size="md"
                >
                    <div className="space-y-5">
                        <Button
                            variant="secondary"
                            size="md"
                            fullWidth
                            onClick={() => { setIsPickingTemplate(false); handleSaveTemplateClick(); }}
                        >
                            <Plus className="h-4 w-4" aria-hidden="true" />
                            Išsaugoti dabartinę veiklą kaip šabloną
                        </Button>

                        {groupedTemplates.length === 0 ? (
                            <p className="py-6 text-center text-body text-ink-muted">
                                Šablonų dar nėra. Išsaugokite dabartinę veiklą kaip šabloną, kad kitą kartą būtų greičiau.
                            </p>
                        ) : (
                            <div className="space-y-4">
                                {groupedTemplates.map((group) => (
                                    <div key={group.id}>
                                        <p className="px-1 pb-1 text-caption font-semibold uppercase tracking-wide text-ink-muted">
                                            {group.label}
                                        </p>
                                        <ul className="divide-y divide-line overflow-hidden rounded-card border border-line">
                                            {group.items.map((t) => {
                                                const tScope = t.scope || 'team';
                                                const editable = canEditTemplate(t);
                                                const isHidden = tScope === 'team' && hiddenTemplateIds.has(t.id);
                                                return (
                                                <li key={t.id} className={`flex items-center gap-1 pr-1 ${isHidden ? 'opacity-60' : ''}`}>
                                                    <button
                                                        type="button"
                                                        onClick={() => { handleApplyTemplate(t); setIsPickingTemplate(false); }}
                                                        className="min-h-touch flex-1 truncate rounded px-3 py-2.5 text-left text-body text-ink hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                                                        title={`Užkrauti šabloną „${t.templateName}“`}
                                                    >
                                                        {t.templateName}
                                                        {tScope === 'personal' && (
                                                            <span className="ml-2 align-middle rounded-full bg-surface-sunken px-1.5 py-0.5 text-caption text-ink-muted">
                                                                asmeninis
                                                            </span>
                                                        )}
                                                        {isHidden && (
                                                            <span className="ml-2 align-middle rounded-full bg-surface-sunken px-1.5 py-0.5 text-caption text-ink-muted">
                                                                paslėptas
                                                            </span>
                                                        )}
                                                    </button>
                                                    {isHidden ? (
                                                        // Hidden from this user's own list — offer to bring it back.
                                                        <IconButton
                                                            icon={Eye}
                                                            label="Rodyti mano sąraše"
                                                            variant="ghost"
                                                            onClick={() => handleUnhideTemplate(t.id)}
                                                        />
                                                    ) : editable ? (
                                                        <>
                                                            <IconButton
                                                                icon={Pencil}
                                                                label="Redaguoti šabloną"
                                                                variant="ghost"
                                                                onClick={() => handleEditTemplate(t)}
                                                            />
                                                            <IconButton
                                                                icon={Trash2}
                                                                label="Ištrinti šabloną"
                                                                variant="danger"
                                                                onClick={() => handleDeleteTemplate(t.id, t.templateName)}
                                                            />
                                                        </>
                                                    ) : (
                                                        // A shared template the user can't edit — they can only HIDE it from
                                                        // their own list (reversible; it stays for everyone else).
                                                        <IconButton
                                                            icon={EyeOff}
                                                            label="Paslėpti iš mano sąrašo"
                                                            variant="ghost"
                                                            onClick={() => handleHideTemplate(t.id)}
                                                        />
                                                    )}
                                                </li>
                                                );
                                            })}
                                        </ul>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </Modal>

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
