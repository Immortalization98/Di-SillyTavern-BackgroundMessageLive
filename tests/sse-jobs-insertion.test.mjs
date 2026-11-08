import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStreamCollector, parseJsonResponse } from '../server/sse.mjs';
import { createRegistry, createResultStore, isJobId, newJobId, REGISTRATION_TTL_MS, RESULT_TTL_MS, validateRegistration } from '../server/jobs.mjs';
import { planInsertion } from '../extension/insertion.js';

test('stream collector joins deltas across arbitrary chunk boundaries', () => {
  const sse = [
    'data: {"choices":[{"delta":{"reasoning_content":"想一想"}}]}',
    'data: {"choices":[{"delta":{"content":"你好，"}}]}',
    ': keep-alive comment',
    'data: {"choices":[{"delta":{"content":"旅人。"}}]}',
    'data: [DONE]', '',
  ].join('\n');
  const bytes = Buffer.from(sse);
  for (const size of [1, 3, 7, bytes.length]) {
    const collector = createStreamCollector();
    for (let i = 0; i < bytes.length; i += size) collector.push(bytes.subarray(i, i + size));
    const result = collector.finish();
    assert.equal(result.text, '你好，旅人。', `chunk size ${size}`);
    assert.equal(result.reasoning, '想一想');
    assert.equal(result.done, true);
    assert.equal(result.error, null);
  }
});

test('stream collector handles CRLF, "reasoning" field and error events', () => {
  const collector = createStreamCollector();
  collector.push('data: {"choices":[{"delta":{"reasoning":"r"}}]}\r\ndata: {"choices":[{"delta":{"content":"a"}}]}\r\n');
  collector.push('data: {"error":{"message":"quota"}}\r\n');
  const result = collector.finish();
  assert.equal(result.text, 'a');
  assert.equal(result.reasoning, 'r');
  assert.deepEqual(result.error, { message: 'quota' });
});

test('non-stream JSON responses are parsed', () => {
  assert.deepEqual(parseJsonResponse('{"choices":[{"message":{"content":"完整回复","reasoning_content":"思考"}}]}'), { text: '完整回复', reasoning: '思考', error: null });
  assert.ok(parseJsonResponse('<html>').error);
  assert.ok(parseJsonResponse('{"error":{"message":"x"}}').error);
});

test('registration validation accepts only main generation types with sane fields', () => {
  const base = { type: 'normal', chatId: 'Seraphina - 2026-11-09@01h02m03s', characterAvatar: 'Seraphina.png', characterName: 'Seraphina', messageCount: 3 };
  assert.deepEqual(validateRegistration(base), base);
  for (const type of ['quiet', 'impersonate', undefined, 'x']) assert.equal(validateRegistration({ ...base, type }), null, String(type));
  assert.equal(validateRegistration({ ...base, chatId: '' }), null);
  assert.equal(validateRegistration({ ...base, messageCount: -1 }), null);
  assert.equal(validateRegistration({ ...base, type: 'continue' }), null, 'continue needs baseLength');
  assert.equal(validateRegistration({ ...base, type: 'continue', baseLength: 12 }).baseLength, 12);
});

test('registry hands out the latest registration of the requested type once, and expires old ones', () => {
  let clock = 0;
  const registry = createRegistry({ now: () => clock });
  const reg = (type) => registry.register('alice', { type, chatId: 'c', messageCount: 1 });
  const first = reg('normal');
  clock += 10;
  const second = reg('normal');
  reg('swipe');
  assert.equal(registry.consume('bob', 'normal'), null, 'users are separate');
  assert.equal(registry.consume('alice', 'quiet'), null);
  assert.equal(registry.consume('alice', 'normal').id, second.id);
  assert.equal(registry.consume('alice', 'normal').id, first.id);
  assert.equal(registry.consume('alice', 'normal'), null);
  reg('normal');
  clock += REGISTRATION_TTL_MS + 1;
  assert.equal(registry.consume('alice', 'normal'), null, 'expired');
  assert.ok(isJobId(newJobId()));
});

test('result store keeps one private file per result, rejects bad ids and prunes after 7 days', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bgml-results-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createResultStore(root);
  const id = newJobId();
  store.save({ id, status: 'done', chatId: 'c', finishedAt: new Date(1000).toISOString(), text: '秘密内容', reasoning: '' });
  assert.equal(store.get(id).text, '秘密内容');
  const listed = store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].length, 4);
  assert.ok(!('text' in listed[0]), 'listing never includes the text');
  assert.equal(store.get('../../etc/passwd'), null);
  assert.equal(store.remove('../x'), false);
  assert.throws(() => store.save({ id: '../evil' }), /invalid job id/);
  assert.equal(store.prune(1000 + RESULT_TTL_MS - 1), 0);
  assert.equal(store.prune(1000 + RESULT_TTL_MS + 1), 1);
  assert.equal(store.list().length, 0);
});

const userMessage = (mes) => ({ is_user: true, mes });
const reply = (mes, extra = {}) => ({ is_user: false, mes, ...extra });

test('insertion plan: normal reply goes into the free spot, replaces a placeholder, or becomes a swipe', () => {
  const result = { type: 'normal', messageCount: 2, text: '完整的回复内容' };
  assert.deepEqual(planInsertion([reply('开场'), userMessage('你好')], result), { kind: 'append' });
  assert.deepEqual(planInsertion([reply('开场'), userMessage('你好'), reply('')], result), { kind: 'replaceCurrent', index: 2 });
  assert.deepEqual(planInsertion([reply('开场'), userMessage('你好'), reply('完整的')], result), { kind: 'replaceCurrent', index: 2 });
  assert.deepEqual(planInsertion([reply('开场'), userMessage('你好'), reply('另一条已经重新生成的回复')], result), { kind: 'addSwipe', index: 2 });
  assert.deepEqual(planInsertion([reply('开场'), userMessage('你好'), reply('x'), userMessage('又说了一句')], result), { kind: 'mismatch' });
  assert.deepEqual(planInsertion([reply('开场')], result), { kind: 'mismatch' });
});

test('insertion plan: swipe and continue', () => {
  const swipe = { type: 'swipe', messageCount: 2, text: '新的一页' };
  assert.deepEqual(planInsertion([userMessage('u'), reply('旧', { swipes: ['旧', ''], swipe_id: 1 })], swipe), { kind: 'replaceCurrent', index: 1 });
  assert.deepEqual(planInsertion([userMessage('u'), reply('旧', { swipes: ['旧'], swipe_id: 0 })], swipe), { kind: 'addSwipe', index: 1 });
  assert.deepEqual(planInsertion([userMessage('u')], swipe), { kind: 'mismatch' });
  const cont = { type: 'continue', messageCount: 2, baseLength: 3, text: '接着写' };
  assert.deepEqual(planInsertion([userMessage('u'), reply('前文。半截')], cont), { kind: 'continue', index: 1 });
  assert.deepEqual(planInsertion([userMessage('u'), reply('前')], cont), { kind: 'mismatch' }, 'message got shorter than the base');
  assert.deepEqual(planInsertion([userMessage('u'), reply('前文。'), userMessage('x')], cont), { kind: 'mismatch' });
});
