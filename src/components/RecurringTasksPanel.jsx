import { useState, useEffect, useCallback, useMemo } from 'react';
import { Repeat, Play, SkipForward, ChevronDown, Check, Pause } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useUsers } from '../context/UsersContext';
import {
    getTaskTemplates,
    setTemplateRecurrence,
    setTemplateAssignee,
    createManagerTask,
} from '../utils/taskActions';
import { runRecurringNow } from '../utils/recurringActions';
import { scopeRoster } from '../utils/teamScope';
import { formatDisplayName } from '../utils/formatters';
import {
    RECURRENCE_FREQS,
    WEEKDAYS,
    defaultRecurrence,
    describeRecurrence,
    nextOccurrence,
} from '../utils/recurrence';
import { cn } from '../utils/cn';
import Button from './ui/Button';
import Select from './ui/Select';
import { Spinner } from './ui/Loading';
import TaskModal from './TaskModal';

const MONTH_DAYS = Array.from({ length: 31 }, (_, i) => ({ value: String(i + 1), label: `${i + 1} d.` }));

// One template's recurrence editor + quick actions. Kept as a child so each row's draft/expander
// state is local and editing one row never re-renders the others.
function RecurringTemplateRow({ template, assignableUsers, currentUser, onChanged, onEdit }) {
    const baked = template.data?.assignedUserId || template.data?.assignedWorkerId || '';
    const recurrence = template.recurrence || null;
    const isRecurring = !!recurrence && recurrence.active !== false;

    const [expanded, setExpanded] = useState(false);
    const [saving, setSaving] = useState(false);
    const [busyAction, setBusyAction] = useState(''); // '', 'skip', 'run', 'pause'
    const [msg, setMsg] = useState(null); // { text, tone: 'ok' | 'err' }

    // Draft seeded from the stored recurrence (or a sensible default when first enabling).
    const [draft, setDraft] = useState(() => recurrence || defaultRecurrence());
    const [draftAssignee, setDraftAssignee] = useState(baked);

    const assigneeName = useMemo(() => {
        const u = assignableUsers.find((a) => a.value === baked);
        return u ? u.label : (baked ? 'Nežinomas' : '—');
    }, [assignableUsers, baked]);

    const openEditor = () => {
        setDraft(recurrence || defaultRecurrence());
        setDraftAssignee(baked);
        setMsg(null);
        setExpanded((v) => !v);
    };

    const toggleWeekday = (iso) => {
        setDraft((d) => {
            const cur = Array.isArray(d.byWeekday) ? d.byWeekday : [];
            const next = cur.includes(iso) ? cur.filter((x) => x !== iso) : [...cur, iso].sort((a, b) => a - b);
            return { ...d, byWeekday: next };
        });
    };

    const handleSave = async () => {
        // A recurring weekly rule needs at least one weekday; any active rule needs an assignee
        // (the generator routes the task to it).
        if (draft.freq === 'weekly' && (!Array.isArray(draft.byWeekday) || draft.byWeekday.length === 0)) {
            setMsg({ text: 'Pasirinkite bent vieną savaitės dieną.', tone: 'err' });
            return;
        }
        if (!draftAssignee) {
            setMsg({ text: 'Pasirinkite vykdytoją.', tone: 'err' });
            return;
        }
        setSaving(true);
        setMsg(null);
        try {
            if (draftAssignee !== baked) {
                await setTemplateAssignee(template.id, draftAssignee, currentUser);
            }
            // Preserve skipDates/lastGeneratedDate already on the stored rule; force active on save.
            await setTemplateRecurrence(template.id, {
                ...defaultRecurrence(),
                ...recurrence,
                ...draft,
                active: true,
            }, currentUser);
            setMsg({ text: 'Išsaugota.', tone: 'ok' });
            setExpanded(false);
            onChanged?.();
        } catch {
            setMsg({ text: 'Nepavyko išsaugoti.', tone: 'err' });
        } finally {
            setSaving(false);
        }
    };

    const handlePauseToggle = async () => {
        setBusyAction('pause');
        setMsg(null);
        try {
            const base = recurrence || defaultRecurrence();
            await setTemplateRecurrence(template.id, { ...base, active: !isRecurring }, currentUser);
            onChanged?.();
        } catch {
            setMsg({ text: 'Nepavyko pakeisti būsenos.', tone: 'err' });
        } finally {
            setBusyAction('');
        }
    };

    const handleSkipNext = async () => {
        if (!recurrence) return;
        const next = nextOccurrence(recurrence);
        if (!next) return;
        setBusyAction('skip');
        setMsg(null);
        try {
            const skipDates = Array.isArray(recurrence.skipDates) ? recurrence.skipDates : [];
            if (!skipDates.includes(next)) {
                await setTemplateRecurrence(template.id, { ...recurrence, skipDates: [...skipDates, next] }, currentUser);
            }
            setMsg({ text: `Praleista: ${next}`, tone: 'ok' });
            onChanged?.();
        } catch {
            setMsg({ text: 'Nepavyko praleisti.', tone: 'err' });
        } finally {
            setBusyAction('');
        }
    };

    const handleRunNow = async () => {
        setBusyAction('run');
        setMsg(null);
        try {
            const res = await runRecurringNow(template.id);
            if (res?.deduped) setMsg({ text: 'Šiandien jau sukurta.', tone: 'ok' });
            else if (res?.needsReassignment) setMsg({ text: 'Sukurta, bet vykdytojas nepasiekiamas — priskirkite kitą.', tone: 'err' });
            else if (res?.created) setMsg({ text: 'Sukurta.', tone: 'ok' });
            else setMsg({ text: res?.reason || 'Nesukurta.', tone: 'err' });
            onChanged?.();
        } catch {
            setMsg({ text: 'Nepavyko sukurti (ar funkcija įdiegta?).', tone: 'err' });
        } finally {
            setBusyAction('');
        }
    };

    // One-tap create from a NON-recurring template (client-side; the recurring path uses the
    // server "Sukurti dabar" with dedup/absence handling instead).
    const handleCreateOnce = async () => {
        if (!baked) {
            setMsg({ text: 'Šablonas be vykdytojo — atidarykite „Tvarkyti" ir priskirkite.', tone: 'err' });
            return;
        }
        setBusyAction('create-once');
        setMsg(null);
        try {
            await createManagerTask({ ...template.data, assignedUserId: baked, sourceTemplateId: template.id }, currentUser);
            setMsg({ text: 'Darbas sukurtas.', tone: 'ok' });
            onChanged?.();
        } catch {
            setMsg({ text: 'Nepavyko sukurti.', tone: 'err' });
        } finally {
            setBusyAction('');
        }
    };

    const next = isRecurring ? nextOccurrence(recurrence) : null;

    return (
        <li className="rounded-control border border-line bg-surface-card">
            <div className="flex items-center gap-1 p-3">
                {/* The task itself is clickable — opens the standard task dialog in template-edit
                    mode so the manager can change title / priority / deadline / people / time. The
                    cadence (when it repeats) stays behind "Tvarkyti". */}
                <button
                    type="button"
                    onClick={() => onEdit?.(template)}
                    title="Redaguoti šabloną"
                    className="-m-1 flex min-w-0 flex-1 items-center gap-3 rounded-control p-1 text-left hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                >
                    <Repeat className={cn('h-5 w-5 shrink-0', isRecurring ? 'text-brand' : 'text-ink-muted')} aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                        <span className="block truncate text-body font-semibold text-ink-strong">{template.templateName || template.data?.title || 'Šablonas'}</span>
                        <span className="block text-caption text-ink-muted">
                            {isRecurring ? describeRecurrence(recurrence) : 'Nepasikartojantis'}
                            {' · '}
                            <span className="text-ink">{assigneeName}</span>
                            {next && <> · Kita: <span className="font-mono">{next}</span></>}
                        </span>
                    </span>
                </button>
                {!isRecurring && (
                    <Button
                        variant="secondary"
                        size="md"
                        icon={Play}
                        loading={busyAction === 'create-once'}
                        onClick={handleCreateOnce}
                        aria-label="Sukurti darbą"
                        className="shrink-0 px-3 sm:px-4"
                    >
                        <span className="hidden sm:inline">Sukurti darbą</span>
                    </Button>
                )}
                <button
                    type="button"
                    onClick={openEditor}
                    aria-expanded={expanded}
                    aria-label="Tvarkyti"
                    className="inline-flex min-h-touch min-w-touch shrink-0 items-center justify-center gap-1 rounded-control px-3 text-body text-ink-muted hover:bg-surface-sunken hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                >
                    <span className="hidden sm:inline">Tvarkyti</span>
                    <ChevronDown className={cn('h-4 w-4 transition-transform', expanded && 'rotate-180')} aria-hidden="true" />
                </button>
            </div>

            {expanded && (
                <div className="border-t border-line p-3 space-y-4">
                    <div className="grid gap-3 sm:grid-cols-2">
                        <div>
                            <span className="mb-1 block text-caption font-bold uppercase tracking-wide text-ink-muted">Dažnumas</span>
                            <Select
                                value={draft.freq}
                                onChange={(val) => setDraft((d) => ({ ...d, freq: val }))}
                                options={RECURRENCE_FREQS}
                                label="Dažnumas"
                                alwaysSheet
                            />
                        </div>
                        <div>
                            <span className="mb-1 block text-caption font-bold uppercase tracking-wide text-ink-muted">Vykdytojas</span>
                            <Select
                                value={draftAssignee}
                                onChange={setDraftAssignee}
                                options={assignableUsers}
                                label="Vykdytojas"
                                placeholder="Pasirinkite…"
                                alwaysSheet
                            />
                        </div>
                    </div>

                    {draft.freq === 'weekly' && (
                        <div>
                            <span className="mb-1 block text-caption font-bold uppercase tracking-wide text-ink-muted">Savaitės dienos</span>
                            <div className="flex flex-wrap gap-2" role="group" aria-label="Savaitės dienos">
                                {WEEKDAYS.map((w) => {
                                    const on = Array.isArray(draft.byWeekday) && draft.byWeekday.includes(w.iso);
                                    return (
                                        <button
                                            key={w.iso}
                                            type="button"
                                            aria-pressed={on}
                                            onClick={() => toggleWeekday(w.iso)}
                                            className={cn(
                                                'inline-flex min-h-touch min-w-touch items-center justify-center rounded-full border px-3 text-body font-medium transition-colors',
                                                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2',
                                                on ? 'border-brand bg-brand/10 text-ink-strong' : 'border-line bg-surface-card text-ink-muted hover:bg-surface-sunken'
                                            )}
                                        >
                                            {w.short}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {draft.freq === 'monthly' && (
                        <div className="max-w-[12rem]">
                            <span className="mb-1 block text-caption font-bold uppercase tracking-wide text-ink-muted">Mėnesio diena</span>
                            <Select
                                value={String(draft.byMonthDay || 1)}
                                onChange={(val) => setDraft((d) => ({ ...d, byMonthDay: Number(val) }))}
                                options={MONTH_DAYS}
                                label="Mėnesio diena"
                                alwaysSheet
                            />
                        </div>
                    )}

                    {msg && (
                        <p className={cn('text-caption', msg.tone === 'err' ? 'text-feedback-danger' : 'text-feedback-success')} role="status">
                            {msg.text}
                        </p>
                    )}

                    <div className="flex flex-wrap items-center gap-2">
                        <Button variant="primary" icon={Check} loading={saving} onClick={handleSave}>
                            Išsaugoti
                        </Button>
                        {recurrence && (
                            <Button variant="secondary" icon={isRecurring ? Pause : Play} loading={busyAction === 'pause'} onClick={handlePauseToggle}>
                                {isRecurring ? 'Pristabdyti' : 'Tęsti'}
                            </Button>
                        )}
                        {isRecurring && (
                            <>
                                <Button variant="secondary" icon={SkipForward} loading={busyAction === 'skip'} onClick={handleSkipNext}>
                                    Praleisti kitą
                                </Button>
                                <Button variant="secondary" icon={Play} loading={busyAction === 'run'} onClick={handleRunNow}>
                                    Sukurti dabar
                                </Button>
                            </>
                        )}
                    </div>
                </div>
            )}

            {!expanded && msg && (
                <p className={cn('px-3 pb-3 text-caption', msg.tone === 'err' ? 'text-feedback-danger' : 'text-feedback-success')} role="status">
                    {msg.text}
                </p>
            )}
        </li>
    );
}

/**
 * RecurringTasksPanel — manager surface to turn task templates into recurring jobs (the headline
 * Fazė 1 feature). Lists every template; per template a manager sets the cadence (daily / weekly on
 * chosen weekdays / monthly), fixes the baked assignee (healing the assignedWorkerId→assignedUserId
 * drift), pauses, skips the next occurrence, or fires it now. The scheduled Cloud Function
 * (generateRecurringTasks) materializes active rules each morning; "Sukurti dabar" runs the same
 * server logic on demand. Read-broad/write-scoped: any manager may edit shared templates (rules),
 * assignee choices are narrowed to the manager's own team.
 *
 * `embedded`: render only the inner list + intro (no collapsible header / section chrome), for use
 * as a dedicated sub-tab panel where the surrounding tab switcher already provides the heading.
 */
export default function RecurringTasksPanel({ embedded = false }) {
    const { currentUser, userData, userRole } = useAuth();
    const { activeUsers } = useUsers();

    const [templates, setTemplates] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [collapsed, setCollapsed] = useState(true);
    // The template currently open in the standard task dialog (template-edit mode), or null.
    const [editingTemplate, setEditingTemplate] = useState(null);

    const assignableUsers = useMemo(() => {
        const roster = scopeRoster(activeUsers || [], userData, currentUser?.uid);
        return roster.map((u) => ({ value: u.id, label: formatDisplayName(u.displayName || u.email) || u.email }));
    }, [activeUsers, userData, currentUser?.uid]);

    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const list = await getTaskTemplates();
            setTemplates(list);
        } catch {
            setError('Nepavyko įkelti šablonų.');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    const activeCount = templates.filter((t) => t.recurrence && t.recurrence.active !== false).length;

    const body = (
        <>
            <p className={cn('mb-3 px-1 text-caption text-ink-muted', embedded && 'mt-1')}>
                Pažymėkite šabloną kaip pasikartojantį — sistema kas rytą automatiškai sukurs darbą pagal grafiką
                ir priskirs pasirinktam vykdytojui. „Sukurti dabar“ paleidžia iškart.
            </p>

            {loading && (
                <div className="flex justify-center py-6"><Spinner /></div>
            )}
            {error && !loading && (
                <p className="px-1 py-3 text-body text-feedback-danger" role="alert">{error}</p>
            )}
            {!loading && !error && templates.length === 0 && (
                <p className="px-1 py-3 text-body text-ink-muted">Šablonų dar nėra. Sukurkite šabloną kurdami darbą.</p>
            )}

            {!loading && !error && templates.length > 0 && (
                <ul className="space-y-2">
                    {templates.map((t) => (
                        <RecurringTemplateRow
                            key={t.id}
                            template={t}
                            assignableUsers={assignableUsers}
                            currentUser={currentUser}
                            onChanged={load}
                            onEdit={setEditingTemplate}
                        />
                    ))}
                </ul>
            )}

            {/* Standard task dialog reused to edit the template's content. On close, reload so the
                row reflects the new title / assignee immediately. */}
            {editingTemplate && (
                <TaskModal
                    isOpen
                    editTemplate={editingTemplate}
                    role={userRole}
                    onClose={() => { setEditingTemplate(null); load(); }}
                />
            )}
        </>
    );

    // Embedded as a sub-tab: the tab switcher already supplies the heading, so skip the
    // collapsible section chrome and render the list directly.
    if (embedded) {
        return <div>{body}</div>;
    }

    return (
        <section className="mb-4 rounded-card border border-line bg-surface-sunken">
            <button
                type="button"
                onClick={() => setCollapsed((c) => !c)}
                aria-expanded={!collapsed}
                className="flex w-full min-h-touch items-center gap-3 rounded-card px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
            >
                <Repeat className="h-5 w-5 shrink-0 text-brand" aria-hidden="true" />
                <span className="flex-1 text-body-lg font-bold text-ink-strong">Pasikartojantys darbai</span>
                {activeCount > 0 && (
                    <span className="rounded-full bg-brand/10 px-2 py-0.5 text-caption font-semibold text-brand tabular-nums">{activeCount}</span>
                )}
                <ChevronDown className={cn('h-5 w-5 shrink-0 text-ink-muted transition-transform', !collapsed && 'rotate-180')} aria-hidden="true" />
            </button>

            {!collapsed && <div className="px-3 pb-3">{body}</div>}
        </section>
    );
}
