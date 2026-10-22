import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { destination, validateSelection, validateTargets } from './jobs.js';
import { errorInfo } from './gcp.js';

export { newJob, publicJob } from './jobs.js';

export async function runGCPBatch(gcp, body, job) {
  const signal = job.controller.signal;
  try {
    if (signal.aborted) { job.state = 'cancelled'; return; }
    const selected = validateSelection(body.selected).map(({ key, folder }) => ({ key, folder }));
    validateTargets(body, selected);
    if (body.action !== 'delete' && !['inherit', 'public'].includes(body.permission)) {
      throw new Error('Choose an explicit permission mode: inherit or public');
    }
    const objects = (await gcp.snapshot(body.bucket, selected, signal)).map(({ key, generation }) => ({ key, generation }));
    job.total = objects.length;
    const sources = new Set(objects.map(item => item.key));
    const targets = new Set();
    // Validate the whole fixed snapshot before any copy or deletion can begin.
    for (const item of objects) {
      if (typeof item.key !== 'string' || !item.key ||
          !(typeof item.generation === 'string' && /^[1-9][0-9]*$/.test(item.generation) ||
            Number.isSafeInteger(item.generation) && item.generation > 0)) {
        throw new Error('Snapshot objects must include an exact generation');
      }
      const target = destination(item, selected, body.targetPrefix || '');
      if (body.action === 'delete') continue;
      if (targets.has(target)) throw new Error('Selected objects have colliding destinations');
      targets.add(target);
      if (body.bucket === body.targetBucket && sources.has(target)) throw new Error('Destination overlaps the source snapshot');
    }
    job.state = 'running';
    for (const item of objects) {
      if (signal.aborted) break;
      let copied = false; let target;
      job.current = item.key;
      try {
        if (body.action !== 'delete') {
          target = destination(item, selected, body.targetPrefix);
          const result = await gcp.copy(body.bucket, item.key, body.targetBucket, target, {
            permission: body.permission, overwrite: body.overwrite === true, generation: item.generation, signal
          });
          if (result?.skipped) {
            job.results.push({ key: item.key, target, state: 'skipped' }); job.done++; continue;
          }
          copied = true;
        }
        if (signal.aborted) {
          job.results.push({ key: item.key, target, state: copied ? 'copied_source_kept' : 'cancelled' }); job.done++; break;
        }
        if (body.action !== 'copy') await gcp.remove(body.bucket, item.key, { generation: item.generation, signal });
        job.results.push({ key: item.key, target, state: 'success' });
      } catch (error) {
        const completed = copied || error.copyCompleted === true;
        const status = Number(error.status ?? error.statusCode ?? error.code ?? error.response?.status);
        if (!completed && body.action !== 'delete' && body.overwrite !== true && status === 412 && error.skipped === true) {
          job.results.push({ key: item.key, target, state: 'skipped' });
        } else {
          job.results.push({ key: item.key, target, state: completed ? 'copied_source_kept' : signal.aborted ? 'cancelled' : 'failed',
            error: errorInfo(error, body.action, item.key) });
        }
      }
      job.done++;
    }
    job.state = signal.aborted ? 'cancelled' : job.results.some(result => result.error) ? 'partial' : 'completed';
  } catch (error) {
    job.state = signal.aborted ? 'cancelled' : 'failed';
    if (!signal.aborted) job.error = errorInfo(error, body.action, body.bucket);
  }
}

const activeInvalidations = new WeakMap();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invalidationContext(body) {
  if (typeof body.project !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:.-]*$/.test(body.project) ||
      typeof body.map !== 'string' || !/^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/.test(body.map) ||
      typeof body.reference !== 'string' || !uuid.test(body.reference) ||
      (body.host !== undefined && (typeof body.host !== 'string' || /[\s/#?]/.test(body.host))) ||
      !Array.isArray(body.paths) || !body.paths.length || body.paths.length > 3000 ||
      body.paths.some(path => typeof path !== 'string' || !path.startsWith('/') || path.length > 4000 ||
        /[\r\n#]/.test(path) || (path.includes('*') && path.indexOf('*') !== path.length - 1))) {
    throw new Error('Invalid global URL map invalidation request');
  }
  return { project: body.project, map: body.map, host: body.host || '', paths: [...body.paths], reference: body.reference.toLowerCase() };
}

function requestId(reference, index) {
  const bytes = createHash('sha256').update(JSON.stringify([reference, index])).digest().subarray(0, 16);
  // UUIDv8 reserves application-defined deterministic bytes and the RFC variant.
  bytes[6] = (bytes[6] & 0x0f) | 0x80; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function recordOperation(result, operation) {
  if (operation?.name) result.operation = operation.name;
  if (operation?.status !== 'DONE') return;
  if (operation.error) {
    const detail = operation.error.errors?.[0] || operation.error;
    result.error = errorInfo({ code: detail.code || 'OperationFailed', message: detail.message || 'Invalidation operation failed' }, 'invalidate', result.path);
    result.state = 'failed';
  } else {
    result.state = 'success';
  }
}

function updateInvalidationState(job, signal) {
  job.done = job.results.filter(result => ['success', 'failed'].includes(result.state)).length;
  job.state = signal.aborted ? 'cancelled' : job.done < job.total ? 'waiting' :
    job.results.some(result => result.state === 'failed') ? 'partial' : 'completed';
}

async function processInvalidations(gcp, job, { pollInterval = 3000, maxPolls = 100 } = {}) {
  const signal = job.controller.signal;
  try {
    if (!Number.isFinite(pollInterval) || pollInterval < 0 || !Number.isSafeInteger(maxPolls) || maxPolls < 0) {
      throw new Error('Invalid polling limits');
    }
    const { project, map, host } = job.context;
    job.state = 'running';
    for (const result of job.results) {
      if (signal.aborted) break;
      if (result.state !== 'pending') continue;
      job.current = result.path;
      try {
        const operation = await gcp.invalidate(project, map, { host, path: result.path, requestId: result.requestId, signal });
        if (!operation?.name) throw new Error('Invalidation response has no operation name');
        result.operation = operation.name; result.state = 'submitted';
        delete result.queryError;
        recordOperation(result, operation);
      } catch (error) {
        // An aborted request may already have reached GCP. Keep its UUID for resume.
        if (!signal.aborted) {
          result.state = 'failed'; result.error = errorInfo(error, 'invalidate', result.path);
        }
      }
      job.done = job.results.filter(item => ['success', 'failed'].includes(item.state)).length;
    }
    for (let poll = 0; poll < maxPolls && !signal.aborted; poll++) {
      if (!job.results.some(result => result.state === 'submitted')) break;
      if (poll > 0 && pollInterval > 0) {
        try { await delay(pollInterval, undefined, { signal }); }
        catch (error) { if (signal.aborted) break; throw error; }
      }
      for (const result of job.results) {
        if (signal.aborted) break;
        if (result.state !== 'submitted') continue;
        job.current = result.path;
        try {
          const operation = await gcp.operation(project, result.operation, signal);
          if (!operation?.status) throw new Error('Invalid operation query response');
          delete result.queryError;
          recordOperation(result, operation);
        } catch (error) {
          if (!signal.aborted) result.queryError = errorInfo(error, 'operation', result.operation);
        }
        job.done = job.results.filter(item => ['success', 'failed'].includes(item.state)).length;
      }
    }
    updateInvalidationState(job, signal);
  } catch (error) {
    job.state = signal.aborted ? 'cancelled' : 'failed';
    if (!signal.aborted) job.error = errorInfo(error, 'invalidate', job.context?.map || '');
  }
}

function startInvalidations(gcp, job, options) {
  // Deferring work installs the lock before a provider can yield or trigger resume.
  const running = Promise.resolve().then(() => processInvalidations(gcp, job, options));
  activeInvalidations.set(job, running);
  void running.finally(() => { if (activeInvalidations.get(job) === running) activeInvalidations.delete(job); });
  return running;
}

export async function runInvalidations(gcp, body, job, options = {}) {
  if (activeInvalidations.has(job)) return activeInvalidations.get(job);
  if (job.context) return resumeInvalidations(gcp, job, options);
  try {
    job.context = invalidationContext(body);
    job.results = job.context.paths.map((path, index) => ({ key: path, path, state: 'pending', requestId: requestId(job.context.reference, index) }));
    job.total = job.results.length; job.done = 0;
  } catch (error) {
    job.state = 'failed'; job.error = errorInfo(error, 'invalidate', body.map || ''); return;
  }
  return startInvalidations(gcp, job, options);
}

export async function resumeInvalidations(gcp, job, options = {}) {
  if (activeInvalidations.has(job)) return activeInvalidations.get(job);
  if (!job.context) {
    job.state = 'failed'; job.error = errorInfo(new Error('Missing invalidation context'), 'invalidate'); return;
  }
  if (job.controller.signal.aborted) job.controller = new AbortController();
  delete job.error;
  return startInvalidations(gcp, job, options);
}
