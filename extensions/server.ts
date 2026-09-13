import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const assets = new Map([
  ['/', ['../web/index.html', 'text/html']],
  ['/xterm.js', ['../node_modules/@xterm/xterm/lib/xterm.js', 'text/javascript']],
  ['/xterm.css', ['../node_modules/@xterm/xterm/css/xterm.css', 'text/css']],
  ['/ask-user.js', ['../web/ask-user.js','text/javascript']],
  ['/app.js', ['../web/app.js', 'text/javascript']],
  ['/style.css', ['../web/style.css', 'text/css']],
  ['/fonts.css', ['../web/fonts.css', 'text/css']],
  ['/fonts/noto-sans-mono-latin.woff2', ['../node_modules/@fontsource-variable/noto-sans-mono/files/noto-sans-mono-latin-wght-normal.woff2', 'font/woff2']],
  ['/fonts/noto-sans-mono-latin-ext.woff2', ['../node_modules/@fontsource-variable/noto-sans-mono/files/noto-sans-mono-latin-ext-wght-normal.woff2', 'font/woff2']],
  ['/fonts/noto-sans-mono-vietnamese.woff2', ['../node_modules/@fontsource-variable/noto-sans-mono/files/noto-sans-mono-vietnamese-wght-normal.woff2', 'font/woff2']],
  ['/fonts/noto-sans-mono-greek.woff2', ['../node_modules/@fontsource-variable/noto-sans-mono/files/noto-sans-mono-greek-wght-normal.woff2', 'font/woff2']],
  ['/fonts/noto-sans-mono-greek-ext.woff2', ['../node_modules/@fontsource-variable/noto-sans-mono/files/noto-sans-mono-greek-ext-wght-normal.woff2', 'font/woff2']],
  ['/fonts/noto-sans-mono-cyrillic.woff2', ['../node_modules/@fontsource-variable/noto-sans-mono/files/noto-sans-mono-cyrillic-wght-normal.woff2', 'font/woff2']],
  ['/fonts/noto-sans-mono-cyrillic-ext.woff2', ['../node_modules/@fontsource-variable/noto-sans-mono/files/noto-sans-mono-cyrillic-ext-wght-normal.woff2', 'font/woff2']],
  ['/marked.js', ['../node_modules/marked/lib/marked.umd.js', 'text/javascript']],
  ['/purify.js', ['../node_modules/dompurify/dist/purify.min.js', 'text/javascript']],
  ['/highlight.js', ['../node_modules/@highlightjs/cdn-assets/highlight.min.js', 'text/javascript']],
]);

/** One loopback server belongs to one live pi process. No session files are written. */
export async function startServer({ snapshot, action, connection }) {
  const token = connection?.token || randomBytes(32).toString('hex');
  const clients = new Set();
  let origin;
  const server = createServer(async (req, res) => {
    const reply = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) {
        return reply(403, { error: '请求来源不匹配' });
      }
      const url = new URL(req.url, origin);
      const asset = assets.get(url.pathname);
      if (asset && req.method === 'GET') {
        const body = await readFile(new URL(asset[0], import.meta.url));
        res.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8` });
        return res.end(body);
      }
      if (req.headers.authorization !== `Bearer ${token}`) return reply(401, { error: '连接凭证已失效，请在 TUI 执行 /web' });
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive' });
        res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/action') {
        if (!req.headers['content-type']?.startsWith('application/json')) return reply(415, { error: '需要 JSON' });
        let size = 0;
        const chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 256 * 1024) { reply(413, { error: '消息过长' }); return; }
          chunks.push(chunk);
        }
        let input;
        try { input = JSON.parse(Buffer.concat(chunks).toString()); }
        catch { return reply(400, { error: '无效 JSON' }); }
        const result = await action(input);
        return reply(200, { ok: true, ...result });
      }
      reply(404, { error: '不存在的接口' });
    } catch (error) {
      if (!res.headersSent) reply(400, { error: error.message });
      else res.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(connection?.port || 0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(': heartbeat\n\n');
  }, 15000);
  heartbeat.unref();
  return {
    url: `${origin}/#${token}`,
    connection: { port: server.address().port, token },
    publish() {
      if (!clients.size) return;
      const data = `data: ${JSON.stringify(snapshot())}\n\n`;
      for (const client of clients) {
        try { client.write(data); }
        catch { clients.delete(client); client.destroy(); }
      }
    },
    async close() {
      clearInterval(heartbeat);
      for (const client of clients) client.end();
      clients.clear();
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    },
  };
}
