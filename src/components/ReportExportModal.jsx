import { useEffect, useMemo, useState } from 'react';
import { Download, Search, FileText, Braces, Table2, AlertTriangle, Check } from 'lucide-react';

import { db } from '../firebase';
import Modal from './ui/Modal';
import Button from './ui/Button';
import DatePicker from './ui/DatePicker';
import { scopeRoster } from '../utils/teamScope';
import { formatDisplayName } from '../utils/formatters';
import { getLithuanianDateString, addDaysToDateString } from '../utils/timeUtils';
import { gatherReportData, reportFilename } from '../utils/reportData';
import { buildReport, renderReportMarkdown, renderReportJSON, renderTimesheetCSV } from '../utils/reportAggregate';

// Calendar-style presets (familiar from the report tab). Each resolves a [start, end] ending today.
const PERIOD_PRESETS = [
    { id: 'week', label: 'Ši savaitė' },
    { id: 'month', label: 'Šis mėnuo' },
    { id: '3months', label: '3 mėnesiai' },
    { id: 'year', label: 'Šie metai' },
];

function resolvePresetRange(id) {
    const today = getLithuanianDateString();
    const pad = (n) => String(n).padStart(2, '0');
    const [y, m] = today.split('-').map(Number);
    switch (id) {
        case 'week': {
            const [yy, mm, dd] = today.split('-').map(Number);
            const dow = new Date(Date.UTC(yy, mm - 1, dd)).getUTCDay(); // 0=Sun…6=Sat
            const mondayOffset = (dow + 6) % 7;
            return { start: addDaysToDateString(today, -mondayOffset), end: today };
        }
        case 'month':
            return { start: `${today.slice(0, 7)}-01`, end: today };
        case '3months': {
            const d = new Date(Date.UTC(y, m - 1 - 2, 1));
            return { start: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-01`, end: today };
        }
        case 'year':
            return { start: `${today.slice(0, 4)}-01-01`, end: today };
        default:
            return null;
    }
}

// Which preset (if any) a given range corresponds to — so an inherited range highlights the right
// chip instead of leaving every preset unselected.
function detectPreset(range) {
    if (!range) return 'month';
    for (const p of PERIOD_PRESETS) {
        const r = resolvePresetRange(p.id);
        if (r && r.start === range.start && r.end === range.end) return p.id;
    }
    return 'custom';
}

const FORMATS = [
    { id: 'md', label: 'Markdown — AI analizei', hint: 'Apskaičiuotos metrikos + Δ, paruošta įkelti į LLM', icon: FileText, recommended: true },
    { id: 'json', label: 'JSON — struktūrinis', hint: 'Tas pats objektas mašininiam apdorojimui', icon: Braces },
    { id: 'csv', label: 'CSV — val./diena', hint: 'Timesheet: eilutė / darbuotoją-dieną skaičiuoklei', icon: Table2 },
];

function triggerDownload(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

/**
 * ReportExportModal — the single "download report" surface. The manager picks a FORMAT
 * (Markdown for an LLM / JSON / CSV), a PERIOD, and a SUBSET of WORKERS, then downloads one
 * pre-aggregated report built by buildReport. Manager-only (mounted behind canExport).
 *
 * @param {boolean} open
 * @param {() => void} onClose
 * @param {Array} users - the full roster (scoped here to what the viewer may see).
 * @param {{ userData, uid, effectiveRole }} scope - the viewer's read scope.
 * @param {{ start, end }} [defaultRange] - initial period (defaults to current month).
 */
export default function ReportExportModal({ open, onClose, users = [], scope, defaultRange }) {
    const { userData, uid, effectiveRole } = scope || {};
    // Primitive views of defaultRange so the on-open effect can depend on the range without
    // re-running on every parent render (defaultRange is a fresh object each render).
    const defStart = defaultRange?.start;
    const defEnd = defaultRange?.end;

    const [format, setFormat] = useState('md');
    const [range, setRange] = useState(() => defaultRange || resolvePresetRange('month'));
    const [activePreset, setActivePreset] = useState(() => detectPreset(defaultRange));
    const [search, setSearch] = useState('');
    const [includeTest, setIncludeTest] = useState(false);
    const [includeEarnings, setIncludeEarnings] = useState(true);
    // Per-day evidence log, only meaningful for the MD/JSON analysis artifacts (CSV is per-day anyway).
    const [includeDaily, setIncludeDaily] = useState(false);
    const [selectedIds, setSelectedIds] = useState(() => new Set());
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    // Candidate roster: everyone the viewer may see, minus disabled, minus test (unless opted in).
    const candidates = useMemo(() => {
        const roster = scopeRoster(users, userData, uid) || [];
        return roster
            .filter((u) => !u.isDisabled && (includeTest || !u.isTest))
            .map((u) => ({ id: u.id, name: formatDisplayName(u.displayName) || u.email || u.id, isTest: !!u.isTest }))
            .sort((a, b) => a.name.localeCompare(b.name, 'lt'));
    }, [users, userData, uid, includeTest]);

    // On open, default the selection to every non-test candidate, reset transient UI, AND re-seed
    // the period from the report's CURRENT range. The modal stays mounted (shown/hidden via `open`),
    // so the lazy useState seeds run only once; without re-seeding here, a reopened modal would
    // keep — and export — the stale period it was first opened with.
    useEffect(() => {
        if (!open) return;
        const roster = scopeRoster(users, userData, uid) || [];
        const defaults = roster.filter((u) => !u.isDisabled && !u.isTest).map((u) => u.id);
        setSelectedIds(new Set(defaults));
        setSearch('');
        setError('');
        setBusy(false);
        const seed = defStart && defEnd ? { start: defStart, end: defEnd } : resolvePresetRange('month');
        setRange(seed);
        setActivePreset(detectPreset(seed));
    }, [open, users, userData, uid, defStart, defEnd]);

    const visible = useMemo(() => {
        const q = search.trim().toLowerCase();
        return q ? candidates.filter((c) => c.name.toLowerCase().includes(q)) : candidates;
    }, [candidates, search]);

    const selectedCount = useMemo(
        () => candidates.filter((c) => selectedIds.has(c.id)).length,
        [candidates, selectedIds]
    );
    const allVisibleSelected = visible.length > 0 && visible.every((c) => selectedIds.has(c.id));
    const showPicker = candidates.length > 1;

    const toggleOne = (id) =>
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });

    const toggleAllVisible = () =>
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (allVisibleSelected) visible.forEach((c) => next.delete(c.id));
            else visible.forEach((c) => next.add(c.id));
            return next;
        });

    const choosePreset = (id) => {
        const r = resolvePresetRange(id);
        if (r) {
            setRange(r);
            setActivePreset(id);
        }
    };

    const setCustomStart = (v) => {
        setActivePreset('custom');
        setRange((prev) => ({ ...prev, start: v }));
    };
    const setCustomEnd = (v) => {
        setActivePreset('custom');
        setRange((prev) => ({ ...prev, end: v }));
    };

    const handleDownload = async () => {
        setError('');
        const ids = candidates.filter((c) => selectedIds.has(c.id)).map((c) => c.id);
        if (!ids.length) {
            setError('Pasirinkite bent vieną darbuotoją.');
            return;
        }
        if (range.start > range.end) {
            setError('„Nuo" data negali būti vėlesnė už „Iki" datą.');
            return;
        }
        setBusy(true);
        try {
            const window = { startStr: range.start, endStr: range.end };
            const { workers, prevWindow } = await gatherReportData({
                db,
                userData,
                uid,
                effectiveRole,
                users,
                window,
                workerIds: ids,
            });
            const scopeLabel =
                ids.length === candidates.length
                    ? `Visi (${ids.length})`
                    : ids.length === 1
                      ? workers[0]?.name || '1 darbuotojas'
                      : `${ids.length} darbuotojai`;
            let content;
            let mime;
            if (format === 'csv') {
                // Per-day timesheet straight from the raw slice — no aggregated report needed.
                content = renderTimesheetCSV(workers, window);
                mime = 'text/csv;charset=utf-8;';
            } else {
                const generatedAt = new Date().toLocaleString('lt-LT', { timeZone: 'Europe/Vilnius' });
                const report = buildReport({ generatedAt, window, prevWindow, scopeLabel, includeEarnings, includeDaily, workers });
                if (format === 'md') {
                    content = renderReportMarkdown(report);
                    mime = 'text/markdown;charset=utf-8;';
                } else {
                    content = renderReportJSON(report);
                    mime = 'application/json;charset=utf-8;';
                }
            }
            triggerDownload(content, reportFilename(format, window), mime);
            onClose?.();
        } catch (err) {
            console.error('Report export failed:', err);
            setError('Nepavyko paruošti ataskaitos. Bandykite dar kartą arba siauresnį laikotarpį.');
        } finally {
            setBusy(false);
        }
    };

    const sectionLabel = 'text-caption uppercase font-bold tracking-wide text-ink-muted';

    return (
        <Modal
            open={open}
            onClose={onClose}
            title="Atsisiųsti ataskaitą"
            size="lg"
            closeOnBackdrop={false}
            footer={
                <div className="flex gap-3">
                    <Button variant="secondary" fullWidth onClick={onClose} disabled={busy}>
                        Atšaukti
                    </Button>
                    <Button variant="primary" fullWidth icon={Download} loading={busy} onClick={handleDownload}>
                        Atsisiųsti
                    </Button>
                </div>
            }
        >
            <div className="space-y-5">
                {error && (
                    <div role="alert" className="flex items-start gap-3 rounded-control border-l-4 border-feedback-danger bg-feedback-danger-soft p-3">
                        <AlertTriangle className="h-5 w-5 shrink-0 text-feedback-danger" aria-hidden="true" />
                        <p className="text-body text-feedback-danger-text">{error}</p>
                    </div>
                )}

                {/* FORMAT */}
                <div>
                    <p className={`${sectionLabel} mb-2`}>Formatas</p>
                    <div role="radiogroup" aria-label="Formatas" className="space-y-2">
                        {FORMATS.map((f) => {
                            const Icon = f.icon;
                            const selected = format === f.id;
                            return (
                                <button
                                    key={f.id}
                                    type="button"
                                    role="radio"
                                    aria-checked={selected}
                                    onClick={() => setFormat(f.id)}
                                    className={`flex w-full items-center gap-3 rounded-control border p-3 text-left min-h-touch transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1 ${
                                        selected ? 'border-brand bg-brand-soft' : 'border-line hover:bg-surface-sunken'
                                    }`}
                                >
                                    <Icon className={`h-5 w-5 shrink-0 ${selected ? 'text-brand' : 'text-ink-muted'}`} aria-hidden="true" />
                                    <span className="min-w-0 flex-1">
                                        <span className="block text-body font-semibold text-ink-strong">{f.label}</span>
                                        <span className="block text-caption text-ink-muted">{f.hint}</span>
                                    </span>
                                    {f.recommended && (
                                        <span className="shrink-0 rounded-full border border-brand px-2 py-0.5 text-caption font-bold text-brand">
                                            rekom.
                                        </span>
                                    )}
                                    {selected && <Check className="h-5 w-5 shrink-0 text-brand" aria-hidden="true" />}
                                </button>
                            );
                        })}
                    </div>
                </div>

                {/* PERIOD */}
                <div>
                    <p className={`${sectionLabel} mb-2`}>Laikotarpis</p>
                    <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                        {PERIOD_PRESETS.map((p) => (
                            <Button
                                key={p.id}
                                variant={activePreset === p.id ? 'primary' : 'secondary'}
                                onClick={() => choosePreset(p.id)}
                                className="justify-center"
                            >
                                {p.label}
                            </Button>
                        ))}
                    </div>
                    <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
                        <div className="flex-1">
                            <label htmlFor="export-from" className="mb-1 block text-caption font-semibold text-ink-muted">Nuo</label>
                            <DatePicker id="export-from" value={range.start} max={range.end} onChange={setCustomStart} />
                        </div>
                        <div className="flex-1">
                            <label htmlFor="export-to" className="mb-1 block text-caption font-semibold text-ink-muted">Iki</label>
                            <DatePicker id="export-to" value={range.end} min={range.start} max={getLithuanianDateString()} onChange={setCustomEnd} />
                        </div>
                    </div>
                </div>

                {/* WORKERS */}
                {showPicker && (
                    <div>
                        <div className="mb-2 flex items-center justify-between">
                            <p className={sectionLabel}>Darbuotojai</p>
                            <span className="rounded-full bg-brand-soft px-2.5 py-0.5 text-caption font-bold text-brand">
                                {selectedCount} pasirinkti
                            </span>
                        </div>
                        <div className="mb-2 flex items-center gap-2 rounded-input border border-line bg-surface-card px-3 min-h-touch focus-within:ring-2 focus-within:ring-brand">
                            <Search className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true" />
                            <input
                                type="text"
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder="Ieškoti darbuotojo…"
                                aria-label="Ieškoti darbuotojo"
                                className="w-full bg-transparent py-2 text-body text-ink placeholder:text-ink-muted focus:outline-none"
                            />
                        </div>
                        <div className="max-h-48 overflow-y-auto rounded-control border border-line">
                            <label className="flex cursor-pointer items-center gap-3 border-b border-line bg-surface-sunken px-3 min-h-touch">
                                <input
                                    type="checkbox"
                                    checked={allVisibleSelected}
                                    onChange={toggleAllVisible}
                                    aria-label="Pažymėti visus matomus darbuotojus"
                                    className="h-5 w-5 rounded border-line text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1"
                                />
                                <span className="text-body font-semibold text-ink">Visi (matomi)</span>
                            </label>
                            {visible.map((c) => (
                                <label key={c.id} className="flex cursor-pointer items-center gap-3 px-3 min-h-touch hover:bg-surface-sunken">
                                    <input
                                        type="checkbox"
                                        checked={selectedIds.has(c.id)}
                                        onChange={() => toggleOne(c.id)}
                                        aria-label={`Pasirinkti ${c.name}`}
                                        className="h-5 w-5 rounded border-line text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1"
                                    />
                                    <span className="text-body text-ink">{c.name}</span>
                                    {c.isTest && <span className="text-caption text-ink-muted">(bandomasis)</span>}
                                </label>
                            ))}
                            {visible.length === 0 && (
                                <p className="px-3 py-4 text-center text-caption text-ink-muted">Nieko nerasta.</p>
                            )}
                        </div>
                    </div>
                )}

                {/* OPTIONS. Earnings + daily-log shape the analysis artifacts (MD/JSON) only — the CSV
                    is a per-day timesheet that ignores both — so they hide when CSV is selected. The
                    test-account toggle gates the worker roster, so it applies to every format. */}
                <div className="flex flex-wrap gap-x-6 gap-y-2">
                    {format !== 'csv' && (
                        <label className="flex cursor-pointer items-center gap-2 min-h-touch">
                            <input
                                type="checkbox"
                                checked={includeEarnings}
                                onChange={(e) => setIncludeEarnings(e.target.checked)}
                                className="h-5 w-5 rounded border-line text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1"
                            />
                            <span className="text-body text-ink">Įtraukti uždarbį</span>
                        </label>
                    )}
                    {format !== 'csv' && (
                        <label className="flex cursor-pointer items-center gap-2 min-h-touch">
                            <input
                                type="checkbox"
                                checked={includeDaily}
                                onChange={(e) => setIncludeDaily(e.target.checked)}
                                className="h-5 w-5 rounded border-line text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1"
                            />
                            <span className="text-body text-ink">Įtraukti dienų išklotinę</span>
                        </label>
                    )}
                    <label className="flex cursor-pointer items-center gap-2 min-h-touch">
                        <input
                            type="checkbox"
                            checked={includeTest}
                            onChange={(e) => setIncludeTest(e.target.checked)}
                            className="h-5 w-5 rounded border-line text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1"
                        />
                        <span className="text-body text-ink">Įtraukti bandomuosius</span>
                    </label>
                </div>
            </div>
        </Modal>
    );
}
