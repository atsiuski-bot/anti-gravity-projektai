import { useEffect, useMemo, useState } from 'react';
import { collection, query, orderBy, limit, onSnapshot, doc, setDoc } from 'firebase/firestore';
import {
    ScrollText, ShieldCheck, User, Bot, Cog,
    CheckCircle2, AlertTriangle, AlertOctagon,
    Timer, FileClock, Database, Info, Power,
} from 'lucide-react';
import { db } from '../firebase';
import { useAuth } from '../context/AuthContext';
import { AGENT_CONTROL_COLLECTION, AGENT_CONTROL_DOC_ID } from '../domain';
import Card from './ui/Card';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';
import Select from './ui/Select';
import { Spinner } from './ui/Loading';
import { logError } from '../utils/errorLog';
import { cn } from '../utils/cn';

/**
 * AuditDashboard — admin-only window onto the AI-native command substrate's two read surfaces
 * (ADR 0015 + ADR 0011):
 *
 *   1. INTEGRITY REPORTS — the daily durability monitor's output (`integrity_reports/{YYYY-MM-DD}`):
 *      volume canary, value anomalies, auto-stopped forgotten timers, stale backlog.
 *   2. DECISION LOG — the append-only event spine (`decision_log`): every consequential command,
 *      stamped with WHO decided (human / agent / system), WHAT, WHY, and a compact before→after.
 *
 * Both are READ-only here. Reads are gated by firestore.rules (managers/admins); the panel is shown
 * only to admins (ManagerView). The decision_log READ rule must be deployed for a client to read it
 * (the server WRITES bypass rules, so entries can exist before the read rule is live) — so a
 * permission-denied is surfaced as a precise "rules not deployed yet" message, not a blank panel.
 *
 * No composite index is needed: each query orders by a single field (ts / day), served by the
 * automatic single-field index. The actor-type filter is applied client-side over the recent page.
 */

const PAGE_DECISIONS = 200; // recent decisions fetched; actor filter narrows this client-side
const PAGE_REPORTS = 30;    // recent daily integrity reports

const dtFmt = new Intl.DateTimeFormat('lt-LT', {
    timeZone: 'Europe/Vilnius',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
});
const formatTs = (ts) => {
    if (!ts) return '—';
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? '—' : dtFmt.format(d);
};

// Severity → label + icon + token classes (color is never the sole signal — icon + word carry it too).
const SEVERITY = {
    ok: { label: 'Tvarkinga', icon: CheckCircle2, cls: 'bg-feedback-success-soft text-feedback-success-text border-feedback-success-border' },
    warning: { label: 'Dėmesio', icon: AlertTriangle, cls: 'bg-feedback-warning-soft text-feedback-warning-text border-feedback-warning-border' },
    critical: { label: 'Kritinė', icon: AlertOctagon, cls: 'bg-feedback-danger-soft text-feedback-danger-text border-feedback-danger-border' },
};

// Actor type → label + icon + token classes. The three-way human/agent/system split is exactly
// what the actor model exists to make legible (a manual edit vs an AI proposal vs a scheduled job).
const ACTOR = {
    human: { label: 'Žmogus', icon: User, cls: 'bg-feedback-info-soft text-feedback-info-text border-feedback-info-border' },
    agent: { label: 'Agentas', icon: Bot, cls: 'bg-brand-soft text-brand-hover border-brand/40' },
    system: { label: 'Sistema', icon: Cog, cls: 'bg-surface-sunken text-ink-muted border-line' },
};

// Friendly Lithuanian copy per command id (UI strings are Lithuanian). Unknown commands fall back
// to their raw id so a newly-added command is still legible before it gets a label here.
const COMMAND_LABELS = {
    'recurring.generate': 'Sukurta pasikartojanti užduotis',
    'integrity.autoStopTimer': 'Sustabdytas pamirštas laikmatis',
    assignTask: 'Užduoties priskyrimas',
    createTask: 'Sukurta užduotis',
    completeTask: 'Užduotis užbaigta',
    reopenTask: 'Užduotis grąžinta taisyti',
};
const commandLabel = (c) => COMMAND_LABELS[c] || c || '—';

const fmtVal = (v) => {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'boolean') return v ? 'taip' : 'ne';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
};

function SeverityPill({ severity }) {
    const s = SEVERITY[severity] || SEVERITY.ok;
    const Icon = s.icon;
    return (
        <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-caption font-semibold', s.cls)}>
            <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {s.label}
        </span>
    );
}

function ActorPill({ type }) {
    const a = ACTOR[type] || ACTOR.system;
    const Icon = a.icon;
    return (
        <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-caption font-semibold', a.cls)}>
            <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {a.label}
        </span>
    );
}

// One key:value list for a decision's before / after snapshot (only the keys actually present).
function KvBlock({ title, data }) {
    if (data === null || data === undefined) return null;
    const entries = typeof data === 'object' ? Object.entries(data) : [['', data]];
    if (!entries.length) return null;
    return (
        <div className="min-w-0 flex-1">
            <p className="text-caption font-semibold uppercase tracking-wide text-ink-muted">{title}</p>
            <dl className="mt-1 space-y-0.5">
                {entries.map(([k, v]) => (
                    <div key={k} className="flex gap-2 text-caption">
                        {k && <dt className="shrink-0 text-ink-muted">{k}:</dt>}
                        <dd className="min-w-0 break-words text-ink">{fmtVal(v)}</dd>
                    </div>
                ))}
            </dl>
        </div>
    );
}

function IntegrityReportCard({ report, prominent }) {
    const counts = report.counts && typeof report.counts === 'object' ? report.counts : {};
    const drops = Array.isArray(report.drops) ? report.drops : [];
    const stopped = report.autoStoppedTimers?.stopped || 0;
    const anomalies = report.totalAnomalies || 0;
    const stale = report.staleBacklog?.count || 0;

    return (
        <Card className={cn('p-4', prominent && 'border-l-4', prominent && (SEVERITY[report.severity] || SEVERITY.ok).cls.split(' ').find((c) => c.startsWith('border-')))}>
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                    <span className="text-body font-semibold text-ink">{report.day || '—'}</span>
                    <SeverityPill severity={report.severity} />
                </div>
                <span className="text-caption text-ink-muted">Paleista {formatTs(report.ranAt)}</span>
            </div>

            {/* Row counts per monitored collection (the volume canary's raw input). */}
            {Object.keys(counts).length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                    {Object.entries(counts).map(([name, n]) => (
                        <span key={name} className="inline-flex items-center gap-1.5 rounded-control border border-line bg-surface-sunken px-2 py-1 text-caption text-ink">
                            <Database className="h-3.5 w-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
                            <span className="text-ink-muted">{name}</span>
                            <span className="font-semibold">{typeof n === 'number' ? n.toLocaleString('lt-LT') : '—'}</span>
                        </span>
                    ))}
                </div>
            )}

            {/* Findings — only render the ones that fired, each with its own icon. */}
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-caption">
                <span className={cn('inline-flex items-center gap-1.5', anomalies > 0 ? 'text-feedback-warning-text' : 'text-ink-muted')}>
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    Anomalijos: <span className="font-semibold">{anomalies}</span>
                </span>
                <span className={cn('inline-flex items-center gap-1.5', stopped > 0 ? 'text-feedback-warning-text' : 'text-ink-muted')}>
                    <Timer className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    Sustabdyti laikmačiai: <span className="font-semibold">{stopped}</span>
                </span>
                <span className="inline-flex items-center gap-1.5 text-ink-muted">
                    <FileClock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    Pasenusios užduotys: <span className="font-semibold">{stale}</span>
                </span>
            </div>

            {/* Volume drop = the data-loss alarm; surface it loudly when present. */}
            {drops.length > 0 && (
                <div className="mt-3 rounded-control border border-feedback-danger-border bg-feedback-danger-soft p-2.5">
                    <p className="text-caption font-semibold text-feedback-danger-text">Pastebėtas kiekio kritimas (galimas duomenų praradimas):</p>
                    <ul className="mt-1 space-y-0.5">
                        {drops.map((d) => (
                            <li key={d.collection} className="text-caption text-feedback-danger-text">
                                {d.collection}: {d.before} → {d.after} (−{d.lost})
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </Card>
    );
}

function DecisionEntry({ entry }) {
    const a = ACTOR[entry.actorType] || ACTOR.system;
    const Icon = a.icon;
    const hasBeforeAfter = entry.before != null || entry.after != null;
    return (
        <Card className="p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                    <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-full border', a.cls)}>
                        <Icon className="h-4 w-4" aria-hidden="true" />
                    </span>
                    <div className="min-w-0">
                        <p className="truncate text-body font-semibold text-ink">{commandLabel(entry.command)}</p>
                        <p className="truncate text-caption text-ink-muted">
                            {entry.actorName || a.label}
                            {entry.actorKind ? ` · ${entry.actorKind}` : ''}
                            {entry.targetType ? ` · ${entry.targetType}${entry.targetId ? ` ${entry.targetId}` : ''}` : ''}
                        </p>
                    </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                    <ActorPill type={entry.actorType} />
                    <span className="text-caption text-ink-muted">{formatTs(entry.ts)}</span>
                </div>
            </div>

            {entry.reason && (
                <p className="mt-2 text-caption text-ink-muted">
                    <span className="font-semibold text-ink">Priežastis: </span>{entry.reason}
                </p>
            )}

            {hasBeforeAfter && (
                <div className="mt-2 flex flex-wrap gap-4 rounded-control border border-line bg-surface-sunken p-2.5">
                    <KvBlock title="Prieš" data={entry.before} />
                    <KvBlock title="Po" data={entry.after} />
                </div>
            )}
        </Card>
    );
}

// A precise message for the one expected precondition failure: the decision_log READ rule not yet
// deployed (the server writes bypass rules, so the spine can hold entries the client can't yet read).
function RulesNotice({ collectionName }) {
    return (
        <Card className="p-4">
            <div className="flex items-start gap-3">
                <Info className="mt-0.5 h-5 w-5 shrink-0 text-feedback-info-text" aria-hidden="true" />
                <div>
                    <p className="text-body font-semibold text-ink">Audito skaitymas dar neaktyvuotas</p>
                    <p className="mt-1 text-caption text-ink-muted">
                        Norint matyti „{collectionName}“ įrašus, reikia įdiegti atnaujintas
                        Firestore taisykles (skaitymą leidžiama administratoriams). Sistema įrašus
                        jau kaupia — jie taps matomi, kai taisyklės bus įdiegtos.
                    </p>
                </div>
            </div>
        </Card>
    );
}

// The agent kill-switch control (ADR 0015): the admin engages/releases the single global brake that
// makes the command kernel refuse EVERY agent command. Reads + writes system_config/agents; the
// write needs the system_config rule deployed (admin-only), so a permission-denied degrades to a
// precise "rules not deployed" note rather than a dead button.
function AgentControlCard() {
    const { currentUser } = useAuth();
    const [status, setStatus] = useState('loading'); // loading | ready | denied | error
    const [enabled, setEnabled] = useState(true);
    const [configured, setConfigured] = useState(false);
    const [busy, setBusy] = useState(false);
    const [writeError, setWriteError] = useState(null);

    useEffect(() => {
        const unsub = onSnapshot(
            doc(db, AGENT_CONTROL_COLLECTION, AGENT_CONTROL_DOC_ID),
            (snap) => {
                setConfigured(snap.exists());
                setEnabled(snap.exists() ? snap.data().enabled !== false : true);
                setStatus('ready');
            },
            (err) => {
                if (err.code !== 'permission-denied') logError(err, { source: 'AuditDashboard:agentControl' });
                setStatus(err.code === 'permission-denied' ? 'denied' : 'error');
            },
        );
        return () => unsub();
    }, []);

    const toggle = async () => {
        setBusy(true);
        setWriteError(null);
        try {
            await setDoc(
                doc(db, AGENT_CONTROL_COLLECTION, AGENT_CONTROL_DOC_ID),
                { enabled: !enabled, updatedAt: new Date().toISOString(), updatedBy: currentUser?.uid || null },
                { merge: true },
            );
            // The onSnapshot listener reflects the new state — no optimistic flip needed.
        } catch (err) {
            logError(err, { source: 'AuditDashboard:agentToggle' });
            setWriteError(
                err.code === 'permission-denied'
                    ? 'Nepavyko išsaugoti — reikia įdiegti atnaujintas Firestore taisykles (system_config).'
                    : 'Nepavyko pakeisti būsenos. Bandykite dar kartą.',
            );
        } finally {
            setBusy(false);
        }
    };

    return (
        <Card as="section" aria-labelledby="agent-control-heading" className="p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line bg-surface-sunken">
                        <Bot className="h-5 w-5 text-ink-muted" aria-hidden="true" />
                    </span>
                    <div className="min-w-0">
                        <h2 id="agent-control-heading" className="text-h2 font-semibold text-ink-strong">AI agentų valdymas</h2>
                        <p className="mt-1 text-caption text-ink-muted">
                            Avarinis jungiklis: kai išjungta, visos AI agentų komandos atmetamos (žmonių
                            ir sistemos veiksmų tai neliečia).
                        </p>
                    </div>
                </div>
                {status === 'ready' && (
                    <span className={cn(
                        'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-caption font-semibold',
                        enabled
                            ? 'bg-feedback-success-soft text-feedback-success-text border-feedback-success-border'
                            : 'bg-feedback-danger-soft text-feedback-danger-text border-feedback-danger-border',
                    )}>
                        <Power className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        {enabled ? 'Agentai įjungti' : 'Agentai išjungti'}
                    </span>
                )}
            </div>

            {status === 'loading' ? (
                <Spinner />
            ) : status === 'denied' ? (
                <div className="mt-3 flex items-start gap-3">
                    <Info className="mt-0.5 h-5 w-5 shrink-0 text-feedback-info-text" aria-hidden="true" />
                    <p className="text-caption text-ink-muted">
                        Jungiklis dar neaktyvuotas — reikia įdiegti atnaujintas Firestore taisykles
                        (system_config). Iki tol agentai lieka numatytai įjungti, bet nė vienas kliento
                        kelias dar nevykdo komandų kaip agentas.
                    </p>
                </div>
            ) : status === 'error' ? (
                <p className="mt-3 text-caption text-feedback-danger-text">Nepavyko įkelti jungiklio būsenos.</p>
            ) : (
                <div className="mt-3 flex flex-wrap items-center gap-3">
                    <Button
                        variant={enabled ? 'danger' : 'success'}
                        icon={Power}
                        loading={busy}
                        onClick={toggle}
                        aria-label={enabled ? 'Išjungti visus AI agentus' : 'Įjungti visus AI agentus'}
                    >
                        {enabled ? 'Išjungti agentus' : 'Įjungti agentus'}
                    </Button>
                    {!configured && (
                        <span className="text-caption text-ink-muted">Numatytoji būsena (dar nekeista).</span>
                    )}
                    {writeError && <span className="text-caption text-feedback-danger-text">{writeError}</span>}
                </div>
            )}
        </Card>
    );
}

export default function AuditDashboard() {
    const [reports, setReports] = useState([]);
    const [reportsLoading, setReportsLoading] = useState(true);
    const [reportsError, setReportsError] = useState(null);

    const [decisions, setDecisions] = useState([]);
    const [decisionsLoading, setDecisionsLoading] = useState(true);
    const [decisionsError, setDecisionsError] = useState(null);

    const [actorFilter, setActorFilter] = useState('all');

    // Integrity reports — order by `day` desc (single-field index). The baseline doc
    // (integrity_reports/_counts) has no `day` field, so this query naturally excludes it.
    useEffect(() => {
        const q = query(collection(db, 'integrity_reports'), orderBy('day', 'desc'), limit(PAGE_REPORTS));
        const unsub = onSnapshot(
            q,
            (snap) => {
                setReports(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
                setReportsLoading(false);
            },
            (err) => {
                logError(err, { source: 'AuditDashboard:integrity_reports' });
                setReportsError(err.code || 'error');
                setReportsLoading(false);
            },
        );
        return () => unsub();
    }, []);

    // Decision log — order by `ts` desc (single-field index); actor filter is applied client-side.
    useEffect(() => {
        const q = query(collection(db, 'decision_log'), orderBy('ts', 'desc'), limit(PAGE_DECISIONS));
        const unsub = onSnapshot(
            q,
            (snap) => {
                setDecisions(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
                setDecisionsLoading(false);
            },
            (err) => {
                logError(err, { source: 'AuditDashboard:decision_log' });
                setDecisionsError(err.code || 'error');
                setDecisionsLoading(false);
            },
        );
        return () => unsub();
    }, []);

    const actorCounts = useMemo(() => {
        const c = { all: decisions.length, human: 0, agent: 0, system: 0 };
        decisions.forEach((d) => { if (c[d.actorType] !== undefined) c[d.actorType] += 1; });
        return c;
    }, [decisions]);

    const filteredDecisions = useMemo(
        () => (actorFilter === 'all' ? decisions : decisions.filter((d) => d.actorType === actorFilter)),
        [decisions, actorFilter],
    );

    const actorOptions = [
        { value: 'all', label: `Visi sprendimai (${actorCounts.all})` },
        { value: 'human', label: `Žmogus (${actorCounts.human})` },
        { value: 'agent', label: `Agentas (${actorCounts.agent})` },
        { value: 'system', label: `Sistema (${actorCounts.system})` },
    ];

    return (
        <div className="pt-1 sm:pt-4 space-y-8">
            <header>
                <div className="flex items-center gap-2">
                    <ScrollText className="h-6 w-6 shrink-0 text-ink" aria-hidden="true" />
                    <h1 className="text-h1 font-bold text-ink-strong">Auditas</h1>
                </div>
                <p className="mt-1 text-body text-ink-muted">
                    Sistemos vientisumo ataskaitos ir sprendimų žurnalas — kas, ką ir kodėl pakeitė
                    (žmogus, AI agentas ar automatinis darbas).
                </p>
            </header>

            {/* ---- Agent kill-switch (most operationally important control — first) ----- */}
            <AgentControlCard />

            {/* ---- Integrity reports ---------------------------------------------------- */}
            <section aria-labelledby="audit-integrity-heading">
                <div className="mb-3 flex items-center gap-2">
                    <ShieldCheck className="h-5 w-5 shrink-0 text-ink-muted" aria-hidden="true" />
                    <h2 id="audit-integrity-heading" className="text-h2 font-semibold text-ink-strong">
                        Vientisumo ataskaitos
                    </h2>
                </div>

                {reportsLoading ? (
                    <Spinner />
                ) : reportsError === 'permission-denied' ? (
                    <RulesNotice collectionName="integrity_reports" />
                ) : reportsError ? (
                    <Card className="p-4">
                        <p className="text-body text-feedback-danger-text">Nepavyko įkelti vientisumo ataskaitų.</p>
                    </Card>
                ) : reports.length === 0 ? (
                    <EmptyState
                        icon={ShieldCheck}
                        title="Ataskaitų dar nėra"
                        description="Vientisumo skenavimas paleidžiamas kasdien 06:00 (Vilnius). Pirmoji ataskaita atsiras po artimiausio paleidimo."
                    />
                ) : (
                    <div className="space-y-3">
                        <IntegrityReportCard report={reports[0]} prominent />
                        {reports.length > 1 && (
                            <div className="space-y-2">
                                {reports.slice(1).map((r) => (
                                    <IntegrityReportCard key={r.id} report={r} />
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </section>

            {/* ---- Decision log --------------------------------------------------------- */}
            <section aria-labelledby="audit-decisions-heading">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                        <ScrollText className="h-5 w-5 shrink-0 text-ink-muted" aria-hidden="true" />
                        <h2 id="audit-decisions-heading" className="text-h2 font-semibold text-ink-strong">
                            Sprendimų žurnalas
                        </h2>
                    </div>
                    {!decisionsError && decisions.length > 0 && (
                        <Select
                            value={actorFilter}
                            onChange={setActorFilter}
                            options={actorOptions}
                            label="Aktorius"
                            ariaLabel="Filtruoti pagal aktorių"
                            className="w-full sm:w-56"
                        />
                    )}
                </div>

                {decisionsLoading ? (
                    <Spinner />
                ) : decisionsError === 'permission-denied' ? (
                    <RulesNotice collectionName="decision_log" />
                ) : decisionsError ? (
                    <Card className="p-4">
                        <p className="text-body text-feedback-danger-text">Nepavyko įkelti sprendimų žurnalo.</p>
                    </Card>
                ) : filteredDecisions.length === 0 ? (
                    <EmptyState
                        icon={ScrollText}
                        title={decisions.length === 0 ? 'Žurnalas tuščias' : 'Pagal filtrą įrašų nėra'}
                        description={
                            decisions.length === 0
                                ? 'Įrašai atsiras savaime: pasikartojančių darbų generatorius (05:00) ir vientisumo skenavimas (06:00) palieka „sistemos“ įrašus, o žmonių/agentų komandos — savuosius.'
                                : 'Pakeiskite aktoriaus filtrą, kad pamatytumėte kitus įrašus.'
                        }
                    />
                ) : (
                    <div className="space-y-2">
                        {filteredDecisions.map((d) => (
                            <DecisionEntry key={d.id} entry={d} />
                        ))}
                    </div>
                )}
            </section>
        </div>
    );
}
