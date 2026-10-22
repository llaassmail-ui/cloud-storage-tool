import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { newJob, publicJob } from '../jobs.js';
import { runGCPBatch, runInvalidations, resumeInvalidations } from '../gcp-jobs.js';

const selection = keys => keys.map(key => ({ key, folder: false }));
const batch = (keys, extra = {}) => ({ action: 'move', bucket: 'source', targetBucket: 'target',
  targetPrefix: '', selected: selection(keys), permission: 'inherit', overwrite: false, ...extra });
const invalidation = (extra = {}) => ({ project: 'test-project', map: 'global-map',
  host: 'cdn.example.com', paths: ['/a', '/b'], reference: randomUUID(), ...extra });
const polling = { pollInterval: 0, maxPolls: 2 };
const failure = (code, message = 'Request failed', extra = {}) => Object.assign(new Error(message), { code, ...extra });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('GCP move isolates copy, permission, skip and exact-generation delete failures', async () => {
  const keys = ['copy-fails', 'acl-fails', 'skip-result', 'skip-412', 'source-race', 'delete-race', 'ok'];
  const deleted = [];
  const job = newJob('move');
  const provider = {
    snapshot: async (bucket, selected, signal) => {
      assert.equal(bucket, 'source'); assert.deepEqual(selected, selection(keys));
      assert.equal(signal, job.controller.signal);
      return keys.map(key => ({ key, generation: '9007199254740993' }));
    },
    copy: async (bucket, key, targetBucket, target, options) => {
      assert.equal(bucket, 'source'); assert.equal(targetBucket, 'target'); assert.equal(target, key);
      assert.deepEqual(options, { permission: 'inherit', overwrite: false, generation: '9007199254740993', signal: job.controller.signal });
      if (key === 'copy-fails') throw failure(403);
      if (key === 'acl-fails') throw failure(412, 'Permission failed after copy', { copyCompleted: true });
      if (key === 'skip-result') return { skipped: true };
      if (key === 'skip-412') throw failure(412, 'Destination exists', { skipped: true });
      if (key === 'source-race') throw failure(412, 'Source generation changed');
    },
    remove: async (bucket, key, options) => {
      assert.equal(bucket, 'source');
      assert.deepEqual(options, { generation: '9007199254740993', signal: job.controller.signal });
      deleted.push(key);
      if (key === 'delete-race') throw failure(412, 'Source changed');
    }
  };
  await runGCPBatch(provider, batch(keys), job);
  assert.deepEqual(deleted, ['delete-race', 'ok']);
  assert.deepEqual(job.results.map(r => r.state), ['failed', 'copied_source_kept', 'skipped', 'skipped', 'failed', 'copied_source_kept', 'success']);
  assert.equal(job.total, 7); assert.equal(job.done, 7); assert.equal(job.state, 'partial');
});

test('GCP overwrite 412 is a failure and permissions have no implicit default', async () => {
  let snapshots = 0; let copies = 0;
  const provider = { snapshot: async () => { snapshots++; return [{ key: 'a', generation: '1' }]; },
    copy: async (...args) => { copies++; assert.equal(args[4].permission, 'public'); throw failure(412); } };
  for (const permission of [undefined, 'private', 'public-read']) {
    const job = newJob('copy'); await runGCPBatch(provider, batch(['a'], { action: 'copy', permission }), job);
    assert.equal(job.state, 'failed');
  }
  assert.equal(snapshots, 0);
  const job = newJob('copy'); await runGCPBatch(provider, batch(['a'], { action: 'copy', permission: 'public', overwrite: true }), job);
  assert.equal(copies, 1); assert.equal(job.results[0].state, 'failed');
});

test('GCP batch preflights target collisions and rejects missing generations before writes', async () => {
  for (const [objects, body] of [
    [[{ key: 'a/file', generation: '1' }, { key: 'b/file', generation: '2' }], batch(['a/file', 'b/file'])],
    [[{ key: 'a/file', generation: '1' }, { key: 'dest/file', generation: '2' }], batch(['a/file', 'dest/file'], { targetBucket: 'source', targetPrefix: 'dest/' })],
    [[{ key: 'ok', generation: '1' }, { key: 'missing' }], batch(['ok', 'missing'])]
  ]) {
    let writes = 0; const job = newJob('move');
    await runGCPBatch({ snapshot: async () => objects, copy: async () => { writes++; }, remove: async () => { writes++; } }, body, job);
    assert.equal(job.state, 'failed'); assert.equal(writes, 0);
  }
});

test('GCP captures a fixed recursive snapshot before starting writes', async () => {
  const objects = [{ key: 'dir/a', generation: '1' }, { key: 'dir/b', generation: '2' }];
  const copies = []; let snapshots = 0;
  const job = newJob('copy');
  await runGCPBatch({ snapshot: async () => { snapshots++; return objects; },
    copy: async (_bucket, key, _targetBucket, target, options) => {
      copies.push({ key, target, generation: options.generation });
      if (key === 'dir/a') { objects.push({ key: 'dir/new', generation: '3' }); objects[1].generation = '99'; }
    }
  }, batch([], { action: 'copy', targetPrefix: 'out/', selected: [{ key: 'dir/', folder: true }] }), job);
  assert.deepEqual(copies, [{ key: 'dir/a', target: 'out/dir/a', generation: '1' }, { key: 'dir/b', target: 'out/dir/b', generation: '2' }]);
  assert.equal(snapshots, 1); assert.equal(job.total, 2); assert.equal(job.state, 'completed');
});

test('GCP cancellation after copying keeps the source and stops subsequent copies', async () => {
  const job = newJob('move'); let copies = 0; let deletes = 0;
  await runGCPBatch({ snapshot: async () => [{ key: 'a', generation: '1' }, { key: 'b', generation: '2' }],
    copy: async () => { copies++; job.controller.abort(); }, remove: async () => { deletes++; }
  }, batch(['a', 'b']), job);
  assert.equal(copies, 1); assert.equal(deletes, 0); assert.equal(job.done, 1);
  assert.equal(job.results[0].state, 'copied_source_kept'); assert.equal(job.state, 'cancelled');
});

test('GCP cancellation during snapshot does not become a failed job', async () => {
  const job = newJob('delete');
  await runGCPBatch({ snapshot: async () => { job.controller.abort(); throw failure('ABORT_ERR'); } }, batch(['a'], { action: 'delete' }), job);
  assert.equal(job.state, 'cancelled'); assert.equal(job.done, 0);
});

test('GCP delete needs no permission mode and retains generation preconditions', async () => {
  const job = newJob('delete'); const deleted = [];
  await runGCPBatch({ snapshot: async () => [{ key: 'a', generation: '1' }, { key: 'b', generation: '2' }],
    remove: async (_bucket, key, { generation }) => { if (key === 'a') throw failure(412); deleted.push({ key, generation }); }
  }, batch(['a', 'b'], { action: 'delete', permission: undefined }), job);
  assert.deepEqual(deleted, [{ key: 'b', generation: '2' }]);
  assert.deepEqual(job.results.map(r => r.state), ['failed', 'success']); assert.equal(job.state, 'partial');
});

test('invalidations submit one stable UUID per path, including duplicate paths', async () => {
  const body = invalidation({ paths: ['/a', '/a', '/*'] }); const ids = [];
  const provider = { invalidate: async (project, map, { path, host, requestId, signal }) => {
    assert.ok(signal instanceof AbortSignal);
    assert.equal(project, body.project); assert.equal(map, body.map); assert.equal(host, body.host);
    assert.equal(path, body.paths[ids.length % 3]);
    assert.match(requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    ids.push(requestId); return { name: `op-${requestId}`, status: 'PENDING' };
  }, operation: async (project, id) => { assert.equal(project, body.project); assert.ok(id.startsWith('op-')); return { status: 'DONE' }; } };
  for (let n = 0; n < 2; n++) {
    const job = newJob('invalidation'); await runInvalidations(provider, body, job, polling);
    assert.equal(job.state, 'completed'); assert.equal(job.done, 3); assert.equal(job.total, 3);
    assert.ok(job.results.every(r => r.state === 'success' && r.operation.startsWith('op-') && r.key === r.path));
  }
  assert.equal(new Set(ids.slice(0, 3)).size, 3); assert.deepEqual(ids.slice(0, 3), ids.slice(3));
});

test('invalidation submission and completed operation failures remain independent', async () => {
  let submissions = 0;
  const provider = { invalidate: async (_p, _m, { path }) => {
    submissions++; if (path === '/submit-fails') throw failure(403); return { name: path.slice(1) };
  }, operation: async (_p, id) => id === 'op-fails' ? { status: 'DONE', error: { errors: [{ code: 'DENIED', message: 'Invalidation denied' }] } } : { status: 'DONE' } };
  const job = newJob('invalidation');
  await runInvalidations(provider, invalidation({ paths: ['/submit-fails', '/op-fails', '/ok'] }), job, polling);
  assert.equal(job.state, 'partial'); assert.equal(job.done, 3);
  assert.deepEqual(job.results.map(r => r.state), ['failed', 'failed', 'success']);
  assert.ok(job.results[1].error); assert.equal(job.results[1].operation, 'op-fails');
  await resumeInvalidations(provider, job, polling); assert.equal(submissions, 3);
});

test('query errors preserve submitted operations and resume never resubmits them', async () => {
  let submissions = 0; let queries = 0; let unavailable = true;
  const provider = { invalidate: async (_p, _m, { path }) => { submissions++; return { name: path.slice(1) }; },
    operation: async () => { queries++; if (unavailable) throw failure(503); return { status: 'DONE' }; } };
  const job = newJob('invalidation');
  await runInvalidations(provider, invalidation(), job, polling);
  assert.equal(job.state, 'waiting'); assert.equal(job.done, 0); assert.equal(queries, 4);
  assert.ok(job.results.every(r => r.state === 'submitted' && r.queryError && !r.error));
  unavailable = false; await resumeInvalidations(provider, job, polling);
  assert.equal(submissions, 2); assert.equal(job.state, 'completed'); assert.equal(job.done, 2);
  assert.ok(job.results.every(r => !r.queryError));
});

test('bounded polling leaves unfinished invalidations waiting', async () => {
  let queries = 0; const job = newJob('invalidation');
  await runInvalidations({ invalidate: async () => ({ name: 'op' }), operation: async () => { queries++; return { status: 'RUNNING' }; } },
    invalidation({ paths: ['/*'] }), job, { pollInterval: 0, maxPolls: 3 });
  assert.equal(queries, 3); assert.equal(job.state, 'waiting'); assert.equal(job.results[0].state, 'submitted');
});

test('cancellation retains submitted operations and resumes only pending submissions', async () => {
  const job = newJob('invalidation'); const submissions = []; let queries = 0;
  const provider = { invalidate: async (_p, _m, { path }) => {
    submissions.push(path); if (submissions.length === 1) job.controller.abort(); return { name: path.slice(1) };
  }, operation: async () => { queries++; return { status: 'DONE' }; } };
  await runInvalidations(provider, invalidation(), job, polling);
  assert.equal(job.state, 'cancelled'); assert.equal(queries, 0);
  assert.deepEqual(job.results.map(r => r.state), ['submitted', 'pending']);
  await resumeInvalidations(provider, job, polling);
  assert.deepEqual(submissions, ['/a', '/b']); assert.equal(job.state, 'completed');
});

test('cancelling an uncertain submission retries with the original request UUID', async () => {
  const job = newJob('invalidation'); const ids = [];
  const provider = { invalidate: async (_p, _m, { requestId: id }) => {
    ids.push(id); if (ids.length === 1) { job.controller.abort(); throw failure('ABORT_ERR'); }
    return { name: 'accepted-before-abort' };
  }, operation: async () => ({ status: 'DONE' }) };
  await runInvalidations(provider, invalidation({ paths: ['/*'] }), job, polling);
  await resumeInvalidations(provider, job, polling);
  assert.equal(ids.length, 2); assert.equal(ids[0], ids[1]); assert.equal(job.state, 'completed');
});

test('simultaneous resume calls share in-flight submission work', async () => {
  const entered = deferred(); const release = deferred(); let submissions = 0;
  const provider = { invalidate: async () => { submissions++; entered.resolve(); await release.promise; return { name: 'op' }; }, operation: async () => ({ status: 'DONE' }) };
  const job = newJob('invalidation');
  const first = runInvalidations(provider, invalidation({ paths: ['/*'] }), job, polling);
  await entered.promise;
  const second = resumeInvalidations(provider, job, polling);
  const third = resumeInvalidations(provider, job, polling);
  release.resolve(); await Promise.all([first, second, third]);
  assert.equal(submissions, 1); assert.equal(job.done, 1); assert.equal(job.results.length, 1);
});

test('resume context is detached from input and stores no credentials', async () => {
  const body = invalidation({ credentials: { access_token: 'secret-token' } });
  const job = newJob('invalidation'); const queries = [];
  const provider = { invalidate: async () => ({ name: 'op' }), operation: async project => { queries.push(project); return { status: 'DONE' }; } };
  await runInvalidations(provider, body, job, { maxPolls: 0 });
  body.project = 'changed'; body.paths.push('/new');
  const saved = JSON.parse(JSON.stringify(publicJob(job)));
  assert.doesNotMatch(JSON.stringify(saved), /secret-token|credentials/);
  const restored = { ...saved, controller: new AbortController() };
  await resumeInvalidations(provider, restored, polling);
  assert.deepEqual(queries, ['test-project', 'test-project']); assert.equal(restored.total, 2); assert.equal(restored.state, 'completed');
});

test('invalid invalidation inputs fail without cloud submissions', async () => {
  for (const overrides of [{ reference: 'not-a-uuid' }, { paths: [] }, { paths: '/a' }, { paths: ['relative'] }, { paths: ['/a*/b'] }, { map: 'regions/us/maps/regional' }]) {
    let submissions = 0; const job = newJob('invalidation');
    await runInvalidations({ invalidate: async () => { submissions++; } }, invalidation(overrides), job, polling);
    assert.equal(job.state, 'failed'); assert.equal(submissions, 0);
  }
});
