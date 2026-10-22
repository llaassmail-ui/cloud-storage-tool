import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { createServer } from '../server.js';
import { createGCPRoutes } from '../gcp-routes.js';

function provider(overrides = {}) {
  return { authenticate: async () => {}, projects: async () => [{ id: 'test-project' }],
    buckets: async () => [{ name: 'test-bucket' }], maps: async () => [], close: async () => {},
    snapshot: async () => [{ key: 'file', generation: '1' }], copy: async () => {}, remove: async () => {},
    invalidate: async () => ({ name: 'operation-1' }), operation: async () => ({ status: 'DONE' }),
    ...overrides };
}

async function setup(t, factory = () => provider(), options = { pollInterval: 0, maxPolls: 1 }, awsFactory) {
  const server = createServer(awsFactory, factory, options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const request = async (path, data, extra = {}) => {
    const { headers, ...init } = extra;
    return fetch(origin + path, { method: data === undefined ? 'GET' : 'POST',
      ...(data === undefined ? {} : { body: JSON.stringify(data) }), ...init,
      headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', ...headers } });
  };
  const connect = async (data = { mode: 'adc' }) => {
    const response = await request('/api/gcp/connect', data);
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return response;
  };
  const job = async id => (await request(`/api/gcp/jobs/${id}`)).json();
  const until = async (id, state) => {
    for (let n = 0; n < 100; n++) {
      const value = await job(id);
      if (value.state === state) return value;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail(`Job did not reach ${state}: ${JSON.stringify(await job(id))}`);
  };
  return { server, origin, request, connect, job, until, get cookie() { return cookie; } };
}

test('GCP authenticates separately, tolerates denied project discovery, and protects mutations', async t => {
  let configuration; let authenticated = 0;
  const app = await setup(t, config => { configuration = config; return provider({
    authenticate: async () => { authenticated++; },
    projects: async () => { throw Object.assign(new Error('Projects denied'), { code: 403 }); }
  }); });
  assert.equal((await app.request('/api/gcp/buckets?project=test-project')).status, 401);
  assert.equal((await app.request('/api/gcp/connect', { mode: 'adc' }, { headers: { Origin: 'https://evil.test' } })).status, 403);
  assert.equal((await app.request('/api/gcp/connect', { mode: 'adc' }, { headers: { Origin: '' } })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => {
    const request = http.get(app.origin + '/api/gcp/session', { headers: { Host: 'evil.test' } }, response => {
      response.resume(); resolve(response.statusCode);
    });
    request.on('error', reject);
  });
  assert.equal(hostStatus, 403);
  assert.equal((await app.connect({ mode: 'invalid' })).status, 400);
  const credentials = { type: 'service_account', private_key: 'private-test', client_email: 'test@example.test' };
  const response = await app.connect({ mode: 'serviceAccount', credentials });
  assert.equal(response.status, 200); assert.equal(authenticated, 1);
  assert.deepEqual(configuration, { mode: 'serviceAccount', credentials });
  assert.match(response.headers.get('set-cookie'), new RegExp(`^gcp_session_${app.server.address().port}=`));
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const session = await (await app.request('/api/gcp/session')).json();
  assert.equal(session.connected, true); assert.deepEqual(session.projects, []); assert.ok(session.projectError);
  assert.doesNotMatch(JSON.stringify(session), /private-test|private_key/);
  assert.equal((await app.request('/api/session')).status, 401);
  const renamed = app.cookie.replace('gcp_session_', 'aws_session_');
  assert.equal((await app.request('/api/gcp/buckets?project=test-project', undefined, { headers: { Cookie: renamed } })).status, 401);
});

test('GCP failed authentication disposes the candidate without replacing the active session', async t => {
  let count = 0; let closed = 0;
  const app = await setup(t, () => ++count === 1 ? provider() : provider({
    authenticate: async () => { throw new Error('Invalid credentials'); }, close: async () => { closed++; }
  }));
  await app.connect(); const cookie = app.cookie;
  assert.equal((await app.connect()).status, 400); assert.equal(closed, 1); assert.equal(app.cookie, cookie);
  assert.equal((await (await app.request('/api/gcp/session')).json()).connected, true);
});

test('active AWS and GCP cookies remain independent when either provider disconnects', async t => {
  let awsClosed = 0; let gcpClosed = 0;
  const app = await setup(t, () => provider({ close: async () => { gcpClosed++; } }), undefined, () => ({
    buckets: async () => [{ name: 'aws-bucket' }], distributionList: async () => [], close: async () => { awsClosed++; }
  }));
  const awsResponse = await app.request('/api/connect', { accessKeyId: 'fake', secretAccessKey: 'fake' });
  assert.equal(awsResponse.status, 200); const awsCookie = awsResponse.headers.get('set-cookie').split(';')[0];
  await app.connect();
  const combined = { headers: { Cookie: `${awsCookie}; ${app.cookie}` } };
  assert.equal((await app.request('/api/session', undefined, combined)).status, 200);
  assert.equal((await app.request('/api/gcp/jobs', undefined, combined)).status, 200);
  await app.request('/api/gcp/disconnect', {}, combined);
  assert.equal(awsClosed, 0); assert.equal(gcpClosed, 1);
  assert.equal((await app.request('/api/session', undefined, combined)).status, 200);
  await app.connect();
  const both = { headers: { Cookie: `${awsCookie}; ${app.cookie}` } };
  await app.request('/api/disconnect', {}, both);
  assert.equal(awsClosed, 1); assert.equal(gcpClosed, 1);
  assert.equal((await app.request('/api/gcp/jobs', undefined, both)).status, 200);
});

test('project checks are independent and safe project/map identifiers are required', async t => {
  let storageCalls = 0; let cdnCalls = 0;
  const app = await setup(t, () => provider({
    buckets: async project => { storageCalls++; assert.equal(project, 'test-project'); throw Object.assign(new Error('Denied'), { code: 403 }); },
    maps: async project => { cdnCalls++; assert.equal(project, 'test-project'); return []; }
  }));
  await app.connect();
  const response = await app.request('/api/gcp/project', { project: 'test-project' });
  assert.equal(response.status, 200); const data = await response.json();
  assert.equal(data.project, 'test-project'); assert.equal(data.checks.storage.state, 'denied');
  assert.ok(data.checks.storage.error); assert.equal(data.checks.cdn.state, 'available'); assert.deepEqual(data.buckets, []);
  assert.equal((await (await app.request('/api/gcp/session')).json()).project, 'test-project');
  for (const value of ['../other', 'a/b', 'a%2fb', 'a?b', 'a\b', '', {}, null]) {
    assert.equal((await app.request('/api/gcp/project', { project: value })).status, 400);
    assert.equal((await app.request('/api/gcp/invalidations', { project: 'test-project', map: value, paths: '/*', reference: randomUUID() })).status, 400);
  }
  assert.equal(storageCalls, 1); assert.equal(cdnCalls, 1);
});

test('storage listing and folder routes preserve inputs and validate before calling the provider', async t => {
  const calls = [];
  const app = await setup(t, () => provider({
    list: async (...args) => { calls.push(args); return { items: [{ key: 'a/file' }], token: 'next' }; },
    createFolder: async (...args) => { calls.push(args); }
  }));
  await app.connect();
  assert.deepEqual(await (await app.request('/api/gcp/buckets?project=test-project')).json(), { items: [{ name: 'test-bucket' }] });
  assert.deepEqual(await (await app.request('/api/gcp/projects')).json(), { items: [{ id: 'test-project' }] });
  assert.deepEqual(await (await app.request('/api/gcp/objects?bucket=test-bucket&prefix=a%2F&token=page')).json(), { items: [{ key: 'a/file' }], token: 'next' });
  assert.equal((await app.request('/api/gcp/folders', { bucket: 'test-bucket', key: 'a/folder/' })).status, 201);
  assert.deepEqual(calls, [['test-bucket', 'a/', 'page'], ['test-bucket', 'a/folder/']]);
  for (const key of ['', '/root/', 'a//b/', '../bad/', 'a/../bad/', 'no-trailing-slash']) {
    assert.equal((await app.request('/api/gcp/folders', { bucket: 'test-bucket', key })).status, 400);
  }
  assert.equal((await app.request('/api/gcp/objects?bucket=..%2Fbad')).status, 400);
  assert.equal(calls.length, 2);
});

test('project storage results survive a synchronous CDN check failure', async t => {
  const app = await setup(t, () => provider({ maps: () => { throw new Error('CDN unavailable'); } }));
  await app.connect();
  const result = await (await app.request('/api/gcp/project', { project: 'test-project' })).json();
  assert.deepEqual(result.buckets, [{ name: 'test-bucket' }]);
  assert.equal(result.checks.storage.state, 'available'); assert.equal(result.checks.cdn.state, 'failed');
});

test('maps normalize URLs and prioritize exact hosts before wildcard matches', async t => {
  const maps = [{ name: 'all', hosts: ['*'] }, { name: 'wild', hosts: ['*.example.com'] },
    { name: 'other', hosts: ['other.test'] }, { name: 'exact', hosts: ['cdn.example.com'] }];
  const app = await setup(t, () => provider({ maps: async () => maps })); await app.connect();
  const data = await (await app.request('/api/gcp/maps?project=test-project&domain=' + encodeURIComponent('https://CDN.Example.com/path/file?x=1#fragment'))).json();
  assert.equal(data.host, 'cdn.example.com'); assert.equal(data.path, '/path/file');
  assert.deepEqual(data.items.map(x => x.name), ['exact', 'wild', 'all']);
  const apex = await (await app.request('/api/gcp/maps?project=test-project&domain=example.com')).json();
  assert.deepEqual(apex.items.map(x => x.name), ['all']);
  assert.equal((await app.request('/api/gcp/maps?project=test-project&domain=' + encodeURIComponent('https://user:secret@example.com'))).status, 400);
});

test('batch routes require permission, reuse target validation, and expose only session-owned public jobs', async t => {
  const app = await setup(t); await app.connect();
  const batch = { action: 'copy', bucket: 'source', prefix: 'folder/', selected: [{ key: 'file', folder: false }], targetBucket: 'target', targetPrefix: '' };
  for (const permission of [undefined, 'private', 'public-read']) {
    assert.equal((await app.request('/api/gcp/jobs', { ...batch, permission })).status, 400);
  }
  assert.equal((await app.request('/api/gcp/jobs', { ...batch, permission: 'inherit', targetBucket: 'source' })).status, 400);
  const accepted = await app.request('/api/gcp/jobs', { ...batch, permission: 'inherit' });
  assert.equal(accepted.status, 202); const { id } = await accepted.json();
  const finished = await app.until(id, 'completed'); assert.equal(finished.controller, undefined);
  assert.equal(finished.bucket, 'source'); assert.equal(finished.prefix, 'folder/');
  assert.equal(finished.targetBucket, 'target'); assert.equal(finished.targetPrefix, '');
  const list = await (await app.request('/api/gcp/jobs')).json(); assert.equal(list.items[0].id, id);
  assert.equal(list.items[0].controller, undefined);
  assert.equal((await app.request(`/api/gcp/jobs/${id}/resume`, {})).status, 400);
  assert.equal((await app.request(`/api/gcp/jobs/${id}`, {}, { method: 'DELETE' })).status, 404);
  await app.connect(); assert.equal((await app.request(`/api/gcp/jobs/${id}`)).status, 404);
});

test('upload routes stream exact bytes, preserve permission, drain skipped/failed input, and reject replay', async t => {
  const uploads = [];
  const app = await setup(t, () => provider({ upload: async (bucket, key, stream, size, type, progress, signal, options) => {
    uploads.push({ bucket, key, size, type, options }); assert.equal(signal.aborted, false);
    if (key === 'skip') return { skipped: true };
    if (key === 'fail') throw Object.assign(new Error('Write denied'), { code: 403 });
    let bytes = 0; for await (const chunk of stream) { bytes += chunk.length; progress(bytes); }
    assert.equal(bytes, size);
  } }));
  await app.connect();
  const metadata = { bucket: 'test-bucket', key: 'ok', size: 3, contentType: 'text/plain', overwrite: true, permission: 'public' };
  assert.equal((await app.request('/api/gcp/uploads', { ...metadata, permission: undefined })).status, 400);
  for (const [key, state] of [['ok', 'completed'], ['skip', 'skipped'], ['fail', 'failed']]) {
    const pending = await app.request('/api/gcp/uploads', { ...metadata, key }); assert.equal(pending.status, 201);
    const { id } = await pending.json();
    const response = await app.request(`/api/gcp/uploads/${id}`, undefined, { method: 'PUT', body: 'abc' });
    assert.equal(response.status, 200); const result = await response.json(); assert.equal(result.state, state);
    if (key === 'ok') assert.equal(result.loaded, 3);
    assert.equal((await app.request(`/api/gcp/uploads/${id}`, undefined, { method: 'PUT', body: 'abc' })).status, 400);
  }
  assert.deepEqual(uploads[0], { bucket: 'test-bucket', key: 'ok', size: 3, type: 'text/plain', options: { permission: 'public', overwrite: true } });
  const { id } = await (await app.request('/api/gcp/uploads', metadata)).json();
  assert.equal((await app.request(`/api/gcp/uploads/${id}`, undefined, { method: 'PUT', body: 'wrong-size' })).status, 400);
  assert.equal(uploads.length, 3);
  const emptyType = await (await app.request('/api/gcp/uploads', { ...metadata, key: 'folder/ok', contentType: '' })).json();
  assert.equal((await app.job(emptyType.id)).prefix, 'folder/');
  assert.equal((await app.request(`/api/gcp/uploads/${emptyType.id}`, undefined, { method: 'PUT', body: 'abc' })).status, 200);
  assert.equal(uploads[3].type, 'application/octet-stream');
});

test('invalidation references deduplicate requests, reject mismatches, and resume existing operations', async t => {
  let submissions = 0; let done = false;
  const app = await setup(t, () => provider({
    invalidate: async () => { submissions++; return { name: `operation-${submissions}` }; },
    operation: async () => ({ status: done ? 'DONE' : 'RUNNING' })
  })); await app.connect();
  const body = { project: 'test-project', map: 'global-map', host: 'cdn.example.com', paths: '/a\n/*', reference: randomUUID() };
  const response = await app.request('/api/gcp/invalidations', body); assert.equal(response.status, 202);
  const { id } = await response.json();
  assert.equal((await (await app.request('/api/gcp/invalidations', body)).json()).id, id);
  assert.equal((await (await app.request('/api/gcp/invalidations', { ...body, paths: '  /a  \r\n\n/*\n/a\n' })).json()).id, id);
  assert.equal((await app.request('/api/gcp/invalidations', { ...body, paths: '/different' })).status, 400);
  const waiting = await app.until(id, 'waiting');
  assert.equal(waiting.project, body.project); assert.equal(waiting.map, body.map); assert.equal(waiting.host, body.host);
  done = true; assert.equal((await app.request(`/api/gcp/jobs/${id}/resume`, {})).status, 202);
  await app.until(id, 'completed'); assert.equal(submissions, 2);
  assert.equal((await app.request(`/api/gcp/jobs/${id}/resume`, {})).status, 400);
  for (const paths of ['', 'relative', '/a?x', '/a#b', '/a b', '/a*/b', '/**', '/a\u0000', Array.from({ length: 101 }, (_, n) => `/a${n}`).join('\n')]) {
    assert.equal((await app.request('/api/gcp/invalidations', { ...body, reference: randomUUID(), paths })).status, 400);
  }
  assert.equal((await app.request('/api/gcp/invalidations', { ...body, reference: 'not-uuid' })).status, 400);
});

test('replacing or disconnecting GCP aborts jobs and disposes its provider', async t => {
  const signals = []; let closed = 0;
  const app = await setup(t, () => provider({
    snapshot: async (_bucket, _selected, signal) => {
      signals.push(signal); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); return [];
    }, close: async () => { closed++; }
  })); await app.connect();
  const start = async () => {
    const response = await app.request('/api/gcp/jobs', { action: 'delete', bucket: 'source', selected: [{ key: 'file', folder: false }] });
    assert.equal(response.status, 202); return (await response.json()).id;
  };
  await start(); await app.connect(); assert.equal(signals[0].aborted, true); assert.equal(closed, 1);
  const id = await start();
  assert.equal((await app.request(`/api/gcp/jobs/${id}/cancel`, {})).status, 200);
  await app.until(id, 'cancelled');
  await start(); const response = await app.request('/api/gcp/disconnect', {});
  assert.equal(response.status, 200); assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(signals[2].aborted, true); assert.equal(closed, 2);
  assert.equal((await app.request('/api/gcp/jobs')).status, 401);
});

test('cancelled and partial invalidations resume without duplicating submitted operations', async t => {
  let submissions = 0; let pollingSignal; let cancelDuringPoll = true;
  const app = await setup(t, () => provider({
    invalidate: async () => { submissions++; return { name: 'existing-operation' }; },
    operation: async (_project, _id, signal) => {
      pollingSignal = signal;
      if (cancelDuringPoll) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      return { status: 'DONE', error: { errors: [{ code: 'DENIED', message: 'Operation failed' }] } };
    }
  }));
  await app.connect();
  const { id } = await (await app.request('/api/gcp/invalidations', { project: 'test-project', map: 'global-map', paths: '/*', reference: randomUUID() })).json();
  for (let n = 0; !pollingSignal && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(pollingSignal);
  await app.request(`/api/gcp/jobs/${id}/cancel`, {});
  await app.until(id, 'cancelled'); assert.equal(pollingSignal.aborted, true);
  cancelDuringPoll = false;
  assert.equal((await app.request(`/api/gcp/jobs/${id}/resume`, {})).status, 202);
  await app.until(id, 'partial');
  assert.equal((await app.request(`/api/gcp/jobs/${id}/resume`, {})).status, 202);
  await app.until(id, 'partial'); assert.equal(submissions, 1);
});

test('closing the route module aborts its jobs and disposes each session once', async () => {
  let closed = 0; let signal; let cookie = '';
  const routes = createGCPRoutes(() => provider({
    close: async () => { closed++; },
    snapshot: async (_bucket, _selected, currentSignal) => {
      signal = currentSignal;
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      return [];
    }
  }));
  const call = async (path, value) => {
    let result;
    await routes.route({ method: 'POST', headers: { cookie } }, {
      setHeader: (_name, value) => { cookie = value.split(';')[0]; }
    }, new URL(path, 'http://127.0.0.1:8787'), { port: 8787, body: async () => value,
      json: (_response, status, body) => { result = { status, body }; } });
    return result;
  };
  try {
    assert.equal((await call('/api/gcp/connect', { mode: 'adc' })).status, 200);
    assert.equal((await call('/api/gcp/jobs', { action: 'delete', bucket: 'source', selected: [{ key: 'file', folder: false }] })).status, 202);
    assert.ok(signal); await routes.close(); await routes.close();
    assert.equal(signal.aborted, true); assert.equal(closed, 1);
    assert.equal((await call('/api/gcp/connect', { mode: 'adc' })).status, 503);
  } finally { await routes.close(); }
});
