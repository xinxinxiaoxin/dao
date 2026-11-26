import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

export async function startPage(runtime, port) {
  const tokenFile = join(runtime.settings.directory, 'page-token');
  try { await writeFile(tokenFile, randomBytes(24).toString('hex'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const token = await readFile(tokenFile, 'utf8');
  const page = await readFile(new URL('../ui/settings.html', import.meta.url), 'utf8');
  const server = http.createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      const json = (status, data) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(data)); };
      if (path === '/_health' && req.method === 'GET') return json(200, { plugin: 'qiandao-gateway', directory: runtime.settings.directory, pid: process.pid });
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, PUT', 'access-control-allow-headers': 'content-type,x-qiandao-page' });
        return res.end();
      }
      if (path === '/' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(page.replaceAll('__PAGE_TOKEN__', token));
      }
      if (req.headers['x-qiandao-page'] !== token) return json(403, { error: '页面连接已失效，本次修改尚未保存。请关闭并重新打开 dao 页面。' });
      if (path === '/api/state' && req.method === 'GET') return json(200, { settings: await runtime.settings.read(), scheduler: await runtime.scheduler.snapshot(), recent: runtime.relay.recent });
      if (path === '/api/settings' && req.method === 'PUT') {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 65536) return json(413, { error: '配置内容过大。' }); chunks.push(chunk); }
        return json(200, { settings: await runtime.settings.save(JSON.parse(Buffer.concat(chunks).toString())) });
      }
      return json(404, { error: '未找到此页面。' });
    } catch (error) { res.writeHead(400, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify({ error: error.message })); }
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    server.unref();
    return server;
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    let existing;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/_health`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) existing = await response.json();
    } catch { /* An occupied port may belong to an unrelated service. */ }
    if (existing?.plugin !== 'qiandao-gateway' || existing.directory !== runtime.settings.directory) throw new Error(`设置端口 ${port} 已被其他程序使用。`);
    return null;
  }
}
