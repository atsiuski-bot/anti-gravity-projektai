import { useState, useRef } from 'react';
import { XOctagon, PauseCircle, BellOff, Hourglass, CheckCircle2, Camera, X, ArrowLeft, Send } from 'lucide-react';
import { SoundManager } from '../utils/soundUtils';
import { formatMinutesToTimeString } from '../utils/timeUtils';
import { uploadAttachments } from '../utils/attachmentUpload';
import Modal from './ui/Modal';
import Button from './ui/Button';

// Keep the popup's own photo cap modest — this is a quick "here's why I need more time" note,
// not the task's full gallery.
const MAX_REQUEST_PHOTOS = 4;

/**
 * Hard stop shown to the worker when 100% of the estimated time is reached. The timer is already
 * auto-paused (time has STOPPED) and a repeating alarm is playing. Unlike the amber
 * TaskTimeWarningPopup (an FYI), this one is red and forces a deliberate decision — the worker
 * cannot dismiss it; they must pick one of two paths:
 *
 *   1. Prašyti laiko pratęsimo — ask the manager for more time, optionally with a note and photos.
 *      The task stays paused until the manager grants (which re-arms the monitor).
 *   2. Pabaigti darbą — finish now; the task is marked completed and handed to the manager for
 *      acceptance (pridavimas).
 *
 * Rendered through the canonical Modal (`bare`, `level="top"`, `dismissible={false}`) so it shares
 * the one scrim, focus-trap and z-ladder while staying a forced-acknowledge alarm above any modal.
 */
export default function TaskTimeLimitPopup({ task, estimatedTime, actualMinutes, uid, onRequestExtension, onFinish }) {
    const [mode, setMode] = useState('choice');   // 'choice' | 'request'
    const [muted, setMuted] = useState(false);
    const [finishing, setFinishing] = useState(false);
    const [comment, setComment] = useState('');
    const [photos, setPhotos] = useState([]);      // { file, url } previews
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');

    const primaryRef = useRef(null);
    const requestRef = useRef(null);
    const fileInputRef = useRef(null);

    if (!task) return null;

    // Who, if anyone, an extension request would go to — mirrors requestTimeExtension's recipient
    // resolution (managerId || taskAuditor). A manager running their OWN task is their own manager,
    // so the request would be self-addressed — asking yourself for permission, which is pointless.
    // In that case, and when there is no manager at all, we hide the request path and offer only
    // "finish"; a self-managing manager extends their own task through the task editor instead.
    const extensionRecipientId = task.managerId || task.taskAuditor;
    const isSelfManaged = !!extensionRecipientId && extensionRecipientId === uid;
    const canRequestExtension = !!extensionRecipientId && extensionRecipientId !== uid;

    const handleMute = () => {
        SoundManager.stopTimeLimitRepeat();
        setMuted(true);
    };

    const handleFinish = async () => {
        if (finishing) return;
        setError('');
        setFinishing(true);
        try {
            await onFinish?.();
            // Parent clears the popup on success → this component unmounts; no state reset needed.
        } catch (e) {
            console.error('Failed to finish task at limit:', e);
            setError('Nepavyko užbaigti užduoties. Bandykite dar kartą.');
            setFinishing(false);
        }
    };

    const onPickPhotos = (e) => {
        const picked = Array.from(e.target.files || []).filter((f) => f.type.startsWith('image/'));
        e.target.value = '';
        if (!picked.length) return;
        setError('');
        setPhotos((prev) => {
            const room = MAX_REQUEST_PHOTOS - prev.length;
            if (room <= 0) {
                setError(`Daugiausia ${MAX_REQUEST_PHOTOS} nuotraukos.`);
                return prev;
            }
            const next = picked.slice(0, room).map((file) => ({ file, url: URL.createObjectURL(file) }));
            return [...prev, ...next];
        });
    };

    const removePhoto = (idx) => {
        setPhotos((prev) => {
            const target = prev[idx];
            if (target) URL.revokeObjectURL(target.url);
            return prev.filter((_, i) => i !== idx);
        });
    };

    const handleSendRequest = async () => {
        if (submitting) return;
        setError('');
        setSubmitting(true);
        try {
            let attachmentUrls = [];
            if (photos.length && uid) {
                attachmentUrls = await uploadAttachments(photos.map((p) => p.file), uid);
            }
            await onRequestExtension?.({ commentText: comment, attachmentUrls });
            // Success → parent unmounts the popup.
        } catch (e) {
            console.error('Failed to send time-extension request:', e);
            setError(
                e?.message === 'no-manager'
                    ? 'Šiai užduočiai nepriskirtas koordinatorius, todėl pratęsimo prašyti negalima. Užbaikite užduotį.'
                    : 'Nepavyko išsiųsti užklausos. Bandykite dar kartą.'
            );
            setSubmitting(false);
        }
    };

    const busy = finishing || submitting;

    return (
        <Modal
            open
            // Forced decision: no Escape / backdrop dismiss. The worker must request more time or
            // finish. Focus the lead action on open and trap Tab. WCAG 2.4.3.
            dismissible={false}
            bare
            level="top"
            size="md"
            role="alertdialog"
            ariaLabelledby="time-limit-title"
            initialFocusRef={mode === 'request' ? requestRef : primaryRef}
        >
            {/* Header — danger token (red-600 → red-700) so the white title clears WCAG 1.4.3. */}
            <div className="flex flex-shrink-0 items-center gap-3 bg-gradient-to-r from-feedback-danger to-feedback-danger-hover px-6 py-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/20 backdrop-blur-sm">
                    <XOctagon className="h-6 w-6 text-white" aria-hidden="true" />
                </div>
                <h2 id="time-limit-title" className="text-h3 font-bold text-white">Laikas baigėsi</h2>
            </div>

            {/* Body */}
            <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
                <p className="text-body font-medium leading-relaxed text-ink-strong">
                    Laikas skirtas užduočiai „{task.title}“ atlikti baigėsi.
                </p>

                {/* Planned vs actual — the numbers the worker needs to judge the overrun. */}
                {(estimatedTime || Number.isFinite(actualMinutes)) && (
                    <div className="rounded-control bg-surface-sunken px-3 py-2 text-body">
                        <div className="flex items-center justify-between">
                            <span className="text-ink-muted">Planuota</span>
                            <span className="font-semibold text-ink-strong">{estimatedTime || '—'}</span>
                        </div>
                        <div className="mt-1 flex items-center justify-between">
                            <span className="text-ink-muted">Sugaišta</span>
                            <span className="font-semibold text-ink-strong">
                                {Number.isFinite(actualMinutes) ? formatMinutesToTimeString(actualMinutes) : '—'}
                            </span>
                        </div>
                    </div>
                )}

                <div className="flex items-center gap-2 rounded-control bg-feedback-danger/10 px-3 py-2 text-body font-semibold text-feedback-danger">
                    <PauseCircle className="h-5 w-5 flex-shrink-0" aria-hidden="true" />
                    Veikla automatiškai sustabdyta.
                </div>

                {mode === 'choice' ? (
                    <p className="text-body text-ink-muted">
                        {canRequestExtension
                            ? 'Pasirinkite: prašyti koordinatoriaus pratęsti laiką ar užbaigti užduotį.'
                            : isSelfManaged
                                ? 'Jūs pats prižiūrite šią užduotį — užbaikite ją arba pratęskite numatytą laiką ją redaguodami.'
                                : 'Šiai užduočiai nepriskirtas koordinatorius — galite užbaigti užduotį.'}
                    </p>
                ) : (
                    <div className="space-y-3">
                        <label htmlFor="ext-comment" className="block text-body font-medium text-ink-strong">
                            Komentaras koordinatoriui <span className="font-normal text-ink-muted">(neprivaloma)</span>
                        </label>
                        <textarea
                            id="ext-comment"
                            value={comment}
                            onChange={(e) => setComment(e.target.value)}
                            maxLength={2000}
                            rows={3}
                            placeholder="Pvz.: reikia dar valandos, nes atsirado papildomų darbų."
                            className="w-full resize-none rounded-input border border-line bg-surface-card px-3 py-2 text-body text-ink placeholder:text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1"
                        />

                        {/* Photo attachments */}
                        {photos.length > 0 && (
                            <div className="flex flex-wrap gap-2">
                                {photos.map((p, idx) => (
                                    <div key={p.url} className="relative h-16 w-16 overflow-hidden rounded-control border border-line">
                                        <img src={p.url} alt={`Priedas ${idx + 1}`} className="h-full w-full object-cover" />
                                        {/* Tap target is the full ≥44px button (WCAG 2.5.5); it
                                            sits inside the corner so the tile's overflow-hidden
                                            doesn't clip it, and the visible ~20px circle is pinned
                                            to the top-right via justify-end/items-start so the glyph
                                            stays in the corner while the hit area spans inward. */}
                                        <button
                                            type="button"
                                            onClick={() => removePhoto(idx)}
                                            aria-label="Pašalinti nuotrauką"
                                            className="absolute right-0 top-0 inline-flex min-h-touch min-w-touch items-start justify-end p-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
                                        >
                                            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white">
                                                <X className="h-3 w-3" aria-hidden="true" />
                                            </span>
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}

                        {photos.length < MAX_REQUEST_PHOTOS && (
                            <>
                                <input
                                    ref={fileInputRef}
                                    type="file"
                                    accept="image/*"
                                    capture="environment"
                                    multiple
                                    onChange={onPickPhotos}
                                    className="hidden"
                                />
                                <Button
                                    variant="secondary"
                                    icon={Camera}
                                    onClick={() => fileInputRef.current?.click()}
                                    disabled={busy}
                                >
                                    Pridėti nuotrauką
                                </Button>
                            </>
                        )}
                    </div>
                )}

                {error && (
                    <p className="text-body font-medium text-feedback-danger" role="alert">{error}</p>
                )}
            </div>

            {/* Footer — actions depend on the mode. */}
            {mode === 'choice' ? (
                <div className="flex flex-shrink-0 flex-col gap-2 px-6 pb-5">
                    {canRequestExtension && (
                        <Button
                            ref={primaryRef}
                            variant="primary"
                            icon={Hourglass}
                            className="w-full"
                            disabled={busy}
                            onClick={() => { setError(''); setMode('request'); }}
                        >
                            Prašyti laiko pratęsimo
                        </Button>
                    )}
                    <Button
                        ref={canRequestExtension ? undefined : primaryRef}
                        variant={canRequestExtension ? 'secondary' : 'primary'}
                        icon={CheckCircle2}
                        className="w-full"
                        loading={finishing}
                        disabled={busy}
                        onClick={handleFinish}
                    >
                        Užbaigti užduotį
                    </Button>
                    <div className="flex justify-center pt-1">
                        <button
                            type="button"
                            onClick={handleMute}
                            disabled={muted}
                            className="inline-flex min-h-touch items-center gap-1.5 px-3 text-body text-ink-muted hover:text-ink-strong disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                        >
                            <BellOff className="h-4 w-4" aria-hidden="true" />
                            {muted ? 'Nutildyta' : 'Nutildyti garsą'}
                        </button>
                    </div>
                </div>
            ) : (
                <div className="flex flex-shrink-0 justify-end gap-2 px-6 pb-5">
                    <Button
                        variant="secondary"
                        icon={ArrowLeft}
                        disabled={busy}
                        onClick={() => { setError(''); setMode('choice'); }}
                    >
                        Atgal
                    </Button>
                    <Button
                        ref={requestRef}
                        variant="primary"
                        icon={Send}
                        loading={submitting}
                        disabled={busy}
                        onClick={handleSendRequest}
                    >
                        Siųsti užklausą
                    </Button>
                </div>
            )}
        </Modal>
    );
}
