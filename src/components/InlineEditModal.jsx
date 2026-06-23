import React, { useState } from 'react';
import { db } from '../firebase';
import { doc, updateDoc } from 'firebase/firestore';
import Modal from './ui/Modal';
import Button from './ui/Button';
import Select from './ui/Select';

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

    const controlClass =
        'w-full px-3 py-2 text-body text-ink-strong bg-surface-card border border-line rounded-control ' +
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2';

    return (
        <Modal
            open={isOpen}
            onClose={onClose}
            title={label}
            size="md"
            footer={
                <div className="flex gap-3">
                    <Button variant="secondary" fullWidth onClick={onClose}>
                        Atšaukti
                    </Button>
                    <Button variant="primary" fullWidth onClick={handleSave}>
                        Išsaugoti
                    </Button>
                </div>
            }
        >
            {field === 'dayOfWeek' ? (
                <Select
                    value={dayValue}
                    onChange={setDayValue}
                    options={dayOptions.map((day) => ({ value: day, label: day }))}
                    label={label}
                    ariaLabel={label}
                    alwaysSheet
                />
            ) : field === 'description' ? (
                <textarea
                    aria-label={label}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    rows={4}
                    className={controlClass}
                    autoFocus
                />
            ) : (
                <input
                    type="text"
                    aria-label={label}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    className={controlClass}
                    autoFocus
                />
            )}
        </Modal>
    );
}
