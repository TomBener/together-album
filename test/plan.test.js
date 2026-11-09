import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendOrder, sendPlan } from '../public/js/plan.js';
import { seal, unseal, newSecret, toBase64, fromBase64 } from '../public/js/seal.js';

test('先发当前这张，再往后两张、往前一张、往后第三张', () => {
  assert.deepEqual(sendOrder(2, 10), [2, 3, 4, 1, 5]);
});

test('开头和结尾不越界', () => {
  assert.deepEqual(sendOrder(0, 5), [0, 1, 2, 3]);
  assert.deepEqual(sendOrder(4, 5), [4, 3]);
  assert.deepEqual(sendOrder(0, 1), [0]);
});

test('不能加密时只发当前这张', () => {
  assert.deepEqual(sendOrder(2, 10, false), [2]);
});

test('还没有照片时什么也不发', () => {
  assert.deepEqual(sendOrder(-1, 3), []);
  assert.deepEqual(sendOrder(0, 0), []);
  assert.deepEqual(sendOrder(5, 3), []);
});

// 五张照片，原图都够大，原画质长边 2048
const photos = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, large: true, fullEdge: 2048 }));
const parts = (list) => list.map(([photo, kind]) => `${photo.id}:${kind}`);
const PHONE = 1890; // iPhone 竖屏全屏看照片要的像素
const MAC = 3240;

test('手机：每张先发预览再发原画质，没有大一档的', () => {
  assert.deepEqual(parts(sendPlan({ photos, index: 1, done: new Set(), need: PHONE, direct: true })), [
    'b:preview', 'b:full', 'c:preview', 'c:full', 'd:preview', 'd:full', 'a:preview', 'a:full', 'e:preview', 'e:full',
  ]);
});

test('大屏幕直连：只给当前这张补发大一档的，排在下一张的原画质后面', () => {
  assert.deepEqual(parts(sendPlan({ photos, index: 1, done: new Set(), need: MAC, direct: true })).slice(0, 6), [
    'b:preview', 'b:full', 'c:preview', 'c:full', 'b:large', 'd:preview',
  ]);
});

test('大屏幕经中转：不发大一档的', () => {
  const list = parts(sendPlan({ photos, index: 1, done: new Set(), need: MAC, direct: false }));
  assert.equal(list.filter((p) => p.endsWith(':large')).length, 0);
});

test('翻到提前收到的那张：先补发它的大一档', () => {
  const done = new Set(['b:preview', 'b:full', 'c:preview', 'c:full']);
  assert.deepEqual(parts(sendPlan({ photos, index: 2, done, need: MAC, direct: true })).slice(0, 3), ['d:preview', 'd:full', 'c:large']);
  const more = new Set([...done, 'd:preview', 'd:full']);
  assert.deepEqual(parts(sendPlan({ photos, index: 2, done: more, need: MAC, direct: true }))[0], 'c:large');
});

test('最后一张、不能提前发时，大一档的紧跟在当前这张后面', () => {
  assert.deepEqual(parts(sendPlan({ photos, index: 4, done: new Set(), need: MAC, direct: true })), [
    'e:preview', 'e:full', 'e:large', 'd:preview', 'd:full',
  ]);
  assert.deepEqual(parts(sendPlan({ photos, index: 1, done: new Set(), need: MAC, direct: true, ahead: false })), [
    'b:preview', 'b:full', 'b:large',
  ]);
});

test('对方已有大一档的，或原图不够大，就不发大一档的', () => {
  assert.deepEqual(parts(sendPlan({ photos, index: 4, done: new Set(['e:large']), need: MAC, direct: true })), ['d:preview', 'd:full']);
  const small = photos.map((p) => ({ ...p, large: false }));
  assert.equal(parts(sendPlan({ photos: small, index: 1, done: new Set(), need: MAC, direct: true })).filter((p) => p.endsWith(':large')).length, 0);
});

test('同一把钥匙能解开，换一把就解不开', async () => {
  const secret = newSecret();
  const data = new TextEncoder().encode('photo bytes');
  const sealed = await seal(secret, data);
  const back = new Uint8Array(await unseal(fromBase64(toBase64(secret)), fromBase64(toBase64(sealed.iv)), sealed.data));
  assert.deepEqual(back, data);
  await assert.rejects(unseal(newSecret(), sealed.iv, sealed.data));
});
