import { useState, useEffect } from 'react';
import { Plus, Trash2, Check } from 'lucide-react';
import { cn } from '../utils/cn';
import { formatDisplayName, formatEurPerHour } from '../utils/formatters';
import { netToGross, validateTiers, EFFECTIVE_TAX_RATE } from '../utils/payRate';
import Modal from './ui/Modal';
import Button from './ui/Button';
import IconButton from './ui/IconButton';

// PayRateModal — admin-only editor for a worker's tiered pay table. The admin enters NET
// (take-home) hourly rates per monthly-hours rėžis; the rates are MARGINAL (a higher tier prices
// only the hours above its threshold). Each row shows the derived GROSS (with-tax) rate so both
// figures are visible, per the design brief. Admin-only write is enforced by firestore.rules
// (ADR 0012) — this UI is only ever rendered for an admin.

// Editor rows hold raw strings so a half-typed number does not fight the input.
const toRow = (t) => ({
    fromHours: t.fromHours === 0 || t.fromHours ? String(t.fromHours) : '',
    netRate: t.netRate === 0 || t.netRate ? String(t.netRate) : '',
});

const DEFAULT_ROWS = [{ fromHours: '0', netRate: '' }];

const INPUT_CLS =
    'block w-full rounded-input border border-line bg-surface-card px-3 py-2.5 text-body-lg text-ink focus:border-brand focus:outline-none focus-visible:ring-2 focus-visible:ring-brand';

export default function PayRateModal({ open, user, onClose, onSave }) {
    const [rows, setRows] = useState(DEFAULT_ROWS);
    const [error, setError] = useState('');
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!open) return;
        const existing = Array.isArray(user?.payRate?.tiers) ? user.payRate.tiers : [];
        setRows(existing.length > 0 ? existing.map(toRow) : DEFAULT_ROWS);
        setError('');
    }, [open, user]);

    if (!user) return null;
    const name = formatDisplayName(user.displayName) || user.email || '';
    const taxPct = Math.round(EFFECTIVE_TAX_RATE * 100);
    const hadRate = Array.isArray(user?.payRate?.tiers) && user.payRate.tiers.length > 0;

    const updateRow = (i, field, value) =>
        setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, [field]: value } : r)));
    const addRow = () => setRows((prev) => [...prev, { fromHours: '', netRate: '' }]);
    const removeRow = (i) => setRows((prev) => prev.filter((_, idx) => idx !== i));

    const buildTiers = () =>
        rows.map((r, i) => ({ fromHours: i === 0 ? 0 : Number(r.fromHours), netRate: Number(r.netRate) }));

    const handleSave = async () => {
        const tiers = buildTiers();
        const err = validateTiers(tiers);
        if (err) { setError(err); return; }
        setSaving(true);
        try {
            await onSave({ tiers });
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
                    ankstesnį rėžį. Sistema parodo ir įkainį su mokesčiais.
                </p>

                <div className="space-y-3">
                    {rows.map((row, i) => {
                        const net = Number(row.netRate);
                        const grossHint = Number.isFinite(net) && net > 0 ? formatEurPerHour(netToGross(net)) : '—';
                        return (
                            <div key={i} className="rounded-card border border-line bg-surface-sunken/40 p-3">
                                <div className="flex items-end gap-3">
                                    <label className="flex-1">
                                        <span className="mb-1 block text-caption font-medium text-ink-muted">Nuo (val.)</span>
                                        {i === 0 ? (
                                            <div className={cn(INPUT_CLS, 'bg-surface-sunken text-ink-muted')}>0</div>
                                        ) : (
                                            <input
                                                type="number"
                                                min="0"
                                                step="1"
                                                inputMode="numeric"
                                                value={row.fromHours}
                                                onChange={(e) => updateRow(i, 'fromHours', e.target.value)}
                                                aria-label={`${i + 1} rėžio pradžia valandomis`}
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
                                            onChange={(e) => updateRow(i, 'netRate', e.target.value)}
                                            placeholder="0,00"
                                            aria-label={`${i + 1} rėžio įkainis eurais per valandą`}
                                            className={INPUT_CLS}
                                        />
                                    </label>
                                    {rows.length > 1 && (
                                        <IconButton
                                            variant="danger"
                                            icon={Trash2}
                                            label="Pašalinti rėžį"
                                            onClick={() => removeRow(i)}
                                        />
                                    )}
                                </div>
                                <p className="mt-2 text-caption text-ink-muted">≈ {grossHint} su mokesčiais</p>
                            </div>
                        );
                    })}
                </div>

                <Button variant="secondary" icon={Plus} onClick={addRow}>Pridėti rėžį</Button>

                {error && (
                    <p role="alert" className="text-body font-medium text-feedback-danger">{error}</p>
                )}

                <p className="text-caption text-ink-muted">
                    Mokesčiai skaičiuojami pagal individualią veiklą Lietuvoje (apie {taxPct}%: GPM + Sodra,
                    be leidžiamų išlaidų atskaitymo).
                </p>
            </div>
        </Modal>
    );
}
