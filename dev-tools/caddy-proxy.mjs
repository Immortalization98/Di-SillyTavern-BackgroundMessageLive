// Local-only helper proxy (dev tool). In rewrite mode it mimics the optional reverse-proxy rule:
//   POST /api/backends/chat-completions/generate  ->  /api/plugins/di-bgmessage-live/generate
// Everything else is proxied unchanged. Streams are piped without buffering.
import http from 'node:http';

// Add --no-rewrite to only forward traffic (simulates a deployment without any proxy rule,
// while still allowing /__drop-generate to cut the generate connection).
const listenPort = Number(process.argv[2] || 8011);
const targetPort = Number(process.argv[3] || 8010);
const rewriteEnabled = !process.argv.includes('--no-rewrite');
const FROM = '/api/backends/chat-completions/generate';
const TO = '/api/plugins/di-bgmessage-live/generate';

const generateSockets = new Set();

http.createServer((req, res) => {
  // Test hook: simulate the phone dropping the connection while the page stays alive.
  if (req.url === '/__drop-generate') {
    const count = generateSockets.size;
    for (const socket of generateSockets) socket.destroy();
    generateSockets.clear();
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end(`dropped ${count}`);
  }
  const isGenerate = req.method === 'POST' && req.url.split('?')[0] === FROM;
  const rewritten = isGenerate && rewriteEnabled;
  const path = rewritten ? TO : req.url;
  if (isGenerate) {
    console.log(`${new Date().toISOString()} generate ${rewritten ? `rewritten -> ${TO}` : 'forwarded unchanged'}`);
    generateSockets.add(req.socket);
    res.on('close', () => generateSockets.delete(req.socket));
  }
  const upstream = http.request({ host: '127.0.0.1', port: targetPort, method: req.method, path, headers: req.headers }, (up) => {
    res.writeHead(up.statusCode, up.headers);
    up.pipe(res);
  });
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
  req.pipe(upstream);
}).listen(listenPort, '127.0.0.1', () => console.log(`proxy ${listenPort} -> ${targetPort} (rewrite ${rewriteEnabled ? 'on' : 'off'})`));
