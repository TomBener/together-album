const SHIFT_PX = 36;

/** 两层 <img> 交替淡入淡出，翻页方向决定滑入方向，像翻相册。 */
export function createStage(frame) {
  const layers = [...frame.querySelectorAll('.photo')];
  let front = 0;
  let token = 0;
  let shown = null;

  return {
    async show(src, direction = 0) {
      if (src === shown) return;
      const t = ++token;
      const incoming = layers[1 - front];
      const outgoing = layers[front];

      incoming.classList.add('no-anim');
      incoming.classList.remove('is-front');
      incoming.style.setProperty('--shift', `${direction * SHIFT_PX}px`);
      incoming.src = src;
      try {
        await incoming.decode();
      } catch {
        // 解码失败也照常切换，避免卡在上一张
      }
      if (t !== token) return; // 已经翻到别的照片了

      shown = src;
      void incoming.offsetWidth; // 先落在起始位置，再开始过渡
      incoming.classList.remove('no-anim');
      incoming.classList.add('is-front');
      outgoing.style.setProperty('--shift', `${-direction * SHIFT_PX}px`);
      outgoing.classList.remove('is-front');
      front = 1 - front;
    },

    clear() {
      token++;
      shown = null;
      for (const layer of layers) {
        layer.classList.remove('is-front');
        layer.removeAttribute('src');
      }
    },
  };
}
