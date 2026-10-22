import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { AWS, errorInfo, matchDistributions, invalidationPaths } from './aws.js';
import { newJob, publicJob, runBatch, validateSelection, validateTargets } from './jobs.js';
import { pathToFileURL } from 'node:url';
import { locateURL } from './locator.js';
import { createGCPRoutes } from './gcp-routes.js';

export function createServer(factory = credentials => new AWS(credentials), gcpFactory, gcpJobOptions) {
  const sessions = new Map();
  const gcp = createGCPRoutes(gcpFactory, gcpJobOptions);
  const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
  async function body(req) {
    const chunks = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 2 * 1024 ** 2) throw new Error('请求内容过大'); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const expected = `127.0.0.1:${server.address().port}`;
    if (req.headers.host !== expected || (req.headers.origin && req.headers.origin !== `http://${expected}`)) return json(res, 403, { error: { message: 'Host 或 Origin 不允许' } });
    const url = new URL(req.url, `http://${expected}`); const route = url.pathname;
    try {
      const staticFiles = { '/': ['public/index.html', 'text/html'], '/app.js': ['public/app.js', 'text/javascript'], '/task-groups.js': ['task-groups.js', 'text/javascript'], '/style.css': ['public/style.css', 'text/css'], '/icons.js': ['node_modules/lucide/dist/umd/lucide.js', 'text/javascript'] };
      Object.assign(staticFiles, { '/gcp': ['public/gcp.html', 'text/html'], '/gcp-app.js': ['public/gcp-app.js', 'text/javascript'], '/gcp-style.css': ['public/gcp-style.css', 'text/css'] });
      if (req.method === 'GET' && staticFiles[route]) {
        const [file, type] = staticFiles[route]; const data = await readFile(new URL(file, import.meta.url));
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); return res.end(data);
      }
      if (req.method !== 'GET' && req.headers.origin !== `http://${expected}`) return json(res, 403, { error: { message: '缺少同源 Origin' } });
      if (route.startsWith('/api/gcp/')) return await gcp.route(req, res, url, { body, json, port: server.address().port });
      const cookieName = `aws_session_${server.address().port}`;
      const sid = new RegExp(`(?:^|; )${cookieName}=([^;]+)`).exec(req.headers.cookie || '')?.[1];
      if (route === '/api/connect' && req.method === 'POST') {
        const b = await body(req);
        if (!b.accessKeyId?.trim() || !b.secretAccessKey?.trim()) throw new Error('请输入 Access Key 和 Secret Key');
        if (sessions.has(sid)) { await sessions.get(sid).aws.close(); sessions.delete(sid); }
        const id = randomUUID(); const session = { aws: factory({ accessKeyId: b.accessKeyId.trim(), secretAccessKey: b.secretAccessKey.trim(), ...(b.sessionToken?.trim() ? { sessionToken: b.sessionToken.trim() } : {}) }), jobs: new Map(), checks: { s3: { state: 'checking' }, cf: { state: 'checking' } }, buckets: [] };
        sessions.set(id, session);
        for (const [name, fn] of [['s3', () => session.aws.buckets()], ['cf', () => session.aws.distributionList()]]) {
          Promise.resolve().then(fn).then(data => { session.checks[name] = { state: 'available' }; if (name === 's3') session.buckets = data; }).catch(e => { session.checks[name] = { state: /AccessDenied|Unauthorized/.test(e.name) ? 'denied' : 'failed', error: errorInfo(e, name) }; });
        }
        res.setHeader('Set-Cookie', `${cookieName}=${id}; HttpOnly; SameSite=Strict; Path=/`); return json(res, 200, { connected: true });
      }
      const s = sessions.get(sid); if (!s) return json(res, 401, { error: { message: '请先连接 AWS' } });
      if (route === '/api/session' && req.method === 'GET') return json(res, 200, { checks: s.checks, buckets: s.buckets });
      if (route === '/api/disconnect' && req.method === 'POST') {
        s.jobs.forEach(j => j.controller.abort()); await s.aws.close(); sessions.delete(sid);
        res.setHeader('Set-Cookie', `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`); return json(res, 200, {});
      }
      if (route === '/api/objects' && req.method === 'GET') return json(res, 200, await s.aws.list(url.searchParams.get('bucket'), url.searchParams.get('prefix') || '', url.searchParams.get('token') || undefined, url.searchParams.get('region') || undefined));
      if (route === '/api/locate' && req.method === 'POST') {
        const b = await body(req);
        return json(res, 200, await locateURL(s.aws, b.url));
      }
      if (route === '/api/folders' && req.method === 'POST') {
        const b = await body(req);
        if (!b.bucket || typeof b.key !== 'string') throw new Error('文件夹参数无效');
        await s.aws.createFolder(b.bucket, b.key);
        return json(res, 201, { bucket: b.bucket, key: b.key });
      }
      if (route === '/api/jobs' && req.method === 'POST') {
        const b = await body(req); validateTargets(b, validateSelection(b.selected));
        const job = newJob(b.action); s.jobs.set(job.id, job); void runBatch(s.aws, b, job); return json(res, 202, { id: job.id });
      }
      const match = /^\/api\/jobs\/([^/]+)(\/cancel)?$/.exec(route);
      if (match) {
        const j = s.jobs.get(match[1]); if (!j) return json(res, 404, { error: { message: '任务不存在' } });
        if (match[2] && req.method === 'POST') j.controller.abort();
        return json(res, 200, publicJob(j));
      }
      if (route === '/api/uploads' && req.method === 'POST') {
        const b = await body(req);
        if (!b.bucket || typeof b.key !== 'string' || !b.key || Buffer.byteLength(b.key) > 1024 || !Number.isSafeInteger(b.size) || b.size < 0 || b.size > 5 * 1024 ** 4) throw new Error('上传参数无效');
        const j = newJob('upload'); Object.assign(j, { total: b.size, loaded: 0, bucket: b.bucket, key: b.key, overwrite: b.overwrite === true, contentType: b.contentType }); s.jobs.set(j.id, j);
        return json(res, 201, { id: j.id });
      }
      const up = /^\/api\/uploads\/([^/]+)$/.exec(route);
      if (up && req.method === 'PUT') {
        const j = s.jobs.get(up[1]); if (!j || j.type !== 'upload' || j.state !== 'preparing' || j.controller.signal.aborted) throw new Error('上传任务无效');
        if (Number(req.headers['content-length']) !== j.total) throw new Error('文件长度不匹配');
        j.state = 'running'; const abort = () => j.controller.abort(); req.once('aborted', abort);
        try {
          if (!j.overwrite && await s.aws.head(j.bucket, j.key)) { req.resume(); j.state = 'skipped'; }
          else { await s.aws.upload(j.bucket, j.key, req, j.total, j.contentType, loaded => { j.loaded = loaded; }, j.controller.signal); j.loaded = j.total; j.state = 'completed'; }
        } catch (e) { j.state = 'failed'; j.error = errorInfo(e, 'upload public-read', j.key); }
        finally { req.removeListener('aborted', abort); }
        return json(res, 200, publicJob(j));
      }
      if (route === '/api/distributions' && req.method === 'GET') return json(res, 200, { items: matchDistributions(await s.aws.distributionList(), url.searchParams.get('domain') || '') });
      if (route === '/api/invalidations' && req.method === 'POST') {
        const b = await body(req); if (!/^[A-Z0-9]+$/.test(b.id) || !/^[\w-]{16,100}$/.test(b.reference)) throw new Error('分配 ID 或请求标识无效');
        const r = await s.aws.invalidate(b.id, invalidationPaths(b.paths), b.reference); return json(res, 200, r.Invalidation);
      }
      if (route === '/api/invalidations' && req.method === 'GET') { const r = await s.aws.invalidation(url.searchParams.get('distribution'), url.searchParams.get('id')); return json(res, 200, r.Invalidation); }
      return json(res, 404, { error: { message: '接口不存在' } });
    } catch (e) { if (!res.headersSent) json(res, 400, { error: errorInfo(e, route) }); else res.destroy(); }
  });
  server.on('close', () => { sessions.forEach(s => { s.jobs.forEach(j => j.controller.abort()); s.aws.close(); }); sessions.clear(); void gcp.close(); });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 8787);
  const server = createServer(); server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `端口 ${port} 已占用，请设置 PORT 后重启。` : e.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`AWS Storage Tool: http://127.0.0.1:${server.address().port}`));
}
