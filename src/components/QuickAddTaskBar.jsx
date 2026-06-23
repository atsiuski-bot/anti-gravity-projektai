import { useState, useRef } from 'react';
import { Plus, Sparkles } from 'lucide-react';
import { createManagerTask } from '../utils/taskActions';
import { parseTaskText } from '../utils/aiActions';
import { getPriorityOptions, DEFAULT_PRIORITY } from '../utils/priority';
import { cn } from '../utils/cn';
import Button from './ui/Button';
import Select from './ui/Select';

// The estimate values that cover the vast majority of tasks (mirrors TaskModal's COMMON_TIMES).
const TIME_OPTIONS = ['15min', '30min', '1h', '2h', '4h', '8h'].map((t) => ({ value: t, label: t }));
const PRIORITY_OPTIONS = getPriorityOptions().map((p) => ({ value: p.id, label: p.label }));

/**
 * QuickAddTaskBar — a single-line task create for the high-volume manager path (the data showed
 * one manager authoring ~10 tasks/active-day, peaking at 09:00). For the common planned task —
 * title + priority + estimate + assignee — this skips the full TaskModal: type, pick, Enter, and
 * the input refocuses for the next one. Writes through the shared createManagerTask helper, so the
 * priority/estimate are canonical and the new tasks shape rules are satisfied. The task list is a
 * live subscription, so a created task appears without any manual refresh.
 *
 * @param {{value:string,label:string}[]} assignableUsers - scoped roster for the assignee picker.
 * @param {Object} currentUser
 */
export default function QuickAddTaskBar({ assignableUsers, currentUser }) {
    const [title, setTitle] = useState('');
    const [priority, setPriority] = useState(DEFAULT_PRIORITY);
    const [estimatedTime, setEstimatedTime] = useState('1h');
    const [assignedUserId, setAssignedUserId] = useState('');
    const [deadline, setDeadline] = useState('');
    const [busy, setBusy] = useState(false);
    const [aiBusy, setAiBusy] = useState(false);
    const [msg, setMsg] = useState(null);
    const titleRef = useRef(null);

    // Show whatever estimate the AI returned even if it isn't one of the common chips (e.g. "1,5h").
    const timeOptions = (estimatedTime && !TIME_OPTIONS.some((o) => o.value === estimatedTime))
        ? [...TIME_OPTIONS, { value: estimatedTime, label: estimatedTime }]
        : TIME_OPTIONS;

    // "✨" — parse the typed natural-language line into the structured fields for review. The server
    // callable (OpenRouter / gemini-2.5-flash) returns a DRAFT; it never creates the task.
    const handleAiParse = async () => {
        const text = title.trim();
        if (!text) { setMsg({ text: 'Įrašykite tekstą, kurį AI pavers darbu.', tone: 'err' }); return; }
        setAiBusy(true);
        setMsg(null);
        try {
            const roster = assignableUsers.map((u) => ({ id: u.value, name: u.label }));
            const d = await parseTaskText(text, roster);
            if (d.title) setTitle(d.title);
            if (d.priority) setPriority(d.priority);
            if (d.estimatedTime) setEstimatedTime(d.estimatedTime);
            setAssignedUserId(d.assignedUserId || '');
            setDeadline(d.deadline || '');
            setMsg({
                text: d.assignedUserId ? 'Užpildyta — peržiūrėkite ir pridėkite.' : 'Užpildyta — patikslinkite vykdytoją.',
                tone: d.assignedUserId ? 'ok' : 'err',
            });
        } catch {
            setMsg({ text: 'AI nepavyko (ar funkcija/raktas įdiegti?).', tone: 'err' });
        } finally {
            setAiBusy(false);
        }
    };

    const submit = async (e) => {
        e?.preventDefault?.();
        if (!title.trim()) { setMsg({ text: 'Įveskite pavadinimą.', tone: 'err' }); return; }
        if (!assignedUserId) { setMsg({ text: 'Pasirinkite vykdytoją.', tone: 'err' }); return; }
        setBusy(true);
        setMsg(null);
        try {
            await createManagerTask({ title, priority, estimatedTime, assignedUserId, deadline }, currentUser);
            setTitle('');
            setDeadline('');
            setMsg({ text: 'Pridėta.', tone: 'ok' });
            // Keep priority/estimate/assignee for rapid repeated adds; refocus the title.
            titleRef.current?.focus();
        } catch {
            setMsg({ text: 'Nepavyko pridėti.', tone: 'err' });
        } finally {
            setBusy(false);
        }
    };

    return (
        <form onSubmit={submit} className="mb-4 rounded-card border border-line bg-surface-card p-3">
            <div className="flex flex-col gap-2 md:flex-row md:items-center">
                <input
                    ref={titleRef}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Greitas darbas — pavadinimas…"
                    aria-label="Darbo pavadinimas"
                    className="min-h-touch flex-1 rounded-input border border-line bg-surface-card px-3 text-body text-ink-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                    style={{ fontSize: '16px' }}
                />
                <div className="flex flex-wrap items-center gap-2">
                    <Select value={priority} onChange={setPriority} options={PRIORITY_OPTIONS} label="Prioritetas" ariaLabel="Prioritetas" className="min-w-[8rem]" />
                    <Select value={estimatedTime} onChange={setEstimatedTime} options={timeOptions} label="Planuojamas laikas" ariaLabel="Planuojamas laikas" className="min-w-[6rem]" />
                    <Select value={assignedUserId} onChange={setAssignedUserId} options={assignableUsers} label="Vykdytojas" placeholder="Vykdytojas…" ariaLabel="Vykdytojas" className="min-w-[10rem]" />
                    <Button type="button" variant="secondary" icon={Sparkles} loading={aiBusy} onClick={handleAiParse} title="AI: paversti tekstą darbu">AI</Button>
                    <Button type="submit" variant="primary" icon={Plus} loading={busy}>Pridėti</Button>
                </div>
            </div>
            {msg && (
                <p className={cn('mt-2 text-caption', msg.tone === 'err' ? 'text-feedback-danger' : 'text-feedback-success')} role="status">
                    {msg.text}
                </p>
            )}
            {deadline && (
                <p className="mt-1 text-caption text-ink-muted">Terminas: <span className="font-mono">{deadline}</span></p>
            )}
        </form>
    );
}
