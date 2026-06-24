import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Zap, Check, PencilLine } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useUndescribedQuickWork } from '../hooks/useUndescribedQuickWork';
import { addQuickWorkDescription } from '../utils/sessionActions';
import { formatMinutesToTimeString } from '../utils/timeUtils';
import { logError } from '../utils/errorLog';
import Modal from './ui/Modal';
import Button from './ui/Button';

// Recorded clock time of an auto-stopped entry, e.g. "14:32". Empty string if unparseable.
function formatCompletedTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('lt-LT', { hour: '2-digit', minute: '2-digit', hour12: false });
}

// The describe dialog. Memoized + uncontrolled textarea (defaultValue + ref) so typing never
// re-renders the parent's live task subscription. Mirrors the live QuickWorkTimer modal copy.
const DescribeModal = React.memo(function DescribeModal({ task, onSubmit, onClose, isSubmitting }) {
    const textareaRef = useRef(null);
    const minutes = task?.manualMinutes || 0;

    const handleSubmit = (e) => {
        e.preventDefault();
        const value = textareaRef.current?.value || '';
        if (value.trim()) onSubmit(value);
    };

    return (
        <Modal open onClose={onClose} title="Greito darbo aprašymas" size="md" initialFocusRef={textareaRef}>
            <form onSubmit={handleSubmit} className="flex flex-col">
                <p className="text-body text-ink-muted mb-4 flex items-start gap-2">
                    <Zap className="w-5 h-5 text-session-quickWork-accent fill-current shrink-0 mt-0.5" aria-hidden="true" />
                    Ši greito darbo sesija buvo užbaigta kitame įrenginyje, todėl liko be aprašymo.
                    Aprašykite, ką nuveikėte.
                </p>

                <div className="mb-5 bg-session-quickWork-surface rounded-card p-4 border border-session-quickWork-soft flex items-center justify-between">
                    <span className="text-session-quickWork-accent font-semibold text-body-lg">Užfiksuotas laikas:</span>
                    <span className="text-4xl font-mono font-bold text-session-quickWork-accent">
                        {formatMinutesToTimeString(minutes)}
                    </span>
                </div>

                <div>
                    <label htmlFor="describeQuickWorkTextarea" className="block text-caption font-bold text-ink mb-2 uppercase tracking-wide">
                        Ką nuveikėte?
                    </label>
                    <textarea
                        ref={textareaRef}
                        id="describeQuickWorkTextarea"
                        name="taskDescription"
                        defaultValue=""
                        placeholder="Trumpai aprašykite atliktą darbą..."
                        rows={4}
                        className="w-full p-3 text-body-lg text-left border-2 border-line rounded-card bg-surface-card text-ink-strong resize-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                        required
                    />
                </div>

                <div className="mt-6 flex gap-3 justify-end">
                    <Button type="button" variant="secondary" onClick={onClose}>
                        Praleisti
                    </Button>
                    <Button type="submit" variant="primary" loading={isSubmitting} icon={Check}>
                        {isSubmitting ? 'Saugoma...' : 'Išsaugoti'}
                    </Button>
                </div>
            </form>
        </Modal>
    );
});

/**
 * Retroactive-description surface for quick-work sessions that ended remotely.
 *
 * Implements the "both" trigger model: on each app entry it auto-opens the describe dialog
 * once for the most recent undescribed entry (the "prompt on return"), and it always renders
 * a calm, persistent banner listing every undescribed entry with its own "Aprašyti" button —
 * so a skip is never a dead end and a worker with several can clear them one by one.
 *
 * The bold whole-screen session red is reserved for an ACTIVE session; this is a reminder, not
 * a live state, so the banner stays on a calm card with only a quick-work accent strip + icon.
 */
export default function QuickWorkDescribePrompt() {
    const { currentUser } = useAuth();
    const items = useUndescribedQuickWork(currentUser);

    const [activeTask, setActiveTask] = useState(null);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState('');

    // Auto-open once per mount for the newest entry — this is the "prompt on return". A ref (not
    // state) gates it so it fires a single time, not on every snapshot; the persistent banner
    // covers the rest, so skipping the dialog never loses the chance to describe later.
    const autoOpenedRef = useRef(false);
    useEffect(() => {
        if (autoOpenedRef.current || items.length === 0) return;
        autoOpenedRef.current = true;
        setActiveTask(items[0]);
    }, [items]);

    const handleSubmit = useCallback(async (text) => {
        if (!activeTask) return;
        setIsSubmitting(true);
        setError('');
        try {
            await addQuickWorkDescription(activeTask, text);
            setActiveTask(null);
        } catch (err) {
            logError(err, { source: 'QuickWorkDescribePrompt.submit', taskId: activeTask?.id });
            setError('Nepavyko išsaugoti aprašymo. Bandykite dar kartą.');
        } finally {
            setIsSubmitting(false);
        }
    }, [activeTask]);

    if (items.length === 0) return null;

    return (
        <section
            aria-label="Neaprašytos greito darbo sesijos"
            className="mb-4 rounded-card border border-line border-l-4 border-l-session-quickWork-accent bg-surface-card p-4 shadow-sm"
        >
            <div className="flex items-start gap-3">
                <Zap className="h-5 w-5 shrink-0 text-session-quickWork-accent fill-current mt-0.5" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                    <h2 className="text-body-lg font-bold text-ink-strong">
                        Neaprašytos greito darbo sesijos ({items.length})
                    </h2>
                    <p className="text-caption text-ink-muted mt-0.5">
                        Šios sesijos buvo užbaigtos kitame įrenginyje. Pridėkite, ką nuveikėte, kad jos
                        nebūtų rodomos kaip „automatiškai išsaugotos“.
                    </p>

                    <ul className="mt-3 space-y-2">
                        {items.map((task) => {
                            const recordedAt = formatCompletedTime(task.completedAt);
                            return (
                                <li
                                    key={task.id}
                                    className="flex items-center justify-between gap-3 rounded-control border border-line bg-surface-sunken p-3"
                                >
                                    <span className="min-w-0 text-body text-ink">
                                        <span className="font-mono font-semibold text-ink-strong">
                                            {formatMinutesToTimeString(task.manualMinutes || 0)}
                                        </span>
                                        {recordedAt && <span className="text-ink-muted"> · {recordedAt}</span>}
                                    </span>
                                    <Button
                                        variant="primary"
                                        icon={PencilLine}
                                        onClick={() => { setError(''); setActiveTask(task); }}
                                    >
                                        Aprašyti
                                    </Button>
                                </li>
                            );
                        })}
                    </ul>

                    {error && (
                        <p className="mt-2 text-caption text-feedback-danger" role="alert">{error}</p>
                    )}
                </div>
            </div>

            {activeTask && (
                <DescribeModal
                    key={activeTask.id}
                    task={activeTask}
                    onSubmit={handleSubmit}
                    onClose={() => setActiveTask(null)}
                    isSubmitting={isSubmitting}
                />
            )}
        </section>
    );
}
