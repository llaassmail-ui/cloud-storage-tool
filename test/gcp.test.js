import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import { setImmediate as tick } from 'node:timers/promises';
import { GCP, errorInfo, validateServiceAccount } from '../gcp.js';

const failure = (code, message = 'Simulated provider failure') => Object.assign(new Error(message), { code });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function provider(t, request = async () => { throw new Error('Unexpected HTTP request'); }) {
  const gcp = new GCP({ mode: 'adc' });
  gcp.auth = { request: async options => ({ data: await request(options) }) };
  gcp.storage = { bucket() { throw new Error('Unexpected storage request'); } };
  t.after(() => gcp.close());
  return gcp;
}
function uploadStorage(gcp, create) {
  const calls = [];
  gcp.storage = { bucket(bucket) { return { file(key) {
    const file = { metadata: { generation: '123' }, createWriteStream(options) {
      calls.push({ bucket, key, options }); return create(options);
    } };
    return file;
  } }; } };
  return calls;
}
const input = () => new PassThrough({ autoDestroy: false });
const upload = (gcp, stream, size, options = {}, signal, progress) =>
  gcp.upload('target', 'dir/file.txt', stream, size, 'text/plain', progress, signal, { permission: 'inherit', overwrite: false, ...options });

test('projects, buckets and global maps follow pagination with scoped parameters', async t => {
  const seen = [];
  const gcp = provider(t, async ({ url, params }) => {
    seen.push({ url, params });
    const second = params.pageToken === 'next';
    if (url.includes('cloudresourcemanager')) {
      assert.equal(params.filter, 'lifecycleState:ACTIVE');
      return { projects: [{ projectId: second ? 'project-b' : 'project-a', name: 'Display' }], nextPageToken: second ? undefined : 'next' };
    }
    if (url.endsWith('/b')) {
      assert.equal(params.project, 'project-a');
      return { items: [{ name: second ? 'bucket-b' : 'bucket-a', location: 'US' }], nextPageToken: second ? undefined : 'next' };
    }
    assert.ok(url.endsWith('/projects/project-a/global/urlMaps'));
    return { items: [{ name: second ? 'map-b' : 'map-a', hostRules: [{ hosts: ['cdn.example.com', '*.example.com'] }, { hosts: ['cdn.example.com'] }] }], nextPageToken: second ? undefined : 'next' };
  });
  assert.deepEqual((await gcp.projects()).map(p => p.id), ['project-a', 'project-b']);
  assert.deepEqual(await gcp.buckets('project-a'), [{ name: 'bucket-a', region: 'US' }, { name: 'bucket-b', region: 'US' }]);
  const maps = await gcp.maps('project-a');
  assert.deepEqual(maps.map(m => m.name), ['map-a', 'map-b']);
  assert.deepEqual(maps[0].hosts, ['cdn.example.com', '*.example.com']);
  assert.equal(seen.length, 6);
  assert.deepEqual(seen.map(r => r.params.pageToken), [undefined, 'next', undefined, 'next', undefined, 'next']);
});

test('recursive snapshot traverses 1003 objects, deduplicates overlap and preserves exact generations', async t => {
  const controller = new AbortController(); let pages = 0;
  const gcp = provider(t, async ({ params, signal }) => {
    assert.equal(signal.aborted, false); assert.equal(params.delimiter, undefined); assert.equal(params.prefix, 'dir/');
    pages++; const second = params.pageToken === 'page-2';
    return { items: Array.from({ length: second ? 3 : 1000 }, (_, i) => ({ name: `dir/${i + (second ? 1000 : 0)}`, generation: '9007199254740993', size: '12' })), nextPageToken: second ? undefined : 'page-2' };
  });
  const objects = await gcp.snapshot('bucket', [{ key: 'dir/', folder: true }, { key: 'dir/0', folder: false, generation: '9007199254740993' }], controller.signal);
  assert.equal(pages, 2); assert.equal(objects.length, 1003);
  assert.equal(objects.at(-1).key, 'dir/1002');
  assert.ok(objects.every(o => o.generation === '9007199254740993'));
});

test('rewrite continuation preserves metadata by omission and holds source/target conditions across pages', async t => {
  for (const permission of ['inherit', 'public']) {
    const rewrites = [];
    const resource = { generation: '999', contentType: 'text/css', cacheControl: 'public,max-age=60', metadata: { release: 'one' } };
    const gcp = provider(t, async request => {
      if (request.url.endsWith('/b/target')) return { iamConfiguration: {} };
      assert.ok(request.url.endsWith('/o/dir%2Fa%20%23.css/rewriteTo/b/target/o/out%2Fa.css'));
      rewrites.push(request);
      return rewrites.length === 1 ? { done: false, rewriteToken: 'continuation-token' } : { done: true, resource };
    });
    assert.deepEqual(await gcp.copy('source', 'dir/a #.css', 'target', 'out/a.css', { permission, overwrite: false, generation: '9007199254740993' }), resource);
    assert.equal(rewrites.length, 2);
    for (const [index, request] of rewrites.entries()) {
      assert.equal(request.method, 'POST'); assert.equal(request.data, undefined);
      assert.equal(request.params.sourceGeneration, '9007199254740993');
      assert.equal(request.params.ifSourceGenerationMatch, '9007199254740993');
      assert.equal(request.params.ifGenerationMatch, 0);
      assert.equal(request.params.destinationPredefinedAcl, permission === 'public' ? 'publicRead' : undefined);
      assert.equal(request.params.rewriteToken, index ? 'continuation-token' : undefined);
    }
  }
});

test('copy overwrite pins observed target generation and propagates a target race', async t => {
  const gcp = provider(t, async request => {
    if (request.method !== 'POST') return { generation: '700' };
    assert.equal(request.params.ifGenerationMatch, '700'); throw failure(412);
  });
  await assert.rejects(gcp.copy('source', 'a', 'target', 'a', { permission: 'inherit', overwrite: true, generation: '10' }), e => Number(e.code) === 412);
});

test('copy source generation 412 remains a failure when destination is absent', async t => {
  const gcp = provider(t, async request => {
    if (request.method === 'POST') throw failure(412, 'Source generation no longer matches');
    if (request.url.includes('/b/target/')) throw failure(404);
    return { generation: '11' };
  });
  await assert.rejects(gcp.copy('source', 'a', 'target', 'a', { permission: 'inherit', overwrite: false, generation: '10' }), e => Number(e.code) === 412);
});

test('copy non-overwrite conflict skips only an existing destination', async t => {
  const gcp = provider(t, async request => {
    if (request.method === 'POST') throw failure(412);
    return { generation: request.url.includes('/b/target/') ? '20' : '10' };
  });
  assert.deepEqual(await gcp.copy('source', 'a', 'target', 'a', { permission: 'inherit', overwrite: false, generation: '10' }), { skipped: true });
});

test('remove targets only the exact generation and rejects unsafe generation numbers', async t => {
  const calls = []; const controller = new AbortController();
  const gcp = provider(t, async request => { calls.push(request); return {}; });
  await gcp.remove('bucket', 'dir/a #', { generation: '9007199254740993', signal: controller.signal });
  assert.equal(calls.length, 1); assert.equal(calls[0].method, 'DELETE');
  assert.match(calls[0].url, /dir%2Fa%20%23$/);
  assert.deepEqual(calls[0].params, { generation: '9007199254740993', ifGenerationMatch: '9007199254740993' });
  for (const generation of [0, -1, Number.MAX_SAFE_INTEGER + 1, 'abc']) await assert.rejects(gcp.remove('bucket', 'a', { generation }));
  assert.equal(calls.length, 1);
});

test('service account validation accepts ephemeral RSA keys and rejects unsafe credential types and endpoints', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const account = { type: 'service_account', project_id: 'test-project', client_email: 'test@test-project.iam.gserviceaccount.com', private_key: privateKey };
  assert.deepEqual(validateServiceAccount(JSON.stringify({ ...account, token_uri: 'https://oauth2.googleapis.com/token' })), account);
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  for (const value of [null, 'invalid-json', { ...account, type: 'external_account' }, { ...account, token_uri: 'https://evil.example/token' },
    { ...account, credential_source: { file: '/secrets' } }, { ...account, private_key: 'invalid' }, { ...account, private_key: ec.privateKey }, { ...account, client_email: 'test@example.com' }]) {
    assert.throws(() => validateServiceAccount(value), error => error.code === 'InvalidCredentials');
  }
});

test('upload waits for SDK completion after input ends and configures inherited metadata/preconditions', async t => {
  const gcp = provider(t); const finishing = deferred(); let finish; let settled = false; const chunks = []; const progress = [];
  const calls = uploadStorage(gcp, () => new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
    final(callback) { finish = callback; finishing.resolve(); } }));
  const stream = input();
  const promise = upload(gcp, stream, 3, {}, undefined, loaded => progress.push(loaded)).finally(() => { settled = true; });
  stream.end(Buffer.from('abc')); await finishing.promise; await tick();
  assert.equal(settled, false); finish(); await promise;
  assert.equal(Buffer.concat(chunks).toString(), 'abc'); assert.equal(progress.at(-1), 3);
  assert.equal(calls[0].bucket, 'target'); assert.equal(calls[0].key, 'dir/file.txt');
  assert.equal(calls[0].options.resumable, true); assert.equal(calls[0].options.validation, 'crc32c');
  assert.deepEqual(calls[0].options.metadata, { contentType: 'text/plain' });
  assert.deepEqual(calls[0].options.preconditionOpts, { ifGenerationMatch: 0 });
  assert.equal(calls[0].options.predefinedAcl, undefined);
});

test('SDK upload failure leaves incoming request usable for the HTTP error response', async t => {
  const gcp = provider(t); const stream = input();
  uploadStorage(gcp, () => new Writable({ write(_chunk, _encoding, callback) { callback(failure(403)); } }));
  const promise = upload(gcp, stream, 3); const rejected = assert.rejects(promise, e => Number(e.code) === 403);
  stream.write('abc'); await rejected;
  assert.equal(stream.destroyed, false); stream.end();
});

test('upload rejects both oversized and undersized bodies', async t => {
  for (const [declared, content] of [[2, 'abc'], [4, 'abc']]) {
    const gcp = provider(t); const stream = input();
    uploadStorage(gcp, () => new Writable({ write(_chunk, _encoding, callback) { callback(); } }));
    const rejected = assert.rejects(upload(gcp, stream, declared), e => e.code === 'InvalidInput');
    stream.end(content); await rejected;
  }
});

test('public upload sets explicit ACL and never falls back after ACL rejection', async t => {
  const gcp = provider(t, async () => ({ iamConfiguration: {} })); const stream = input();
  const calls = uploadStorage(gcp, () => new Writable({ write(_chunk, _encoding, callback) { callback(failure(403, 'Public ACL denied')); } }));
  const rejected = assert.rejects(upload(gcp, stream, 3, { permission: 'public' }), e => Number(e.code) === 403);
  stream.end('abc'); await rejected;
  assert.equal(calls.length, 1); assert.equal(calls[0].options.predefinedAcl, 'publicRead');
});

test('public upload policy rejection never retries privately and preserves the request', async t => {
  const gcp = provider(t); const stream = input();
  const calls = uploadStorage(gcp, () => new Writable({ write(_chunk, _encoding, callback) { callback(); },
    final(callback) { callback(failure(400, 'Uniform bucket-level access disallows object ACLs')); } }));
  const rejected = assert.rejects(upload(gcp, stream, 0, { permission: 'public' }), e => Number(e.code) === 400);
  stream.end(); await rejected;
  assert.equal(calls.length, 1); assert.equal(calls[0].options.predefinedAcl, 'publicRead'); assert.equal(stream.destroyed, false);
});

test('overwrite upload 412 fails while non-overwrite existing-object 412 skips', async t => {
  for (const overwrite of [true, false]) {
    const gcp = provider(t, async () => ({ generation: '70' })); const stream = input();
    const calls = uploadStorage(gcp, () => new Writable({ write(_chunk, _encoding, callback) { callback(failure(412)); } }));
    const promise = upload(gcp, stream, 3, { overwrite });
    const result = overwrite ? assert.rejects(promise, e => Number(e.code) === 412) : promise.then(value => assert.deepEqual(value, { skipped: true }));
    stream.end('abc'); await result;
    assert.equal(calls[0].options.preconditionOpts.ifGenerationMatch, overwrite ? '70' : 0);
  }
});

test('invalidation reuses supplied UUID and normalizes host without changing path', async t => {
  const calls = []; const requestId = randomUUID();
  const gcp = provider(t, async request => { calls.push(request); return { name: 'operation-1', status: 'PENDING' }; });
  for (let i = 0; i < 2; i++) await gcp.invalidate('test-project', 'global-map', { host: 'https://CDN.example.com/', path: '/assets/*', requestId });
  assert.equal(calls.length, 2);
  for (const request of calls) {
    assert.ok(request.url.endsWith('/global/urlMaps/global-map/invalidateCache'));
    assert.equal(request.method, 'POST'); assert.deepEqual(request.params, { requestId });
    assert.deepEqual(request.data, { host: 'cdn.example.com', path: '/assets/*' });
  }
  await assert.rejects(gcp.invalidate('test-project', 'global-map', { path: '/*', requestId: 'invalid' }));
  assert.equal(calls.length, 2);
});

test('invalidation and operation requests honor caller cancellation signals', async t => {
  for (const method of ['invalidate', 'operation']) {
    const entered = deferred(); let observed; const controller = new AbortController();
    const gcp = provider(t, async ({ signal }) => { observed = signal; entered.resolve(); return { name: 'op', status: 'DONE' }; });
    const promise = method === 'invalidate' ? gcp.invalidate('test-project', 'map', { path: '/*', requestId: randomUUID(), signal: controller.signal })
      : gcp.operation('test-project', 'operation-1', controller.signal);
    await promise; await entered.promise; controller.abort();
    assert.equal(observed.aborted, true, `${method} must combine the caller signal`);
    await assert.rejects(method === 'invalidate' ? gcp.invalidate('test-project', 'map', { path: '/*', requestId: randomUUID(), signal: controller.signal })
      : gcp.operation('test-project', 'operation-1', controller.signal), e => e.name === 'AbortError');
  }
});

test('operation returns DONE errors intact for the job runner to classify', async t => {
  const operation = { name: 'operation-1', status: 'DONE', error: { errors: [{ code: 'PERMISSION_DENIED', message: 'Missing permission' }] } };
  const gcp = provider(t, async ({ url }) => { assert.ok(url.endsWith('/projects/test-project/global/operations/operation-1')); return operation; });
  assert.deepEqual(await gcp.operation('test-project', 'operation-1'), operation);
});

test('errorInfo strips credentials and request data while preserving actionable categories', () => {
  for (const [code, detail] of [[401, 'Authentication failed'], [403, 'Permission storage.objects.create denied'], [404, 'Resource not found'], [412, 'Generation precondition failed'], [429, 'Rate limit exceeded']]) {
    const error = Object.assign(failure(code, `${detail}; Bearer secret-token private_key=secret-key`), {
      config: { headers: { Authorization: 'Bearer secret-token' } }, response: { status: code, data: { private_key: 'secret-key' } }
    });
    const info = errorInfo(error, 'copy', 'dir/file');
    assert.equal(info.operation, 'copy'); assert.equal(info.object, 'dir/file'); assert.equal(String(info.code), String(code));
    assert.ok(info.message.includes(detail)); assert.doesNotMatch(JSON.stringify(info), /secret-token|secret-key/);
    assert.equal('config' in info, false); assert.equal('response' in info, false);
  }
  assert.doesNotMatch(JSON.stringify(errorInfo(failure('UNKNOWN', 'access_token=secret-token'))), /secret-token/);
});

test('API errors retain policy diagnostics and safe request IDs while stripping URLs and private keys', () => {
  const info = errorInfo({ response: { status: 403, headers: { 'x-goog-request-id': 'request-123' }, data: { error: {
    status: 'PERMISSION_DENIED', message: 'Public access prevention is enforced. https://example.com/?access_token=secret-url-token -----BEGIN PRIVATE KEY-----secret-key-----END PRIVATE KEY-----'
  } } }, config: { credentials: { private_key: 'secret-key' } } }, 'upload', 'file.txt');
  assert.equal(info.code, 'PERMISSION_DENIED'); assert.equal(info.requestId, 'request-123');
  assert.match(info.message, /Public access prevention is enforced/);
  assert.doesNotMatch(JSON.stringify(info), /secret-url-token|secret-key|https:/);
});

test('errorInfo gives proxy guidance for network timeouts', () => {
  const info = errorInfo(Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' }), 'projects');
  assert.equal(info.code, 'ETIMEDOUT');
  assert.match(info.message, /V2Ray\/Xray/);
  assert.doesNotMatch(info.message, /request timed out/);
});
