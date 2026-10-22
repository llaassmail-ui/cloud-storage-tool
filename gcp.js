import { GoogleAuth } from 'google-auth-library';
import { Storage } from '@google-cloud/storage';
import { createPrivateKey } from 'node:crypto';
import { PassThrough, Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const STORAGE = 'https://storage.googleapis.com/storage/v1';
const COMPUTE = 'https://compute.googleapis.com/compute/v1';
const SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];
const enc = value => encodeURIComponent(value);
const status = error => Number(error?.response?.status || error?.code || error?.statusCode);
const failure = (code, message) => Object.assign(new Error(message), { code });
const messages = {
  400: 'Invalid Google Cloud request.', 401: 'Google Cloud authentication failed.',
  403: 'Google Cloud permission denied.', 404: 'Google Cloud resource not found.',
  409: 'Google Cloud resource conflict.', 412: 'Object generation precondition failed.',
  429: 'Google Cloud rate limit exceeded.', 500: 'Google Cloud service error.',
  502: 'Google Cloud service unavailable.', 503: 'Google Cloud service unavailable.',
  ETIMEDOUT: 'Google API 网络连接超时，请检查 V2Ray/Xray 是否开启以及 HTTP 代理端口。',
  ECONNREFUSED: 'Google API 代理连接被拒绝，请检查本机代理端口。',
  ECONNRESET: 'Google API 网络连接被重置，请检查 V2Ray/Xray 代理状态。',
  ENETUNREACH: '当前网络无法到达 Google API，请检查 V2Ray/Xray 代理和网络连接。',
  EAI_AGAIN: 'Google API 域名解析暂时失败，请检查 V2Ray/Xray 代理和 DNS。',
  InvalidCredentials: 'Invalid service account credentials.', InvalidInput: 'Invalid input.',
  InvalidPermission: 'Permission must be inherit or public.',
  PublicAccessRestricted: 'Bucket policy prevents object-level public access.',
  AbortError: 'Operation cancelled.', AuthenticationFailed: 'Google Cloud authentication failed.',
};

function sanitizeMessage(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(Bearer|Basic)\s+[^\s"',;]+/gi, '$1 [REDACTED]')
    .replace(/(["']?(?:authorization|private[_-]?key(?:[_-]?id)?|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|client[_-]?secret|password|token|credential|api[_-]?key)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s&,;}]+)/gi, '$1[REDACTED]')
    .replace(/https?:\/\/[^\s<>"']+/gi, '[REDACTED URL]')
    .replace(/\bya29\.[a-zA-Z0-9._-]+|\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, '[REDACTED TOKEN]')
    .replace(/\bsecret[-_][a-zA-Z0-9_-]+/gi, '[REDACTED]')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .slice(0, 2000);
}
const safeIdentifier = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}$/.test(value)
  && sanitizeMessage(value) === value ? value : '';

// Copy only explicitly selected diagnostics, never SDK configs or credential objects.
export function errorInfo(error, operation = '', object = '') {
  const apiError = error?.response?.data?.error;
  const code = error?.name === 'AbortError' ? 'AbortError'
    : safeIdentifier(apiError?.status) || safeIdentifier(String(error?.code ?? ''))
      || (Number.isFinite(status(error)) ? String(status(error)) : safeIdentifier(error?.name)) || 'Error';
  const headers = error?.response?.headers;
  const header = name => typeof headers?.get === 'function' ? headers.get(name) : headers?.[name];
  const requestId = safeIdentifier(error?.requestId) || safeIdentifier(header('x-goog-request-id'))
    || safeIdentifier(header('x-guploader-uploadid')) || safeIdentifier(header('x-request-id'));
  const sanitized = sanitizeMessage(typeof apiError?.message === 'string' ? apiError.message : error?.message);
  const useful = sanitized.replace(/(?:Bearer|Basic)\s*\[REDACTED\]/gi, '')
    .replace(/[a-zA-Z_"'-]+\s*[:=]\s*\[REDACTED\]/g, '')
    .replace(/\[REDACTED[^\]]*\]|[\s,;{}"']/g, '');
  const networkError = ['ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EAI_AGAIN'].includes(code);
  const message = networkError ? messages[code] : useful ? sanitized : messages[code] || messages[status(error)] || 'Google Cloud request failed.';
  return { operation: sanitizeMessage(operation), object: sanitizeMessage(object), code, message, requestId };
}

export function validatePermission(permission) {
  if (!['inherit', 'public'].includes(permission)) throw failure('InvalidPermission', messages.InvalidPermission);
  return permission;
}

export function validateServiceAccount(input) {
  let data = input;
  try { if (typeof data === 'string') data = JSON.parse(data); } catch { throw failure('InvalidCredentials', messages.InvalidCredentials); }
  const invalid = () => { throw failure('InvalidCredentials', messages.InvalidCredentials); };
  if (!data || typeof data !== 'object' || Array.isArray(data)) invalid();
  const allowed = new Set(['type', 'project_id', 'private_key_id', 'private_key', 'client_email', 'client_id',
    'auth_uri', 'token_uri', 'auth_provider_x509_cert_url', 'client_x509_cert_url', 'universe_domain']);
  if (Object.keys(data).some(key => !allowed.has(key)) || data.type !== 'service_account') invalid();
  if (typeof data.project_id !== 'string' || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(data.project_id)) invalid();
  if (typeof data.client_email !== 'string' || !/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.iam\.gserviceaccount\.com$/.test(data.client_email)) invalid();
  const endpoints = { token_uri: 'https://oauth2.googleapis.com/token', auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs', universe_domain: 'googleapis.com' };
  for (const [key, value] of Object.entries(endpoints)) if (data[key] !== undefined && data[key] !== value) invalid();
  if (data.client_x509_cert_url !== undefined && data.client_x509_cert_url !== `https://www.googleapis.com/robot/v1/metadata/x509/${enc(data.client_email)}`) invalid();
  if (typeof data.private_key !== 'string' || !data.private_key.startsWith('-----BEGIN PRIVATE KEY-----')) invalid();
  try { if (createPrivateKey(data.private_key).asymmetricKeyType !== 'rsa') invalid(); } catch { invalid(); }
  // Only these fields reach either SDK, even when optional fields are present in the JSON.
  return { type: 'service_account', project_id: data.project_id, client_email: data.client_email, private_key: data.private_key };
}

export function normalizeDomain(input) {
  if (typeof input !== 'string' || !input.trim()) throw failure('InvalidInput', 'Invalid CDN host.');
  const raw = input.trim();
  let url;
  try { url = new URL(raw.includes('://') ? raw : `https://${raw}`); } catch { throw failure('InvalidInput', 'Invalid CDN host.'); }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port ||
      !/^[a-z0-9.-]+$/.test(host) || host.length > 253 || host.split('.').some(part => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part))) {
    throw failure('InvalidInput', 'Invalid CDN host.');
  }
  return host;
}

export function invalidationPaths(text) {
  if (typeof text !== 'string') throw failure('InvalidInput', 'Invalid CDN path.');
  const paths = [...new Set(text.split(/\r?\n/).map(path => path.trim()).filter(Boolean))];
  if (!paths.length || paths.some(path => !path.startsWith('/') || path.length > 1024 || /[?#\s\x00-\x1f\x7f]/.test(path) ||
    (path.includes('*') && path.indexOf('*') !== path.length - 1))) {
    throw failure('InvalidInput', 'Invalid CDN path.');
  }
  return paths;
}

function generationValue(value) {
  if ((typeof value !== 'string' && typeof value !== 'number') ||
      (typeof value === 'number' && !Number.isSafeInteger(value)) || !/^[1-9][0-9]*$/.test(String(value))) {
    throw failure('InvalidInput', 'A valid object generation is required.');
  }
  return String(value);
}
const objectInfo = item => ({ key: item.name, size: Number(item.size || 0), modified: item.updated, generation: generationValue(item.generation) });

export class GCP {
  constructor({ mode, credentials } = {}) {
    if (!['adc', 'serviceAccount'].includes(mode) || (mode === 'adc' && credentials !== undefined)) throw failure('InvalidCredentials', messages.InvalidCredentials);
    const validated = mode === 'serviceAccount' ? validateServiceAccount(credentials) : undefined;
    this.auth = new GoogleAuth({ scopes: SCOPES, ...(validated ? { credentials: validated } : {}) });
    this.storage = new Storage({ authClient: this.auth, timeout: 60000,
      retryOptions: { autoRetry: true, maxRetries: 2, retryDelayMultiplier: 2, maxRetryDelay: 4, totalTimeout: 120 },
      ...(validated ? { projectId: validated.project_id } : {}) });
    this.controller = new AbortController();
  }
  signal(signal) { return signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal; }
  async request(url, { signal, ...options } = {}) {
    const combined = this.signal(signal);
    combined.throwIfAborted();
    const method = (options.method || 'GET').toUpperCase();
    const conditional = options.params?.ifGenerationMatch !== undefined || !!options.params?.requestId;
    const retryable = ['GET', 'HEAD', 'OPTIONS'].includes(method) || (conditional && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method));
    const result = await this.auth.request({ url, ...options, timeout: 60000, retry: retryable,
      retryConfig: { retry: retryable ? 2 : 0, noResponseRetries: retryable ? 2 : 0,
        httpMethodsToRetry: retryable ? [method] : [], statusCodesToRetry: [[408, 408], [429, 429], [500, 599]],
        retryDelay: 250, retryDelayMultiplier: 2, maxRetryDelay: 4000, totalTimeout: 120000 }, signal: combined });
    combined.throwIfAborted();
    return result.data;
  }
  async authenticate() {
    this.controller.signal.throwIfAborted();
    const token = await this.auth.getAccessToken();
    this.controller.signal.throwIfAborted();
    if (typeof token !== 'string' || !token) throw failure('AuthenticationFailed', messages.AuthenticationFailed);
    return true;
  }
  async projects() {
    const all = []; let pageToken;
    do {
      const page = await this.request('https://cloudresourcemanager.googleapis.com/v1/projects', { params: { pageSize: 1000, pageToken, filter: 'lifecycleState:ACTIVE' } });
      all.push(...(page.projects || []).map(p => ({ id: p.projectId, name: p.name || p.projectId })));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return all;
  }
  async buckets(project) {
    const all = []; let pageToken;
    do {
      const page = await this.request(`${STORAGE}/b`, { params: { project, maxResults: 1000, pageToken } });
      all.push(...(page.items || []).map(b => ({ name: b.name, region: b.location || '' })));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return all;
  }
  async list(bucket, prefix = '', token, signal, recursive = false) {
    const page = await this.request(`${STORAGE}/b/${enc(bucket)}/o`, { signal, params: { prefix, pageToken: token, maxResults: 1000, ...(recursive ? {} : { delimiter: '/' }) } });
    return { folders: (page.prefixes || []).map(key => ({ key, folder: true })), files: (page.items || []).map(objectInfo), token: page.nextPageToken || null };
  }
  async snapshot(bucket, selected, signal) {
    const objects = new Map();
    for (const item of selected) {
      this.signal(signal).throwIfAborted();
      if (!item.folder) {
        const metadata = item.generation ? item : await this.head(bucket, item.key, signal);
        if (!metadata) throw failure(404, messages[404]);
        objects.set(item.key, { ...item, ...(metadata.name ? objectInfo(metadata) : metadata), generation: generationValue(metadata.generation) });
        continue;
      }
      if (!item.key || !item.key.endsWith('/')) throw failure('InvalidInput', 'Folder prefixes must end with /.');
      let token;
      do {
        const page = await this.list(bucket, item.key, token, signal, true);
        page.files.forEach(object => { if (!objects.has(object.key)) objects.set(object.key, object); });
        token = page.token;
      } while (token);
    }
    return [...objects.values()];
  }
  async head(bucket, key, signal) {
    try { return await this.request(`${STORAGE}/b/${enc(bucket)}/o/${enc(key)}`, { signal }); }
    catch (error) { if (status(error) === 404) return null; throw error; }
  }
  async targetGeneration(bucket, key, overwrite, signal) {
    if (typeof overwrite !== 'boolean') throw failure('InvalidInput', 'Overwrite must be boolean.');
    if (!overwrite) return 0;
    const metadata = await this.head(bucket, key, signal);
    return metadata ? generationValue(metadata.generation) : 0;
  }
  async copy(bucket, key, targetBucket, target, { permission, overwrite = false, generation, signal } = {}) {
    validatePermission(permission);
    const source = generationValue(generation ?? (await this.head(bucket, key, signal))?.generation);
    const targetGeneration = await this.targetGeneration(targetBucket, target, overwrite, signal);
    const params = { sourceGeneration: source, ifSourceGenerationMatch: source, ifGenerationMatch: targetGeneration,
      ...(permission === 'public' ? { destinationPredefinedAcl: 'publicRead' } : {}) };
    let rewriteToken;
    // https://cloud.google.com/storage/docs/json_api/v1/objects/rewrite
    do {
      let page;
      try {
        page = await this.request(`${STORAGE}/b/${enc(bucket)}/o/${enc(key)}/rewriteTo/b/${enc(targetBucket)}/o/${enc(target)}`,
          { method: 'POST', params: { ...params, ...(rewriteToken ? { rewriteToken } : {}) }, signal });
      } catch (error) {
        if (!overwrite && status(error) === 412) {
          // A generic 412 can also mean a stale source. Only a confirmed target collision is a skip.
          let currentSource, currentTarget;
          try {
            currentSource = await this.head(bucket, key, signal);
            if (currentSource && generationValue(currentSource.generation) === source) currentTarget = await this.head(targetBucket, target, signal);
          } catch { this.signal(signal).throwIfAborted(); throw error; }
          if (currentTarget) return { skipped: true };
        }
        throw error;
      }
      if (page.done) return page.resource;
      if (!page.rewriteToken) throw failure('InvalidInput', 'Rewrite response is missing its continuation token.');
      rewriteToken = page.rewriteToken;
    } while (rewriteToken);
  }
  async remove(bucket, key, { generation, signal } = {}) {
    const value = generationValue(generation ?? (await this.head(bucket, key, signal))?.generation);
    return this.request(`${STORAGE}/b/${enc(bucket)}/o/${enc(key)}`, { method: 'DELETE', params: { generation: value, ifGenerationMatch: value }, signal });
  }
  async createFolder(bucket, key) {
    if (typeof key !== 'string' || !key || !key.endsWith('/') || key.startsWith('/') || key.includes('//') || Buffer.byteLength(key) > 1024) throw failure('InvalidInput', 'Invalid folder key.');
    return this.upload(bucket, key, Readable.from([]), 0, 'application/x-directory', undefined, undefined, { permission: 'inherit', overwrite: false });
  }
  async upload(bucket, key, stream, size, contentType, onProgress, signal, { permission, overwrite = false } = {}) {
    const combined = this.signal(signal);
    const input = new PassThrough({ highWaterMark: 64 * 1024 });
    let output, inputError, started = false;
    const onInputError = error => { inputError = error; if (started) input.destroy(error); };
    const onInputAborted = () => onInputError(Object.assign(new Error('Upload request aborted.'), { name: 'AbortError' }));
    stream.on('error', onInputError);
    stream.on('aborted', onInputAborted);
    try {
      validatePermission(permission);
      if (!Number.isSafeInteger(size) || size < 0) throw failure('InvalidInput', 'Invalid upload size.');
      combined.throwIfAborted();
      const ifGenerationMatch = await this.targetGeneration(bucket, key, overwrite, combined);
      combined.throwIfAborted();
      if (inputError) throw inputError;
      if (stream.destroyed || stream.aborted) throw Object.assign(new Error('Upload request aborted.'), { name: 'AbortError' });
      const file = this.storage.bucket(bucket).file(key);
      // Resumable requests inherit interceptors, but not createWriteStream's timeout option.
      file.interceptors?.push({ request: options => ({ ...options, timeout: 60000, signal: combined }) });
      output = file.createWriteStream({ resumable: true, chunkSize: 8 * 1024 * 1024, timeout: 60000, validation: 'crc32c',
        metadata: { contentType: contentType || 'application/octet-stream' },
        preconditionOpts: { ifGenerationMatch }, ...(permission === 'public' ? { predefinedAcl: 'publicRead' } : {}) });
      let loaded = 0;
      const counter = new Transform({
        transform(chunk, encoding, callback) {
          loaded += chunk.length;
          if (loaded > size) return callback(failure('InvalidInput', 'Upload size does not match the declared size.'));
          try { onProgress?.(loaded); callback(null, chunk); } catch (error) { callback(error); }
        },
        flush(callback) { callback(loaded === size ? null : failure('InvalidInput', 'Upload size does not match the declared size.')); },
      });
      // Keep IncomingMessage outside pipeline: SDK errors must not destroy the HTTP response socket.
      const transfer = pipeline(input, counter, output, { signal: combined });
      started = true;
      stream.pipe(input);
      await transfer;
      return file.metadata;
    } catch (error) {
      stream.unpipe(input);
      input.destroy();
      output?.destroy();
      stream.resume();
      if (!overwrite && status(error) === 412) return { skipped: true };
      throw error;
    } finally {
      stream.unpipe(input);
      const cleanup = () => {
        stream.removeListener('error', onInputError);
        stream.removeListener('aborted', onInputAborted);
        stream.removeListener('end', cleanup);
        stream.removeListener('close', cleanup);
      };
      if (stream.readableEnded || stream.destroyed) cleanup();
      else { stream.once('end', cleanup); stream.once('close', cleanup); }
    }
  }
  async maps(project) {
    const all = []; let pageToken;
    do {
      const page = await this.request(`${COMPUTE}/projects/${enc(project)}/global/urlMaps`, { params: { maxResults: 500, pageToken } });
      all.push(...(page.items || []).map(map => ({ ...map, name: map.name, id: map.id, description: map.description || '',
        hosts: [...new Set((map.hostRules || []).flatMap(rule => rule.hosts || []))] })));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return all;
  }
  async invalidate(project, map, { host, path, requestId, signal } = {}) {
    const paths = invalidationPaths(path);
    if (paths.length !== 1 || (requestId !== undefined && (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId) || requestId === '00000000-0000-0000-0000-000000000000'))) {
      throw failure('InvalidInput', 'Invalid cache invalidation request.');
    }
    return this.request(`${COMPUTE}/projects/${enc(project)}/global/urlMaps/${enc(map)}/invalidateCache`, { method: 'POST',
      signal, params: requestId === undefined ? {} : { requestId }, data: { path: paths[0], ...(host ? { host: normalizeDomain(host) } : {}) } });
  }
  operation(project, id, signal) {
    return this.request(`${COMPUTE}/projects/${enc(project)}/global/operations/${enc(id)}`, { signal: signal?.signal ?? signal });
  }
  async close() {
    this.controller.abort();
    this.auth = null;
    this.storage = null;
  }
}
