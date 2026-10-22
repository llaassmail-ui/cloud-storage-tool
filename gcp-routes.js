import { randomUUID } from 'node:crypto';
import { GCP, errorInfo } from './gcp.js';
import { newJob, publicJob, validateSelection, validateTargets } from './jobs.js';
import { runGCPBatch, runInvalidations, resumeInvalidations } from './gcp-jobs.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function projectId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:.-]{0,252}$/.test(value)) throw new Error('项目 ID 无效');
  return value;
}
function mapName(value) {
  if (typeof value !== 'string' || !/^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/.test(value)) throw new Error('全局 URL 映射名称无效');
  return value;
}
function bucketName(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(value) || value.includes('..')) throw new Error('存储桶名称无效');
  return value;
}
function objectKey(value, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value) || Buffer.byteLength(value) > 1024 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('对象路径无效');
  return value;
}
function permission(value) {
  if (!['inherit', 'public'].includes(value)) throw new Error('请明确选择权限：继承存储桶权限或公开读取');
  return value;
}
function overwrite(value) {
  if (value !== undefined && typeof value !== 'boolean') throw new Error('覆盖选项必须为布尔值');
  return value === true;
}
function domain(value = '') {
  if (typeof value !== 'string' || /[\s\u0000-\u001f\u007f\\]/.test(value)) throw new Error('域名或 URL 无效');
  if (!value) return { host: '', path: '/' };
  let url;
  try { url = new URL(value.includes('://') ? value : `https://${value}`); } catch { throw new Error('域名或 URL 无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname ||
      !/^[a-z0-9.-]+$/i.test(url.hostname)) throw new Error('域名或 URL 无效');
  return { host: url.hostname.toLowerCase().replace(/\.$/, ''), path: url.pathname || '/' };
}
function invalidationHost(value) {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || !/^(?:\*|(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.?)$/i.test(value)) throw new Error('缓存刷新主机名无效');
  return value.toLowerCase().replace(/\.$/, '');
}
function invalidationPaths(value) {
  if (typeof value !== 'string') throw new Error('请逐行输入缓存刷新路径');
  const paths = [...new Set(value.split(/\r?\n/).map(path => path.trim()).filter(Boolean))];
  if (!paths.length || paths.length > 100 || paths.some(path => !path.startsWith('/') || path.length > 1024 ||
      /[?#\s\u0000-\u001f\u007f]/.test(path) || (path.includes('*') && path.indexOf('*') !== path.length - 1))) {
    throw new Error('请输入 1–100 个以 / 开头的路径，通配符只能位于末尾，不能包含空格、控制字符、? 或 #');
  }
  return paths;
}
function check(result, operation, resource) {
  if (result.status === 'fulfilled') return { state: 'available' };
  const error = errorInfo(result.reason, operation, resource);
  const status = Number(result.reason?.status ?? result.reason?.statusCode ?? result.reason?.code ?? result.reason?.response?.status);
  return { state: status === 401 || status === 403 || /denied|unauthorized|forbidden/i.test(String(error.code)) ? 'denied' : 'failed', error };
}

export function createGCPRoutes(factory = options => new GCP(options), jobOptions = {}) {
  const sessions = new Map();
  let closed = false;
  const uploadPreparationTimeoutMs = Number.isFinite(jobOptions.uploadPreparationTimeoutMs) && jobOptions.uploadPreparationTimeoutMs >= 0
    ? jobOptions.uploadPreparationTimeoutMs : 5 * 60 * 1000;
  async function dispose(session) {
    for (const job of session.jobs.values()) job.controller.abort();
    try { await session.gcp.close(); } catch { /* Session disposal must not retain credentials after a close failure. */ }
  }
  const sessionInfo = session => ({ connected: true, projects: session.projects, projectError: session.projectError, project: session.project });
  function expirePreparingUploads(session) {
    const cutoff = Date.now() - uploadPreparationTimeoutMs;
    for (const job of session.jobs.values()) {
      if (job.type !== 'upload' || job.state !== 'preparing' || job.created > cutoff) continue;
      job.state = 'failed';
      job.error = errorInfo(new Error('上传数据未能及时收到，请重新选择本地文件后重试。'), 'upload', job.key);
    }
  }
  function launch(job, action) {
    void Promise.resolve().then(action).catch(error => {
      job.state = job.controller.signal.aborted ? 'cancelled' : 'failed';
      job.error = errorInfo(error, job.type);
    });
  }

  async function route(req, res, url, { body, json, port }) {
    const path = url.pathname;
    const cookieName = `gcp_session_${port}`;
    const sid = (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    const cookie = value => res.setHeader('Set-Cookie', `${cookieName}=${value}; HttpOnly; SameSite=Strict; Path=/${value ? '' : '; Max-Age=0'}`);
    const read = async () => {
      const value = await body(req);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求内容必须为 JSON 对象');
      return value;
    };
    try {
      if (closed) return json(res, 503, { error: { message: 'GCP 服务已关闭' } });
      if (path === '/api/gcp/connect' && req.method === 'POST') {
        const b = await read();
        if (!['adc', 'serviceAccount'].includes(b.mode)) throw new Error('请选择 ADC 或服务账号认证');
        if (b.mode === 'serviceAccount' && (!b.credentials || typeof b.credentials !== 'object' || Array.isArray(b.credentials))) throw new Error('请输入服务账号凭证');
        const gcp = await factory({ mode: b.mode, ...(b.mode === 'serviceAccount' ? { credentials: b.credentials } : {}) });
        const session = { gcp, jobs: new Map(), references: new Map(), projects: [], projectError: null, project: '' };
        try { await gcp.authenticate(); } catch (error) { await dispose(session); throw error; }
        try { session.projects = await gcp.projects(); } catch (error) { session.projectError = errorInfo(error, 'projects'); }
        if (closed) { await dispose(session); return json(res, 503, { error: { message: 'GCP 服务已关闭' } }); }
        const previous = sessions.get(sid);
        sessions.delete(sid);
        if (previous) await dispose(previous);
        const id = randomUUID(); sessions.set(id, session); cookie(id);
        return json(res, 200, sessionInfo(session));
      }
      const s = sessions.get(sid);
      if (!s) {
        if (path === '/api/gcp/session' && req.method === 'GET') return json(res, 200, { connected: false, projects: [], projectError: null, project: '' });
        if (req.method === 'PUT') req.resume();
        return json(res, 401, { error: { message: '请先连接 GCP' } });
      }
      if (path === '/api/gcp/session' && req.method === 'GET') return json(res, 200, sessionInfo(s));
      if (path === '/api/gcp/disconnect' && req.method === 'POST') {
        sessions.delete(sid); await dispose(s); cookie(''); return json(res, 200, {});
      }
      if (path === '/api/gcp/projects' && req.method === 'GET') {
        s.projects = await s.gcp.projects(); s.projectError = null; return json(res, 200, { items: s.projects });
      }
      if (path === '/api/gcp/project' && req.method === 'POST') {
        const project = projectId((await read()).project);
        const [storage, cdn] = await Promise.allSettled([
          Promise.resolve().then(() => s.gcp.buckets(project)), Promise.resolve().then(() => s.gcp.maps(project))
        ]);
        s.project = project;
        return json(res, 200, { project, checks: { storage: check(storage, 'buckets', project), cdn: check(cdn, 'maps', project) }, buckets: storage.status === 'fulfilled' ? storage.value : [] });
      }
      if (path === '/api/gcp/buckets' && req.method === 'GET') return json(res, 200, { items: await s.gcp.buckets(projectId(url.searchParams.get('project'))) });
      if (path === '/api/gcp/objects' && req.method === 'GET') {
        return json(res, 200, await s.gcp.list(bucketName(url.searchParams.get('bucket')), objectKey(url.searchParams.get('prefix') || '', true), url.searchParams.get('token') || undefined));
      }
      if (path === '/api/gcp/folders' && req.method === 'POST') {
        const b = await read(); bucketName(b.bucket); objectKey(b.key);
        if (!b.key.endsWith('/') || b.key.startsWith('/') || b.key.includes('//') || b.key.split('/').some(part => part === '.' || part === '..')) throw new Error('文件夹路径无效');
        await s.gcp.createFolder(b.bucket, b.key); return json(res, 201, { bucket: b.bucket, key: b.key });
      }
      if (path === '/api/gcp/jobs' && req.method === 'GET') {
        expirePreparingUploads(s);
        return json(res, 200, { items: [...s.jobs.values()].map(publicJob) });
      }
      if (path === '/api/gcp/jobs' && req.method === 'POST') {
        const b = await read(); bucketName(b.bucket);
        if (b.prefix !== undefined) objectKey(b.prefix, true);
        validateTargets(b, validateSelection(b.selected));
        if (b.action !== 'delete') { permission(b.permission); bucketName(b.targetBucket); objectKey(b.targetPrefix, true); }
        b.overwrite = overwrite(b.overwrite);
        const job = newJob(b.action);
        Object.assign(job, { bucket: b.bucket, prefix: b.prefix || '', targetBucket: b.targetBucket, targetPrefix: b.targetPrefix });
        s.jobs.set(job.id, job);
        launch(job, () => runGCPBatch(s.gcp, b, job, jobOptions)); return json(res, 202, { id: job.id });
      }
      const match = /^\/api\/gcp\/jobs\/([^/]+)(?:\/(cancel|resume))?$/.exec(path);
      if (match && ((!match[2] && req.method === 'GET') || (match[2] && req.method === 'POST'))) {
        expirePreparingUploads(s);
        const job = s.jobs.get(match[1]);
        if (!job) return json(res, 404, { error: { message: '任务不存在' } });
        if (match[2] === 'cancel') {
          job.controller.abort();
          if (['preparing', 'waiting'].includes(job.state)) job.state = 'cancelled';
        }
        if (match[2] === 'resume') {
          if (job.type !== 'invalidation' || !['waiting', 'cancelled', 'partial'].includes(job.state)) throw new Error('当前任务状态不支持恢复缓存刷新');
          job.controller = new AbortController(); job.state = 'running';
          launch(job, () => resumeInvalidations(s.gcp, job, jobOptions));
          return json(res, 202, { id: job.id });
        }
        return json(res, 200, publicJob(job));
      }
      if (path === '/api/gcp/uploads' && req.method === 'POST') {
        const b = await read(); bucketName(b.bucket); objectKey(b.key); permission(b.permission);
        const prefix = b.prefix === undefined ? b.key.slice(0, b.key.lastIndexOf('/') + 1) : objectKey(b.prefix, true);
        if ((prefix && (!prefix.endsWith('/') || prefix.startsWith('/') || prefix.includes('//') || prefix.split('/').some(part => part === '.' || part === '..'))) || !b.key.startsWith(prefix)) throw new Error('上传文件路径必须位于所选目标目录内');
        if (!Number.isSafeInteger(b.size) || b.size < 0 || b.size > 5 * 1024 ** 4 ||
            (b.contentType !== undefined && (typeof b.contentType !== 'string' || b.contentType.length > 1024 || /[\u0000-\u001f\u007f]/.test(b.contentType)))) throw new Error('上传参数无效');
        const job = newJob('upload');
        Object.assign(job, { bucket: b.bucket, key: b.key, prefix, total: b.size, loaded: 0, contentType: b.contentType || 'application/octet-stream', overwrite: overwrite(b.overwrite), permission: b.permission });
        s.jobs.set(job.id, job); return json(res, 201, { id: job.id });
      }
      const upload = /^\/api\/gcp\/uploads\/([^/]+)$/.exec(path);
      if (upload && req.method === 'PUT') {
        expirePreparingUploads(s);
        const job = s.jobs.get(upload[1]);
        if (!job || job.type !== 'upload' || job.state !== 'preparing' || job.controller.signal.aborted) throw new Error('上传任务无效');
        if (!/^[0-9]+$/.test(req.headers['content-length'] || '') || Number(req.headers['content-length']) !== job.total) throw new Error('上传文件长度不匹配');
        job.state = 'running'; const abort = () => job.controller.abort(); req.once('aborted', abort);
        try {
          const result = await s.gcp.upload(job.bucket, job.key, req, job.total, job.contentType, loaded => { job.loaded = loaded; }, job.controller.signal, { permission: job.permission, overwrite: job.overwrite });
          job.state = result?.skipped ? 'skipped' : 'completed';
          if (job.state === 'completed') job.loaded = job.total;
        } catch (error) {
          job.state = job.controller.signal.aborted ? 'cancelled' : 'failed';
          if (!job.controller.signal.aborted) job.error = errorInfo(error, 'upload', job.key);
        } finally {
          req.removeListener('aborted', abort);
          if (!req.readableEnded) req.resume();
        }
        return json(res, 200, publicJob(job));
      }
      if (path === '/api/gcp/maps' && req.method === 'GET') {
        const project = projectId(url.searchParams.get('project'));
        const { host, path: objectPath } = domain(url.searchParams.get('domain') || '');
        const maps = await s.gcp.maps(project);
        const rank = map => Math.min(...(map.hosts || []).map(value => {
          const pattern = value.toLowerCase().replace(/\.$/, '');
          return pattern === host ? 0 : pattern.startsWith('*.') && host.endsWith(pattern.slice(1)) && host !== pattern.slice(2) ? 1 : pattern === '*' ? 2 : 3;
        }), 3);
        const items = host ? maps.filter(map => rank(map) < 3).sort((a, b) => rank(a) - rank(b)) : maps;
        return json(res, 200, { items, host, path: objectPath });
      }
      if (path === '/api/gcp/invalidations' && req.method === 'POST') {
        const b = await read(); projectId(b.project); mapName(b.map);
        if (typeof b.reference !== 'string' || !uuid.test(b.reference)) throw new Error('请求标识必须为有效 UUID');
        const host = invalidationHost(b.host); const paths = invalidationPaths(b.paths);
        const reference = b.reference.toLowerCase();
        const fingerprint = JSON.stringify([b.project, b.map, host, paths]);
        const previous = s.references.get(reference);
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw new Error('该请求标识已用于其他缓存刷新内容');
          return json(res, 202, { id: previous.id });
        }
        const job = newJob('invalidation'); Object.assign(job, { project: b.project, map: b.map, host });
        s.jobs.set(job.id, job); s.references.set(reference, { id: job.id, fingerprint });
        launch(job, () => runInvalidations(s.gcp, { project: b.project, map: b.map, host, paths, reference }, job, jobOptions));
        return json(res, 202, { id: job.id });
      }
      return json(res, 404, { error: { message: '接口不存在' } });
    } catch (error) {
      if (req.method === 'PUT' && !req.readableEnded) req.resume();
      if (!res.headersSent) return json(res, 400, { error: errorInfo(error, path) });
      res.destroy();
    }
  }

  async function close() {
    closed = true; const current = [...sessions.values()]; sessions.clear();
    await Promise.allSettled(current.map(dispose));
  }
  return { route, close };
}
