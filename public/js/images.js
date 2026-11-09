const MAX_EDGE = 2048; // 原画质：手机全屏看够清晰（iPhone 上最多显示约 1700 px），单张约 0.3–1.2 MB
const QUALITY = 0.85;
// 大一档的原画质，给 Mac、iPad 这类大屏幕全屏看，约 1–2.5 MB。只给正在看的那张，两边直连时才生成（plan.js）
const LARGE_EDGE = 3072;
// 预览：每次翻页先发这张小图，约 50 KB，经中转也很快到；手机上看已经比较清楚，原画质随后换上
const PREVIEW_EDGE = 960;
const PREVIEW_QUALITY = 0.65;
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
    const edge = Math.max(img.naturalWidth, img.naturalHeight);
    const full = await encode(img, MAX_EDGE, QUALITY);
    const preview = await encode(img, PREVIEW_EDGE, PREVIEW_QUALITY);
    const thumb = await encode(img, THUMB_EDGE, 0.7);
    // fullEdge：原画质的长边。原图比原画质大不少时，才值得给大屏幕另做一份（large）
    return { full, preview, thumb, fullEdge: Math.min(edge, MAX_EDGE), large: edge > MAX_EDGE * 1.15 };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 从处理好的照片生成预览。暂存的照片没有预览时（旧版本存的）用。 */
export const previewOf = (blob) => reencode(blob, PREVIEW_EDGE, PREVIEW_QUALITY);

/** 从原图生成大一档的原画质，给大屏幕用。 */
export const largeOf = (file) => reencode(file, LARGE_EDGE, QUALITY);

async function reencode(blob, maxEdge, quality) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return await encode(img, maxEdge, quality);
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
