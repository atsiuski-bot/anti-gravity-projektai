import React, { useState, useEffect } from 'react';
import { db } from '../firebase';
import { doc, updateDoc, addDoc, collection, getDocs, query, where } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { X, Plus, Trash2, ExternalLink } from 'lucide-react';

export default function TaskModal({ isOpen, onClose, task, role }) {
    const { currentUser } = useAuth();
    const [loading, setLoading] = useState(false);
    const [workers, setWorkers] = useState([]);

    const [formData, setFormData] = useState({
        title: '',
        assignedWorkerId: '',
        priority: 'Medium',
        estimatedTime: '',
        actualTime: '',
        description: '',
        links: [],
        status: 'Todo',
        comments: [],
        dayOfWeek: 'Nepriskirta',
        completed: false
    });

    const [newLink, setNewLink] = useState('');
    const [newComment, setNewComment] = useState('');

    useEffect(() => {
        if (task) {
            setFormData({
                title: task.title || '',
                assignedWorkerId: task.assignedWorkerId || '',
                priority: task.priority || 'Medium',
                estimatedTime: task.estimatedTime || '',
                actualTime: task.actualTime || '',
                description: task.description || '',
                links: task.links || [],
                status: task.status || 'Todo',
                comments: task.comments || [],
                dayOfWeek: task.dayOfWeek || 'Nepriskirta',
                completed: task.completed || false
            });
        } else {
            // Reset for new task
            setFormData({
                title: '',
                assignedWorkerId: '',
                priority: 'Medium',
                estimatedTime: '',
                actualTime: '',
                description: '',
                links: [],
                status: 'Todo',
                comments: [],
                dayOfWeek: 'Nepriskirta',
                completed: false
            });
        }

        fetchWorkers();
    }, [task, role]);

    async function fetchWorkers() {
        const q = query(collection(db, 'users'));
        const snapshot = await getDocs(q);
        const workersData = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));
        setWorkers(workersData);
    }

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);

        try {
            const taskData = {
                ...formData,
                updatedAt: new Date().toISOString()
            };

            if (task) {
                await updateDoc(doc(db, 'tasks', task.id), taskData);
            } else {
                await addDoc(collection(db, 'tasks'), {
                    ...taskData,
                    createdAt: new Date().toISOString(),
                    createdBy: currentUser.uid
                });
            }
            onClose();
        } catch (error) {
            console.error("Error saving task:", error);
        } finally {
            setLoading(false);
        }
    };

    const addLink = () => {
        if (newLink) {
            setFormData(prev => ({ ...prev, links: [...prev.links, newLink] }));
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

    const isManager = role === 'manager' || role === 'admin';

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4 overflow-y-auto">
            <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
                <div className="flex justify-between items-center p-6 border-b border-gray-200 sticky top-0 bg-white z-10">
                    <h2 className="text-xl font-bold text-gray-900">
                        {task ? 'Redaguoti užduotį' : 'Sukurti užduotį'}
                    </h2>
                    <button onClick={onClose} className="text-gray-500 hover:text-gray-700">
                        <X className="w-6 h-6" />
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="p-6 space-y-6">
                    {/* Title - Manager Only Edit */}
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Pavadinimas</label>
                        <input
                            type="text"
                            value={formData.title}
                            onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                            disabled={!isManager}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100"
                            required
                        />
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        {/* Priority - Manager Only Edit */}
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Prioritetas</label>
                            <select
                                value={formData.priority}
                                onChange={(e) => setFormData({ ...formData, priority: e.target.value })}
                                disabled={!isManager}
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
                            >
                                <option value="Low">Žemas</option>
                                <option value="Medium">Vidutinis</option>
                                <option value="High">Aukštas</option>
                                <option value="Urgent">Skubus</option>
                            </select>
                        </div>

                        {/* Status - Both Edit */}
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Būsena</label>
                            <select
                                value={formData.status}
                                onChange={(e) => setFormData({ ...formData, status: e.target.value })}
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                            >
                                <option value="Todo">Atlikti</option>
                                <option value="In Progress">Vykdoma</option>
                                <option value="Done">Atlikta</option>
                            </select>
                        </div>

                        {/* Day of Week - Manager Only, REQUIRED */}
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                                Savaitės diena <span className="text-red-500">*</span>
                            </label>
                            <select
                                value={formData.dayOfWeek}
                                onChange={(e) => setFormData({ ...formData, dayOfWeek: e.target.value })}
                                disabled={!isManager}
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
                                required
                            >
                                <option value="Nepriskirta">Nepriskirta</option>
                                <option value="Pirmadienis">Pirmadienis</option>
                                <option value="Antradienis">Antradienis</option>
                                <option value="Trečiadienis">Trečiadienis</option>
                                <option value="Ketvirtadienis">Ketvirtadienis</option>
                                <option value="Penktadienis">Penktadienis</option>
                                <option value="Šeštadienis">Šeštadienis</option>
                                <option value="Sekmadienis">Sekmadienis</option>
                            </select>
                        </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        {/* Estimated Time - Manager Only */}
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Numatomas laikas</label>
                            <select
                                value={formData.estimatedTime}
                                onChange={(e) => setFormData({ ...formData, estimatedTime: e.target.value })}
                                disabled={!isManager}
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
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
                                <option value="2h 15m">2 val 15 min</option>
                                <option value="2h 30m">2 val 30 min</option>
                                <option value="2h 45m">2 val 45 min</option>
                                <option value="3h">3 val</option>
                                <option value="3h 15m">3 val 15 min</option>
                                <option value="3h 30m">3 val 30 min</option>
                                <option value="3h 45m">3 val 45 min</option>
                                <option value="4h">4 val</option>
                                <option value="5h">5 val</option>
                                <option value="6h">6 val</option>
                                <option value="7h">7 val</option>
                                <option value="8h">8 val</option>
                                <option value="9h">9 val</option>
                                <option value="10h">10 val</option>
                                <option value="11h">11 val</option>
                                <option value="12h">12 val</option>
                                <option value="13h">13 val</option>
                                <option value="14h">14 val</option>
                                <option value="15h">15 val</option>
                                <option value="16h">16 val</option>
                                <option value="17h">17 val</option>
                                <option value="18h">18 val</option>
                                <option value="19h">19 val</option>
                                <option value="20h">20 val</option>
                            </select>
                        </div>

                        {/* Actual Time - Both Edit (Worker mostly) */}
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Faktinis laikas</label>
                            <select
                                value={formData.actualTime}
                                onChange={(e) => setFormData({ ...formData, actualTime: e.target.value })}
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
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
                                <option value="2h 15m">2 val 15 min</option>
                                <option value="2h 30m">2 val 30 min</option>
                                <option value="2h 45m">2 val 45 min</option>
                                <option value="3h">3 val</option>
                                <option value="3h 15m">3 val 15 min</option>
                                <option value="3h 30m">3 val 30 min</option>
                                <option value="3h 45m">3 val 45 min</option>
                                <option value="4h">4 val</option>
                                <option value="5h">5 val</option>
                                <option value="6h">6 val</option>
                                <option value="7h">7 val</option>
                                <option value="8h">8 val</option>
                            </select>
                        </div>
                    </div>

                    {/* Assigned Worker - Manager Only */}
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Priskirtas darbuotojas</label>
                        <select
                            value={formData.assignedWorkerId}
                            onChange={(e) => setFormData({ ...formData, assignedWorkerId: e.target.value })}
                            disabled={!isManager}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
                        >
                            <option value="">Nepriskirta</option>
                            {workers.map(worker => (
                                <option key={worker.id} value={worker.id}>
                                    {worker.displayName || worker.email}
                                </option>
                            ))}
                        </select>
                    </div>

                    {/* Description - Manager Only */}
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Aprašymas</label>
                        <textarea
                            value={formData.description}
                            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                            disabled={!isManager}
                            rows={3}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
                        />
                    </div>

                    {/* Links - Manager Only */}
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Nuorodos</label>
                        <div className="space-y-2 mb-2">
                            {formData.links.map((link, index) => (
                                <div key={index} className="flex items-center justify-between bg-gray-50 p-2 rounded">
                                    <a href={link} target="_blank" rel="noopener noreferrer" className="text-blue-600 truncate flex items-center gap-1">
                                        <ExternalLink className="w-3 h-3" />
                                        {link}
                                    </a>
                                    {isManager && (
                                        <button type="button" onClick={() => removeLink(index)} className="text-red-500 hover:text-red-700">
                                            <Trash2 className="w-4 h-4" />
                                        </button>
                                    )}
                                </div>
                            ))}
                        </div>
                        {isManager && (
                            <div className="flex gap-2">
                                <input
                                    type="url"
                                    value={newLink}
                                    onChange={(e) => setNewLink(e.target.value)}
                                    placeholder="https://..."
                                    className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                                />
                                <button type="button" onClick={addLink} className="bg-gray-100 px-4 rounded-lg hover:bg-gray-200">
                                    Pridėti
                                </button>
                            </div>
                        )}
                    </div>

                    {/* Comments - Both Edit */}
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Komentarai</label>
                        <div className="space-y-3 mb-3 max-h-40 overflow-y-auto">
                            {formData.comments.map((comment, index) => (
                                <div key={index} className="bg-gray-50 p-3 rounded-lg text-sm">
                                    <div className="flex justify-between text-xs text-gray-500 mb-1">
                                        <span className="font-medium text-gray-900">{comment.user}</span>
                                        <span>{new Date(comment.createdAt).toLocaleString()}</span>
                                    </div>
                                    <p className="text-gray-700">{comment.text}</p>
                                </div>
                            ))}
                        </div>
                        <div className="flex gap-2">
                            <input
                                type="text"
                                value={newComment}
                                onChange={(e) => setNewComment(e.target.value)}
                                placeholder="Rašyti komentarą..."
                                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                            />
                            <button type="button" onClick={addComment} className="bg-blue-50 text-blue-600 px-4 rounded-lg hover:bg-blue-100 font-medium">
                                Skelbti
                            </button>
                        </div>
                    </div>

                    {/* Timestamps - Read Only */}
                    {task && (
                        <div className="text-xs text-gray-400 border-t border-gray-100 pt-4 flex flex-col gap-1">
                            <p>Sukurta: {new Date(task.createdAt).toLocaleString()}</p>
                            {task.updatedAt && <p>Atnaujinta: {new Date(task.updatedAt).toLocaleString()}</p>}
                            {task.id && <p className="font-mono text-[10px]">ID: {task.id}</p>}
                        </div>
                    )}

                    <div className="flex justify-end gap-3 pt-4 border-t border-gray-200">
                        <button
                            type="button"
                            onClick={onClose}
                            className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
                        >
                            Atšaukti
                        </button>
                        <button
                            type="submit"
                            disabled={loading}
                            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
                        >
                            {loading ? 'Saugoma...' : 'Išsaugoti'}
                        </button>
                    </div>
                </form>
            </div >
        </div >
    );
}
