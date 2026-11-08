import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRegistry } from '../server/jobs.mjs';
import { createRelay } from '../server/relay.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));

/** Minimal stand-in for an Express response attached to a client socket. */
function fakeResponse() {
  const response = new EventEmitter();
  Object.assign(response, {
    statusCode: 200, headers: {}, chunks: [], headersSent: false, writableFinished: false, gone: false,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; this.headersSent = true; },
    flushHeaders() {},
    write(chunk) { if (!this.gone) this.chunks.push(String(chunk)); return true; },
    end() {
      if (this.gone) return;
      setImmediate(() => { if (!this.gone) { this.writableFinished = true; this.emit('finish'); this.emit('close'); } });
    },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; this.headersSent = true; this.end(); },
    disconnect() { this.gone = true; this.emit('close'); },
    text() { return this.chunks.join(''); },
  });
  return response;
}

/** Fake loopback: returns a controllable upstream stream; aborting destroys it. */
function fakeLoopback({ status = 200, contentType = 'text/event-stream' } = {}) {
  const state = { calls: 0, aborted: false, upstream: null };
  const loopback = async (request, body, { signal }) => {
    state.calls++;
    const upstream = new PassThrough();
    upstream.statusCode = status;
    upstream.headers = { 'content-type': contentType };
    upstream.complete = false;
    signal?.addEventListener('abort', () => { state.aborted = true; upstream.destroy(new Error('aborted')); });
    state.upstream = upstream;
    return upstream;
  };
  const send = (content) => state.upstream.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
  const finish = () => { state.upstream.write('data: [DONE]\n\n'); state.upstream.complete = true; state.upstream.end(); };
  return { loopback, state, send, finish };
}

function setup({ timeoutMs, ...loopbackOptions } = {}) {
  const registry = createRegistry();
  const finished = [];
  const fake = fakeLoopback(loopbackOptions);
  const relay = createRelay({ registry, loopback: fake.loopback, onFinished: (job, outcome) => finished.push({ job, outcome }), timeoutMs });
  const user = { handle: 'alice', root: '/tmp/alice' };
  const request = (type = 'normal', source = 'custom') => ({ body: { type, chat_completion_source: source, messages: [] }, socket: { localPort: 8000 }, headers: {} });
  const register = (type = 'normal') => registry.register('alice', { type, chatId: 'chat', messageCount: 2 });
  return { relay, finished, fake, user, request, register };
}

test('unregistered requests behave like SillyTavern: streamed through and aborted on disconnect', async () => {
  const { relay, finished, fake, user, request } = setup();
  const response = fakeResponse();
  await relay.handle(request(), response, user);
  fake.send('半');
  await tick();
  assert.equal(response.text().includes('半'), true);
  assert.equal(response.headers['Cache-Control'], 'no-cache, no-transform');
  assert.equal(response.headers['X-Bgml-Job'], undefined);
  response.disconnect();
  await tick();
  assert.equal(fake.state.aborted, true, 'upstream generation stopped');
  assert.equal(finished.length, 0);
  assert.equal(relay.size(), 0);
});

test('registered generation that reaches the client completely is not kept', async () => {
  const { relay, finished, fake, user, request, register } = setup();
  const registration = register();
  const response = fakeResponse();
  await relay.handle(request(), response, user);
  assert.equal(response.headers['X-Bgml-Job'], registration.id);
  assert.equal(relay.active('alice').length, 1);
  fake.send('完整');
  fake.finish();
  await tick(); await tick(); await tick();
  assert.equal(finished.length, 0, 'delivered, nothing to recover');
  assert.equal(relay.size(), 0);
});

test('registered generation keeps running after the client leaves and is handed to onFinished', async () => {
  const { relay, finished, fake, user, request, register } = setup();
  register();
  const response = fakeResponse();
  await relay.handle(request(), response, user);
  fake.send('你离开之前');
  await tick();
  response.disconnect();
  await tick();
  assert.equal(fake.state.aborted, false, 'not aborted');
  fake.send('，以及之后。');
  fake.finish();
  await tick(); await tick();
  assert.equal(finished.length, 1);
  assert.deepEqual(finished[0].outcome, { ok: true, text: '你离开之前，以及之后。', reasoning: '' });
  assert.equal(finished[0].job.registration.chatId, 'chat');
  assert.ok(!response.text().includes('之后'), 'nothing written after disconnect');
});

test('stop button cancels a detached job without keeping a result', async () => {
  const { relay, finished, fake, user, request, register } = setup();
  const registration = register();
  const response = fakeResponse();
  await relay.handle(request(), response, user);
  response.disconnect();
  assert.equal(relay.cancel('bob', registration.id), false, 'other users cannot cancel');
  assert.equal(relay.cancel('alice', registration.id), true);
  await tick(); await tick();
  assert.equal(fake.state.aborted, true);
  assert.equal(finished.length, 0);
});

test('upstream errors after the client left are reported as failed results', async () => {
  const { relay, finished, fake, user, request, register } = setup({ status: 400, contentType: 'application/json' });
  register();
  const response = fakeResponse();
  await relay.handle(request(), response, user);
  response.disconnect();
  fake.state.upstream.write('{"error":{"message":"bad key"}}');
  fake.state.upstream.complete = true;
  fake.state.upstream.end();
  await tick(); await tick();
  assert.equal(finished.length, 1);
  assert.deepEqual(finished[0].outcome, { ok: false, code: 'UPSTREAM_ERROR', status: 400 });
});

test('hard timeout aborts a detached job and reports TIMEOUT', async () => {
  const { relay, finished, fake, user, request, register } = setup({ timeoutMs: 20 });
  register();
  const response = fakeResponse();
  await relay.handle(request(), response, user);
  response.disconnect();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(fake.state.aborted, true);
  assert.equal(finished.length, 1);
  assert.equal(finished[0].outcome.code, 'TIMEOUT');
});

test('sources whose responses are not OpenAI-compatible are never detached', async () => {
  const { relay, finished, fake, user, request, register } = setup();
  register();
  const response = fakeResponse();
  await relay.handle(request('normal', 'claude'), response, user);
  assert.equal(response.headers['X-Bgml-Job'], undefined);
  response.disconnect();
  await tick();
  assert.equal(fake.state.aborted, true);
  assert.equal(finished.length, 0);
});

test('quiet requests pass through even if a registration exists', async () => {
  const { relay, fake, user, request, register } = setup();
  register('normal');
  const response = fakeResponse();
  await relay.handle(request('quiet'), response, user);
  assert.equal(response.headers['X-Bgml-Job'], undefined);
  response.disconnect();
  await tick();
  assert.equal(fake.state.aborted, true);
});

test('streams without a Content-Type header (as SillyTavern forwards them) are still collected', async () => {
  const { relay, finished, fake, user, register } = setup({ contentType: '' });
  register();
  const response = fakeResponse();
  await relay.handle({ body: { type: 'normal', chat_completion_source: 'custom', stream: true }, socket: { localPort: 8000 }, headers: {} }, response, user);
  assert.equal(response.headers['Content-Type'], undefined, 'no header invented');
  response.disconnect();
  fake.send('没有类型头');
  fake.finish();
  await tick(); await tick();
  assert.deepEqual(finished[0].outcome, { ok: true, text: '没有类型头', reasoning: '' });
});

test('an SSE body is recognised even when the request did not say stream', async () => {
  const { relay, finished, fake, user, request, register } = setup({ contentType: '' });
  register();
  const response = fakeResponse();
  await relay.handle(request(), response, user);
  response.disconnect();
  fake.send('兜底解析');
  fake.finish();
  await tick(); await tick();
  assert.deepEqual(finished[0].outcome, { ok: true, text: '兜底解析', reasoning: '' });
});

test('in-process mode: unregistered requests go straight to the original handler, registered ones loop back with the bypass header', async () => {
  const registry = createRegistry();
  const calls = [];
  const loopback = async (request, body, options) => {
    calls.push(options.extraHeaders);
    const upstream = new PassThrough();
    upstream.statusCode = 200; upstream.headers = {}; upstream.complete = false;
    return upstream;
  };
  const relay = createRelay({ registry, loopback, onFinished() {}, loopbackHeaders: { 'x-bgml-bypass': 'token' } });
  const user = { handle: 'alice', root: '/tmp/alice' };
  let passedThrough = 0;
  const passThrough = () => { passedThrough++; };
  await relay.handle({ body: { type: 'normal', chat_completion_source: 'custom' }, socket: {}, headers: {} }, fakeResponse(), user, { passThrough });
  assert.equal(passedThrough, 1);
  assert.equal(calls.length, 0, 'no loopback for unregistered requests');
  registry.register('alice', { type: 'normal', chatId: 'c', messageCount: 1 });
  await relay.handle({ body: { type: 'normal', chat_completion_source: 'custom' }, socket: { localPort: 8000 }, headers: {} }, fakeResponse(), user, { passThrough });
  assert.equal(passedThrough, 1, 'registered request is not passed through');
  assert.deepEqual(calls, [{ 'x-bgml-bypass': 'token' }]);
  relay.abortAll();
});
