import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Zap, Check, PencilLine, Mic } from 'lucide-react';
import clsx from 'clsx';
import { useAuth } from '../context/AuthContext';
import { useUsers } from '../context/UsersContext';
import { useUndescribedQuickWork } from '../hooks/useUndescribedQuickWork';
import { useSpeechDictation } from '../hooks/useSpeechDictation';
import { addQuickWorkDescription } from '../utils/sessionActions';
import { formatMinutesToTimeString } from '../utils/timeUtils';
import { formatDisplayName } from '../utils/formatters';
import {
    buildTemplateOptions,
    resolveQuickWorkEntry,
    canSubmitQuickWork,
} from '../utils/quickWorkTemplates';
import { logError } from '../utils/errorLog';
import Modal from './ui/Modal';
import Button from './ui/Button';
import IconButton from './ui/IconButton';
import PersonSelect from './ui/PersonSelect';

// Recorded clock time of an auto-stopped entry, e.g. "14:32". Empty string if unparseable.
function formatCompletedTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('lt-LT', { hour: '2-digit', minute: '2-digit', hour12: false });
}

// The describe dialog. Mirrors the live QuickWorkTimer finish modal so the worker meets the SAME
// surface whether they describe now or later: a template picker (label becomes the title; the box
// turns into an optional comment) over an uncontrolled textarea (ref-driven, so typing never
// re-renders the parent's live task subscription). The manager picker and "defer" path are absent
// here — the routing was already chosen when the session was logged; this step only adds a title.
const DescribeModal = React.memo(function DescribeModal({ task, onSubmit, onClose, isSubmitting, templateOptions = [], roster = [] }) {
    const textareaRef = useRef(null);
    const minutes = task?.manualMinutes || 0;

    // Which quick-work TEMPLATE (category) is chosen — its label becomes the title and the textarea
    // turns into an optional comment. null = free-write mode (textarea IS the title).
    const [selectedTemplateId, setSelectedTemplateId] = useState(null);
    const [helpUserId, setHelpUserId] = useState('');
    // Track only WHETHER the textarea has text (cheap), keeping the field uncontrolled so the
    // dictation hook can write el.value directly (its dispatched 'input' event keeps this in sync).
    const [hasText, setHasText] = useState(false);
    const { supported: dictationSupported, isListening, toggle: toggleDictation } = useSpeechDictation(textareaRef);

    const selectedTemplate = templateOptions.find((o) => o.id === selectedTemplateId) || null;
    const isHelp = selectedTemplate?.kind === 'help';
    const textIsComment = !!selectedTemplate;

    const canSubmit = canSubmitQuickWork({ template: selectedTemplate, helpUserId, text: hasText ? 'x' : '' });

    const handleSubmit = (e) => {
        e.preventDefault();
        const helpName = isHelp
            ? formatDisplayName(roster.find((u) => u.id === helpUserId)?.displayName || roster.find((u) => u.id === helpUserId)?.email || '')
            : '';
        const { title, comment } = resolveQuickWorkEntry({
            template: selectedTemplate,
            helpName,
            text: textareaRef.current?.value || '',
        });
        if (!title) return;
        onSubmit(title, comment);
    };

    return (
        <Modal open onClose={onClose} title="Greitos veiklos aprašymas" size="md" initialFocusRef={textareaRef}>
            <form onSubmit={handleSubmit} className="flex flex-col">
                <p className="text-body text-ink-muted mb-4 flex items-start gap-2">
                    <Zap className="w-5 h-5 text-session-quickWork-accent fill-current shrink-0 mt-0.5" aria-hidden="true" />
                    Ši greitos veiklos sesija buvo užbaigta kitame įrenginyje, todėl liko be aprašymo.
                    Pasirinkite šabloną arba įrašykite, ką nuveikėte.
                </p>

                <div className="mb-5 bg-session-quickWork-surface rounded-card p-4 border border-session-quickWork-soft flex items-center justify-between">
                    <span className="text-session-quickWork-accent font-semibold text-body-lg">Užfiksuotas laikas:</span>
                    <span className="text-4xl font-mono font-bold text-session-quickWork-accent">
                        {formatMinutesToTimeString(minutes)}
                    </span>
                </div>

                {/* Template (category) picker — built-ins + this worker's own profile templates.
                    Single-select: tapping the active one again clears it (back to free-write). */}
                <div className="mb-4">
                    <span id="describeTemplateLabel" className="block text-caption font-bold text-ink mb-2 uppercase tracking-wide">
                        Greito darbo šablonas
                    </span>
                    <div role="radiogroup" aria-labelledby="describeTemplateLabel" className="grid grid-cols-2 gap-2">
                        {templateOptions.map((opt) => {
                            const selected = opt.id === selectedTemplateId;
                            return (
                                <button
                                    key={opt.id}
                                    type="button"
                                    role="radio"
                                    aria-checked={selected}
                                    onClick={() => setSelectedTemplateId(selected ? null : opt.id)}
                                    className={clsx(
                                        'flex min-h-touch flex-col items-start justify-center gap-0.5 rounded-card border px-3 py-2 text-left transition-colors',
                                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2',
                                        selected
                                            ? 'border-brand bg-brand-soft text-ink-strong'
                                            : 'border-line bg-surface-card text-ink hover:bg-surface-sunken'
                                    )}
                                >
                                    <span className="flex items-center gap-1.5 text-body font-medium">
                                        {selected && <Check className="h-4 w-4 text-brand shrink-0" aria-hidden="true" />}
                                        {opt.label}
                                    </span>
                                    {opt.hint && (
                                        <span className="text-caption text-ink-muted">{opt.hint}</span>
                                    )}
                                </button>
                            );
                        })}
                    </div>
                </div>

                {/* "Pagalba" expands a full-roster member picker; the title becomes "Pagalba: <vardas>". */}
                {isHelp && (
                    <div className="mb-4">
                        <PersonSelect
                            value={helpUserId}
                            onChange={setHelpUserId}
                            users={roster}
                            label="Kuriam nariui padėjote?"
                            placeholder="Pasirinkite narį"
                        />
                    </div>
                )}

                <div>
                    <label htmlFor="describeQuickWorkTextarea" className="block text-caption font-bold text-ink mb-2 uppercase tracking-wide">
                        {textIsComment ? 'Komentaras (nebūtinas)' : 'Ką nuveikėte?'}
                    </label>
                    <div className="relative">
                        <textarea
                            ref={textareaRef}
                            id="describeQuickWorkTextarea"
                            name="taskDescription"
                            defaultValue=""
                            onInput={(e) => setHasText(e.currentTarget.value.trim().length > 0)}
                            placeholder={textIsComment ? 'Papildoma informacija (nebūtina)...' : 'Trumpai aprašykite atliktą veiklą...'}
                            rows={textIsComment ? 2 : 4}
                            className="w-full text-body-lg text-left border-2 border-line rounded-card bg-surface-card text-ink-strong resize-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                            style={{ padding: dictationSupported ? '12px 12px 52px 12px' : '12px' }}
                        />
                        {/* Voice dictation — feature-detected; hidden where the Web Speech API is
                            absent. Listening state is color + label + filled/outline mic glyph (§5). */}
                        {dictationSupported && (
                            <IconButton
                                icon={Mic}
                                label={isListening ? 'Stabdyti diktavimą' : 'Diktuoti balsu'}
                                variant={isListening ? 'danger-solid' : 'default'}
                                aria-pressed={isListening}
                                onClick={toggleDictation}
                                className={clsx('absolute bottom-2 right-2', isListening && 'wz-pulse-soft')}
                            />
                        )}
                    </div>
                    {isListening && (
                        <p className="mt-2 text-caption text-feedback-danger" role="status">
                            Klausomasi… kalbėkite, tekstas atsiras laukelyje.
                        </p>
                    )}
                </div>

                <div className="mt-6 flex gap-3 justify-end">
                    <Button type="button" variant="secondary" onClick={onClose}>
                        Praleisti
                    </Button>
                    <Button type="submit" variant="primary" loading={isSubmitting} icon={Check} disabled={!canSubmit}>
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
    const { currentUser, userData } = useAuth();
    const { activeUsers } = useUsers();
    const items = useUndescribedQuickWork(currentUser);

    // Same template set + roster the live finish modal uses, so describing later offers the
    // identical choices (built-in categories + this worker's own profile templates).
    const templateOptions = useMemo(() => buildTemplateOptions(userData?.quickWorkTemplates), [userData?.quickWorkTemplates]);
    const roster = useMemo(() => (activeUsers || [])
        .filter((u) => u.id !== currentUser?.uid)
        .map((u) => ({ id: u.id, displayName: u.displayName, email: u.email, photoURL: u.photoURL })),
    [activeUsers, currentUser?.uid]);

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

    const handleSubmit = useCallback(async (title, comment) => {
        if (!activeTask) return;
        setIsSubmitting(true);
        setError('');
        try {
            await addQuickWorkDescription(activeTask, { title, comment });
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
            aria-label="Neaprašytos greitos veiklos sesijos"
            className="mb-4 rounded-card border border-line border-l-4 border-l-session-quickWork-accent bg-surface-card p-4 shadow-sm"
        >
            <div className="flex items-start gap-3">
                <Zap className="h-5 w-5 shrink-0 text-session-quickWork-accent fill-current mt-0.5" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                    <h2 className="text-body-lg font-bold text-ink-strong">
                        Neaprašytos greitos veiklos sesijos ({items.length})
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
                    templateOptions={templateOptions}
                    roster={roster}
                />
            )}
        </section>
    );
}
