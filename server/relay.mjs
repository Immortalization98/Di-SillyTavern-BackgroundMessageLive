// The generate relay. Caddy rewrites POST /api/backends/chat-completions/generate to this plugin.
// Default behaviour is identical to SillyTavern: stream through, abort when the client disconnects.
// Only a request the extension registered just before (a main chat generation) is "detached":
// it keeps running when the client disconnects, and its result is kept for later recovery.
//
// Detached jobs are also kept alive for proxies such as Cloudflare, which drop a request when the
// origin sends nothing for about 100 seconds. If SillyTavern has not answered after
// `keepAliveAfterMs`, the relay sends the response headers itself (status 200) and then, while
// nothing else is written, harmless padding every `keepAliveIntervalMs`: an SSE comment line between
// stream events, or whitespace before a JSON body. If the upstream then fails, its error is rewritten
// into a body SillyTavern's page reports as an error, because the status can no longer change.
import { createStreamCollector, parseJsonResponse } from './sse.mjs';

/** Sources whose SillyTavern response is OpenAI-compatible (SSE deltas / choices[0].message). */
export const DETACHABLE_SOURCES = Object.freeze(['custom', 'openai', 'openrouter', 'deepseek']);
export const JOB_TIMEOUT_MS = 20 * 60 * 1000;
export const KEEPALIVE_AFTER_MS = 60_000;
export const KEEPALIVE_INTERVAL_MS = 20_000;
const MAX_RAW_CHARS = 1_000_000;
const SSE_KEEPALIVE = ': keepalive\n\n';

/** True when the text written so far ends on an SSE event boundary (a blank line). */
const endsEvent = (tail) => tail.endsWith('\n\n') || tail.endsWith('\r\n\r\n') || tail.endsWith('\r\r');

/**
 * The error body to send once a 200 status has already gone out. It always has an `error` field: the
 * non-streaming page path only reports `data.error`. SillyTavern's own error JSON is kept as it is;
 * a bare `message` / `detail` is wrapped; anything else becomes the same generic message the page
 * would have shown for that status.
 */
export function committedErrorBody(status, raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      if (parsed.error) return parsed;
      const text = parsed.message ?? parsed.detail;
      if (text) return { error: { message: (typeof text === 'string' ? text : JSON.stringify(text)).slice(0, 2000) } };
    }
  } catch { /* not JSON */ }
  return { error: { message: `Got response status ${status}` } };
}

export function createRelay({
  registry, loopback, onFinished, timeoutMs = JOB_TIMEOUT_MS, now = () => Date.now(), loopbackHeaders = {},
  keepAliveAfterMs = KEEPALIVE_AFTER_MS, keepAliveIntervalMs = KEEPALIVE_INTERVAL_MS,
}) {
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
    let settled = false;
    let keepAlive = null;
    const stopKeepAlive = () => { if (keepAlive) { clearTimeout(keepAlive); clearInterval(keepAlive); keepAlive = null; } };
    response.on('close', () => {
      if (response.writableFinished) return;
      clientGone = true;
      stopKeepAlive();
      if (!job) controller.abort();
    });
    let timer = null;
    if (job) {
      timer = setTimeout(() => { job.timedOut = true; controller.abort(); }, timeoutMs);
      timer.unref?.();
    }

    // What has been written to the client so far, shared by the keep-alive timer and the relay.
    // mode: 'sse' (padding = comment lines between events), 'json' (padding = whitespace before the
    // body) or null (no padding: an error body is being passed through unchanged).
    const out = { committed: false, mode: null, upstreamStarted: false, tail: '', activeSinceTick: false };
    const baseHeaders = () => {
      const headers = { 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' };
      if (job) headers['X-Bgml-Job'] = job.id;
      return headers;
    };
    const send = (chunk) => {
      response.write(chunk);
      response.flush?.();
      out.tail = (out.tail + (typeof chunk === 'string' ? chunk : chunk.toString('latin1'))).slice(-4);
    };
    const pad = () => {
      if (out.mode === 'sse' && (!out.upstreamStarted || endsEvent(out.tail))) send(SSE_KEEPALIVE);
      else if (out.mode === 'json' && !out.upstreamStarted) send(' ');
    };
    const tick = () => {
      if (clientGone || settled) return stopKeepAlive();
      if (out.activeSinceTick) { out.activeSinceTick = false; return; }
      pad();
    };
    if (job && keepAliveAfterMs > 0) {
      keepAlive = setTimeout(() => {
        keepAlive = null;
        if (clientGone || settled) return;
        if (!response.headersSent) {
          const headers = baseHeaders();
          headers['Content-Type'] = body?.stream === true ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8';
          response.writeHead(200, headers);
          response.flushHeaders?.();
          out.committed = true;
          out.mode = body?.stream === true ? 'sse' : 'json';
        }
        tick();
        keepAlive = setInterval(tick, keepAliveIntervalMs);
        keepAlive.unref?.();
      }, keepAliveAfterMs);
      keepAlive.unref?.();
    }
    const sendCommittedError = (payload) => {
      const text = JSON.stringify(payload);
      send(out.mode === 'sse' ? `data: ${text}\n\n` : text);
    };

    let upstream;
    try {
      upstream = await loopback(request, body, { port: request.socket?.localPort, signal: controller.signal, extraHeaders: loopbackHeaders });
    } catch {
      settled = true;
      stopKeepAlive();
      if (timer) clearTimeout(timer);
      const code = job?.cancelled ? 'CANCELLED' : job?.timedOut ? 'TIMEOUT' : 'RELAY_ERROR';
      const outcome = { ok: false, code };
      const message = code === 'TIMEOUT' ? 'Background generation timed out' : 'Background relay could not reach SillyTavern';
      if (!clientGone && out.committed) {
        if (code !== 'CANCELLED') sendCommittedError({ error: { message } });
        // Delivered only if the error reached the client socket, as in done() below.
        response.once('finish', () => finish(job, outcome, true));
        response.once('close', () => { if (!response.writableFinished) finish(job, outcome, false); });
        response.end();
        return;
      }
      if (!clientGone && !response.headersSent) response.status(502).json({ error: { message } });
      return finish(job, outcome, !clientGone);
    }

    const status = upstream.statusCode || 502;
    const contentType = String(upstream.headers['content-type'] || '');
    // SillyTavern's forwardFetchResponse() does not copy Content-Type, so the request's own
    // `stream` flag is the reliable signal; the header is only a second hint.
    const streaming = status === 200 && (body?.stream === true || contentType.includes('text/event-stream'));
    // After an early 200, an upstream error must not be passed through as it is (see sendCommittedError).
    const forward = !out.committed || status === 200;
    if (!clientGone && !out.committed) {
      const headers = baseHeaders();
      if (contentType) headers['Content-Type'] = contentType;
      response.writeHead(status, headers);
      response.flushHeaders?.();
      out.mode = status === 200 ? (streaming ? 'sse' : 'json') : null;
    }

    const collector = job && streaming ? createStreamCollector() : null;
    let raw = '';
    upstream.on('data', (chunk) => {
      if (!clientGone && !settled && forward) {
        out.upstreamStarted = true;
        out.activeSinceTick = true;
        send(chunk);
      }
      if (collector) collector.push(chunk);
      else if (job && raw.length < MAX_RAW_CHARS) raw += chunk.toString('utf8');
    });

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
      stopKeepAlive();
      if (timer) clearTimeout(timer);
      if (!job) { if (!clientGone) response.end(); return; }
      const outcome = summarise(endedNormally);
      if (clientGone) return finish(job, outcome, false);
      if (!forward && !job.cancelled) sendCommittedError(committedErrorBody(status, raw));
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
