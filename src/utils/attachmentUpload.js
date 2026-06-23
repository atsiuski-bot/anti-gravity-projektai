import { ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage';
import { storage } from '../firebase';
import { compressImage } from './imageUtils';

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
 * Compress then upload a batch of image files; resolves to their download URLs in order.
 *
 * @param {File[]} files - selected image files
 * @param {string} uid - uploader uid (the folder owner the Storage rules scope to)
 * @returns {Promise<string[]>} download URLs
 */
export async function uploadAttachments(files, uid) {
    const compressed = await Promise.all(files.map((f) => compressImage(f)));
    return Promise.all(compressed.map((f) => uploadOne(f, uid)));
}
