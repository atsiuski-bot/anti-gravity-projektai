import { AlertTriangle } from 'lucide-react';
import Modal from './Modal';
import Button from './Button';

/**
 * ConfirmDialog — the ONLY way to confirm a destructive / consequential action
 * (DESIGN_SYSTEM §8). `window.confirm` / `window.alert` are banned in UI flows.
 *
 * Mirrors the good `DeleteConfirmationModal`: full-width stacked buttons, color-coded intent,
 * and an explicit irreversibility warning. Defaults to the `danger` variant.
 */
export default function ConfirmDialog({
    open = true,
    onConfirm,
    onCancel,
    title = 'Ar tikrai?',
    message,
    warning,
    confirmLabel = 'Patvirtinti',
    cancelLabel = 'Atšaukti',
    variant = 'danger',
    loading = false,
}) {
    return (
        <Modal open={open} onClose={onCancel} title={title} size="sm" dismissible={!loading}>
            <div className="space-y-3">
                {message && <p className="text-body text-ink">{message}</p>}
                {warning && (
                    <div className="flex items-start gap-2 rounded-control bg-feedback-danger-soft p-3 text-body text-feedback-danger-text">
                        <AlertTriangle className="w-5 h-5 shrink-0" aria-hidden="true" />
                        <span>{warning}</span>
                    </div>
                )}
                <div className="flex flex-col gap-2 pt-2">
                    <Button variant={variant} size="lg" fullWidth onClick={onConfirm} loading={loading}>
                        {confirmLabel}
                    </Button>
                    <Button variant="secondary" size="lg" fullWidth onClick={onCancel} disabled={loading}>
                        {cancelLabel}
                    </Button>
                </div>
            </div>
        </Modal>
    );
}
