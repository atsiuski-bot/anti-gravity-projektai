import React, { useState, useRef, useCallback, useMemo } from 'react';
import { useActiveSessionStatus, getInterruptionReason } from '../hooks/useActiveSessionStatus';
import { useTimerState } from '../hooks/useTimerState';
import { useSpeechDictation } from '../hooks/useSpeechDictation';
import { Zap, Square, Check, ShieldAlert, Mic, Clock } from 'lucide-react';
import { formatMinutesToTimeString, getLithuanianNow, clampSessionMinutes, MIN_LOGGED_SESSION_MINUTES } from '../utils/timeUtils';
import { formatDisplayName, isManagerRole } from '../utils/formatters';
import {
    buildTemplateOptions,
    resolveQuickWorkEntry,
    canSubmitQuickWork,
} from '../utils/quickWorkTemplates';
import clsx from 'clsx';
import { useAuth } from '../context/AuthContext';
import { useUsers } from '../context/UsersContext';
import { SoundManager } from '../utils/soundUtils';
import { startSession, endSession } from '../utils/sessionActions';
import Button from './ui/Button';
import IconButton from './ui/IconButton';
import Modal from './ui/Modal';
import PersonSelect from './ui/PersonSelect';
import SessionToggleButton from './ui/SessionToggleButton';

// Separate memoized modal component to prevent re-renders from timer updates
const QuickWorkModalComponent = React.memo(({ onSubmit, onClose, onDefer, currentSessionMinutes, isSubmitting, managers = [], defaultManagerId = '', templateOptions = [], roster = [] }) => {
    const textareaRef = useRef(null);
    // Which manager confirms this work. Primary pre-selected so the common case is one tap;
    // the worker can switch before saving. Initialized once — by the time the prompt opens the
    // roster and the worker's team are already loaded.
    const [selectedManagerId, setSelectedManagerId] = useState(defaultManagerId || managers[0]?.id || '');
    // Which quick-work TEMPLATE (category) is chosen — its label becomes the title and the textarea
    // turns into an optional comment. null = free-write mode (textarea IS the title). `helpUserId`
    // is only meaningful for the 'help' template (Pagalba: <member>).
    const [selectedTemplateId, setSelectedTemplateId] = useState(null);
    const [helpUserId, setHelpUserId] = useState('');
    // Track only WHETHER the textarea has text (cheap), so "Patvirtinti" can enable/disable without
    // making the field controlled — which would fight the dictation hook that writes el.value
    // directly (it dispatches an 'input' event, so onInput keeps this flag in sync).
    const [hasText, setHasText] = useState(false);
    const totalDisplay = formatMinutesToTimeString(currentSessionMinutes);
    const { supported: dictationSupported, isListening, toggle: toggleDictation } = useSpeechDictation(textareaRef);

    const selectedTemplate = templateOptions.find((o) => o.id === selectedTemplateId) || null;
    const isHelp = selectedTemplate?.kind === 'help';
    // With a template chosen the box is a comment; otherwise it's the title itself.
    const textIsComment = !!selectedTemplate;

    // The manager who will confirm this work, whether it's named now or deferred. Mirrors the
    // type-now resolution so the routing (and the single-manager default) survives a defer.
    const resolvedAuditorId = managers.length
        ? (selectedManagerId || defaultManagerId || managers[0]?.id || null)
        : null;

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
        onSubmit(title, resolvedAuditorId, comment);
    };

    // "Vėliau aprašysiu": log the quick work now with no title. It still routes to the same
    // manager, so the deferred row lands in their queue and surfaces in the worker's
    // "describe later" banner for naming.
    const handleDefer = () => onDefer(resolvedAuditorId);

    return (
        <Modal
            open
            onClose={onClose}
            title="Greitos veiklos pabaiga"
            size="md"
            initialFocusRef={textareaRef}
        >
            <form onSubmit={handleSubmit} className="flex flex-col">
                <p className="text-body text-ink-muted mb-4 flex items-center gap-2">
                    <Zap className="w-5 h-5 text-session-quickWork-accent fill-current shrink-0" aria-hidden="true" />
                    Pasirinkite šabloną arba įrašykite, ką nuveikėte
                </p>

                <div className="mb-5 bg-session-quickWork-surface rounded-card p-4 border border-session-quickWork-soft flex items-center justify-between">
                    <span className="text-session-quickWork-accent font-semibold text-body-lg">Užfiksuotas laikas:</span>
                    <span className="text-4xl font-mono font-bold text-session-quickWork-accent">{totalDisplay}</span>
                </div>

                {/* Template (category) picker — built-ins + this worker's own profile templates.
                    Single-select: tapping the active one again clears it (back to free-write). A
                    selected template becomes the title; the textarea below then acts as a comment. */}
                <div className="mb-4">
                    <span id="quickWorkTemplateLabel" className="block text-caption font-bold text-ink mb-2 uppercase tracking-wide">
                        Greito darbo šablonas
                    </span>
                    <div role="radiogroup" aria-labelledby="quickWorkTemplateLabel" className="grid grid-cols-2 gap-2">
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
                    <label htmlFor="quickWorkTextarea" className="block text-caption font-bold text-ink mb-2 uppercase tracking-wide">
                        {textIsComment ? 'Komentaras (nebūtinas)' : 'Ką nuveikėte?'}
                    </label>

                    <div className="relative">
                        <textarea
                            ref={textareaRef}
                            id="quickWorkTextarea"
                            name="taskDescription"
                            onInput={(e) => setHasText(e.currentTarget.value.trim().length > 0)}
                            placeholder={textIsComment ? 'Papildoma informacija (nebūtina)...' : 'Trumpai aprašykite atliktą veiklą...'}
                            rows={textIsComment ? 2 : 4}
                            className="border-2 border-line rounded-card bg-surface-card text-ink-strong"
                            style={{
                                width: '100%',
                                // Reserve room at the bottom-right so dictated text never slides under the mic.
                                padding: dictationSupported ? '12px 12px 52px 12px' : '12px',
                                fontSize: '16px',
                                resize: 'none',
                                direction: 'ltr',
                                textAlign: 'left'
                            }}
                        />
                        {/* Voice dictation — feature-detected; hidden where the Web Speech API is
                            absent. Listening state is signalled by color AND a label change AND the
                            filled/outline mic glyph, so color is never the sole cue (§5). */}
                        {dictationSupported && (
                            <IconButton
                                icon={Mic}
                                label={isListening ? 'Stabdyti diktavimą' : 'Diktuoti balsu'}
                                variant={isListening ? 'danger-solid' : 'default'}
                                aria-pressed={isListening}
                                onClick={toggleDictation}
                                className={clsx(
                                    'absolute bottom-2 right-2',
                                    isListening && 'wz-pulse-soft'
                                )}
                            />
                        )}
                    </div>
                    {isListening && (
                        <p className="mt-2 text-caption text-feedback-danger" role="status">
                            Klausomasi… kalbėkite, tekstas atsiras laukelyje.
                        </p>
                    )}
                </div>

                {/* Who confirms this work. Several managers → pills (single-select radio group,
                    primary pre-selected, per design: NOT a dropdown). Exactly one → a calm,
                    read-only line for transparency. None → nothing to choose. */}
                {managers.length >= 2 && (
                    <div className="mt-5">
                        <span id="quickWorkManagerLabel" className="block text-caption font-bold text-ink mb-2 uppercase tracking-wide">
                            Kuriam vadovui pateikti?
                        </span>
                        <div role="radiogroup" aria-labelledby="quickWorkManagerLabel" className="flex flex-wrap gap-2">
                            {managers.map((m) => {
                                const selected = m.id === selectedManagerId;
                                return (
                                    <button
                                        key={m.id}
                                        type="button"
                                        role="radio"
                                        aria-checked={selected}
                                        onClick={() => setSelectedManagerId(m.id)}
                                        className={clsx(
                                            'inline-flex min-h-touch items-center gap-2 rounded-full border px-4 text-body font-medium transition-colors',
                                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2',
                                            selected
                                                ? 'border-brand bg-brand/10 text-ink-strong'
                                                : 'border-line bg-surface-card text-ink-muted hover:bg-surface-sunken'
                                        )}
                                    >
                                        {selected && <Check className="h-4 w-4 text-brand" aria-hidden="true" />}
                                        {m.name}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                )}
                {managers.length === 1 && (
                    <p className="mt-5 text-caption text-ink-muted">
                        Bus pateikta tvirtinti: <span className="font-semibold text-ink">{managers[0].name}</span>
                    </p>
                )}

                <div className="mt-6 flex flex-col gap-2">
                    <div className="flex gap-3 justify-end">
                        <Button type="button" variant="secondary" onClick={onClose}>
                            Atšaukti
                        </Button>
                        <Button type="submit" variant="primary" loading={isSubmitting} icon={Check} disabled={!canSubmit}>
                            {isSubmitting ? 'Saugoma...' : 'Patvirtinti'}
                        </Button>
                    </div>
                    {/* Defer naming: log the work now without a description. The "describe later"
                        banner surfaces it for naming. Subordinate (ghost) so the type-now primary
                        stays dominant (§8). */}
                    <Button type="button" variant="ghost" icon={Clock} onClick={handleDefer} disabled={isSubmitting} className="self-end">
                        Vėliau aprašysiu
                    </Button>
                </div>
            </form>
        </Modal>
    );
});
QuickWorkModalComponent.displayName = 'QuickWorkModalComponent';

export default function QuickWorkTimer({ compact = false, hideLabel = false }) {
    const { currentUser, userData, setOptimisticUserData } = useAuth();
    const { usersMap, activeUsers } = useUsers();
    const { isSecondarySessionActive, activeSessionType } = useActiveSessionStatus();

    // Quick-work finish templates: the fixed categories plus THIS worker's own profile templates
    // (users/{uid}.quickWorkTemplates). Picking one becomes the session title; the box turns into a
    // comment. Built once per render from the live user doc.
    const templateOptions = useMemo(() => buildTemplateOptions(userData?.quickWorkTemplates), [userData?.quickWorkTemplates]);

    // Full active roster for the "Pagalba" member picker (any teammate the worker may have helped),
    // minus the worker themselves. Reduced to the {id, displayName, email, photoURL} PersonSelect needs.
    const roster = useMemo(() => (activeUsers || [])
        .filter((u) => u.id !== currentUser?.uid)
        .map((u) => ({ id: u.id, displayName: u.displayName, email: u.email, photoURL: u.photoURL })),
    [activeUsers, currentUser?.uid]);

    // The worker's managers, resolved to {id, name} for the finish prompt. Managers/admins
    // self-confirm their own quick work, so they get no picker (empty list). Source of truth is
    // the user's team (teamManagerIds), falling back to the single legacy defaultManager.
    const isManager = isManagerRole(userData?.role);
    const managers = useMemo(() => {
        if (isManager) return [];
        const ids = Array.isArray(userData?.teamManagerIds) && userData.teamManagerIds.length
            ? userData.teamManagerIds
            : (userData?.defaultManager ? [userData.defaultManager] : []);
        return ids
            .map((id) => usersMap?.[id])
            .filter((m) => m && !m.isDisabled)
            .map((m) => ({ id: m.id, name: formatDisplayName(m.displayName || m.email) || m.email }));
    }, [isManager, userData?.teamManagerIds, userData?.defaultManager, usersMap]);
    const defaultManagerId = useMemo(() => {
        if (userData?.defaultManager && managers.some((m) => m.id === userData.defaultManager)) {
            return userData.defaultManager;
        }
        return managers[0]?.id || '';
    }, [managers, userData?.defaultManager]);
    // useTimerState now handles generic 'quickWork' type
    const {
        isActive: isQuickWorking,
        currentSessionMinutes,
        startTime
    } = useTimerState(currentUser, 'quickWorkState', 'isQuickWorking', null, null, 'quickWork');

    // Quick work may be started ON TOP of an active break (the break nests as pausedSession and
    // resumes when the quick work ends) — mirroring how a call is allowed during a break. Any
    // OTHER secondary session (a call) still blocks it.
    const isDisabled = isSecondarySessionActive && !isQuickWorking && activeSessionType !== 'break';

    const [showTitleModal, setShowTitleModal] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState('');

    // Listen for external stop requests is still good,
    // but session actions handle this via endSession usually. 
    // However, for the MODAL, we need local state.
    // If the session is stopped remotely (e.g. by starting a task), isQuickWorking becomes false.
    // The previous logic used an event listener 'stop-quick-work'.
    // We should maintain that if we want to prompt for title.
    // BUT if the user starts a task elsewhere, we might just auto-save or discard.
    // Let's keep it simple: if session ends remotely, we might miss the title prompt.
    // That's acceptable for now (auto-save generic title).

    const handleStartQuickWork = async () => {
        if (!currentUser || isDisabled) return;
        setError('');
        try {
            // Optimistic UI Update: Instantly assume Quick Work started, clear other sessions.
            // Preserve whatever session was active (e.g. a break started first) as pausedSession so
            // the optimistic state matches what the server writes and the break can resume on finish.
            setOptimisticUserData({
                ...userData,
                activeSession: {
                    type: 'quickWork',
                    startTime: new Date().toISOString(),
                    pausedSession: userData?.activeSession || null
                },
                quickWorkState: { ...userData?.quickWorkState, isQuickWorking: true, lastStartedAt: new Date().toISOString() },
                breakState: { ...userData?.breakState, isTakingBreak: false },
                callState: { ...userData?.callState, isCalling: false },
                workStatus: { ...userData?.workStatus, isWorking: false, status: 'paused' }
            });

            await startSession(currentUser.uid, 'quickWork');
            SoundManager.playQuickTaskSound();
        } catch (err) {
            console.error("Error starting quick work:", err);
            setOptimisticUserData(null); // Revert on error
            setError("Nepavyko pradėti greitos veiklos. Bandykite dar kartą.");
        }
    };

    const handleStopQuickWork = async () => {
        // Here we just check duration and decide whether to show modal or stop immediately
        const now = getLithuanianNow();
        let sessionDuration = 0;
        if (startTime) {
            // Clamp so a backward clock skew can't make a real session read as negative.
            sessionDuration = clampSessionMinutes((now - startTime) / (1000 * 60));
        }

        // Discard an accidental sub-minute tap rather than prompting to name/log it.
        if (sessionDuration <= MIN_LOGGED_SESSION_MINUTES) {
            try {
                await endSession(currentUser.uid); // Auto discard/stop
            } catch (err) {
                // endSession now rethrows a failed critical write (so the described/finish paths can
                // revert their optimistic overlay). This discard path sets no optimistic state, but
                // still needs to handle the rejection rather than leave it unhandled.
                console.error('Error stopping quick work:', err);
                setError('Nepavyko sustabdyti greitos veiklos. Bandykite dar kartą.');
            }
            return;
        }

        SoundManager.playQuickTaskSound();
        setShowTitleModal(true);
    };

    // Shared end-of-quick-work flow. `taskTitle` carries the worker's description on the
    // type-now path; the defer path passes undefined so endSession logs the session WITHOUT a
    // customTitle — which makes handleLegacyLogging stamp it autoStopped:true + the placeholder
    // title, the exact record the "describe later" banner (QuickWorkDescribePrompt) surfaces for
    // retroactive naming. The confirming manager (auditorManagerId) is carried either way so the
    // single-manager default and routing survive a defer.
    const finishQuickWork = useCallback(async (taskTitle, auditorManagerId, comment) => {
        setIsSubmitting(true);
        setError('');
        try {
            // Optimistic UI Update: restore whatever this quick work interrupted. If it was started
            // on top of a break/call/task (pausedSession), that session resumes — so finishing a
            // quick work taken during a break drops the worker straight back into the break, with no
            // flash through an idle state. Falls back to the queued task (resumableTaskIds) when the
            // quick work was started from idle.
            const pausedSession = userData?.activeSession?.pausedSession;
            const pausedType = pausedSession?.type;
            const optimistic = { ...userData, quickWorkState: { ...userData?.quickWorkState, isQuickWorking: false } };

            if (pausedType === 'break') {
                optimistic.activeSession = pausedSession;
                optimistic.breakState = { ...userData?.breakState, isTakingBreak: true };
            } else if (pausedType === 'call') {
                optimistic.activeSession = pausedSession;
                optimistic.callState = { ...userData?.callState, isCalling: true };
            } else if (pausedType === 'task' && pausedSession?.taskId) {
                optimistic.activeSession = pausedSession;
                optimistic.workStatus = { isWorking: true, status: 'running', activeTaskId: pausedSession.taskId };
            } else {
                // Fallback: resume a queued task (quick work started from idle).
                const resumableTasks = userData?.quickWorkState?.resumableTaskIds || [];
                const activeTaskId = resumableTasks.length > 0 ? resumableTasks[0] : null;
                optimistic.activeSession = activeTaskId ? { type: 'task', startTime: new Date().toISOString(), taskId: activeTaskId } : null;
                optimistic.workStatus = activeTaskId ? { isWorking: true, status: 'running', activeTaskId } : userData?.workStatus;
            }

            setOptimisticUserData(optimistic);

            // End session with the chosen confirming manager (null if the worker has no managers;
            // endSession then leaves the auditor unset, today's behavior). A title is included
            // only on the type-now path — omitting it triggers the autoStopped log path.
            const overrides = { auditorManagerId: auditorManagerId || null };
            if (taskTitle) overrides.customTitle = taskTitle;
            // A comment only accompanies a template-titled entry (free-write text is the title
            // itself). It rides into the task description alongside the recorded time.
            if (comment) overrides.customComment = comment;
            await endSession(currentUser.uid, null, overrides);
            setShowTitleModal(false);
        } catch (err) {
            console.error("Error completing quick work:", err);
            setOptimisticUserData(null); // Revert on error
            setError("Nepavyko išsaugoti greitos veiklos. Bandykite dar kartą.");
        } finally {
            setIsSubmitting(false);
        }
    }, [currentUser, userData, setOptimisticUserData]);

    const handleCompleteQuickWork = useCallback((taskTitle, auditorManagerId, comment) => {
        if (!taskTitle || !taskTitle.trim()) return;
        return finishQuickWork(taskTitle.trim(), auditorManagerId, comment);
    }, [finishQuickWork]);

    // "Vėliau aprašysiu": log the quick work now with no title (deferred naming).
    const handleDeferQuickWork = useCallback((auditorManagerId) => finishQuickWork(undefined, auditorManagerId), [finishQuickWork]);

    // Render modal if showing
    const renderModal = showTitleModal && (
        <QuickWorkModalComponent
            onSubmit={handleCompleteQuickWork}
            onClose={() => setShowTitleModal(false)}
            onDefer={handleDeferQuickWork}
            currentSessionMinutes={currentSessionMinutes}
            isSubmitting={isSubmitting}
            managers={managers}
            defaultManagerId={defaultManagerId}
            templateOptions={templateOptions}
            roster={roster}
        />
    );

    // Render Compact (Mobile)
    if (compact) {
        return (
            <div className="flex flex-col items-center">
                {/* Live time is surfaced by ActiveSessionReadout above the bar, so the column
                    itself stays as short as button + label (no reserved readout row). */}
                <SessionToggleButton
                    session="quickWork"
                    variant="compact"
                    active={isQuickWorking}
                    disabled={isDisabled}
                    onClick={isQuickWorking ? handleStopQuickWork : handleStartQuickWork}
                    aria-label={isQuickWorking ? "Baigti greitą veiklą" : (isDisabled ? getInterruptionReason(activeSessionType) : "Greita veikla")}
                    title={isQuickWorking ? "Baigti greitą veiklą" : (isDisabled ? getInterruptionReason(activeSessionType) : "Greita veikla")}
                >
                    {isQuickWorking ? (
                        <Square className="w-5 h-5 fill-current" aria-hidden="true" />
                    ) : (
                        <Zap className="w-5 h-5 fill-current" aria-hidden="true" />
                    )}
                </SessionToggleButton>

                {/* Always-visible text label so color/icon is never the sole signal (WCAG 1.4.1).
                    Suppressed only in the collapsed side rail (`hideLabel`), where the icon SHAPE
                    differs by state and the button keeps its aria-label + title tooltip. */}
                {!hideLabel && (
                    <span className="mt-1 text-caption font-medium text-ink-muted leading-none">Greita</span>
                )}

                {error && (
                    <div className="mt-2 flex items-start gap-2 rounded-control border-l-4 border-feedback-danger bg-feedback-danger/10 p-2 wz-shake" role="alert">
                        <ShieldAlert className="h-4 w-4 shrink-0 text-feedback-danger" aria-hidden="true" />
                        <p className="text-caption text-feedback-danger">{error}</p>
                    </div>
                )}

                {renderModal}
            </div>
        );
    }

    // Render Desktop (Wide)
    return (
        <>
            <button
                onClick={isQuickWorking ? handleStopQuickWork : handleStartQuickWork}
                disabled={isDisabled}
                aria-label={isQuickWorking ? "Baigti greitą veiklą" : (isDisabled ? getInterruptionReason(activeSessionType) : "Pradėti greitą veiklą")}
                className={clsx(
                    "flex-1 flex items-center justify-between min-h-touch px-4 py-3 rounded-card transition-all shadow-sm active:scale-95 border min-w-[140px]",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2",
                    isDisabled ? "bg-surface-sunken text-ink-muted cursor-not-allowed border-line" :
                        isQuickWorking
                            ? 'bg-session-quickWork-surface border-session-quickWork-soft text-session-quickWork-accent ring-1 ring-session-quickWork-soft'
                            : 'bg-surface-card border-line text-ink hover:bg-surface-sunken hover:border-line'
                )}
                title={isDisabled ? getInterruptionReason(activeSessionType) : ""}
            >
                <div className="flex items-center gap-3">
                    <div className={clsx("rounded-control", isQuickWorking ? "text-session-quickWork-accent" : "text-ink-muted")}>
                        {isQuickWorking ? (
                            <Square className="w-5 h-5 fill-current" aria-hidden="true" />
                        ) : (
                            <Zap className="w-5 h-5 fill-current" aria-hidden="true" />
                        )}
                    </div>
                    <div className="flex flex-col items-start leading-tight">
                        <span className="text-caption font-bold uppercase tracking-wider text-ink-muted">Greita</span>
                        {isQuickWorking && <span className="text-caption font-semibold text-session-quickWork-accent">Vyksta...</span>}
                    </div>
                </div>
                <span className={clsx(
                    "text-lg font-mono font-bold ml-2",
                    isQuickWorking ? "text-session-quickWork-accent" : "text-ink-muted"
                )}>
                    {formatMinutesToTimeString(currentSessionMinutes)}
                </span>
            </button>

            {error && (
                <div className="mt-2 flex items-start gap-2 rounded-control border-l-4 border-feedback-danger bg-feedback-danger/10 p-3 wz-shake" role="alert">
                    <ShieldAlert className="h-5 w-5 shrink-0 text-feedback-danger" aria-hidden="true" />
                    <p className="text-body text-feedback-danger">{error}</p>
                </div>
            )}

            {renderModal}
        </>
    );
}
