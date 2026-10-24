const MAX_EDGE = 2048; // 手机、平板、笔记本全屏都够清晰，单张约 0.3–1.2 MB（细节多的照片更大）
const QUALITY = 0.85;
const THUMB_EDGE = 200;

/**
 * 在浏览器里把照片缩小并重新编码为 JPEG。
 * 重新编码会丢掉 EXIF（包括 GPS 位置），方向则由浏览器在绘制时按 EXIF 摆正。
 */
export async function prepareImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    const full = await encode(img, MAX_EDGE, QUALITY);
    const thumb = await encode(img, THUMB_EDGE, 0.7);
    return { full, thumb };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function encode(img, maxEdge, quality) {
  const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#fff'; // 透明 PNG 转 JPEG 时垫白底
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => {
        canvas.width = canvas.height = 0; // iOS 上尽快释放画布内存
        blob ? resolve(blob) : reject(new Error('encode_failed'));
      },
      'image/jpeg',
      quality,
    ),
  );
}
