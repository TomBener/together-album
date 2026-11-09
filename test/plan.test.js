import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendOrder } from '../public/js/plan.js';
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

test('同一把钥匙能解开，换一把就解不开', async () => {
  const secret = newSecret();
  const data = new TextEncoder().encode('photo bytes');
  const sealed = await seal(secret, data);
  const back = new Uint8Array(await unseal(fromBase64(toBase64(secret)), fromBase64(toBase64(sealed.iv)), sealed.data));
  assert.deepEqual(back, data);
  await assert.rejects(unseal(newSecret(), sealed.iv, sealed.data));
});
