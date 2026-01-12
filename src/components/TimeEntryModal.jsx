import React, { useState } from 'react';
import { Check } from 'lucide-react';

export default function TimeEntryModal({ isOpen, onClose, onSubmit, direction }) {
    const [time, setTime] = useState('');

    if (!isOpen) return null;

    const handleSubmit = () => {
        if (direction === 'right' && !time) return; // Mandatory for finish
        onSubmit(time || '');
        setTime('');
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
            <div className="bg-white rounded-xl shadow-xl max-w-sm w-full p-6" onClick={(e) => e.stopPropagation()}>
                <h3 className="text-lg font-semibold text-gray-900 mb-4">
                    {direction === 'right' ? 'Pažymėti kaip užbaigtą' : 'Pažymėti kaip pradėtą'}
                </h3>
                <p className="text-sm text-gray-600 mb-4">
                    {direction === 'right'
                        ? 'Įveskite faktinį laiką (privaloma):'
                        : 'Jei darbas jau buvo pradėtas anksčiau, galite įvesti laiką, praleistą prie darbo iki dabar.'}
                </p>

                <select
                    value={time}
                    onChange={(e) => setTime(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 mb-4"
                    autoFocus
                >
                    <option value="">Pasirinkite {direction === 'right' ? '(privaloma)' : '(nebūtina)'}...</option>
                    <option value="15m">15 min</option>
                    <option value="30m">30 min</option>
                    <option value="45m">45 min</option>
                    <option value="1h">1 val</option>
                    <option value="1h 15m">1 val 15 min</option>
                    <option value="1h 30m">1 val 30 min</option>
                    <option value="1h 45m">1 val 45 min</option>
                    <option value="2h">2 val</option>
                    <option value="2h 30m">2 val 30 min</option>
                    <option value="3h">3 val</option>
                    <option value="4h">4 val</option>
                    <option value="5h">5 val</option>
                    <option value="6h">6 val</option>
                    <option value="7h">7 val</option>
                    <option value="8h">8 val</option>
                </select>

                <div className="flex gap-3">
                    <button
                        onClick={onClose}
                        className="flex-1 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200"
                    >
                        Atšaukti
                    </button>
                    <button
                        onClick={handleSubmit}
                        disabled={direction === 'right' && !time}
                        className={`flex-1 px-4 py-2 text-white rounded-lg flex items-center justify-center gap-2 ${direction === 'right' && !time
                                ? 'bg-blue-300 cursor-not-allowed'
                                : 'bg-blue-600 hover:bg-blue-700'
                            }`}
                    >
                        <Check className="w-4 h-4" />
                        Patvirtinti
                    </button>
                </div>
            </div>
        </div>
    );
}
