import React, { useState } from 'react';
import { X } from 'lucide-react';
import { db } from '../firebase';
import { doc, updateDoc } from 'firebase/firestore';

export function InlineEditModal({ isOpen, onClose, task, field, label }) {
    const [value, setValue] = useState('');
    const [dayValue, setDayValue] = useState('');

    React.useEffect(() => {
        if (isOpen) {
            if (field === 'dayOfWeek') {
                setDayValue(task[field] || 'Nepriskirta');
            } else {
                setValue(task[field] || '');
            }
        }
    }, [isOpen, task, field]);

    if (!isOpen) return null;

    const handleSave = async () => {
        try {
            const updates = {
                [field]: field === 'dayOfWeek' ? dayValue : value,
                updatedAt: new Date().toISOString()
            };

            await updateDoc(doc(db, 'tasks', task.id), updates);
            onClose();
        } catch (error) {
            console.error('Error updating field:', error);
        }
    };

    const dayOptions = [
        'Nepriskirta',
        'Pirmadienis',
        'Antradienis',
        'Trečiadienis',
        'Ketvirtadienis',
        'Penktadienis',
        'Šeštadienis',
        'Sekmadienis'
    ];

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
            <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
                <div className="flex justify-between items-center mb-4">
                    <h3 className="text-lg font-semibold">{label}</h3>
                    <button onClick={onClose} className="text-gray-500 hover:text-gray-700">
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {field === 'dayOfWeek' ? (
                    <select
                        value={dayValue}
                        onChange={(e) => setDayValue(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                        autoFocus
                    >
                        {dayOptions.map(day => (
                            <option key={day} value={day}>{day}</option>
                        ))}
                    </select>
                ) : field === 'description' ? (
                    <textarea
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        rows={4}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                        autoFocus
                    />
                ) : (
                    <input
                        type="text"
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                        autoFocus
                    />
                )}

                <div className="flex gap-3 mt-4">
                    <button
                        onClick={onClose}
                        className="flex-1 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200"
                    >
                        Atšaukti
                    </button>
                    <button
                        onClick={handleSave}
                        className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                    >
                        Išsaugoti
                    </button>
                </div>
            </div>
        </div>
    );
}
