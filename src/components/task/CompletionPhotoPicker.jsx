import { useRef } from 'react';
import { Camera, ImagePlus, X } from 'lucide-react';
import Button from '../ui/Button';

// A work-end proof photo is usually one or two shots, not the task's full gallery — keep the cap low.
export const MAX_COMPLETION_PHOTOS = 6;

/**
 * CompletionPhotoPicker — the pick/preview/remove half of the work-end proof photo prompt,
 * extracted from the old standalone CompletionPhotoModal so it can be ONE SECTION of the finish
 * summary instead of a separate pop-up ahead of it.
 *
 * Presentational and fully controlled: the parent owns the picked list (and therefore the upload
 * and the footer buttons that trigger it), because the save action lives in the summary's shared
 * footer. Photos stay entirely OPTIONAL — not every job has a photographable result and a worker
 * with no camera must never be trapped (WCAG 2.1.2 / no dead end).
 *
 * @param {{file: File, url: string}[]} props.photos  picked previews, owned by the parent
 * @param {Function} props.onChange   receives the next preview list
 * @param {Function} props.onError    receives a Lithuanian message when the cap is hit
 * @param {boolean}  props.disabled   true while an upload is in flight
 */
export default function CompletionPhotoPicker({ photos, onChange, onError, disabled }) {
    const cameraRef = useRef(null);
    const galleryRef = useRef(null);

    const onPickPhotos = (e) => {
        const picked = Array.from(e.target.files || []).filter((f) => f.type.startsWith('image/'));
        e.target.value = '';
        if (!picked.length) return;
        const room = MAX_COMPLETION_PHOTOS - photos.length;
        if (room <= 0) {
            onError?.(`Daugiausia ${MAX_COMPLETION_PHOTOS} nuotraukos.`);
            return;
        }
        onError?.('');
        onChange([...photos, ...picked.slice(0, room).map((file) => ({ file, url: URL.createObjectURL(file) }))]);
    };

    const removePhoto = (idx) => {
        const target = photos[idx];
        if (target) URL.revokeObjectURL(target.url);
        onChange(photos.filter((_, i) => i !== idx));
    };

    return (
        <div className="space-y-3">
            <p className="text-body text-ink">
                Užfiksuokite rezultatą — pabaigos nuotrauka rodoma atskirai nuo darbo eigos nuotraukų
                ir patvirtina atliktą darbą.
            </p>

            {photos.length > 0 && (
                <div className="flex flex-wrap gap-2">
                    {photos.map((p, idx) => (
                        <div key={p.url} className="relative h-20 w-20 overflow-hidden rounded-control border border-line bg-surface-sunken">
                            {/* object-contain (not -cover) so a tall phone photo shows whole, not just its
                                middle; the sunken canvas fills the letterbox bands around it. */}
                            <img src={p.url} alt={`Pabaigos nuotrauka ${idx + 1}`} className="h-full w-full object-contain" />
                            <button
                                type="button"
                                onClick={() => removePhoto(idx)}
                                aria-label={`Pašalinti nuotrauką ${idx + 1}`}
                                // Visible badge stays small so it doesn't smother the 80px thumb, but a
                                // centred pseudo-element (±10px) gives it a ≥44px tap area (DESIGN_SYSTEM §7).
                                className="absolute right-0.5 top-0.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-ring before:absolute before:-inset-[10px] before:content-['']"
                            >
                                <X className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                        </div>
                    ))}
                </div>
            )}

            {photos.length < MAX_COMPLETION_PHOTOS && (
                <div className="flex flex-wrap gap-2">
                    <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="sr-only" onChange={onPickPhotos} disabled={disabled} />
                    <input ref={galleryRef} type="file" accept="image/*" multiple className="sr-only" onChange={onPickPhotos} disabled={disabled} />
                    <Button variant="secondary" icon={Camera} onClick={() => cameraRef.current?.click()} disabled={disabled}>
                        Fotografuoti
                    </Button>
                    <Button variant="secondary" icon={ImagePlus} onClick={() => galleryRef.current?.click()} disabled={disabled}>
                        Pridėti
                    </Button>
                </div>
            )}
        </div>
    );
}
