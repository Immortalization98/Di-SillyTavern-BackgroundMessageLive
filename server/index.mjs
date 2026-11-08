// Background Message Live — SillyTavern server plugin.
// Replies keep generating when the browser disconnects, can be recovered later, and a
// content-free push notification is sent when they finish.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { normaliseSubscription, sendPush } from './webpush.mjs';
import { createSubscriptionStore, loadOrCreateVapid, PLUGIN_DIRECTORY_NAME } from './store.mjs';
import { createRegistry, createResultStore, isJobId, validateRegistration } from './jobs.mjs';
import { createRelay } from './relay.mjs';
import { loopbackRequest } from './loopback.mjs';
import { BYPASS_HEADER, createBypassToken, installGenerateTakeover } from './takeover.mjs';
import { loadConfig } from './config.mjs';
import { buildNotification, notificationLanguage } from './messages.mjs';

export const info = {
  id: 'di-bgmessage-live',
  name: 'Background Message Live',
  description: 'Keeps replies generating when the browser disconnects, lets you recover them, and sends content-free push notifications.',
};

/** SillyTavern versions this release was tested on (major.minor). Others start with a warning. */
export const TESTED_TAVERN_VERSIONS = Object.freeze(['1.19']);
export const TEST_COOLDOWN_MS = 10_000;
const PRUNE_INTERVAL_MS = 3600 * 1000;
const LOG = '[di-bgmessage-live]';

export function isTestedVersion(version) {
  const [major, minor] = String(version).split('.');
  return TESTED_TAVERN_VERSIONS.includes(`${major}.${minor}`);
}

class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

function optionalUser(request) {
  const handle = request.user?.profile?.handle;
  const root = request.user?.directories?.root;
  return handle && root ? { handle, root } : null;
}

function currentUser(request) {
  const user = optionalUser(request);
  if (!user) throw new HttpError(401, 'NOT_LOGGED_IN');
  return user;
}

function handler(fn) {
  return async (request, response) => {
    try {
      const result = await fn(request, response);
      if (!response.headersSent) response.json({ ok: true, ...result });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const code = error instanceof HttpError ? error.code : 'SERVER_ERROR';
      if (status === 500) console.error(`${LOG} request failed:`, error?.message || error);
      if (!response.headersSent) response.status(status).json({ ok: false, error: { code } });
    }
  };
}

const serviceOf = (endpoint) => { try { return new URL(endpoint).hostname; } catch { return 'unknown'; } };

let activeRelay = null;
let activeTakeover = null;
let pruneTimer = null;

/**
 * Registers the plugin routes. SillyTavern calls init(router); the options exist for tests.
 */
export async function init(router, {
  appDirectory = process.cwd(),
  dataRoot = globalThis.DATA_ROOT,
  fetchImpl = fetch,
  loopback = loopbackRequest,
  now = () => Date.now(),
  timeoutMs,
  routerModuleUrl,
  inProcess,
} = {}) {
  const tavern = createRequire(path.join(appDirectory, 'package.json'))('./package.json');
  if (!isTestedVersion(tavern.version)) {
    console.warn(`${LOG} SillyTavern ${tavern.version} has not been tested with this plugin (tested: ${TESTED_TAVERN_VERSIONS.join(', ')}.x). It will still check the generate route and stay inactive if the route looks different.`);
  }
  if (!dataRoot) throw new Error(`${LOG} data root unknown`);
  const { config, warnings, file: configFile } = loadConfig(dataRoot);
  for (const warning of warnings) console.warn(`${LOG} ${warning}`);
  const vapid = loadOrCreateVapid(path.join(dataRoot, PLUGIN_DIRECTORY_NAME));
  const lastTestAt = new Map();
  const registry = createRegistry({ now });
  const resultStore = (root) => createResultStore(root, { ttlMs: config.resultRetentionMs });

  /** kind: 'test' | 'done' | 'failed'. Each device gets the text in the language it subscribed with. */
  async function notify(user, kind) {
    const store = createSubscriptionStore(user.root);
    const subscriptions = store.list();
    if (subscriptions.length === 0) return [];
    const topic = kind === 'test' ? 'bgml-test' : 'bgml-done';
    const settled = await Promise.allSettled(subscriptions.map(subscription =>
      sendPush(subscription, buildNotification(kind, subscription.language, { title: config.notificationTitle }),
        { vapid, subject: config.vapidSubject, fetchImpl, topic })));
    const gone = [];
    const results = settled.map((outcome, index) => {
      const { endpoint, device } = subscriptions[index];
      if (outcome.status === 'rejected') return { device, service: serviceOf(endpoint), ok: false, error: 'NETWORK_ERROR' };
      if (outcome.value.gone) gone.push(endpoint);
      return { device, service: serviceOf(endpoint), ok: outcome.value.ok, status: outcome.value.status };
    });
    if (gone.length) store.remove(gone);
    return results.map(item => ({ ...item, removed: gone.length }));
  }

  const bypassToken = createBypassToken();
  const relay = createRelay({
    registry,
    loopback,
    timeoutMs: timeoutMs ?? config.jobTimeoutMs,
    now,
    loopbackHeaders: { [BYPASS_HEADER]: bypassToken },
    async onFinished(job, outcome) {
      const { registration, user } = job;
      const result = {
        id: job.id,
        status: outcome.ok ? 'done' : 'error',
        code: outcome.ok ? null : outcome.code,
        type: registration.type,
        chatId: registration.chatId,
        characterAvatar: registration.characterAvatar,
        characterName: registration.characterName,
        messageCount: registration.messageCount,
        baseLength: registration.baseLength ?? null,
        startedAt: job.startedAt,
        finishedAt: new Date(now()).toISOString(),
        text: outcome.ok ? outcome.text : '',
        reasoning: outcome.ok ? outcome.reasoning : '',
      };
      resultStore(user.root).save(result);
      await notify(user, outcome.ok ? 'done' : 'failed');
    },
  });
  activeRelay = relay;

  // --- background generation -------------------------------------------------------------

  const relayRequest = (request, response, passThrough) => {
    relay.handle(request, response, optionalUser(request), { passThrough }).catch((error) => {
      console.error(`${LOG} relay failed:`, error?.message || error);
      if (!response.headersSent) response.status(502).json({ error: { message: 'Background relay failed' } });
    });
  };

  // Default: take over SillyTavern's generate route in-process (no reverse proxy needed).
  let mode = 'proxy-only';
  let takeoverError = null;
  if (inProcess ?? config.inProcessTakeover) {
    const takeover = await installGenerateTakeover({
      appDirectory, routerModuleUrl, bypassToken,
      onRequest: (request, response, callOriginal) => relayRequest(request, response, callOriginal),
    });
    if (takeover.error) {
      takeoverError = takeover.error;
      console.warn(`${LOG} in-process takeover unavailable (${takeover.error}); background generation only works through a reverse-proxy rewrite to /api/plugins/di-bgmessage-live/generate (see README)`);
    } else {
      mode = 'in-process';
      activeTakeover = takeover;
    }
  }

  // Optional reverse-proxy mode (kept for existing deployments): the proxy rewrites the generate
  // request to this route. Unregistered requests go to the original handler when it is reachable.
  router.post('/generate', (request, response) => relayRequest(request, response, activeTakeover ? () => activeTakeover.callOriginal(request, response) : undefined));

  router.get('/status', handler(() => ({ mode, takeoverError: takeoverError ? 'UNAVAILABLE' : null })));

  router.post('/jobs/register', handler((request) => {
    const user = currentUser(request);
    const registration = validateRegistration(request.body);
    if (!registration) throw new HttpError(400, 'INVALID_REGISTRATION');
    return { id: registry.register(user.handle, registration).id };
  }));

  router.post('/jobs/:id/cancel', handler((request) => {
    const user = currentUser(request);
    if (!isJobId(request.params.id)) throw new HttpError(400, 'INVALID_JOB');
    return { cancelled: relay.cancel(user.handle, request.params.id) };
  }));

  router.get('/jobs/active', handler((request) => ({ jobs: relay.active(currentUser(request).handle) })));

  router.get('/jobs/results', handler((request) => {
    const user = currentUser(request);
    const { chatId, characterAvatar } = request.query || {};
    const results = resultStore(user.root).list().filter(item =>
      (typeof chatId !== 'string' || item.chatId === chatId)
      && (typeof characterAvatar !== 'string' || item.characterAvatar === characterAvatar));
    return { results };
  }));

  router.get('/jobs/results/:id', handler((request) => {
    const user = currentUser(request);
    const result = resultStore(user.root).get(request.params.id);
    if (!result) throw new HttpError(404, 'NOT_FOUND');
    return { result };
  }));

  router.post('/jobs/results/:id/dismiss', handler((request) => {
    const user = currentUser(request);
    if (!isJobId(request.params.id)) throw new HttpError(400, 'INVALID_JOB');
    return { removed: resultStore(user.root).remove(request.params.id) };
  }));

  // --- push notifications -----------------------------------------------------------------

  router.get('/push/public-key', handler(() => ({ publicKey: vapid.publicKey })));

  router.get('/push/status', handler((request) => {
    const user = currentUser(request);
    const subscriptions = createSubscriptionStore(user.root).list();
    return { count: subscriptions.length, devices: subscriptions.map(item => ({ device: item.device, service: serviceOf(item.endpoint), createdAt: item.createdAt })) };
  }));

  router.post('/push/subscribe', handler((request) => {
    const user = currentUser(request);
    const subscription = normaliseSubscription(request.body?.subscription);
    if (!subscription) throw new HttpError(400, 'INVALID_SUBSCRIPTION');
    const language = notificationLanguage(request.body?.language);
    const count = createSubscriptionStore(user.root).add(subscription, { userAgent: request.get?.('user-agent'), language });
    return { count };
  }));

  router.post('/push/unsubscribe', handler((request) => {
    const user = currentUser(request);
    const endpoint = request.body?.endpoint;
    if (typeof endpoint !== 'string') throw new HttpError(400, 'INVALID_ENDPOINT');
    return { removed: createSubscriptionStore(user.root).remove(endpoint) };
  }));

  router.post('/push/test', handler(async (request) => {
    const user = currentUser(request);
    const last = lastTestAt.get(user.handle) || 0;
    if (now() - last < TEST_COOLDOWN_MS) throw new HttpError(429, 'RATE_LIMITED');
    lastTestAt.set(user.handle, now());
    const results = await notify(user, 'test');
    if (results.length === 0) throw new HttpError(409, 'NO_SUBSCRIPTION');
    return { results: results.map(({ removed, ...item }) => item), removed: results[0]?.removed ?? 0 };
  }));

  // --- housekeeping -----------------------------------------------------------------------

  const prune = () => {
    try {
      for (const entry of fs.readdirSync(dataRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
        resultStore(path.join(dataRoot, entry.name)).prune(now());
      }
    } catch (error) {
      console.warn(`${LOG} pruning old results failed:`, error?.message || error);
    }
  };
  prune();
  pruneTimer = setInterval(prune, PRUNE_INTERVAL_MS);
  pruneTimer.unref?.();

  console.info(`${LOG} background generation (${mode}) and push notifications ready; config: ${configFile}`);
}

export async function exit() {
  if (pruneTimer) clearInterval(pruneTimer);
  activeRelay?.abortAll();
  activeTakeover?.restore();
  activeTakeover = null;
}
