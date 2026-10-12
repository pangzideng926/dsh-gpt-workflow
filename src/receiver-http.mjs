import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
export async function serveReceiver(store, token) {
  const server = http.createServer(async (req, res) => {
    const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    const supplied = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (req.headers.origin || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return reply(403, { error: '未授权' });
    try {
      if (req.method === 'GET' && req.url === '/health') return reply(200, { protocol: 1, version: '0.2.0', mode: 'desktop' });
      if (req.method === 'GET' && req.url.startsWith('/jobs/')) return reply(200, store.get(req.url.slice(6)));
      if (req.method !== 'POST' || (req.url !== '/jobs' && !req.url.startsWith('/reviews/'))) return reply(404, { error: '未知接口' });
      const chunks = []; let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 1000000) { reply(413, { error: '任务过大' }); return; }
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return reply(200, req.url === '/jobs' ? await store.accept(body) : store.review(req.url.slice(9), body));
    } catch (error) { reply(error.code === 'ENOENT' ? 404 : 409, { error: error.message }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
