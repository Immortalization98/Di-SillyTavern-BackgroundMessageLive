import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRegistry } from '../server/jobs.mjs';
import { committedErrorBody, createRelay } from '../server/relay.mjs';

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
function fakeLoopback({ status = 200, contentType = 'text/event-stream', delayMs = 0, fail = false } = {}) {
  const state = { calls: 0, aborted: false, upstream: null };
  const loopback = async (request, body, { signal }) => {
    state.calls++;
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
    if (fail) throw new Error('ECONNREFUSED');
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

function setup({ timeoutMs, keepAliveAfterMs, keepAliveIntervalMs, ...loopbackOptions } = {}) {
  const registry = createRegistry();
  const finished = [];
  const fake = fakeLoopback(loopbackOptions);
  const relay = createRelay({ registry, loopback: fake.loopback, onFinished: (job, outcome) => finished.push({ job, outcome }), timeoutMs, keepAliveAfterMs, keepAliveIntervalMs });
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

// --- keep-alive for slow upstreams (Cloudflare drops requests with no response for ~100 s) ---

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const streamRequest = (stream = true) => ({ body: { type: 'normal', chat_completion_source: 'custom', stream }, socket: { localPort: 8000 }, headers: {} });
const KEEPALIVE = { keepAliveAfterMs: 20, keepAliveIntervalMs: 10 };

test('slow stream: headers go out early, comment lines keep the connection busy, the reply follows', async () => {
  const { relay, finished, fake, user, register } = setup({ ...KEEPALIVE, delayMs: 70 });
  const registration = register();
  const response = fakeResponse();
  await relay.handle(streamRequest(), response, user);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['Content-Type'], 'text/event-stream; charset=utf-8');
  assert.equal(response.headers['X-Bgml-Job'], registration.id);
  assert.ok(response.chunks.length >= 2, 'several keep-alive lines while waiting');
  assert.ok(response.chunks.every(chunk => chunk === ': keepalive\n\n'));
  fake.send('慢渠道');
  fake.finish();
  await tick(); await tick(); await tick();
  assert.ok(response.text().endsWith('data: [DONE]\n\n'));
  assert.equal(finished.length, 0, 'delivered');
});

test('no keep-alive line is put inside an unfinished SSE event', async () => {
  const { relay, fake, user, register } = setup(KEEPALIVE);
  register();
  const response = fakeResponse();
  await relay.handle(streamRequest(), response, user);
  fake.state.upstream.write('data: {"choices":[{"delta":{"content":"半');
  await wait(60);
  assert.ok(!response.text().includes('keepalive'), 'event still open');
  fake.state.upstream.write('"}}]}\n\n');
  await wait(60);
  assert.ok(response.text().endsWith(': keepalive\n\n'), 'padding resumes after the event ends');
  relay.abortAll();
});

test('a fast reply is never padded', async () => {
  const { relay, fake, user, register } = setup(KEEPALIVE);
  register();
  const response = fakeResponse();
  await relay.handle(streamRequest(), response, user);
  fake.send('快');
  fake.finish();
  await wait(50);
  assert.ok(!response.text().includes('keepalive'));
});

test('slow non-streaming reply: whitespace before the JSON body, which still parses', async () => {
  const { relay, fake, user, register } = setup({ ...KEEPALIVE, delayMs: 50, contentType: 'application/json' });
  register();
  const response = fakeResponse();
  await relay.handle(streamRequest(false), response, user);
  assert.equal(response.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.match(response.text(), /^ +$/);
  fake.state.upstream.write('{"choices":[{"message":{"content":"整段"}}]}');
  fake.state.upstream.complete = true;
  fake.state.upstream.end();
  await wait(30);
  assert.equal(JSON.parse(response.text()).choices[0].message.content, '整段');
  assert.ok(response.text().trimEnd().endsWith('}'), 'no padding once the body started');
});

test('upstream error after an early 200 becomes an error event the page shows', async () => {
  const { relay, finished, fake, user, register } = setup({ ...KEEPALIVE, delayMs: 40, status: 429, contentType: 'application/json' });
  register();
  const response = fakeResponse();
  await relay.handle(streamRequest(), response, user);
  fake.state.upstream.write('{"error":{"message":"rate limited"}}');
  fake.state.upstream.complete = true;
  fake.state.upstream.end();
  await tick(); await tick(); await tick();
  assert.equal(response.statusCode, 200, 'status was already sent');
  assert.ok(response.text().endsWith('data: {"error":{"message":"rate limited"}}\n\n'));
  assert.ok(!response.text().replace(/data: .*\n\n$/, '').includes('rate limited'), 'raw body not passed through');
  assert.equal(finished.length, 0, 'the page saw the error; nothing to recover');
});

test('non-streaming upstream error after an early 200 is a JSON error body', async () => {
  const { relay, fake, user, register } = setup({ ...KEEPALIVE, delayMs: 40, status: 502, contentType: 'text/html' });
  register();
  const response = fakeResponse();
  await relay.handle(streamRequest(false), response, user);
  fake.state.upstream.write('<html>bad gateway</html>');
  fake.state.upstream.complete = true;
  fake.state.upstream.end();
  await tick(); await tick();
  assert.deepEqual(JSON.parse(response.text()), { error: { message: 'Got response status 502' } });
});

test('relay failure after an early 200 still ends the response with an error', async () => {
  const { relay, finished, user, register } = setup({ ...KEEPALIVE, delayMs: 40, fail: true });
  register();
  const response = fakeResponse();
  await relay.handle(streamRequest(), response, user);
  await tick(); await tick();
  assert.ok(response.text().endsWith('data: {"error":{"message":"Background relay could not reach SillyTavern"}}\n\n'));
  assert.equal(response.writableFinished, true);
  assert.equal(finished.length, 0);
});

test('client that leaves during the keep-alive phase: job continues, padding stops', async () => {
  const { relay, finished, fake, user, register } = setup({ ...KEEPALIVE, delayMs: 40 });
  register();
  const response = fakeResponse();
  const handled = relay.handle(streamRequest(), response, user);
  await wait(30);
  response.disconnect();
  const written = response.chunks.length;
  await handled;
  fake.send('离开后');
  fake.finish();
  await wait(40);
  assert.equal(response.chunks.length, written, 'nothing written after the client left');
  assert.deepEqual(finished[0].outcome, { ok: true, text: '离开后', reasoning: '' });
});

test('keep-alive is off for unregistered requests and when configured to 0', async () => {
  for (const options of [{ ...KEEPALIVE, delayMs: 50, registered: false }, { keepAliveAfterMs: 0, keepAliveIntervalMs: 10, delayMs: 50, registered: true }]) {
    const { registered, ...rest } = options;
    const { relay, fake, user, register } = setup(rest);
    if (registered) register();
    const response = fakeResponse();
    await relay.handle(streamRequest(), response, user);
    assert.ok(!response.text().includes('keepalive'));
    assert.equal(response.headers['Content-Type'], 'text/event-stream', 'headers came from the upstream');
    fake.finish();
    await tick();
  }
});

test('committedErrorBody keeps SillyTavern error JSON and hides everything else', () => {
  assert.deepEqual(committedErrorBody(400, '{"error":{"message":"bad key"}}'), { error: { message: 'bad key' } });
  assert.deepEqual(committedErrorBody(500, '{"error":true}'), { error: true });
  assert.deepEqual(committedErrorBody(500, '{"ok":true}'), { error: { message: 'Got response status 500' } });
  assert.deepEqual(committedErrorBody(400, '{"message":"quota"}'), { error: { message: 'quota' } }, 'non-stream page path only reads data.error');
  assert.deepEqual(committedErrorBody(422, '{"detail":[{"msg":"bad"}]}'), { error: { message: '[{"msg":"bad"}]' } });
  assert.deepEqual(committedErrorBody(504, '<html>timeout</html>'), { error: { message: 'Got response status 504' } });
});
