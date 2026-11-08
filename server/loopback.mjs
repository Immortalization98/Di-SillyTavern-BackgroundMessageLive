// Re-issues a request to SillyTavern's own endpoint inside the same process, over loopback.
// The user's session cookie and CSRF token are forwarded unchanged, so SillyTavern performs its
// normal login/CSRF checks and reads the user's own API key itself; this plugin never sees keys.
import http from 'node:http';

export const GENERATE_PATH = '/api/backends/chat-completions/generate';
const FORWARDED_HEADERS = ['cookie', 'x-csrf-token', 'host', 'user-agent', 'authorization', 'accept-language'];

/** Resolves with the upstream http.IncomingMessage once response headers arrive. */
export function loopbackRequest(request, body, { port, path = GENERATE_PATH, signal, host = '127.0.0.1', extraHeaders = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body ?? {}));
    const headers = {
      'content-type': 'application/json',
      'content-length': String(payload.length),
      accept: request.headers?.accept || '*/*',
      'accept-encoding': 'identity',
    };
    for (const name of FORWARDED_HEADERS) {
      const value = request.headers?.[name];
      if (value) headers[name] = value;
    }
    Object.assign(headers, extraHeaders);
    const outgoing = http.request({ host, port, method: 'POST', path, headers, signal, agent: false }, resolve);
    outgoing.on('error', reject);
    outgoing.end(payload);
  });
}
