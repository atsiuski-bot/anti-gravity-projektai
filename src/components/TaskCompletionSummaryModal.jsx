import { useState, useRef, useEffect, useMemo } from 'react';
import { doc, updateDoc } from 'firebase/firestore';
import { CheckCircle2 } from 'lucide-react';
import { db } from '../firebase';
import { useAuth } from '../context/AuthContext';
import { uploadAttachments, padThumbs } from '../utils/attachmentUpload';
import { notifyMany } from '../utils/notify';
import { logError } from '../utils/errorLog';
import { parseTimeStringToMinutes } from '../utils/timeUtils';
import { buildPlanVerdict, hasVerdictContent } from '../utils/planPerformance';
import useSimilarTaskHistory from '../hooks/useSimilarTaskHistory';
import Modal from './ui/Modal';
import Button from './ui/Button';
import PlanPerformanceSummary from './task/PlanPerformanceSummary';
import EarningsBreakdown from './task/EarningsBreakdown';
import CompletionPhotoPicker from './task/CompletionPhotoPicker';

/**
 * TaskCompletionSummaryModal — the single card a worker sees after finishing a task.
 *
 * Replaces a CHAIN of two pop-ups (the work-end photo prompt, then the earnings breakdown) with one
 * card in a fixed, deliberate order:
 *
 *      fact  →  plan  →  money  →  photo
 *
 * The order carries the product decision. WORKZ pays by the hour on rising monthly tiers, so a fast
 * finish earns LESS. The plan verdict therefore comes FIRST and speaks only about the plan, and the
 * money sits below it as a separate, uncoloured fact — the two are never joined into a claim that
 * being quick was worth something financially, because it was not. See PlanPerformanceSummary for
 * the copy rules and planPerformance.js for why "smaller percentage" is never scored.
 *
 * The photo section stays skippable and stays LAST: it is the only part that writes anything.
 *
 * @param {Object}   props.task          the just-finished task
 * @param {number}   props.totalMinutes  its final duration
 * @param {boolean}  props.withPhoto     offer the work-end proof photo (worker's own task only)
 * @param {Function} props.onClose       parent unmounts us
 */
export default function TaskCompletionSummaryModal({ task, totalMinutes, withPhoto = false, onClose }) {
    const { currentUser } = useAuth();
    const [photos, setPhotos] = useState([]); // { file, url } previews
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');

    // Mirror the latest previews in a ref so the unmount cleanup can revoke them WITHOUT re-running
    // on every pick (a deps-on-photos effect would tear down/recreate object URLs mid-session). The
    // normal close paths already revoke; this only catches the modal being unmounted while still
    // open (e.g. the parent navigates away) so no blob URL is orphaned.
    const photosRef = useRef(photos);
    photosRef.current = photos;
    useEffect(() => () => photosRef.current.forEach((p) => URL.revokeObjectURL(p.url)), []);

    const estimatedMinutes = useMemo(() => {
        const stored = Number(task?.estimatedTimeMinutes);
        if (Number.isFinite(stored) && stored > 0) return stored;
        return parseTimeStringToMinutes(task?.estimatedTime || '');
    }, [task?.estimatedTimeMinutes, task?.estimatedTime]);

    // The worker's own past runs of the SAME work — never a colleague's, never the manager's guess.
    const { priorMinutes } = useSimilarTaskHistory({
        task,
        uid: currentUser?.uid,
        enabled: !!task && !!currentUser?.uid,
    });

    const verdict = useMemo(
        () => buildPlanVerdict({ actualMinutes: totalMinutes, estimatedMinutes, priorMinutes }),
        [totalMinutes, estimatedMinutes, priorMinutes]
    );

    if (!task) return null;

    // Revoke any object URLs we created, then hand control back to the parent.
    const closeAndCleanup = () => {
        photos.forEach((p) => URL.revokeObjectURL(p.url));
        onClose?.();
    };

    const handleSavePhotos = async () => {
        if (saving || !photos.length || !currentUser) return;
        setError('');
        setSaving(true);
        try {
            const { urls, thumbUrls } = await uploadAttachments(photos.map((p) => p.file), currentUser.uid);
            await updateDoc(doc(db, 'tasks', task.id), {
                // Append to the SEPARATE completion-photo field, never the regular attachmentUrls.
                completionPhotoUrls: [...(task.completionPhotoUrls || []), ...urls],
                // Index-aligned gallery renditions. Padded to the CURRENT url count first, so photos
                // added before thumbnails existed keep their slots (and fall back to the original)
                // instead of shifting every later thumb onto the wrong photo.
                completionPhotoThumbUrls: [
                    ...padThumbs(task.completionPhotoThumbUrls, (task.completionPhotoUrls || []).length),
                    ...thumbUrls,
                ],
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
            logError(err, { source: 'TaskCompletionSummaryModal.handleSavePhotos' });
            setError('Nepavyko įkelti nuotraukos. Bandykite dar kartą.');
            setSaving(false);
        }
    };

    const hasPickedPhotos = withPhoto && photos.length > 0;

    return (
        <Modal open onClose={closeAndCleanup} bare size="md" ariaLabelledby="completion-summary-title">
            {/* Header — success token: the task is done, this is the wrap-up beat. */}
            <div className="flex flex-shrink-0 items-center gap-3 border-b border-line px-6 py-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-feedback-success-soft">
                    <CheckCircle2 className="h-6 w-6 text-feedback-success-text" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                    <h2 id="completion-summary-title" className="text-h3 font-bold text-ink-strong">
                        Veikla užbaigta
                    </h2>
                    <p className="truncate text-caption text-ink-muted">{task.title || 'Veikla'}</p>
                </div>
            </div>

            {/* Body — fact, then plan, then money, then photo. The order is the decision. */}
            <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
                {hasVerdictContent(verdict) || totalMinutes > 0 ? (
                    <PlanPerformanceSummary
                        verdict={verdict}
                        totalMinutes={totalMinutes}
                        estimatedMinutes={estimatedMinutes}
                    />
                ) : null}

                <EarningsBreakdown task={task} totalMinutes={totalMinutes} />

                {withPhoto && (
                    <div className="space-y-3 border-t border-line pt-4">
                        <h3 className="text-body font-semibold text-ink-strong">Darbo pabaigos nuotrauka</h3>
                        <CompletionPhotoPicker
                            photos={photos}
                            onChange={setPhotos}
                            onError={setError}
                            disabled={saving}
                        />
                    </div>
                )}

                {error && (
                    <p role="alert" className="rounded-control border border-feedback-danger-border bg-feedback-danger-soft px-3 py-2 text-caption font-medium text-feedback-danger-text">
                        {error}
                    </p>
                )}
            </div>

            {/* Footer — the save button appears only once a photo is picked; otherwise this card is
                purely informational and closes with one tap. */}
            <div className="flex flex-shrink-0 items-center justify-end gap-2 border-t border-line bg-surface-sunken px-6 py-4">
                {hasPickedPhotos ? (
                    <>
                        <Button variant="ghost" onClick={closeAndCleanup} disabled={saving}>
                            Praleisti
                        </Button>
                        <Button variant="primary" icon={CheckCircle2} loading={saving} disabled={saving} onClick={handleSavePhotos}>
                            Išsaugoti
                        </Button>
                    </>
                ) : (
                    <Button variant="primary" fullWidth onClick={closeAndCleanup}>
                        Gerai
                    </Button>
                )}
            </div>
        </Modal>
    );
}
