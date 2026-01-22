/**
 * Compresses an image file by resizing and converting to WebP format
 *
 * @param file - Original image file
 * @param maxDimension - Maximum width or height (default: 1920px)
 * @param quality - WebP quality 0-1 (default: 0.8)
 * @returns Compressed image as Blob
 */
export async function compressImage(
  file: File,
  maxDimension: number = 1920,
  quality: number = 0.7
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);

    img.onload = () => {
      try {
        // Clean up object URL
        URL.revokeObjectURL(objectUrl);

        // Calculate new dimensions maintaining aspect ratio
        let width = img.width;
        let height = img.height;

        if (width > maxDimension || height > maxDimension) {
          if (width > height) {
            height = (height / width) * maxDimension;
            width = maxDimension;
          } else {
            width = (width / height) * maxDimension;
            height = maxDimension;
          }
        }

        // Create canvas and draw resized image
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");

        if (!ctx) {
          reject(new Error("Failed to get canvas context"));
          return;
        }

        ctx.drawImage(img, 0, 0, width, height);

        // Convert to WebP blob
        canvas.toBlob(
          (blob) => {
            if (blob) {
              resolve(blob);
            } else {
              reject(new Error("Failed to create compressed image blob"));
            }
          },
          "image/webp",
          quality
        );
      } catch (error) {
        reject(error);
      }
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Failed to load image"));
    };

    img.src = objectUrl;
  });
}
