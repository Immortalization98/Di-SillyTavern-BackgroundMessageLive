import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BYPASS_HEADER, createBypassToken, installGenerateTakeover } from '../server/takeover.mjs';

/** Writes a module shaped like SillyTavern's chat-completions router and returns its URL. */
function fakeRouterModule(t, { generateHandlers = 1, includeGenerate = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bgml-takeover-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const handlers = Array.from({ length: generateHandlers }, () => `{ handle(request, response) { calls.push(['original', request.body?.type]); response.done = 'original'; } }`).join(', ');
  const generate = includeGenerate ? `{ route: { path: '/generate', methods: { post: true }, stack: [${handlers}] } },` : '';
  const file = path.join(directory, 'chat-completions.mjs');
  fs.writeFileSync(file, `export const calls = [];
export const router = { stack: [
  { route: { path: '/status', methods: { post: true }, stack: [{ handle() {} }] } },
  ${generate}
] };`);
  return pathToFileURL(file).href;
}

test('wraps the generate handler, lets loopback calls with the token through, and restores', async (t) => {
  const url = fakeRouterModule(t);
  const { router, calls } = await import(url);
  const token = createBypassToken();
  const seen = [];
  const takeover = await installGenerateTakeover({
    routerModuleUrl: url, bypassToken: token,
    onRequest: (request, response, callOriginal) => { seen.push(request.body.type); if (request.body.type === 'quiet') callOriginal(); },
  });
  assert.equal(takeover.error, undefined);
  const handle = router.stack[1].route.stack[0].handle;
  assert.equal(handle.bgmlWrapped, true);

  const normal = { headers: {}, body: { type: 'normal' } };
  handle(normal, {}, () => {});
  assert.deepEqual(seen, ['normal']);
  assert.deepEqual(calls, [], 'the plugin decides; original not called yet');

  const quiet = { headers: {}, body: { type: 'quiet' } };
  const quietResponse = {};
  handle(quiet, quietResponse, () => {});
  assert.equal(quietResponse.done, 'original', 'callOriginal reaches SillyTavern');

  const loop = { headers: { [BYPASS_HEADER]: token }, body: { type: 'normal' } };
  handle(loop, {}, () => {});
  assert.deepEqual(seen, ['normal', 'quiet'], 'loopback calls never reach the plugin again');

  const forged = { headers: { [BYPASS_HEADER]: 'guess' }, body: { type: 'swipe' } };
  handle(forged, {}, () => {});
  assert.deepEqual(seen, ['normal', 'quiet', 'swipe'], 'a wrong token is treated as a normal request');

  takeover.restore();
  assert.notEqual(router.stack[1].route.stack[0].handle, handle);
  assert.equal(router.stack[1].route.stack[0].handle.bgmlWrapped, undefined);
});

test('refuses safely when the route is missing, unexpected or already wrapped', async (t) => {
  const missing = await installGenerateTakeover({ routerModuleUrl: fakeRouterModule(t, { includeGenerate: false }), bypassToken: 'x', onRequest() {} });
  assert.match(missing.error, /not found/);
  const twoHandlers = await installGenerateTakeover({ routerModuleUrl: fakeRouterModule(t, { generateHandlers: 2 }), bypassToken: 'x', onRequest() {} });
  assert.match(twoHandlers.error, /expected shape/);
  const unloadable = await installGenerateTakeover({ routerModuleUrl: pathToFileURL(path.join(os.tmpdir(), 'does-not-exist.mjs')).href, bypassToken: 'x', onRequest() {} });
  assert.match(unloadable.error, /cannot load/);
  const url = fakeRouterModule(t);
  const first = await installGenerateTakeover({ routerModuleUrl: url, bypassToken: 'x', onRequest() {} });
  const second = await installGenerateTakeover({ routerModuleUrl: url, bypassToken: 'x', onRequest() {} });
  assert.match(second.error, /already wrapped/);
  first.restore();
});

test('bypass tokens are long and random', () => {
  const a = createBypassToken();
  assert.equal(a.length, 48);
  assert.notEqual(a, createBypassToken());
});
