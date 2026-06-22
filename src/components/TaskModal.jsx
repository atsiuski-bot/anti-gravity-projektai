import { useState, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { db, storage } from '../firebase';
import { ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage';
import { doc, updateDoc, addDoc, collection, getDoc } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { useUsers } from '../context/UsersContext';
import { X, Plus, Trash2, Clock } from 'lucide-react';
import { formatDisplayName, isManagerRole } from '../utils/formatters';
import { saveTaskTemplate, getTaskTemplates, updateTaskTemplate, deleteTaskTemplate } from '../utils/taskActions';
import { getPriorityOptions, normalizePriority, DEFAULT_PRIORITY } from '../utils/priority';
import { compressImage } from '../utils/imageUtils';
import { calculateCurrentTotalMinutes, formatMinutesToTimeString } from '../utils/timeUtils';
import { TASK_TAGS } from '../utils/taskUtils';
import Button from './ui/Button';
import IconButton from './ui/IconButton';
import ConfirmDialog from './ui/ConfirmDialog';
import { useModalA11y } from '../hooks/useModalA11y';

// Persistent field label — fields previously had only placeholders, which vanish on input
// and leave a picked <select> value meaningless (DESIGN_SYSTEM §8, audit per-screen).
const fieldLabel = 'mt-4 mb-1 block text-body font-medium text-ink';

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
        attachmentUrls: [] // New field for multiple attachments
    });

    const [newLink, setNewLink] = useState('');
    const [newComment, setNewComment] = useState('');
    const [selectedFiles, setSelectedFiles] = useState([]); // Changed to array
    const [, setUploadProgress] = useState(0);

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

    const managers = workers.filter(w => w.role === 'manager' || w.role === 'admin' || w.id === currentUser.uid);

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
                attachmentUrls: existingUrls
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
                    attachmentUrls: []
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

    const uploadFile = (file) => {
        return new Promise((resolve, reject) => {
            const fileId = `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
            // Store under a per-uploader folder so Storage rules can scope direct
            // SDK access (read/list/overwrite/delete) to the owner. Task viewers still
            // see the file via the tokenized download URL saved on the task document.
            const storageRef = ref(storage, `attachments/${currentUser.uid}/${fileId}_${file.name}`);
            const metadata = { contentType: file.type };
            const uploadTask = uploadBytesResumable(storageRef, file, metadata);

            uploadTask.on('state_changed',
                (_snapshot) => {
                    /* progress events intentionally ignored */
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

                // Then upload compressed files
                const uploadPromises = compressedFiles.map(file => uploadFile(file));
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
                
                await updateDoc(docRef, taskData);
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

    if (!isOpen) return null;

    const isManager = isManagerRole(role) || isManagerRole(userRole);

    // Filter to only allow Managers, Admins, and the current user (so they can assign to themselves).
    // This excludes other 'regular' workers.

    return createPortal(
        <div className="fixed inset-0 z-modal flex items-start justify-center bg-feedback-scrim p-4 pt-10 pb-20 overflow-y-auto">
            <div
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="task-modal-title"
                tabIndex={-1}
                className="bg-surface-card rounded-modal shadow-xl w-full max-w-2xl flex flex-col my-auto relative focus:outline-none"
            >
                {/* Header - Fixed */}
                <div className="flex justify-between items-center p-6 border-b border-line flex-shrink-0">
                    <h2 id="task-modal-title" className="text-xl font-bold text-ink-strong">
                        {isSavingTemplate ? 'Išsaugoti šabloną' : (task ? 'Redaguoti užduotį' : 'Sukurti užduotį')}
                    </h2>
                    <div className="flex items-center gap-2">
                        {!isSavingTemplate && !task && isManagerRole(role) && templates.length > 0 && (
                            <select
                                onChange={(e) => handleLoadTemplate(e.target.value)}
                                aria-label="Užkrauti šabloną"
                                className="mr-2 px-3 py-1 border border-line rounded-lg text-sm"
                                value=""
                            >
                                <option value="">Užkrauti šabloną...</option>
                                <option value="" disabled>Šablonai</option>
                                {sortedTemplates.map(t => (
                                    <option key={t.id} value={t.id}>{t.templateName}</option>
                                ))}
                            </select>
                        )}
                        <IconButton icon={X} label="Uždaryti" onClick={onClose} />
                    </div>
                </div>

                {/* Scrollable Content */}
                <div className="flex-1 overflow-y-auto p-6">
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
                                                key === 'assignedUserId' ? 'Priskirtas darbuotojas' :
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
                        <form id="task-form" onSubmit={handleSubmit} className="space-y-6">
                            {/* Title - Manager Only Edit OR Worker Creation */}
                            <div>
                                <span className="mb-1 block text-body font-medium text-ink">Pavadinimas</span>
                                <input
                                    type="text"
                                    value={formData.title}
                                    onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                                    disabled={!isManager && !!task}
                                    placeholder="Pavadinimas"
                                    aria-label="Pavadinimas"
                                    className="w-full px-3 py-3 border border-line rounded-lg focus:ring-2 focus:ring-brand focus:border-brand disabled:bg-surface-sunken text-base"
                                    required
                                />

                                <span className={fieldLabel}>Prioritetas</span>
                                <select
                                    value={formData.priority}
                                    onChange={(e) => setFormData({ ...formData, priority: e.target.value })}
                                    disabled={!isManager && !!task}
                                    aria-label="Prioritetas"
                                    className="w-full px-3 py-3 border border-line rounded-lg focus:ring-2 focus:ring-brand disabled:bg-surface-sunken text-base mt-4"
                                >
                                    {getPriorityOptions().map(p => (
                                        <option key={p.id} value={p.id}>
                                            {p.label}
                                        </option>
                                    ))}
                                </select>

                                <span className={fieldLabel}>Atlikti iki</span>
                                <input
                                    type={formData.deadline ? "date" : "text"}
                                    value={formData.deadline}
                                    onChange={(e) => setFormData({ ...formData, deadline: e.target.value })}
                                    onFocus={(e) => e.target.type = 'date'}
                                    aria-label="Atlikti iki"
                                    onBlur={(e) => !e.target.value && (e.target.type = 'text')}
                                    placeholder="Atlikti iki"
                                    disabled={!isManager && !!task}
                                    className="w-full px-3 py-3 border border-line rounded-lg focus:ring-2 focus:ring-brand disabled:bg-surface-sunken text-base mt-4"
                                />

                                <span className={fieldLabel}>Planuojamas laikas</span>
                                <select
                                    value={formData.estimatedTime}
                                    onChange={(e) => setFormData({ ...formData, estimatedTime: e.target.value })}
                                    disabled={!isManager && !!task}
                                    aria-label="Planuojamas laikas"
                                    className="w-full px-3 py-3 border border-line rounded-lg focus:ring-2 focus:ring-brand disabled:bg-surface-sunken text-base mt-4"
                                    required
                                >
                                    <option value="" disabled>Planuojamas laikas...</option>
                                    <option value="5min">5min</option>
                                    <option value="15min">15min</option>
                                    <option value="30min">30min</option>
                                    <option value="45min">45min</option>
                                    <option value="1h">1h</option>
                                    <option value="1,5h">1,5h</option>
                                    <option value="2h">2h</option>
                                    <option value="2,5h">2,5h</option>
                                    <option value="3h">3h</option>
                                    <option value="4h">4h</option>
                                    <option value="5h">5h</option>
                                    <option value="6h">6h</option>
                                    <option value="8h">8h</option>
                                    <option value="10h">10h</option>
                                    <option value="12h">12h</option>
                                    <option value="15h">15h</option>
                                    <option value="20h">20h</option>
                                    <option value="25h">25h</option>
                                    <option value="30h">30h</option>
                                    <option value="40h">40h</option>
                                    <option value="50h">50h</option>
                                    <option value="60h">60h</option>
                                    <option value="70h">70h</option>
                                    <option value="80h">80h</option>
                                    <option value="90h">90h</option>
                                    <option value="100h">100h</option>
                                    <option value="110h">110h</option>
                                    <option value="120h">120h</option>
                                    <option value="150h">150h</option>
                                    <option value="200h">200h</option>
                                </select>

                                <span className={fieldLabel}>Vadovas</span>
                                <select
                                    value={formData.managerId}
                                    onChange={(e) => setFormData({ ...formData, managerId: e.target.value })}
                                    disabled={!isManager && !!task}
                                    aria-label="Vadovas"
                                    className="w-full px-3 py-3 border border-line rounded-lg focus:ring-2 focus:ring-brand disabled:bg-surface-sunken text-base mt-4"
                                >
                                    <option value="">Priskirti vadovą...</option>
                                    {managers.map(manager => (
                                        <option key={manager.id} value={manager.id}>
                                            {formatDisplayName(manager.displayName || manager.email)}
                                        </option>
                                    ))}
                                </select>

                                <span className={fieldLabel}>Darbuotojas</span>
                                <select
                                    value={formData.assignedUserId}
                                    onChange={(e) => setFormData({ ...formData, assignedUserId: e.target.value })}
                                    disabled={!isManager}
                                    aria-label="Darbuotojas"
                                    className="w-full px-3 py-3 border border-line rounded-lg focus:ring-2 focus:ring-brand disabled:bg-surface-sunken text-base mt-4"
                                >
                                    <option value="">Priskirti darbuotoją...</option>
                                    {workers.map(worker => (
                                        <option key={worker.id} value={worker.id}>
                                            {formatDisplayName(worker.displayName || worker.email)}
                                        </option>
                                    ))}
                                </select>

                                <span className={fieldLabel}>Aprašymas</span>
                                <textarea
                                    value={formData.description}
                                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                                    disabled={!isManager && !!task}
                                    rows={3}
                                    placeholder="Užduoties aprašymas..."
                                    aria-label="Aprašymas"
                                    className="w-full px-3 py-3 border border-line rounded-lg focus:ring-2 focus:ring-brand disabled:bg-surface-sunken text-base mt-4"
                                />

                                {/* Input: New Link (Manager) */}
                                <div className="flex gap-2 mt-4">
                                    <input
                                        type="url"
                                        value={newLink}
                                        onChange={(e) => setNewLink(e.target.value)}
                                        placeholder="https://..."
                                        aria-label="Nuoroda"
                                        inputMode="url"
                                        className="flex-1 px-3 py-3 border border-line rounded-lg focus:ring-2 focus:ring-brand text-base"
                                        onKeyPress={(e) => e.key === 'Enter' && (e.preventDefault(), addLink())}
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
                                <select
                                    value={formData.tag || ''}
                                    onChange={(e) => setFormData({ ...formData, tag: e.target.value })}
                                    disabled={!isManager && !!task}
                                    aria-label="Žyma"
                                    className="w-full px-3 py-3 border border-line rounded-lg focus:ring-2 focus:ring-brand disabled:bg-surface-sunken text-base mt-4"
                                >
                                    <option value="">Pasirinkti žymą...</option>
                                    {TASK_TAGS.map(tag => (
                                        <option key={tag} value={tag}>{tag}</option>
                                    ))}
                                </select>

                                {/* File Upload */}
                                <div className="mt-4">
                                    <label className="block w-full px-3 py-3 border border-line border-dashed rounded-lg text-center cursor-pointer hover:bg-surface-sunken text-ink-muted">
                                        <span className="text-base text-ink-muted">Prisegti nuotraukas (Maks. 8)</span>
                                        <input
                                            type="file"
                                            accept="image/*"
                                            multiple // Allow multiple files
                                            onChange={handleFileSelect}
                                            className="hidden"
                                        />
                                    </label>

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

                                    {/* Display Selected (Proposed) Attachments */}
                                    {selectedFiles.length > 0 && (
                                        <div className="mt-4">
                                            <p className="text-xs font-semibold text-ink-muted mb-2">Naujai pasirinktos:</p>
                                            <div className="space-y-2">
                                                {selectedFiles.map((file, index) => (
                                                    <div key={`selected-${index}`} className="flex items-center justify-between text-sm text-ink bg-surface-sunken p-2 rounded">
                                                        <span className="truncate max-w-[80%]">{file.name}</span>
                                                        <button
                                                            type="button"
                                                            onClick={() => removeSelectedFile(index)}
                                                            aria-label="Pašalinti failą"
                                                            className="inline-flex items-center justify-center min-h-touch min-w-touch text-ink-muted hover:text-red-500 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                                                        >
                                                            <X className="w-4 h-4" aria-hidden="true" />
                                                        </button>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>

                                {/* Input: New Comment */}
                                <div className="flex gap-2 mt-4">
                                    <input
                                        type="text"
                                        value={newComment}
                                        onChange={(e) => setNewComment(e.target.value)}
                                        placeholder="Rašyti komentarą..."
                                        aria-label="Rašyti komentarą"
                                        className="flex-1 px-3 py-3 border border-line rounded-lg focus:ring-2 focus:ring-brand text-base"
                                    />
                                    <button type="button" onClick={addComment} className="min-h-touch bg-blue-50 text-blue-600 px-4 rounded-lg hover:bg-blue-100 font-medium whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2">
                                        Skelbti
                                    </button>
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
                                {loading ? (selectedFiles.length > 0 ? 'Keliama…' : 'Saugoma…') : 'Išsaugoti'}
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
