import { startHost } from './host.js';
import { startViewer } from './viewer.js';

// 只在用 Tab 键操作时显示焦点框。iOS Safari 会给程序设置的焦点（弹层打开时自动聚焦、
// 关闭后焦点回到原来的按钮）也画上焦点框，看起来像按钮多了一圈边
const root = document.documentElement;
addEventListener('keydown', (e) => e.key === 'Tab' && root.classList.add('kbd-nav'), true);
addEventListener('pointerdown', () => root.classList.remove('kbd-nav'), true);

const join = location.pathname.match(/^\/v\/([\w-]{16,64})\/?$/);
if (join) startViewer(join[1]);
else startHost();
