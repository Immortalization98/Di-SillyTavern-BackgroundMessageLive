// Local-only mock of an OpenAI-compatible model: streams a reply slowly and logs disconnects.
import http from 'node:http';

const port = Number(process.argv[2] || 8020);
const parts = ['旅人，', '欢迎来到', '小镇的', '酒馆。', '炉火', '正旺，', '窗外', '下着', '细雨。', '你想', '先喝', '点什么', '暖暖', '身子吗？', '（店主', '擦着', '杯子，', '朝你', '微笑。）', '【结束】'];
let counter = 0;

http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'mock-model', object: 'model' }] }));
  }
  if (req.method !== 'POST' || !req.url.startsWith('/v1/chat/completions')) { res.writeHead(404); return res.end(); }
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    const id = ++counter;
    const tag = `#${id}`;
    console.log(`${new Date().toISOString()} ${tag} start stream=${body.stream} messages=${body.messages?.length}`);
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: parts.join('') } }] }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    let i = 0;
    let closed = false;
    res.on('close', () => { if (!res.writableFinished) { closed = true; console.log(`${new Date().toISOString()} ${tag} CLIENT ABORTED after ${i} parts`); } });
    const timer = setInterval(() => {
      if (closed) return clearInterval(timer);
      if (i < parts.length) {
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: parts[i] } }] })}\n\n`);
        i++;
      } else {
        clearInterval(timer);
        res.write('data: [DONE]\n\n');
        res.end();
        console.log(`${new Date().toISOString()} ${tag} COMPLETED all ${parts.length} parts`);
      }
    }, 400);
  });
}).listen(port, '127.0.0.1', () => console.log(`mock llm on ${port}`));
