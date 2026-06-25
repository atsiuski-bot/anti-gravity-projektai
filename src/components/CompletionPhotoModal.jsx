import { useState, useRef, useEffect } from 'react';
import { Camera, ImagePlus, X, CheckCircle2 } from 'lucide-react';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { uploadAttachments } from '../utils/attachmentUpload';
import { notifyMany } from '../utils/notify';
import { logError } from '../utils/errorLog';
import { useAuth } from '../context/AuthContext';
import Modal from './ui/Modal';
import Button from './ui/Button';

// A work-end proof photo is usually one or two shots, not the task's full gallery — keep the cap low.
const MAX_COMPLETION_PHOTOS = 6;

/**
 * Post-finish nudge: once a worker finishes their OWN task, invite them to attach a "work-end" photo
 * — the documented result of the job. These land in the task's dedicated `completionPhotoUrls` field
 * (kept SEPARATE from `attachmentUrls`, the before/during-work photos), which is what the
 * "Dokumentuoja darbą" badge counts. The first photo on a completed task earns the badge edge
 * server-side (functions onTaskFinishedBadge); adding more never re-counts.
 *
 * Deliberately SKIPPABLE — not every job has a photographable result, and a worker with no camera
 * must never be trapped (WCAG 2.1.2 / no dead end). "Praleisti" closes it with no write. The prompt
 * is a gentle encouragement, not a gate, in keeping with the calm-canvas design system.
 *
 * @param {Object}   props
 * @param {Object}   props.task     the just-finished task (lives in `tasks/`)
 * @param {Function} props.onClose  called after skip OR a successful save (the parent unmounts us)
 */
export default function CompletionPhotoModal({ task, onClose }) {
    const { currentUser } = useAuth();
    const [photos, setPhotos] = useState([]); // { file, url } previews
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const cameraRef = useRef(null);
    const galleryRef = useRef(null);

    // Mirror the latest previews in a ref so the unmount cleanup can revoke them WITHOUT re-running
    // on every pick (a deps-on-photos effect would tear down/recreate object URLs mid-session). The
    // normal close paths (removePhoto / closeAndCleanup) already revoke; this only catches the modal
    // being unmounted while still open (e.g. the parent navigates away) so no blob URL is orphaned.
    const photosRef = useRef(photos);
    photosRef.current = photos;
    useEffect(() => () => photosRef.current.forEach((p) => URL.revokeObjectURL(p.url)), []);

    if (!task) return null;

    const onPickPhotos = (e) => {
        const picked = Array.from(e.target.files || []).filter((f) => f.type.startsWith('image/'));
        e.target.value = '';
        if (!picked.length) return;
        setError('');
        setPhotos((prev) => {
            const room = MAX_COMPLETION_PHOTOS - prev.length;
            if (room <= 0) {
                setError(`Daugiausia ${MAX_COMPLETION_PHOTOS} nuotraukos.`);
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

    // Revoke any object URLs we created, then hand control back to the parent.
    const closeAndCleanup = () => {
        photos.forEach((p) => URL.revokeObjectURL(p.url));
        onClose?.();
    };

    const handleSave = async () => {
        if (saving || !photos.length || !currentUser) return;
        setError('');
        setSaving(true);
        try {
            const urls = await uploadAttachments(photos.map((p) => p.file), currentUser.uid);
            await updateDoc(doc(db, 'tasks', task.id), {
                // Append to the SEPARATE completion-photo field, never the regular attachmentUrls.
                completionPhotoUrls: [...(task.completionPhotoUrls || []), ...urls],
                updatedAt: new Date().toISOString(),
            });
            // Let the manager know a work-end photo landed (same spine as a regular new photo);
            // notifyMany de-dupes and drops the uploader so it never echoes back to the worker.
            await notifyMany([task.managerId, task.assignedUserId], {
                type: 'new_photo',
                taskId: task.id,
                taskTitle: task.title || 'Užduotis',
                actorUid: currentUser.uid,
                actorName: currentUser.displayName || currentUser.email,
            });
            closeAndCleanup();
        } catch (err) {
            logError(err, { source: 'CompletionPhotoModal.handleSave' });
            setError('Nepavyko įkelti nuotraukos. Bandykite dar kartą.');
            setSaving(false);
        }
    };

    return (
        <Modal open onClose={closeAndCleanup} bare size="md" ariaLabelledby="completion-photo-title">
            {/* Header — success token: the task is done, this is the celebratory wrap-up beat. */}
            <div className="flex flex-shrink-0 items-center gap-3 border-b border-line px-6 py-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-feedback-success-soft">
                    <CheckCircle2 className="h-6 w-6 text-feedback-success-text" aria-hidden="true" />
                </div>
                <h2 id="completion-photo-title" className="text-h3 font-bold text-ink-strong">
                    Pridėkite darbo pabaigos nuotrauką
                </h2>
            </div>

            {/* Body */}
            <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
                <p className="text-body leading-relaxed text-ink">
                    Užduotis „{task.title}“ užbaigta. Užfiksuokite rezultatą — pabaigos nuotrauka rodoma
                    atskirai nuo darbo eigos nuotraukų ir patvirtina atliktą darbą.
                </p>

                {photos.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                        {photos.map((p, idx) => (
                            <div key={p.url} className="relative h-20 w-20 overflow-hidden rounded-control border border-line">
                                <img src={p.url} alt={`Pabaigos nuotrauka ${idx + 1}`} className="h-full w-full object-cover" />
                                <button
                                    type="button"
                                    onClick={() => removePhoto(idx)}
                                    aria-label={`Pašalinti nuotrauką ${idx + 1}`}
                                    className="absolute right-0.5 top-0.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                                >
                                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                                </button>
                            </div>
                        ))}
                    </div>
                )}

                {photos.length < MAX_COMPLETION_PHOTOS && (
                    <div className="flex flex-wrap gap-2">
                        <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="sr-only" onChange={onPickPhotos} disabled={saving} />
                        <input ref={galleryRef} type="file" accept="image/*" multiple className="sr-only" onChange={onPickPhotos} disabled={saving} />
                        <Button variant="secondary" icon={Camera} onClick={() => cameraRef.current?.click()} disabled={saving}>
                            Fotografuoti
                        </Button>
                        <Button variant="secondary" icon={ImagePlus} onClick={() => galleryRef.current?.click()} disabled={saving}>
                            Pridėti
                        </Button>
                    </div>
                )}

                {error && (
                    <p role="alert" className="rounded-control border border-feedback-danger-border bg-feedback-danger-soft px-3 py-2 text-caption font-medium text-feedback-danger-text">
                        {error}
                    </p>
                )}
            </div>

            {/* Footer — skip stays available throughout (never a dead end); save is gated on a pick. */}
            <div className="flex flex-shrink-0 items-center justify-end gap-2 border-t border-line bg-surface-sunken px-6 py-4">
                <Button variant="ghost" onClick={closeAndCleanup} disabled={saving}>
                    Praleisti
                </Button>
                <Button variant="primary" icon={CheckCircle2} loading={saving} disabled={!photos.length || saving} onClick={handleSave}>
                    Išsaugoti
                </Button>
            </div>
        </Modal>
    );
}
