import { ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage';
import { storage } from '../firebase';
import { compressImage, makeThumbnail } from './imageUtils';

/**
 * Photo attachment upload, shared by the create/edit form and the task preview sheet so a photo
 * added from either path lands in the same place with the same per-uploader scoping the Storage
 * rules expect. The file goes under `attachments/<uid>/…`; viewers later read it via the
 * tokenized download URL saved on the task document.
 */
export const MAX_ATTACHMENTS = 8;

function uploadOne(file, uid) {
    return new Promise((resolve, reject) => {
        const fileId = `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        const storageRef = ref(storage, `attachments/${uid}/${fileId}_${file.name}`);
        const uploadTask = uploadBytesResumable(storageRef, file, { contentType: file.type });
        uploadTask.on(
            'state_changed',
            null,
            (error) => {
                if (error.code === 'storage/unauthorized') {
                    reject(new Error(`Neturite teisių įkelti failo ${file.name}`));
                } else {
                    reject(new Error(`Nepavyko įkelti ${file.name}`));
                }
            },
            () => getDownloadURL(uploadTask.snapshot.ref).then(resolve).catch(reject)
        );
    });
}

/**
 * Compress then upload a batch of image files, each with a small gallery rendition beside it.
 *
 * `thumbUrls` is INDEX-ALIGNED with `urls`, and a slot may be null when the browser could not
 * produce a thumbnail. Callers must never treat a missing thumb as an error — `withThumbs` below is
 * the one place that resolves the fallback, so "no thumb" always means "use the original".
 *
 * A failed THUMB upload is swallowed for the same reason: the original already landed, and losing
 * the photo because its preview failed would be a far worse outcome than fetching a big tile.
 *
 * @param {File[]} files - selected image files
 * @param {string} uid - uploader uid (the folder owner the Storage rules scope to)
 * @returns {Promise<{urls: string[], thumbUrls: Array<string|null>}>}
 */
export async function uploadAttachments(files, uid) {
    const compressed = await Promise.all(files.map((f) => compressImage(f)));
    const urls = await Promise.all(compressed.map((f) => uploadOne(f, uid)));
    const thumbUrls = await Promise.all(compressed.map(async (f) => {
        const thumb = await makeThumbnail(f);
        if (!thumb) return null;
        try {
            return await uploadOne(thumb, uid);
        } catch {
            return null;
        }
    }));
    return { urls, thumbUrls };
}

/**
 * Pair stored photo URLs with their gallery renditions.
 *
 * The ONE place the fallback lives, so no reader has to know the thumb array may be shorter, hold
 * nulls, or be absent entirely (every task saved before thumbnails existed). Tiles render `thumb`;
 * anything that opens the photo full-size must use `url`.
 *
 * @param {string[]} urls
 * @param {Array<string|null>} [thumbs]
 * @returns {Array<{url: string, thumb: string}>}
 */
export const withThumbs = (urls = [], thumbs = []) =>
    (urls || []).map((url, i) => ({ url, thumb: (Array.isArray(thumbs) && thumbs[i]) || url }));

/**
 * Grow (or trim) a stored thumb array to exactly `count` slots before appending new ones.
 *
 * Alignment is positional, and the two arrays start out DIFFERENT lengths on every task that
 * already had photos when thumbnails shipped: urls has N entries, thumbs has none. Appending to the
 * short array would put the first new thumb at index 0 — pairing a freshly-uploaded preview with
 * the oldest photo. Padding with nulls keeps every existing photo on the "no thumb → use the
 * original" path and puts the new ones where they belong.
 */
export const padThumbs = (thumbs, count) => {
    const existing = Array.isArray(thumbs) ? thumbs.slice(0, count) : [];
    return existing.concat(new Array(Math.max(0, count - existing.length)).fill(null));
};
