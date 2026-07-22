import { useState, useEffect } from 'react';
import { Plus, Trash2, Check } from 'lucide-react';
import { cn } from '../utils/cn';
import { formatDisplayName, formatEurPerHour } from '../utils/formatters';
import { netToGross, validateTiers, EFFECTIVE_TAX_RATE } from '../utils/payRate';
import Modal from './ui/Modal';
import Button from './ui/Button';
import IconButton from './ui/IconButton';
import ConfirmDialog from './ui/ConfirmDialog';

// PayRateModal — admin-only editor for a worker's pay tariffs. A worker may have SEVERAL named
// tariffs (e.g. "Statyba", "Griovimas"); the manager later picks which one applies when assigning a
// task (utils/payRate.js). Each tariff is a MARGINAL tier table: the admin enters NET (take-home)
// hourly rates per monthly-hours rėžis, and a higher tier prices only the hours above its threshold.
// Each row shows the derived GROSS (with-tax) rate so both figures are visible. Admin-only write is
// enforced by firestore.rules (ADR 0012) — this UI is only ever rendered for an admin.

// Editor rows hold raw strings so a half-typed number does not fight the input.
const toRow = (t) => ({
    fromHours: t.fromHours === 0 || t.fromHours ? String(t.fromHours) : '',
    netRate: t.netRate === 0 || t.netRate ? String(t.netRate) : '',
});

const emptyRows = () => [{ fromHours: '0', netRate: '' }];

// Stable per-tariff id — referenced by tasks (task.payRateId), so it must survive future edits AND
// never repeat. crypto.randomUUID exists only in a SECURE context (https / localhost), so over a
// plain-http LAN host (phone testing) the fallback is what actually runs — and it must be unique on
// its own. The previous fallback was a module-level counter, which restarts at 1 on every page load
// and therefore re-minted an id an earlier session had already stored; two tariffs sharing an id
// make resolvePayRate (utils/payRate.js) match the FIRST one, silently billing work at the wrong
// table. Time + randomness cannot be reset by a reload. Exported for the unit test.
// eslint-disable-next-line react-refresh/only-export-components -- pure helper exported for unit tests.
export const mintId = () => {
    try {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) return `rate_${crypto.randomUUID()}`;
    } catch { /* fall through */ }
    return `rate_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
};

// Fail closed before a duplicate can reach Firestore: an id collision is invisible in the UI (both
// tariffs keep their own name) but re-prices every task bound to the shadowed one. Exported for the
// unit test.
// eslint-disable-next-line react-refresh/only-export-components -- pure helper exported for unit tests.
export const hasDuplicateRateIds = (rates) => {
    const ids = rates.map((r) => r.id);
    return new Set(ids).size !== ids.length;
};

// The stored payRate document for a built tariff set. It ALWAYS carries the full named `rates`
// set — even for a single tariff — because `rates` is the only place a tariff's id lives, and a
// task references its tariff by that id (task.payRateId). Dropping `rates` on the way back down to
// one tariff stripped those ids, so every task still bound to a deleted tariff fell through
// resolvePayRate's list[0] fallback (utils/payRate.js) and was silently re-priced against whichever
// table happened to remain — a pay change nobody could see. `tiers` / `label` stay as a mirror of
// the first tariff so any legacy reader of payRate.tiers still resolves the default.
// eslint-disable-next-line react-refresh/only-export-components -- pure helper exported for unit tests.
export const buildPayRateDoc = (built) => ({
    tiers: built[0].tiers,
    ...(built[0].label ? { label: built[0].label } : {}),
    rates: built,
});

// Build the editor's tariff cards from a stored payRate. Preference mirrors listPayRates: the named
// `rates` set when present, else the legacy single `tiers` as one card, else one empty card.
const cardsFromPayRate = (payRate) => {
    if (Array.isArray(payRate?.rates) && payRate.rates.length > 0) {
        return payRate.rates.map((r) => ({
            id: typeof r?.id === 'string' && r.id ? r.id : mintId(),
            label: r?.label ? String(r.label) : '',
            rows: Array.isArray(r?.tiers) && r.tiers.length > 0 ? r.tiers.map(toRow) : emptyRows(),
        }));
    }
    if (Array.isArray(payRate?.tiers) && payRate.tiers.length > 0) {
        return [{ id: '', label: payRate?.label ? String(payRate.label) : '', rows: payRate.tiers.map(toRow) }];
    }
    return [{ id: '', label: '', rows: emptyRows() }];
};

const INPUT_CLS =
    'block w-full rounded-input border border-line bg-surface-card px-3 py-2.5 text-body-lg text-ink focus:border-brand focus:outline-none focus-visible:ring-2 focus-visible:ring-brand';

export default function PayRateModal({ open, user, onClose, onSave }) {
    const [cards, setCards] = useState(cardsFromPayRate(null));
    const [error, setError] = useState('');
    const [saving, setSaving] = useState(false);
    // Index of the tariff card awaiting a delete confirmation (null = none).
    const [confirmRemoveIdx, setConfirmRemoveIdx] = useState(null);

    useEffect(() => {
        if (!open) return;
        setCards(cardsFromPayRate(user?.payRate));
        setError('');
        setConfirmRemoveIdx(null);
    }, [open, user]);

    if (!user) return null;
    const name = formatDisplayName(user.displayName) || user.email || '';
    const taxPct = Math.round(EFFECTIVE_TAX_RATE * 100);
    const hadRate =
        (Array.isArray(user?.payRate?.tiers) && user.payRate.tiers.length > 0) ||
        (Array.isArray(user?.payRate?.rates) && user.payRate.rates.length > 0);
    const multi = cards.length > 1;

    const updateCard = (ci, patch) =>
        setCards((prev) => prev.map((c, idx) => (idx === ci ? { ...c, ...patch } : c)));
    const updateRow = (ci, ri, field, value) =>
        updateCard(ci, { rows: cards[ci].rows.map((r, idx) => (idx === ri ? { ...r, [field]: value } : r)) });
    const addRow = (ci) => updateCard(ci, { rows: [...cards[ci].rows, { fromHours: '', netRate: '' }] });
    const removeRow = (ci, ri) => updateCard(ci, { rows: cards[ci].rows.filter((_, idx) => idx !== ri) });
    const addCard = () => setCards((prev) => [...prev, { id: mintId(), label: '', rows: emptyRows() }]);
    // Removing a tariff is CONSEQUENTIAL, never silent: work already assigned to it (and any work
    // carrying no explicit tariff) falls back to the FIRST remaining tariff afterwards, i.e. it is
    // re-priced. The admin confirms that trade first — see the ConfirmDialog below.
    const removeCard = (ci) => setCards((prev) => prev.filter((_, idx) => idx !== ci));

    const rowsToTiers = (rows) =>
        rows.map((r, i) => ({ fromHours: i === 0 ? 0 : Number(r.fromHours), netRate: Number(r.netRate) }));

    const handleSave = async () => {
        // Build + validate every tariff. When there are 2+, a name is required so the manager can
        // tell them apart in the assignment picker.
        const built = cards.map((c) => ({
            id: c.id || mintId(),
            label: (c.label || '').trim(),
            tiers: rowsToTiers(c.rows),
        }));
        for (let i = 0; i < built.length; i += 1) {
            const b = built[i];
            const tierErr = validateTiers(b.tiers);
            if (tierErr) { setError(cards.length > 1 ? `„${b.label || `Tarifas ${i + 1}`}“: ${tierErr}` : tierErr); return; }
            if (cards.length > 1 && !b.label) { setError(`Įveskite ${i + 1}-o tarifo pavadinimą.`); return; }
        }
        if (hasDuplicateRateIds(built)) {
            setError('Nepavyko išsaugoti: tarifai susidubliavo. Uždarykite langą ir bandykite dar kartą.');
            return;
        }

        const payRate = buildPayRateDoc(built);

        setSaving(true);
        try {
            await onSave(payRate);
            onClose();
        } catch {
            setError('Nepavyko išsaugoti įkainio. Bandykite dar kartą.');
        } finally {
            setSaving(false);
        }
    };

    const handleClear = async () => {
        setSaving(true);
        try {
            await onSave(null);
            onClose();
        } catch {
            setError('Nepavyko pašalinti įkainio. Bandykite dar kartą.');
        } finally {
            setSaving(false);
        }
    };

    return (
        <>
        <Modal
            open={open}
            onClose={onClose}
            title={`Įkainis — ${name}`}
            size="lg"
            closeOnBackdrop={false}
            footer={
                <div className="flex flex-col gap-3">
                    <div className="flex gap-3">
                        <Button variant="secondary" fullWidth onClick={onClose}>Atšaukti</Button>
                        <Button variant="primary" icon={Check} fullWidth loading={saving} onClick={handleSave}>
                            Išsaugoti
                        </Button>
                    </div>
                    {hadRate && (
                        <Button variant="ghost" className="text-feedback-danger" onClick={handleClear} disabled={saving}>
                            Pašalinti įkainį
                        </Button>
                    )}
                </div>
            }
        >
            <div className="space-y-4">
                <p className="text-body text-ink-muted">
                    Įveskite valandinį įkainį <strong>atskaičius mokesčius</strong> (neto, į rankas) kiekvienam
                    mėnesio valandų rėžiui. Aukštesnis įkainis taikomas tik toms valandoms, kurios viršija
                    ankstesnį rėžį. Galite sukurti <strong>kelis tarifus</strong> — vadovas pasirinks tinkamą,
                    priskirdamas darbą. Sistema parodo ir įkainį su mokesčiais.
                </p>

                {cards.map((card, ci) => (
                    <div key={card.id || ci} className="space-y-3 rounded-card border border-line bg-surface-card p-3">
                        {multi && (
                            <div className="flex items-end gap-3">
                                <label className="flex-1">
                                    <span className="mb-1 block text-caption font-medium text-ink-muted">Tarifo pavadinimas</span>
                                    <input
                                        type="text"
                                        value={card.label}
                                        onChange={(e) => updateCard(ci, { label: e.target.value })}
                                        placeholder="Pvz. Statyba"
                                        aria-label={`${ci + 1} tarifo pavadinimas`}
                                        className={INPUT_CLS}
                                    />
                                </label>
                                <IconButton
                                    variant="danger"
                                    icon={Trash2}
                                    label="Pašalinti tarifą"
                                    onClick={() => setConfirmRemoveIdx(ci)}
                                />
                            </div>
                        )}

                        <div className="space-y-3">
                            {card.rows.map((row, ri) => {
                                const net = Number(row.netRate);
                                const grossHint = Number.isFinite(net) && net > 0 ? formatEurPerHour(netToGross(net)) : '—';
                                return (
                                    <div key={ri} className="rounded-card border border-line bg-surface-sunken/40 p-3">
                                        <div className="flex items-end gap-3">
                                            <label className="flex-1">
                                                <span className="mb-1 block text-caption font-medium text-ink-muted">Nuo (val.)</span>
                                                {ri === 0 ? (
                                                    <div className={cn(INPUT_CLS, 'bg-surface-sunken text-ink-muted')}>0</div>
                                                ) : (
                                                    <input
                                                        type="number"
                                                        min="0"
                                                        step="1"
                                                        inputMode="numeric"
                                                        value={row.fromHours}
                                                        onChange={(e) => updateRow(ci, ri, 'fromHours', e.target.value)}
                                                        aria-label={`${ri + 1} rėžio pradžia valandomis`}
                                                        className={INPUT_CLS}
                                                    />
                                                )}
                                            </label>
                                            <label className="flex-1">
                                                <span className="mb-1 block text-caption font-medium text-ink-muted">
                                                    Įkainis (neto, €/val.)
                                                </span>
                                                <input
                                                    type="number"
                                                    min="0"
                                                    step="0.01"
                                                    inputMode="decimal"
                                                    value={row.netRate}
                                                    onChange={(e) => updateRow(ci, ri, 'netRate', e.target.value)}
                                                    placeholder="0,00"
                                                    aria-label={`${ri + 1} rėžio įkainis eurais per valandą`}
                                                    className={INPUT_CLS}
                                                />
                                            </label>
                                            {card.rows.length > 1 && (
                                                <IconButton
                                                    variant="danger"
                                                    icon={Trash2}
                                                    label="Pašalinti rėžį"
                                                    onClick={() => removeRow(ci, ri)}
                                                />
                                            )}
                                        </div>
                                        <p className="mt-2 text-caption text-ink-muted">≈ {grossHint} su mokesčiais</p>
                                    </div>
                                );
                            })}
                        </div>

                        <Button variant="secondary" icon={Plus} onClick={() => addRow(ci)}>Pridėti rėžį</Button>
                    </div>
                ))}

                <Button variant="secondary" icon={Plus} onClick={addCard}>Pridėti tarifą</Button>

                {error && (
                    <p role="alert" className="text-body font-medium text-feedback-danger">{error}</p>
                )}

                <p className="text-caption text-ink-muted">
                    Mokesčiai skaičiuojami pagal individualią veiklą Lietuvoje (apie {taxPct}%: GPM + Sodra,
                    be leidžiamų išlaidų atskaitymo).
                </p>
            </div>
        </Modal>

        {confirmRemoveIdx !== null && (
            <ConfirmDialog
                open={confirmRemoveIdx !== null}
                title="Pašalinti tarifą?"
                message={`Tarifas „${cards[confirmRemoveIdx]?.label?.trim() || `Tarifas ${confirmRemoveIdx + 1}`}“ bus pašalintas iš sąrašo.`}
                warning="Darbai, kuriems šis tarifas jau priskirtas, bus apmokami pagal pirmą likusį tarifą — įkainis gali pasikeisti. Pakeitimas įsigalios paspaudus „Išsaugoti“."
                confirmLabel="Pašalinti"
                cancelLabel="Atšaukti"
                onConfirm={() => { removeCard(confirmRemoveIdx); setConfirmRemoveIdx(null); }}
                onCancel={() => setConfirmRemoveIdx(null)}
            />
        )}
        </>
    );
}
