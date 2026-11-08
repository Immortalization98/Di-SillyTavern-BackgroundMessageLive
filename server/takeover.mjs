// In-process takeover of SillyTavern's chat-completions generate route — no reverse proxy needed.
//
// SillyTavern exports the router of src/endpoints/backends/chat-completions.js and mounts that very
// object at /api/backends/chat-completions. Importing the same file from a server plugin yields the
// same instance, and Express 4 reads `layer.handle` on every request, so wrapping the route's handler
// at runtime takes effect immediately. Login, whitelist and CSRF middlewares run before the route,
// exactly as before. If anything does not look as expected we change nothing and report it.
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const BYPASS_HEADER = 'x-bgml-bypass';
export const ROUTER_MODULE = 'src/endpoints/backends/chat-completions.js';

/** Random per process; marks the plugin's own loopback calls so they reach the original handler. */
export const createBypassToken = () => crypto.randomBytes(24).toString('hex');

function findGenerateHandler(router) {
  if (!Array.isArray(router?.stack)) return null;
  const layer = router.stack.find(item => item?.route?.path === '/generate' && item.route.methods?.post);
  const handlers = layer?.route?.stack;
  if (!Array.isArray(handlers) || handlers.length !== 1 || typeof handlers[0]?.handle !== 'function') return null;
  return handlers[0];
}

/**
 * Wraps the generate route. `onRequest(request, response, callOriginal)` receives every request
 * except the plugin's own loopback calls (recognised by the bypass token).
 * Returns { callOriginal, restore } or { error } when the route cannot be taken over safely.
 */
export async function installGenerateTakeover({ appDirectory = process.cwd(), routerModuleUrl, bypassToken, onRequest }) {
  let router;
  try {
    const url = routerModuleUrl || pathToFileURL(path.join(appDirectory, ROUTER_MODULE)).href;
    ({ router } = await import(url));
  } catch (error) {
    return { error: `cannot load ${ROUTER_MODULE}: ${error?.message || error}` };
  }
  const target = findGenerateHandler(router);
  if (!target) return { error: 'POST /generate route not found or not in the expected shape' };
  if (target.handle.bgmlWrapped) return { error: 'generate route already wrapped' };

  const original = target.handle;
  const wrapped = function bgmlGenerate(request, response, next) {
    const callOriginal = () => original.call(this, request, response, next);
    if (request.headers?.[BYPASS_HEADER] === bypassToken) return callOriginal();
    return onRequest(request, response, callOriginal);
  };
  wrapped.bgmlWrapped = true;
  target.handle = wrapped;

  return {
    callOriginal: (request, response, next = () => {}) => original.call(target, request, response, next),
    restore() { if (target.handle === wrapped) target.handle = original; },
  };
}
