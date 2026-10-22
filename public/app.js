import { failureItem, folderTaskKey, resultStats } from '../task-groups.js';

'use strict';
const $ = id => document.getElementById(id);
const state = { bucket: '', prefix: '', items: [], selected: new Map(), buckets: [], connected: false, busy: 0, failed: [], uploads: [], distribution: '' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
function node(tag, text, parent) { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (parent) parent.append(n); return n; }
function notice(message = '') { $('notice').textContent = message; if ($('modal').open && message) { let error = $('modalError'); if (!error) { error = node('p', '', $('modalForm')); error.id = 'modalError'; error.setAttribute('role', 'alert'); } error.textContent = message; } }
function formatError(e) { return [e.operation, e.object, e.code, e.message, e.requestId && `Request ID: ${e.requestId}`].filter(Boolean).join(' | '); }
async function api(path, method = 'GET', data) {
  const response = await fetch(`/api/${path}`, { method, headers: data === undefined ? {} : { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 404 && result.error?.message === '接口不存在') throw new Error(`本地接口不存在：${method} /api/${path}。请重启云存储与 CDN 工具本地服务后刷新页面；这不是 AWS 权限错误。`);
    throw new Error(formatError(result.error || { message: response.statusText }));
  }
  return result;
}
function guarded(fn) { return async event => { try { await fn(event); } catch (e) { notice(e.message); } }; }
const size = value => value < 1024 ? `${value} B` : value < 1024 ** 2 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 ** 2).toFixed(1)} MB`;
function tab(name) { $('s3').hidden = !state.connected || name !== 's3'; $('cf').hidden = !state.connected || name !== 'cf'; }
$('s3Tab').onclick = () => tab('s3'); $('cfTab').onclick = () => tab('cf');
function renderBuckets() {
  $('buckets').replaceChildren(); $('bucketOptions').replaceChildren();
  for (const b of state.buckets) {
    const option = node('option', undefined, $('bucketOptions')); option.value = b.name;
    if (!b.name.includes($('bucketSearch').value.trim())) continue;
    const button = node('button', b.name + (b.region ? ` · ${b.region}` : ''), $('buckets'));
    button.onclick = guarded(async () => { state.bucket = b.name; state.prefix = ''; $('region').value = b.region || ''; $('bucketView').hidden = true; $('fileView').hidden = false; await browse(); });
  }
}
async function checks() {
  while (state.connected) {
    const r = await api('session'); state.buckets = r.buckets; renderBuckets();
    const names = { checking: '检查中', available: '可用', denied: '无权限', failed: '请求失败' };
    $('checks').replaceChildren();
    for (const [key, label] of [['s3', 'S3 列桶'], ['cf', 'CloudFront 列分配']]) {
      node('span', `${label}：${names[r.checks[key].state]}`, $('checks'));
      if (r.checks[key].error) node('span', formatError(r.checks[key].error), $('checks'));
    }
    if (Object.values(r.checks).every(c => c.state !== 'checking')) break;
    await sleep(700);
  }
}
$('connectForm').onsubmit = guarded(async e => {
  e.preventDefault(); const button = e.submitter; button.disabled = true; notice('正在建立本地会话…');
  try {
    await api('connect', 'POST', { accessKeyId: $('access').value, secretAccessKey: $('secret').value, sessionToken: $('token').value });
    $('connectForm').reset(); state.connected = true; $('login').hidden = true; $('disconnect').hidden = false; tab('s3'); notice(); await checks();
  } finally { button.disabled = false; }
});
$('disconnect').onclick = guarded(async () => {
  if (!confirm(state.busy ? '仍有任务执行中。断开将停止待执行工作；已提交的 CloudFront 失效无法撤销。确认断开？' : '确认断开连接？')) return;
  state.connected = false; await api('disconnect', 'POST'); location.reload();
});
$('bucketSearch').oninput = renderBuckets;
let browseSequence = 0;
let located;
$('locateForm').onsubmit = guarded(async e => {
  e.preventDefault(); const button = $('locateButton'); button.disabled = true;
  $('locateResults').replaceChildren(); notice('正在查找域名、路径规则和 S3 源…');
  try {
    const result = await api('locate', 'POST', { url: $('resourceUrl').value });
    for (const issue of result.issues) node('p', formatError({ ...issue, operation: issue.distribution, object: issue.origin }), $('locateResults'));
    for (const item of result.items) {
      const row = node('div', undefined, $('locateResults')); row.className = 'locateResult';
      node('strong', `s3://${item.bucket}/${item.key}`, row);
      node('small', [item.distribution && `分配 ${item.distribution}（${item.enabled ? '启用' : '禁用'}）`, item.behavior, item.origin && `源 ${item.origin}`, item.originDomain].filter(Boolean).join(' · '), row);
      for (const warning of item.warnings) node('p', warning, row);
      const open = node('button', '打开 S3 目录', row); open.type = 'button';
      open.onclick = guarded(async () => {
        open.disabled = true;
        try {
          state.bucket = item.bucket; state.prefix = item.prefix; located = item;
          $('region').value = ''; $('bucketView').hidden = true; $('fileView').hidden = false; tab('s3');
          if (!await browse()) return;
          while (!item.folder && !state.items.some(x => x.key === item.key) && state.next) {
            notice('正在后续分页中查找目标文件…');
            if (!await browse(true)) return;
          }
          if (state.bucket !== item.bucket || state.prefix !== item.prefix) return;
          const found = state.items.some(x => x.key === item.key);
          notice(item.folder ? `已打开目录：s3://${item.bucket}/${item.prefix}` : found ? `已定位文件：${item.key}` : `已打开父目录，但未找到文件：${item.key}。请核对路径改写、网站索引或对象是否存在。`);
          $('objects').querySelector('.located')?.scrollIntoView({ block: 'nearest' });
        } finally { open.disabled = false; }
      });
    }
    notice(result.items.length ? `找到 ${result.items.length} 个候选路径，请核对后打开。` : '未能定位到 S3，请查看上方原因。');
  } finally { button.disabled = false; }
});
$('back').onclick = () => { browseSequence++; $('bucketView').hidden = false; $('fileView').hidden = true; };
function selection() { $('selection').textContent = `${state.selected.size} 项已选`; for (const id of ['copy', 'move', 'delete']) $(id).disabled = !state.selected.size; }
function renderFiles() {
  $('objects').replaceChildren();
  for (const item of state.items) {
    const row = node('tr', undefined, $('objects')); const cell = node('td', undefined, row); const check = node('input', undefined, cell); check.type = 'checkbox'; check.setAttribute('aria-label', item.key); check.checked = state.selected.has(item.key);
    if (located?.bucket === state.bucket && located.key === item.key) { row.className = 'located'; row.setAttribute('aria-label', '链接定位的文件'); }
    check.onchange = () => { check.checked ? state.selected.set(item.key, item) : state.selected.delete(item.key); selection(); };
    const name = node('td', undefined, row); const button = node('button', `${item.folder ? '▸ ' : ''}${item.key.slice(state.prefix.length)}`, name);
    button.onclick = item.folder ? guarded(async () => { state.prefix = item.key; await browse(); }) : () => { check.click(); };
    node('td', item.folder ? '—' : size(item.size || 0), row); node('td', item.modified ? new Date(item.modified).toLocaleString() : '—', row);
  }
  selection();
}
async function browse(append = false) {
  const sequence = ++browseSequence;
  if (!append) {
    state.items = []; state.selected.clear(); state.next = null;
    $('selectAll').checked = false; $('more').hidden = true; $('crumbs').replaceChildren(); renderFiles();
  }
  notice('正在加载目录…');
  const query = new URLSearchParams({ bucket: state.bucket, prefix: state.prefix, region: $('region').value }); if (append && state.next) query.set('token', state.next);
  const r = await api(`objects?${query}`); if (sequence !== browseSequence) return false;
  $('region').value = r.region; state.next = r.token;
  if (!append) { state.items = []; state.selected.clear(); $('selectAll').checked = false; }
  state.items.push(...r.folders, ...r.files.filter(f => f.key !== state.prefix).map(f => ({ ...f, folder: false })));
  $('more').hidden = !r.token; renderFiles(); $('crumbs').replaceChildren();
  const root = node('button', state.bucket, $('crumbs')); root.onclick = guarded(async () => { state.prefix = ''; await browse(); });
  let prefix = ''; for (const part of state.prefix.split('/').filter(Boolean)) { prefix += `${part}/`; const value = prefix; const b = node('button', part, $('crumbs')); b.onclick = guarded(async () => { state.prefix = value; await browse(); }); }
  notice();
  return true;
}
$('refresh').onclick = guarded(() => browse()); $('more').onclick = guarded(() => browse(true)); $('region').onchange = guarded(() => browse());
$('selectAll').onchange = () => { state.selected.clear(); if ($('selectAll').checked) state.items.forEach(i => state.selected.set(i.key, i)); renderFiles(); };
let modalAction;
function dialog(action, description) {
  $('modalError')?.remove();
  modalAction = action; $('modalTitle').textContent = { copy: '复制对象', move: '移动对象', delete: '删除对象', upload: '上传文件', folder: '新建文件夹' }[action];
  $('modalDescription').textContent = description; $('targetFields').hidden = !['copy', 'move'].includes(action); $('folderFields').hidden = action !== 'folder'; $('targetBucket').required = !$('targetFields').hidden;
  $('targetBucket').value = state.bucket; $('targetPrefix').value = ''; $('targetRegion').value = ''; $('overwrite').checked = false; $('folderName').value = '';
  $('overwriteLabel').hidden = !['copy', 'move', 'upload'].includes(action); $('publicWarning').hidden = action !== 'upload'; $('modal').showModal();
}
$('newFolder').onclick = () => dialog('folder', `将在当前目录创建：s3://${state.bucket}/${state.prefix}`);
for (const action of ['copy', 'move', 'delete']) $(action).onclick = () => dialog(action, `源：s3://${state.bucket}/${state.prefix}\n选中 ${state.selected.size} 项（文件夹递归处理）：\n${[...state.selected.keys()].join('\n')}\n${action === 'move' ? '移动不是原子操作，每个对象复制成功后才删除源。' : action === 'delete' ? '确认删除所有选中对象及文件夹内容。版本化桶执行普通删除，保留历史版本。' : ''}`);
$('cancelModal').onclick = () => $('modal').close();
const taskGroups = new Map();
function showFailures(title, failures) {
  $('failureTitle').textContent = `${title} · 失败项`;
  $('failureSummary').textContent = `共 ${failures.length} 项。详细错误包含操作、对象、AWS 错误码、说明和请求 ID（如 AWS 返回）。`;
  $('failureItems').replaceChildren();
  for (const item of failures) {
    const row = node('tr', undefined, $('failureItems'));
    node('td', item.object || '批量任务', row);
    node('td', item.target || '—', row);
    node('td', item.state, row);
    node('td', formatError(item.error || { message: '操作未完成' }), row);
  }
  $('failureDialog').showModal();
}
function task(title, key = title) {
  $('activity').hidden = false;
  if (taskGroups.has(key)) return taskGroups.get(key);
  const box = node('details', undefined, $('tasks')); box.className = 'task';
  const summary = node('summary', undefined, box); const header = node('div', undefined, summary); header.className = 'taskHeader';
  const name = node('strong', title, header); const text = node('span', '等待执行', header); text.className = 'taskStatus';
  const progress = node('progress', undefined, summary); progress.max = 1; progress.value = 0;
  const body = node('div', undefined, box); body.className = 'taskBody';
  const actions = node('div', undefined, body); actions.className = 'taskActions';
  const failureButton = node('button', '查看失败项', actions); failureButton.hidden = true; failureButton.type = 'button';
  const detail = node('div', undefined, body); detail.className = 'taskDetails';
  const view = { box, name, text, progress, detail, failureButton, jobs: new Map(), entries: new Map(), errors: [] };
  view.addButton = (label, handler) => { const button = node('button', label, actions); button.type = 'button'; button.onclick = handler; return button; };
  view.addEntry = (id, entry) => { view.entries.set(id, { ...entry }); view.render(); };
  view.updateEntry = (id, patch) => { view.entries.set(id, { ...(view.entries.get(id) || {}), ...patch }); view.render(); };
  view.addJob = (id, label) => { view.jobs.set(id, { label, state: 'preparing', total: 0, done: 0, results: [] }); view.render(); };
  view.updateJob = (id, job) => { view.jobs.set(id, { ...(view.jobs.get(id) || {}), ...job }); view.render(); };
  view.render = () => {
    const items = [];
    for (const [jobId, job] of view.jobs) for (const result of job.results || []) items.push({ ...result, id: `${jobId}:${result.key}`, object: result.key });
    for (const [id, entry] of view.entries) items.push({ ...entry, id, object: entry.object || entry.label });
    const stats = resultStats(items);
    const jobErrors = [...view.jobs.values()].filter(job => job.error).map(job => job.error);
    const active = [...view.jobs.values()].some(job => ['preparing', 'running'].includes(job.state)) || items.some(item => ['pending', 'uploading'].includes(item.state));
    const total = [...view.jobs.values()].reduce((sum, job) => sum + (job.total || 0), 0) || items.length;
    const done = [...view.jobs.values()].reduce((sum, job) => sum + (job.done || 0), 0) || items.filter(item => !['pending', 'uploading'].includes(item.state)).length;
    const entryBytes = [...view.entries.values()].reduce((sum, item) => sum + (item.size || 0), 0);
    const uploadedBytes = [...view.entries.values()].reduce((sum, item) => sum + Math.min(item.size || 0, item.loaded || (['completed', 'skipped'].includes(item.state) ? item.size || 0 : 0)), 0);
    view.progress.value = entryBytes ? uploadedBytes / entryBytes : total ? done / total : 0;
    const failedCount = stats.failed + jobErrors.length;
    const stopped = [...view.jobs.values()].some(job => ['cancelled', 'interrupted'].includes(job.state));
    view.text.textContent = active ? `执行中 · ${done}/${total} · 失败 ${failedCount}` : `${stopped ? '已停止' : '已结束'} · 成功 ${stats.completed} · 跳过 ${stats.skipped} · 失败 ${failedCount}`;
    detail.replaceChildren();
    for (const item of items) {
      const row = node('div', undefined, detail); row.className = 'taskItem';
      const label = node('span', `${item.state || 'pending'} · ${item.object || item.label || ''}`, row); label.className = item.error || ['failed', 'copied_source_kept', 'cancelled'].includes(item.state) ? 'failed' : '';
      if (item.target) node('small', `目标：${item.target}`, row);
      if (item.size && item.loaded !== undefined) node('small', `${size(item.loaded)} / ${size(item.size)}`, row);
      if (item.error) node('small', formatError(item.error), row);
    }
    for (const error of jobErrors) { const errorLine = node('p', formatError(error), detail); errorLine.className = 'taskError'; }
    const failures = [...items.map(failureItem).filter(Boolean), ...jobErrors.map(error => failureItem({ state: 'failed', key: error.object || '批量任务', error })).filter(Boolean)];
    view.failureButton.hidden = !failures.length;
    view.failureButton.textContent = `查看失败项（${failures.length}）`;
    view.failureButton.onclick = () => showFailures(name.textContent, failures);
  };
  view.render(); taskGroups.set(key, view); return view;
}
async function watchJob(id, view) {
  while (state.connected) {
    let j;
    try { j = await api(`jobs/${id}`); }
    catch (error) { view.updateJob(id, { state: 'interrupted', error: { operation: '查询任务进度', message: `状态查询失败，服务端任务可能仍在执行：${error.message}` } }); throw error; }
    view.updateJob(id, j);
    if (!['preparing', 'running'].includes(j.state)) break; await sleep(800);
  }
}
$('modalForm').onsubmit = guarded(async e => {
  e.preventDefault(); const action = modalAction; const overwrite = $('overwrite').checked;
  if (action === 'upload') { $('modal').close(); await uploadAll(state.uploads, { bucket: state.bucket, prefix: state.prefix, overwrite }); return; }
  if (action === 'folder') {
    const name = $('folderName').value.trim();
    if (!name || name.includes('/') || name === '.' || name === '..') throw new Error('请输入不含 / 的文件夹名称');
    await api('folders', 'POST', { bucket: state.bucket, key: `${state.prefix}${name}/` }); $('modal').close(); notice('文件夹已创建'); await browse(); return;
  }
  const data = { action, bucket: state.bucket, selected: [...state.selected.values()].map(x => ({ key: x.key, folder: x.folder })), targetBucket: $('targetBucket').value.trim(), targetPrefix: $('targetPrefix').value, overwrite };
  if (data.targetPrefix && !data.targetPrefix.endsWith('/')) data.targetPrefix += '/';
  if ($('targetRegion').value) await api(`objects?${new URLSearchParams({ bucket: data.targetBucket, region: $('targetRegion').value })}`);
  const result = await api('jobs', 'POST', data); $('modal').close(); const taskKey = folderTaskKey({ operation: action, bucket: data.bucket, prefix: state.prefix, targetBucket: data.targetBucket, targetPrefix: data.targetPrefix }); const view = task(`${action} · ${data.bucket}/${state.prefix || '(根目录)'}`, taskKey); view.addJob(result.id, `${action} · ${data.bucket}`); const cancel = view.addButton('停止待执行操作', guarded(() => api(`jobs/${result.id}/cancel`, 'POST', {})));
  state.busy++; try { await watchJob(result.id, view); if (state.connected) await browse(); } finally { state.busy--; cancel.disabled = true; }
});
function prepare(files) {
  if (state.uploading) { notice('当前上传批次尚未完成，请等待后再添加文件。'); return; }
  if (!state.bucket || !files.length) return; state.uploads = files;
  dialog('upload', `目标：s3://${state.bucket}/${state.prefix}\n文件数：${files.length}\n总大小：${size(files.reduce((sum, x) => sum + x.file.size, 0))}\n${files.slice(0, 30).map(x => x.path).join('\n')}${files.length > 30 ? '\n…' : ''}`);
}
$('chooseFiles').onclick = () => $('files').click(); $('chooseFolder').onclick = () => $('folder').click();
for (const id of ['files', 'folder']) $(id).onchange = () => { prepare([...$(id).files].map(file => ({ file, path: file.webkitRelativePath || file.name }))); $(id).value = ''; };
async function walk(entry, base = '') {
  if (entry.isFile) return [{ file: await new Promise((resolve, reject) => entry.file(resolve, reject)), path: base + entry.name }];
  const reader = entry.createReader(); const out = []; let batch;
  do { batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject)); for (const child of batch) out.push(...await walk(child, base + entry.name + '/')); } while (batch.length);
  return out;
}
$('drop').ondragover = e => { e.preventDefault(); $('drop').classList.add('over'); }; $('drop').ondragleave = () => $('drop').classList.remove('over');
$('drop').ondrop = guarded(async e => { e.preventDefault(); $('drop').classList.remove('over'); const entries = [...e.dataTransfer.items].map(x => x.webkitGetAsEntry?.()).filter(Boolean); const fallback = [...e.dataTransfer.files]; const files = []; if (entries.length) for (const entry of entries) files.push(...await walk(entry)); else files.push(...fallback.map(file => ({ file, path: file.name }))); prepare(files); });
async function uploadAll(files, context) {
  if (state.uploading) throw new Error('已有上传批次正在执行');
  state.uploading = true;
  state.busy++; state.failed = []; $('retry').hidden = true; const taskKey = folderTaskKey({ operation: 'upload', bucket: context.bucket, prefix: context.prefix }); const total = task(`上传 · ${context.bucket}/${context.prefix || '(根目录)'}`, taskKey); let index = 0;
  const batch = files.map(item => ({ ...item, entryId: item.entryId || crypto.randomUUID() }));
  for (const item of batch) total.entries.set(item.entryId, { object: item.path, state: 'pending', size: item.file.size, loaded: 0 });
  total.render();
  async function worker() {
    while (index < batch.length && state.connected) {
      const item = batch[index++]; const entryId = item.entryId; total.updateEntry(entryId, { state: 'uploading' }); let polling = true;
      try {
        const r = await api('uploads', 'POST', { bucket: context.bucket, key: context.prefix + item.path, size: item.file.size, contentType: item.file.type, overwrite: context.overwrite });
        const poll = async () => { while (polling && state.connected) { try { const j = await api(`jobs/${r.id}`); total.updateEntry(entryId, { state: j.state === 'completed' ? 'completed' : 'uploading', loaded: j.loaded || 0 }); } catch { /* PUT response remains authoritative. */ } await sleep(600); } };
        const pending = poll(); let j;
        try { const response = await fetch(`/api/uploads/${r.id}`, { method: 'PUT', body: item.file }); j = await response.json(); if (!response.ok || j.error) throw new Error(formatError(j.error)); }
        finally { polling = false; await pending; }
        if (!['completed', 'skipped'].includes(j.state)) throw new Error(`上传未完成：${j.state}`);
        total.updateEntry(entryId, { state: j.state, loaded: item.file.size, error: undefined });
      } catch (e) { polling = false; state.failed.push({ ...item, context }); total.updateEntry(entryId, { state: 'failed', loaded: 0, error: { message: e.message } }); }
    }
  }
  try { await Promise.all(Array.from({ length: Math.min(3, files.length) }, worker)); $('retry').hidden = !state.failed.length; if (state.connected) await browse(); }
  finally { state.busy--; state.uploading = false; }
}
$('retry').onclick = guarded(async () => { const failed = [...state.failed]; if (failed.length) await uploadAll(failed, failed[0].context); });
$('searchForm').onsubmit = guarded(async e => {
  e.preventDefault(); notice('正在搜索分配…'); state.distribution = ''; $('distributions').replaceChildren();
  const r = await api(`distributions?${new URLSearchParams({ domain: $('domain').value })}`);
  for (const d of r.items) { const label = node('label', undefined, $('distributions')); const radio = node('input', undefined, label); radio.type = 'radio'; radio.name = 'distribution'; radio.value = d.id; radio.onchange = () => { state.distribution = d.id; }; label.append(document.createTextNode(` ${d.id} · ${d.domain} · ${d.enabled ? '启用' : '禁用'} · ${d.aliases.join(', ')}`)); if (r.items.length === 1) { radio.checked = true; state.distribution = d.id; } }
  notice(r.items.length ? '' : '未找到匹配的分配');
});
let invalidationAttempt;
$('invalidateForm').onsubmit = guarded(async e => {
  e.preventDefault(); if (!state.distribution) throw new Error('请先搜索并选择分配');
  const paths = [...new Set($('paths').value.split(/\r?\n/).map(x => x.trim()).filter(Boolean))];
  if (!paths.length || paths.some(p => !p.startsWith('/') || p.includes('#') || (p.includes('*') && p.indexOf('*') !== p.length - 1))) throw new Error('路径须以 / 开头，* 只能在末尾，不能含 #');
  if (!confirm(`确认提交到 ${state.distribution}？\n${paths.join('\n')}${paths.includes('/*') ? '\n注意：/* 将使全站缓存失效。' : ''}`)) return;
  const signature = JSON.stringify([state.distribution, paths]); if (invalidationAttempt?.signature !== signature) invalidationAttempt = { signature, reference: crypto.randomUUID() };
  const button = e.submitter; button.disabled = true; let r; const id = state.distribution;
  try { r = await api('invalidations', 'POST', { id, paths: paths.join('\n'), reference: invalidationAttempt.reference }); invalidationAttempt = null; }
  finally { button.disabled = false; }
  const view = task(`CloudFront · ${id} · 请求 ${r.Id}`); view.text.textContent = r.Status;
  const poll = async () => { while (state.connected && r.Status !== 'Completed') { await sleep(5000); try { r = await api(`invalidations?${new URLSearchParams({ distribution: id, id: r.Id })}`); view.text.textContent = r.Status; view.detail.textContent = ''; } catch (e) { view.detail.textContent = `请求已提交，状态查询失败，将继续查询：${e.message}`; } } view.progress.value = r.Status === 'Completed' ? 1 : 0; };
  void poll();
});
selection(); window.lucide?.createIcons();
void (async () => { try { await api('session'); state.connected = true; $('login').hidden = true; $('disconnect').hidden = false; tab('s3'); await checks(); } catch { /* No session on first visit. */ } })();
