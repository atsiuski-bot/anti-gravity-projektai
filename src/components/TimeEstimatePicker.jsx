import { useState, useEffect } from 'react';
import { Check } from 'lucide-react';
import Modal from './ui/Modal';
import Button from './ui/Button';
import { parseTimeStringToMinutes } from '../utils/timeUtils';

// The full estimated-time scale offered in the picker popup, ordered shortest → longest. The
// comma is the decimal separator the parser expects ("1,5h" → 90 min, "7,5h" → 450 min). This is
// the single source of truth for the popup; the four one-tap chips on the form spine
// (15min/30min/1h/2h) are a deliberate quick-access subset, defined in TaskModal.
const TIME_PICKER_OPTIONS = [
    '15min', '30min', '45min', '1h', '1,5h', '2h', '3h', '4h',
    '5h', '7,5h', '10h', '12,5h', '15h', '20h',
];

/**
 * TimeEstimatePicker — the "+" popup behind the planned-time chips. A scrollable grid of the full
 * duration scale plus a free-text "Įvesti savo" field for anything off-scale. Routed through the
 * canonical Modal (§8): centred sheet, focus-trap, Escape/backdrop dismissal, top stacking level
 * (it opens from inside the already-open TaskModal). Selecting any value closes the popup.
 *
 * @param {boolean} open
 * @param {string} value - the currently chosen estimate (highlighted if it is in the scale).
 * @param {(value: string) => void} onSelect - called with the chosen duration string.
 * @param {() => void} onClose
 */
export default function TimeEstimatePicker({ open, value, onSelect, onClose }) {
    const [custom, setCustom] = useState('');

    // Clear the custom field whenever the popup (re)opens so a stale entry never lingers.
    useEffect(() => {
        if (open) setCustom('');
    }, [open]);

    if (!open) return null;

    const pick = (t) => { onSelect(t); onClose(); };

    const customValid = parseTimeStringToMinutes(custom) > 0;
    const confirmCustom = () => {
        if (!customValid) return;
        pick(custom.trim());
    };

    return (
        <Modal open onClose={onClose} title="Planuojamas laikas" size="sm" level="top">
            <div className="flex flex-wrap gap-2" role="group" aria-label="Planuojamas laikas">
                {TIME_PICKER_OPTIONS.map((t) => {
                    const active = value === t;
                    return (
                        <button
                            key={t}
                            type="button"
                            onClick={() => pick(t)}
                            aria-pressed={active}
                            className={`inline-flex min-h-touch items-center gap-1 rounded-full border px-4 text-base transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${active ? 'border-brand bg-brand/10 font-medium text-brand' : 'border-line text-ink hover:bg-surface-sunken'}`}
                        >
                            {active && <Check className="h-4 w-4" aria-hidden="true" />}
                            {t}
                        </button>
                    );
                })}
            </div>

            <div className="mt-4 border-t border-line pt-4">
                <label htmlFor="custom-estimated-time" className="mb-1 block text-body font-medium text-ink">
                    Įvesti savo
                </label>
                <div className="flex items-stretch gap-2">
                    <input
                        id="custom-estimated-time"
                        type="text"
                        value={custom}
                        onChange={(e) => setCustom(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); confirmCustom(); } }}
                        placeholder="pvz. 6h arba 90min"
                        aria-label="Įvesti savo planuojamą laiką"
                        className="flex-1 rounded-lg border border-line px-3 py-3 text-base focus:ring-2 focus:ring-brand"
                    />
                    <Button type="button" variant="primary" disabled={!customValid} onClick={confirmCustom}>
                        Pasirinkti
                    </Button>
                </div>
                <p className="mt-1 text-caption text-ink-muted">Formatai: 30min, 1h, 1,5h, 2h 30min</p>
            </div>
        </Modal>
    );
}
