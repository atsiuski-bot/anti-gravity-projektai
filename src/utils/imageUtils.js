/**
 * Compresses and resizes an image file.
 * 
 * @param {File} file - The original image file.
 * @param {number} maxWidth - Maximum width in pixels.
 * @param {number} maxHeight - Maximum height in pixels.
 * @param {number} quality - JPEG quality (0 to 1).
 * @returns {Promise<File>} - A Promise resolving to the compressed File object.
 */
export const compressImage = (file, maxWidth = 3000, maxHeight = 3000, quality = 0.8) => {
    return new Promise((resolve, reject) => {
        // If it's not an image, return original
        if (!file.type.match(/image.*/)) {
            resolve(file);
            return;
        }

        const image = new Image();
        // Keep the blob URL in a local so every exit path can release it. An unrevoked URL pins
        // the whole original file in memory until the document is discarded — and this PWA is a
        // single document a worker keeps open all shift, so a dozen 5 MB phone photos never come
        // back and the OS grows more likely to evict the app (which is what orphans running
        // timers). Revoking once the decode has finished or failed is safe: the decoded bitmap is
        // already held by the image element, independent of the URL.
        const objectUrl = URL.createObjectURL(file);
        image.src = objectUrl;

        image.onload = () => {
            URL.revokeObjectURL(objectUrl);

            let width = image.width;
            let height = image.height;

            // Calculate new dimensions
            if (width > height) {
                if (width > maxWidth) {
                    height = Math.round((height * maxWidth) / width);
                    width = maxWidth;
                }
            } else {
                if (height > maxHeight) {
                    width = Math.round((width * maxHeight) / height);
                    height = maxHeight;
                }
            }

            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;

            const ctx = canvas.getContext('2d');
            ctx.drawImage(image, 0, 0, width, height);

            canvas.toBlob((blob) => {
                if (!blob) {
                    reject(new Error('Canvas is empty'));
                    return;
                }

                // Create a new File from the blob, preserving the original name and modification date
                const newFile = new File([blob], file.name, {
                    type: 'image/jpeg',
                    lastModified: Date.now(),
                });

                resolve(newFile);
            }, 'image/jpeg', quality);
        };

        image.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            // The browser hands onerror a bare DOM Event, not an Error — no message, no stack — so
            // the crash log used to record only {"isTrusted":true} with nothing identifying the
            // photo. Reject with a real Error naming the file instead: this path is reached by an
            // iPhone HEIC/HEIF (Chrome on Android cannot decode it in an <img>) and by any
            // truncated/corrupt photo, and the filename is the only thing that tells the worker —
            // and the manager reading error_logs — which picture to drop from the selection.
            reject(new Error(`Nepavyko apdoroti nuotraukos ${file.name}`));
        };
    });
};

// ── Gallery thumbnails ──────────────────────────────────────────────────────────────────────────
//
// Every photo surface in the app draws its tiles at 64–96 CSS px, but until now each tile was the
// FULL stored image: a ~3000px, ~0.8-quality JPEG, routinely 1–2 MB. Opening one task with eight
// photos therefore pulled ~10 MB over a field worker's mobile data to paint eight postage stamps —
// and the same bytes again on the next task, because nothing is shared between them.
//
// So a second, small rendition is uploaded ALONGSIDE the original and stored in a parallel array.
// The original is untouched (the lightbox still opens the full-resolution photo, which is the whole
// point of keeping 3000px), and the array is additive: a task saved before this change simply has
// no thumb entry and every reader falls back to the original, exactly as it behaves today.
//
// 480px at q0.6 covers a 96px tile at 3× DPR with headroom, and lands around 30–60 kB — roughly a
// 30× reduction per tile.
export const THUMB_MAX_PX = 480;
export const THUMB_QUALITY = 0.6;

/**
 * A small rendition of an already-compressed image, for gallery tiles.
 * Returns null when the browser cannot produce one (HEIC, a corrupt file) — never throws, because a
 * missing thumbnail must degrade to "show the original", never to a failed upload.
 *
 * @param {File} file - preferably the COMPRESSED file, so the work is a cheap second downscale.
 * @returns {Promise<File|null>}
 */
export const makeThumbnail = async (file) => {
    try {
        return await compressImage(file, THUMB_MAX_PX, THUMB_MAX_PX, THUMB_QUALITY);
    } catch {
        return null;
    }
};
