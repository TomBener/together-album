const ENTER = 0.16; // 新照片从翻页方向一侧、离中心多远开始滑入（相对舞台宽度）
const EXIT = 0.12; // 旧照片朝反方向再退多远
const LIFT = 0.06; // 拖过整屏宽时照片缩小的比例，像把照片从桌上拿起来
const still = matchMedia('(prefers-reduced-motion: reduce)');

/**
 * 看照片的舞台：两层 <img> 交替淡入淡出，翻页方向决定滑入方向，像翻相册；
 * 拖动时照片跟着手指走，背后铺一层取自照片颜色的柔光。
 */
export function createStage(root) {
  const frame = root.querySelector('.frame');
  const layers = [...frame.querySelectorAll('.photo')];
  const glows = [...root.querySelectorAll('.ambient canvas')];
  let front = 0;
  let glow = 0;
  let token = 0;
  let shown = null;
  let dragX = 0;

  const place = (el, x, scale) => {
    el.style.setProperty('--x', `${x}px`);
    el.style.setProperty('--s', scale);
  };

  // 把照片缩成几十个像素画到画布上，再由 CSS 放大、模糊，作为背景光
  function paintGlow(img) {
    glow = 1 - glow;
    const canvas = glows[glow];
    try {
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    } catch {
      return; // 解码失败的图片画不上去，保留上一张的光
    }
    canvas.classList.add('is-on');
    glows[1 - glow].classList.remove('is-on');
  }

  function settle() {
    const el = layers[front];
    dragX = 0;
    el.classList.remove('no-anim');
    el.classList.add('is-settling');
    place(el, 0, 1);
  }

  return {
    frame,

    async show(src, direction = 0) {
      if (src === shown) return settle();
      const t = ++token;
      const incoming = layers[1 - front];
      const width = frame.clientWidth;
      const travel = still.matches ? 0 : direction;

      incoming.classList.add('no-anim');
      incoming.classList.remove('is-front', 'is-settling');
      place(incoming, travel * ENTER * width, direction || still.matches ? 1 : 0.96);
      incoming.src = src;
      try {
        await incoming.decode();
      } catch {
        // 解码失败也照常切换，避免卡在上一张
      }
      if (t !== token) return; // 已经翻到别的照片了

      const outgoing = layers[front];
      shown = src;
      void incoming.offsetWidth; // 先落在起始位置，再开始过渡
      incoming.classList.remove('no-anim');
      incoming.classList.add('is-front');
      place(incoming, 0, 1);
      // 拖动翻页时旧照片从手指松开的位置接着往外走
      outgoing.classList.remove('no-anim', 'is-front', 'is-settling');
      place(outgoing, dragX - travel * EXIT * width * (dragX ? 2 : 1), still.matches ? 1 : 0.92);
      dragX = 0;
      front = 1 - front;
      paintGlow(incoming);
    },

    /** 照片跟着手指横向移动 dx 像素。 */
    drag(dx) {
      if (!shown) return;
      const el = layers[front];
      dragX = dx;
      el.classList.add('no-anim');
      place(el, dx, 1 - Math.min(Math.abs(dx) / (frame.clientWidth || 1), 1) * LIFT);
    },

    /** 松手但没翻页：弹回原位。 */
    settle,

    clear() {
      token++;
      shown = null;
      dragX = 0;
      for (const layer of layers) {
        layer.classList.remove('is-front', 'is-settling');
        layer.removeAttribute('src');
      }
      for (const canvas of glows) canvas.classList.remove('is-on');
    },
  };
}

// 越拖越沉的阻力，和 iOS 滚动到头时的手感一致
const rubber = (dx, width) => Math.sign(dx) * (1 - 1 / ((Math.abs(dx) * 0.55) / width + 1)) * width;

/**
 * 左右拖动翻页：照片跟手，松手时按拖动距离和速度决定翻过去还是弹回来。
 * step 为 1 是下一张，-1 是上一张；canStep(step) 为假时拖动有阻力，松手后调用 blocked(step)。
 * 没怎么移动就松手算点按，tap 收到点按位置在舞台宽度上的比例（0–1）。
 */
export function bindSwipe(stage, { canStep, step, blocked, tap, enabled = () => true }) {
  const { frame } = stage;
  let g = null;

  frame.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary) {
      // 第二根手指落下，多半是在双指缩放
      if (g?.axis === 'x') stage.settle();
      g = null;
      return;
    }
    if (e.button > 0 || !enabled()) return;
    g = { id: e.pointerId, x: e.clientX, y: e.clientY, axis: null, dx: 0, vx: 0, t: e.timeStamp };
  });

  frame.addEventListener('pointermove', (e) => {
    if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (!g.axis) {
      if (Math.hypot(dx, dy) < 8) return;
      g.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      try {
        if (g.axis === 'x') frame.setPointerCapture(e.pointerId); // 手指滑出舞台也能收到松手
      } catch {
        // 指针已经不在了
      }
    }
    if (g.axis !== 'x') return;
    const dt = e.timeStamp - g.t;
    if (dt > 0) g.vx = 0.7 * ((dx - g.dx) / dt) + 0.3 * g.vx;
    g.dx = dx;
    g.t = e.timeStamp;
    stage.drag(canStep(dx < 0 ? 1 : -1) ? dx : rubber(dx, frame.clientWidth || 1));
  });

  frame.addEventListener('pointerup', (e) => {
    if (!g || e.pointerId !== g.id) return;
    const { axis, dx, t } = g;
    const vx = e.timeStamp - t > 80 ? 0 : g.vx; // 停住再松手不算甩
    g = null;
    if (!axis) {
      const { left, width } = frame.getBoundingClientRect();
      tap?.((e.clientX - left) / width);
      return;
    }
    if (axis !== 'x') return;
    const dir = dx < 0 ? 1 : -1;
    const flung = Math.abs(dx) > frame.clientWidth * 0.2 || (Math.abs(vx) > 0.35 && Math.sign(vx) === Math.sign(dx));
    if (flung && canStep(dir)) return step(dir);
    stage.settle();
    if (flung) blocked?.(dir);
  });

  frame.addEventListener('pointercancel', (e) => {
    if (!g || e.pointerId !== g.id) return;
    if (g.axis === 'x') stage.settle();
    g = null;
  });
}
