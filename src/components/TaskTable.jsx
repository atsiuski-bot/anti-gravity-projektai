import React, { useState } from 'react';
import clsx from 'clsx';
import { db } from '../firebase';
import { doc, updateDoc } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { Link as LinkIcon, MessageCircle, FileText, CheckCircle2 } from 'lucide-react';
import { LinksModal, CommentsModal, DescriptionModal } from './TaskDetailsModals';

export default function TaskTable({ tasks, onEdit, role }) {
    const { currentUser } = useAuth();
    const [expandedComments, setExpandedComments] = useState({});
    const [activeModal, setActiveModal] = useState({ type: null, taskId: null }); // { type: 'description'|'links'|'comments', taskId: string }

    const priorityColors = {
        Low: 'bg-green-100 text-green-800',
        Medium: 'bg-yellow-100 text-yellow-800',
        High: 'bg-orange-100 text-orange-800',
        Urgent: 'bg-red-100 text-red-800'
    };

    const priorityLabels = {
        Low: 'Žemas',
        Medium: 'Vidutinis',
        High: 'Aukštas',
        Urgent: 'Skubus'
    };

    const statusColors = {
        'pending': 'bg-white text-gray-800 border border-gray-200',
        'in-progress': 'bg-white text-gray-800 border border-gray-200',
        'completed': 'bg-gray-200 text-gray-800',
        'confirmed': 'bg-green-100 text-gray-800'
    };

    const statusLabels = {
        'pending': 'Nepradėtas',
        'in-progress': 'Pradėtas',
        'completed': 'Užbaigtas, nepriduotas',
        'confirmed': 'Užbaigtas, priduotas'
    };

    const handleToggleComplete = async (taskId, currentStatus) => {
        try {
            const taskRef = doc(db, 'tasks', taskId);
            await updateDoc(taskRef, {
                completed: !currentStatus,
                completedAt: !currentStatus ? new Date().toISOString() : null,
                completedBy: !currentStatus ? currentUser.uid : null,
                updatedAt: new Date().toISOString()
            });
        } catch (err) {
            console.error("Error toggling task completion:", err);
        }
    };

    const handleConfirmTask = async (taskId) => {
        try {
            const taskRef = doc(db, 'tasks', taskId);
            await updateDoc(taskRef, {
                status: 'confirmed',
                confirmedBy: currentUser.uid,
                confirmedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            });
        } catch (err) {
            console.error("Error confirming task:", err);
        }
    };

    const getStatusStyle = (task) => {
        const status = task.status || 'pending';
        if (status === 'confirmed') return 'bg-green-50';
        if (status === 'completed') return 'bg-gray-100';
        return 'bg-white';
    };

    const toggleComments = (taskId) => {
        setExpandedComments(prev => ({
            ...prev,
            [taskId]: !prev[taskId]
        }));
    };

    const isWorker = role === 'worker';

    return (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                        ))}
        </tbody>
                </table >
            </div >
        {/* Modals */ }
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
                    />
                </>
            );
        })()
    }
        </div >
    );
}
