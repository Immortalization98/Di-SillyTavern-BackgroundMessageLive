// The generate relay. Caddy rewrites POST /api/backends/chat-completions/generate to this plugin.
// Default behaviour is identical to SillyTavern: stream through, abort when the client disconnects.
// Only a request the extension registered just before (a main chat generation) is "detached":
// it keeps running when the client disconnects, and its result is kept for later recovery.
import { createStreamCollector, parseJsonResponse } from './sse.mjs';

/** Sources whose SillyTavern response is OpenAI-compatible (SSE deltas / choices[0].message). */
export const DETACHABLE_SOURCES = Object.freeze(['custom', 'openai', 'openrouter', 'deepseek']);
export const JOB_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_RAW_CHARS = 1_000_000;

export function createRelay({ registry, loopback, onFinished, timeoutMs = JOB_TIMEOUT_MS, now = () => Date.now(), loopbackHeaders = {} }) {
  const jobs = new Map();

  function finish(job, outcome, delivered) {
    if (!job || job.finished) return;
    job.finished = true;
    jobs.delete(job.id);
    if (delivered || outcome.code === 'CANCELLED') return;
    Promise.resolve(onFinished(job, outcome)).catch(error => console.error('[di-bgmessage-live] saving result failed:', error?.message || error));
  }

  /**
   * `passThrough` (in-process mode) hands a request straight to SillyTavern's original handler.
   * Without it (reverse-proxy mode) non-detached requests are relayed over loopback instead.
   */
  async function handle(request, response, user, { passThrough } = {}) {
    const body = request.body;
    const registration = user ? registry.consume(user.handle, body?.type) : null;
    const detach = Boolean(registration) && DETACHABLE_SOURCES.includes(body?.chat_completion_source);
    if (!detach && passThrough) return passThrough();
    const controller = new AbortController();
    const job = detach ? {
      id: registration.id, user, registration, controller,
      startedAt: new Date(now()).toISOString(), cancelled: false, timedOut: false, finished: false,
    } : null;
    if (job) jobs.set(job.id, job);

    let clientGone = false;
    response.on('close', () => {
      if (response.writableFinished) return;
      clientGone = true;
      if (!job) controller.abort();
    });
    let timer = null;
    if (job) {
      timer = setTimeout(() => { job.timedOut = true; controller.abort(); }, timeoutMs);
      timer.unref?.();
    }

    let upstream;
    try {
      upstream = await loopback(request, body, { port: request.socket?.localPort, signal: controller.signal, extraHeaders: loopbackHeaders });
    } catch {
      if (timer) clearTimeout(timer);
      if (!clientGone && !response.headersSent) response.status(502).json({ error: { message: 'Background relay could not reach SillyTavern' } });
      const code = job?.cancelled ? 'CANCELLED' : job?.timedOut ? 'TIMEOUT' : 'RELAY_ERROR';
      return finish(job, { ok: false, code }, !clientGone);
    }

    const status = upstream.statusCode || 502;
    const contentType = String(upstream.headers['content-type'] || '');
    // SillyTavern's forwardFetchResponse() does not copy Content-Type, so the request's own
    // `stream` flag is the reliable signal; the header is only a second hint.
    const streaming = status === 200 && (body?.stream === true || contentType.includes('text/event-stream'));
    if (!clientGone) {
      const headers = { 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' };
      if (contentType) headers['Content-Type'] = contentType;
      if (job) headers['X-Bgml-Job'] = job.id;
      response.writeHead(status, headers);
      response.flushHeaders?.();
    }

    const collector = job && streaming ? createStreamCollector() : null;
    let raw = '';
    upstream.on('data', (chunk) => {
      if (!clientGone) { response.write(chunk); response.flush?.(); }
      if (collector) collector.push(chunk);
      else if (job && raw.length < MAX_RAW_CHARS) raw += chunk.toString('utf8');
    });

    let settled = false;
    const summarise = (endedNormally) => {
      if (job?.cancelled) return { ok: false, code: 'CANCELLED' };
      if (job?.timedOut) return { ok: false, code: 'TIMEOUT' };
      if (!endedNormally) return { ok: false, code: 'INTERRUPTED' };
      if (status !== 200) return { ok: false, code: 'UPSTREAM_ERROR', status };
      let parsed = collector ? collector.finish() : parseJsonResponse(raw);
      if (!collector && parsed.error && /^\s*data:/m.test(raw)) {
        const fallback = createStreamCollector();
        fallback.push(raw);
        parsed = fallback.finish();
      }
      if (parsed.error) return { ok: false, code: 'UPSTREAM_ERROR', status };
      if (parsed.tooLarge) return { ok: false, code: 'TOO_LARGE' };
      if (!parsed.text && !parsed.reasoning) return { ok: false, code: 'EMPTY' };
      return { ok: true, text: parsed.text, reasoning: parsed.reasoning };
    };
    const done = (endedNormally) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (!job) { if (!clientGone) response.end(); return; }
      const outcome = summarise(endedNormally);
      if (clientGone) return finish(job, outcome, false);
      // Delivered only if the whole response reached the client socket.
      response.once('finish', () => finish(job, outcome, true));
      response.once('close', () => { if (!response.writableFinished) finish(job, outcome, false); });
      response.end();
    };
    upstream.on('end', () => done(true));
    upstream.on('error', () => done(false));
    upstream.on('aborted', () => done(false));
    upstream.on('close', () => done(upstream.complete));
  }

  return {
    handle,
    cancel(handle, id) {
      const job = jobs.get(id);
      if (!job || job.user.handle !== handle) return false;
      job.cancelled = true;
      job.controller.abort();
      return true;
    },
    active(handle) {
      return [...jobs.values()].filter(job => job.user.handle === handle).map(job => ({
        id: job.id, type: job.registration.type, chatId: job.registration.chatId,
        characterAvatar: job.registration.characterAvatar, startedAt: job.startedAt,
      }));
    },
    abortAll() { for (const job of jobs.values()) { job.cancelled = true; job.controller.abort(); } },
    size: () => jobs.size,
  };
}
