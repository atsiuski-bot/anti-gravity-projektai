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
        image.src = URL.createObjectURL(file);

        image.onload = () => {
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

        image.onerror = (error) => {
            reject(error);
        };
    });
};
