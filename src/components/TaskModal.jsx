import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { db, storage } from '../firebase';
import { ref, uploadBytes, uploadBytesResumable, getDownloadURL } from 'firebase/storage';
import { doc, updateDoc, addDoc, collection, getDocs, query, where } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { X, Plus, Trash2, ExternalLink } from 'lucide-react';
import { formatDisplayName } from '../utils/formatters';
import { saveTaskTemplate, getTaskTemplates } from '../utils/taskActions';
import { getPriorityOptions, normalizePriority, DEFAULT_PRIORITY } from '../utils/priority';
import { compressImage } from '../utils/imageUtils';

export default function TaskModal({ isOpen, onClose, task, role }) {
    const { currentUser, userRole } = useAuth();
    const [loading, setLoading] = useState(false);
    const [workers, setWorkers] = useState([]);

    const [formData, setFormData] = useState({
        title: '',
        assignedWorkerId: '',
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
    const [uploadProgress, setUploadProgress] = useState(0);

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
        assignedWorkerId: false,
        managerId: false,
        deadline: false
    });

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
                assignedWorkerId: task.assignedWorkerId || '',
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
            setFormData({
                title: '',
                assignedWorkerId: role === 'worker' ? currentUser.uid : '',
                managerId: currentUser.uid,
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
        }
        setSelectedFiles([]);
        fetchWorkers();
    }, [task, role, currentUser]);

    useEffect(() => {
        if (role === 'manager' || role === 'admin') {
            fetchTemplates();
        }
    }, [role, isOpen]);

    const fetchTemplates = async () => {
        try {
            console.log("Fetching templates for role:", role);
            const temps = await getTaskTemplates();
            console.log("Fetched templates:", temps);
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
        setTemplateName('');
        // Reset fields to default or current form state? Let's just default to all true except sensitive ones
        setSelectedTemplateFields({
            title: !!formData.title,
            priority: true,
            estimatedTime: !!formData.estimatedTime,
            description: !!formData.description,
            tag: !!formData.tag,
            links: formData.links.length > 0,
            assignedWorkerId: !!formData.assignedWorkerId,
            managerId: !!formData.managerId,
            deadline: !!formData.deadline
        });
    };

    const handleConfirmSaveTemplate = async () => {
        if (!templateName.trim()) {
            alert("Prašome įvesti šablono pavadinimą!");
            return;
        }
        setLoading(true);
        try {
            const dataToSave = {};
            // Copy only selected fields
            Object.keys(selectedTemplateFields).forEach(key => {
                if (selectedTemplateFields[key]) {
                    dataToSave[key] = formData[key];
                }
            });

            await saveTaskTemplate(templateName, dataToSave, currentUser);
            alert("Šablonas sėkmingai išsaugotas!");
            await fetchTemplates();
            setIsSavingTemplate(false);
        } catch (error) {
            console.error("Failed to save template", error);
            alert("Klaida saugant šabloną: " + error.message);
        } finally {
            setLoading(false);
        }
    };

    // Helper to trigger template load from footer
    const handleFooterTemplateSelect = (e) => {
        handleLoadTemplate(e.target.value);
    };

    async function fetchWorkers() {
        try {
            console.log("Fetching workers...");
            const q = query(collection(db, 'users'));
            const snapshot = await getDocs(q);
            const workersData = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            })).filter(w => !w.isDisabled);
            console.log("Fetched workers:", workersData.length, workersData);
            setWorkers(workersData);
        } catch (error) {
            console.error("Error fetching workers:", error);
            alert("Klaida gaunant darbuotojų sąrašą: " + error.message);
        }
    }

    const handleFileSelect = (e) => {
        const files = Array.from(e.target.files);
        const currentCount = (formData.attachmentUrls?.length || 0) + selectedFiles.length + files.length;

        if (currentCount > 8) {
            alert(`Maksimalus nuotraukų kiekis: 8. Jūs jau turite ${formData.attachmentUrls?.length + selectedFiles.length}, bandote pridėti ${files.length}.`);
            return;
        }

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
            const storageRef = ref(storage, `attachments/${fileId}_${file.name}`);
            const metadata = { contentType: file.type };
            const uploadTask = uploadBytesResumable(storageRef, file, metadata);

            uploadTask.on('state_changed',
                (snapshot) => {
                    const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
                    console.log(`Upload ${file.name} is ${progress}% done`);
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
                        console.log('File available at', downloadURL);
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
                console.log(`Starting compression and upload for ${selectedFiles.length} files...`);

                // Compress files first
                const compressionPromises = selectedFiles.map(file => compressImage(file));
                const compressedFiles = await Promise.all(compressionPromises);

                // Then upload compressed files
                const uploadPromises = compressedFiles.map(file => uploadFile(file));
                const newUrls = await Promise.all(uploadPromises);

                currentAttachmentUrls = [...currentAttachmentUrls, ...newUrls];
            }

            console.log("Saving task data...");
            // Keep the first URL as 'attachmentUrl' for backward compatibility, if any
            const primaryAttachmentUrl = currentAttachmentUrls.length > 0 ? currentAttachmentUrls[0] : '';

            const taskData = {
                ...formData,
                attachmentUrl: primaryAttachmentUrl,
                attachmentUrls: currentAttachmentUrls,
                managerName: selectedManager ? (selectedManager.displayName || selectedManager.email) : '',
                updatedAt: new Date().toISOString()
            };

            // Status Logic for New Tasks
            if (!task) {
                // Determine if user is a manager/admin based on Context OR Prop
                const isManagerOrAdmin = userRole === 'manager' || userRole === 'admin' || role === 'manager' || role === 'admin';
                const isSelfAssigned = formData.assignedWorkerId === currentUser.uid;

                console.log('Task Creation Status Check:', {
                    userRole, role, isManagerOrAdmin, isSelfAssigned,
                    currentId: currentUser.uid, assignedId: formData.assignedWorkerId
                });

                // If NOT a manager (so, a worker) and assigning to SELF -> unapproved
                if (!isManagerOrAdmin && isSelfAssigned) {
                    taskData.status = 'unapproved';
                    console.log('SETTING STATUS TO UNAPPROVED');
                }
            }


            if (task) {
                await updateDoc(doc(db, 'tasks', task.id), taskData);
            } else {
                await addDoc(collection(db, 'tasks'), {
                    ...taskData,
                    createdAt: new Date().toISOString(),
                    createdBy: currentUser.uid,
                    creatorName: currentUser.displayName || currentUser.email
                });
            }
            console.log("Task saved successfully");
            onClose();
        } catch (error) {
            console.error("Error saving task:", error);
            alert("Klaida: " + error.message);
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

    const isManager = role === 'manager' || role === 'admin' || userRole === 'manager' || userRole === 'admin';
    const isCreator = String(task?.createdBy) === String(currentUser?.uid);

    // Filter to only allow Managers, Admins, and the current user (so they can assign to themselves).
    // This excludes other 'regular' workers.

    return createPortal(
        <div className="fixed inset-0 z-[100] flex items-start justify-center bg-black bg-opacity-50 p-4 pt-10 pb-20 overflow-y-auto">
            <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl flex flex-col my-auto relative">
                {/* Header - Fixed */}
                <div className="flex justify-between items-center p-6 border-b border-gray-200 flex-shrink-0">
                    <h2 className="text-xl font-bold text-gray-900">
                        {isSavingTemplate ? 'Išsaugoti šabloną' : (task ? 'Redaguoti užduotį' : 'Sukurti užduotį')}
                    </h2>
                    <div className="flex items-center gap-2">
                        {!isSavingTemplate && !task && (role === 'manager' || role === 'admin') && templates.length > 0 && (
                            <select
                                onChange={(e) => handleLoadTemplate(e.target.value)}
                                className="mr-2 px-3 py-1 border border-gray-300 rounded-lg text-sm"
                                value=""
                            >
                                <option value="">Užkrauti šabloną...</option>
                                <option value="" disabled>Šablonai</option>
                                {templates.map(t => (
                                    <option key={t.id} value={t.id}>{t.templateName}</option>
                                ))}
                            </select>
                        )}
                        <button onClick={onClose} className="text-gray-500 hover:text-gray-700">
                            <X className="w-6 h-6" />
                        </button>
                    </div>
                </div>

                {/* Scrollable Content */}
                <div className="flex-1 overflow-y-auto p-6">
                    {isSavingTemplate ? (
                        <div className="space-y-6">
                            <div>
                                <input
                                    type="text"
                                    value={templateName}
                                    onChange={(e) => setTemplateName(e.target.value)}
                                    placeholder="Šablono pavadinimas"
                                    className="w-full px-3 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                                />
                            </div>
                            <div>
                                <h4 className="font-medium mb-3">Pasirinkite laukus, kuriuos išsaugoti:</h4>
                                <div className="grid grid-cols-2 gap-3">
                                    {Object.keys(selectedTemplateFields).map(key => (
                                        <label key={key} className="flex items-center gap-2 p-2 border rounded hover:bg-gray-50 cursor-pointer">
                                            <input
                                                type="checkbox"
                                                checked={selectedTemplateFields[key]}
                                                onChange={(e) => setSelectedTemplateFields(prev => ({ ...prev, [key]: e.target.checked }))}
                                                className="w-4 h-4 text-blue-600 rounded"
                                            />
                                            <span className="capitalize">{
                                                key === 'assignedWorkerId' ? 'Priskirtas darbuotojas' :
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
                                <input
                                    type="text"
                                    value={formData.title}
                                    onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                                    disabled={!isManager && !!task && !isCreator}
                                    placeholder="Pavadinimas"
                                    className="w-full px-3 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100 text-base"
                                    required
                                />

                                {/* Select: Priority */}
                                <select
                                    value={formData.priority}
                                    onChange={(e) => setFormData({ ...formData, priority: e.target.value })}
                                    disabled={!isManager && !!task && !isCreator}
                                    className="w-full px-3 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 text-base mt-4"
                                >
                                    {getPriorityOptions().map(p => (
                                        <option key={p.id} value={p.id}>
                                            {p.label}
                                        </option>
                                    ))}
                                </select>

                                {/* Input: Deadline */}
                                <input
                                    type={formData.deadline ? "date" : "text"}
                                    value={formData.deadline}
                                    onChange={(e) => setFormData({ ...formData, deadline: e.target.value })}
                                    onFocus={(e) => e.target.type = 'date'}
                                    onBlur={(e) => !e.target.value && (e.target.type = 'text')}
                                    placeholder="Atlikti iki"
                                    disabled={!isManager && !!task && !isCreator}
                                    className="w-full px-3 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 text-base mt-4"
                                />

                                {/* Select: Estimated Time */}
                                <select
                                    value={formData.estimatedTime}
                                    onChange={(e) => setFormData({ ...formData, estimatedTime: e.target.value })}
                                    disabled={!isManager && !!task && !isCreator}
                                    className="w-full px-3 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 text-base mt-4"
                                >
                                    <option value="">Planuojamas laikas...</option>
                                    <option value="15 min">15 min</option>
                                    <option value="30 min">30 min</option>
                                    <option value="45 min">45 min</option>
                                    <option value="1 val">1 val</option>
                                    <option value="1.5 val">1.5 val</option>
                                    <option value="2 val">2 val</option>
                                    <option value="3 val">3 val</option>
                                    <option value="4 val">4 val</option>
                                    <option value="5 val">5 val</option>
                                    <option value="6 val">6 val</option>
                                    <option value="7 val">7 val</option>
                                    <option value="8 val">8 val</option>
                                </select>

                                <select
                                    value={formData.managerId}
                                    onChange={(e) => setFormData({ ...formData, managerId: e.target.value })}
                                    disabled={(!isManager && !isCreator) && !!task}
                                    className="w-full px-3 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 text-base mt-4"
                                >
                                    <option value="">Priskirti vadovą...</option>
                                    {managers.map(manager => (
                                        <option key={manager.id} value={manager.id}>
                                            {formatDisplayName(manager.displayName || manager.email)}
                                        </option>
                                    ))}
                                </select>

                                {/* Select: Assigned Worker */}
                                <select
                                    value={formData.assignedWorkerId}
                                    onChange={(e) => setFormData({ ...formData, assignedWorkerId: e.target.value })}
                                    disabled={!isManager}
                                    className="w-full px-3 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 text-base mt-4"
                                >
                                    <option value="">Priskirti darbuotoją...</option>
                                    {workers.map(worker => (
                                        <option key={worker.id} value={worker.id}>
                                            {formatDisplayName(worker.displayName || worker.email)}
                                        </option>
                                    ))}
                                </select>

                                {/* Textarea: Description */}
                                <textarea
                                    value={formData.description}
                                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                                    disabled={!isManager && !!task}
                                    rows={3}
                                    placeholder="Užduoties aprašymas..."
                                    className="w-full px-3 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 text-base mt-4"
                                />

                                {/* Input: New Link (Manager) */}
                                <div className="flex gap-2 mt-4">
                                    <input
                                        type="url"
                                        value={newLink}
                                        onChange={(e) => setNewLink(e.target.value)}
                                        placeholder="https://..."
                                        inputMode="url"
                                        className="flex-1 px-3 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-base"
                                        onKeyPress={(e) => e.key === 'Enter' && (e.preventDefault(), addLink())}
                                    />
                                    <button
                                        type="button"
                                        onClick={addLink}
                                        className="px-4 py-2 bg-blue-50 text-blue-600 rounded-lg hover:bg-blue-100 font-medium"
                                    >
                                        <Plus className="w-5 h-5" />
                                    </button>
                                </div>

                                {formData.links.length > 0 && (
                                    <div className="mt-2 space-y-2">
                                        {formData.links.map((link, index) => (
                                            <div key={index} className="flex items-center justify-between bg-gray-50 p-2 rounded-lg">
                                                <a href={link} target="_blank" rel="noopener noreferrer" className="text-sm text-blue-600 truncate hover:underline flex-1 mr-2">
                                                    {link}
                                                </a>
                                                <button
                                                    type="button"
                                                    onClick={() => removeLink(index)}
                                                    className="text-gray-400 hover:text-red-500"
                                                >
                                                    <Trash2 className="w-4 h-4" />
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                )}

                                {/* Select: Tag */}
                                <select
                                    value={formData.tag || ''}
                                    onChange={(e) => setFormData({ ...formData, tag: e.target.value })}
                                    disabled={!isManager && !!task}
                                    className="w-full px-3 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 text-base mt-4"
                                >
                                    <option value="">Pasirinkti žymą...</option>
                                    {['Auto', 'Renginiams', 'Piro'].map(tag => (
                                        <option key={tag} value={tag}>{tag}</option>
                                    ))}
                                </select>

                                {/* File Upload */}
                                <div className="mt-4">
                                    <label className="block w-full px-3 py-3 border border-gray-300 border-dashed rounded-lg text-center cursor-pointer hover:bg-gray-50 text-gray-500">
                                        <span className="text-base text-gray-500">Prisegti nuotraukas (Maks. 8)</span>
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
                                                        className="absolute top-1 right-1 bg-white rounded-full p-1 text-red-500 shadow opacity-0 group-hover:opacity-100 transition-opacity"
                                                    >
                                                        <Trash2 className="w-4 h-4" />
                                                    </button>
                                                </div>
                                            ))}
                                        </div>
                                    )}

                                    {/* Display Selected (Proposed) Attachments */}
                                    {selectedFiles.length > 0 && (
                                        <div className="mt-4">
                                            <p className="text-xs font-semibold text-gray-500 mb-2">Naujai pasirinktos:</p>
                                            <div className="space-y-2">
                                                {selectedFiles.map((file, index) => (
                                                    <div key={`selected-${index}`} className="flex items-center justify-between text-sm text-gray-700 bg-gray-50 p-2 rounded">
                                                        <span className="truncate max-w-[80%]">{file.name}</span>
                                                        <button
                                                            type="button"
                                                            onClick={() => removeSelectedFile(index)}
                                                            className="text-gray-400 hover:text-red-500"
                                                        >
                                                            <X className="w-4 h-4" />
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
                                        className="flex-1 px-3 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-base"
                                    />
                                    <button type="button" onClick={addComment} className="bg-blue-50 text-blue-600 px-4 rounded-lg hover:bg-blue-100 font-medium whitespace-nowrap">
                                        Skelbti
                                    </button>
                                </div>
                            </div>

                            {/* Timestamps - Read Only */}
                            {
                                task && (
                                    <div className="text-xs text-gray-400 border-t border-gray-100 pt-4 flex flex-col gap-1">
                                        <p>Sukurta: {new Date(task.createdAt).toLocaleString()}</p>
                                        {task.updatedAt && <p>Atnaujinta: {new Date(task.updatedAt).toLocaleString()}</p>}
                                        {task.id && <p className="font-mono text-[10px]">ID: {task.id}</p>}
                                    </div>
                                )
                            }
                        </form>
                    )}
                </div>

                {/* Footer - Fixed */}
                <div className="flex justify-end gap-3 p-4 border-t border-gray-200 flex-shrink-0 bg-gray-50 rounded-b-xl">
                    {isSavingTemplate ? (
                        <>
                            <button
                                type="button"
                                onClick={() => setIsSavingTemplate(false)}
                                className="px-4 py-2 text-gray-700 hover:bg-gray-200 rounded-lg transition-colors"
                            >
                                Atšaukti
                            </button>
                            <button
                                type="button"
                                onClick={handleConfirmSaveTemplate}
                                disabled={loading}
                                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
                            >
                                Išsaugoti šabloną
                            </button>
                        </>
                    ) : (
                        <>
                            <>
                                <div className="flex-1 flex items-center justify-start gap-2">
                                    {!task && (role === 'manager' || role === 'admin') && (
                                        <button
                                            type="button"
                                            onClick={handleSaveTemplateClick}
                                            className="text-xs text-blue-600 hover:text-blue-800 hover:underline transition-colors text-left"
                                            title="Išsaugoti kaip šabloną"
                                        >
                                            Išsaugoti kaip šabloną
                                        </button>
                                    )}

                                    {!task && (role === 'manager' || role === 'admin') && templates.length > 0 && (
                                        <div className="relative">
                                            <select
                                                onChange={handleFooterTemplateSelect}
                                                className="appearance-none bg-indigo-50 text-indigo-700 px-2 py-1 rounded text-xs hover:bg-indigo-100 transition-colors cursor-pointer pr-6 font-medium border border-indigo-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                                                value=""
                                            >
                                                <option value="" disabled>Šablonai</option>
                                                {templates.map(t => (
                                                    <option key={t.id} value={t.id}>{t.templateName}</option>
                                                ))}
                                            </select>
                                            <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-1 text-indigo-700">
                                                <svg className="fill-current h-3 w-3" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z" /></svg>
                                            </div>
                                        </div>
                                    )}
                                </div>

                                <button
                                    type="button"
                                    onClick={onClose}
                                    className="px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-200 rounded-lg transition-colors border border-gray-300"
                                >
                                    Atšaukti
                                </button>
                                <button
                                    type="submit"
                                    form="task-form"
                                    disabled={loading}
                                    className="px-3 py-1.5 text-xs font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 min-w-[80px]"
                                >
                                    {loading ? (selectedFiles.length > 0 ? 'Keliama...' : 'Saugoma...') : 'Išsaugoti'}
                                </button>
                            </>
                        </>
                    )}
                </div>
            </div>
        </div>,
        document.body
    );
}
