'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const active = new Set(['preparing', 'running']);
  const labels = { preparing: '准备中', running: '执行中', completed: '已完成', partial: '部分失败', failed: '失败', cancelled: '已取消', waiting: '等待继续查询', pending: '等待执行', success: '成功', submitted: '已提交，等待结果', skipped: '已跳过', queued: '等待上传' };
  const actionNames = { copy: '复制', move: '移动', delete: '删除', upload: '上传', invalidation: '缓存失效', invalidate: '缓存失效', invalidations: '缓存失效' };
  const state = { connected: false, project: '', bucket: '', prefix: '', tab: 'files', buckets: [], items: [], selected: new Map(), token: '', jobs: new Map(), uploads: new Map(), queue: [], workers: 0, map: '', host: '', browseVersion: 0, projectVersion: 0, mapVersion: 0, epoch: 0, loading: false, switching: false, timer: null };
  let modalContext, retryContext, modalBusy = false, directoryRefreshTimer;
  const node = (tag, text, parent, cls) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; parent?.append(el); return el; };
  const icon = (name, parent) => { const el = node('i', undefined, parent); el.dataset.lucide = name; el.setAttribute('aria-hidden', 'true'); };
  const icons = () => window.lucide?.createIcons();
  const size = value => { const n = Number(value) || 0; const u = n >= 1024 ** 3 ? 3 : n >= 1024 ** 2 ? 2 : n >= 1024 ? 1 : 0; return (u ? (n / 1024 ** u).toFixed(1) : n) + ' ' + ['B', 'KB', 'MB', 'GB'][u]; };
  const message = e => typeof e === 'string' ? e : [e?.operation, e?.object, e?.code, e?.message].filter(Boolean).join(' | ') || '请求失败';
  const notice = (text = '') => { $('notice').textContent = text; };
  const guard = fn => async event => { try { await fn(event); } catch (e) { if ($('modal').open) $('modalError').textContent = message(e); else notice(message(e)); } };
  const on = (id, type, fn) => $(id).addEventListener(type, guard(fn));
  const query = value => new URLSearchParams(value).toString();
  const prefixOf = value => value && !value.endsWith('/') ? value + '/' : value;
  const parentOf = key => key?.includes('/') ? key.slice(0, key.lastIndexOf('/') + 1) : '';
  const projectId = p => typeof p === 'string' ? p : p?.projectId || p?.project_id || p?.id || '';
  async function api(path, method = 'GET', data, options = {}) {
    const response = await fetch('/api/gcp/' + path, { method, credentials: 'same-origin', cache: 'no-store', ...options, headers: data === undefined ? options.headers : { 'Content-Type': 'application/json' }, body: data === undefined ? options.body : JSON.stringify(data) });
    const text = await response.text(); let result;
    try { result = text ? JSON.parse(text) : {}; } catch { throw new Error('服务返回了无效响应（HTTP ' + response.status + '），请检查本地服务。'); }
    if (!response.ok) throw new Error(message(result.error || { message: '请求失败（HTTP ' + response.status + '）' }));
    return result;
  }
  function saveView() { try { sessionStorage.setItem('gcp-view', JSON.stringify({ project: state.project, bucket: state.bucket, prefix: state.prefix, tab: state.tab })); } catch { /* Storage is optional; credentials are never persisted. */ } }
  function readView() { try { return JSON.parse(sessionStorage.getItem('gcp-view') || '{}'); } catch { return {}; } }
  function connected(value) { state.connected = value; $('login').hidden = value; $('workspace').hidden = !value; $('disconnect').hidden = !value; $('connectionState').textContent = value ? '已连接' : '未连接'; }
  function tab(name, focus = false) {
    state.tab = name === 'cdn' ? 'cdn' : 'files';
    for (const [id, panel, value] of [['filesTab', 'storagePanel', 'files'], ['cdnTab', 'cdnPanel', 'cdn']]) { const yes = state.tab === value; $(id).setAttribute('aria-selected', String(yes)); $(id).tabIndex = yes ? 0 : -1; $(panel).hidden = !yes; if (yes && focus) $(id).focus(); } saveView();
  }
  for (const [id, name] of [['filesTab', 'files'], ['cdnTab', 'cdn']]) { on(id, 'click', () => tab(name)); on(id, 'keydown', e => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) { e.preventDefault(); tab(e.key === 'Home' ? 'files' : e.key === 'End' ? 'cdn' : state.tab === 'files' ? 'cdn' : 'files', true); } }); }
  const authMode = () => $('connectForm').querySelector('[name=authMode]:checked').value;
  on('connectForm', 'change', () => { const service = authMode() === 'serviceAccount'; $('credentialField').hidden = !service; $('credentialFile').required = service; $('adcHint').hidden = service; if (!service) $('credentialFile').value = ''; });
  on('connectForm', 'submit', async e => {
    e.preventDefault(); $('connectButton').disabled = true; notice('正在连接 Google Cloud…'); let credentials;
    try {
      const mode = authMode();
      if (mode === 'serviceAccount') {
        const file = $('credentialFile').files[0]; if (!file) throw new Error('请选择服务账号 JSON 文件。');
        try { credentials = JSON.parse(await file.text()); } catch { throw new Error('密钥文件不是有效的 JSON。'); }
        if (!credentials || Array.isArray(credentials) || typeof credentials !== 'object' || credentials.type !== 'service_account' || !credentials.client_email || !credentials.private_key) throw new Error('请选择有效的服务账号 JSON 密钥，需包含 client_email 和 private_key。');
      }
      $('credentialFile').value = '';
      const result = await api('connect', 'POST', { mode, ...(credentials ? { credentials } : {}) }); credentials = undefined;
      if (!result.connected) throw new Error('连接未建立，请检查凭据。'); await activate(result); notice();
    } finally { credentials = undefined; $('credentialFile').value = ''; $('connectButton').disabled = false; }
  });
  async function activate(result, restore = false) {
    connected(true); const saved = restore ? readView() : {};
    $('projectSelect').replaceChildren(); node('option', '手动输入项目 ID', $('projectSelect')).value = '';
    for (const p of result.projects || []) { const id = projectId(p); if (id) node('option', (p.displayName || p.name) ? (p.displayName || p.name) + ' (' + id + ')' : id, $('projectSelect')).value = id; }
    $('projectError').hidden = !result.projectError; $('projectError').textContent = result.projectError ? '项目列表加载失败，可手动输入项目 ID。' + message(result.projectError) : '';
    tab(saved.tab);
    try { await refreshJobs(); } catch (e) { $('jobStatus').textContent = '任务恢复失败：' + message(e) + '。可点击刷新任务重试。'; }
    startPolling();
    const project = projectId(result.project) || saved.project || projectId(result.projects?.[0]);
    if (project) { $('projectId').value = project; await selectProject(project); if (restore && saved.project === state.project && saved.bucket) { state.bucket = saved.bucket; state.prefix = typeof saved.prefix === 'string' ? saved.prefix : ''; await browse(); } }
  }
  function clearMaps() { state.mapVersion++; state.map = ''; state.host = ''; $('maps').replaceChildren(); $('mapChoices').hidden = true; $('cdnHost').value = ''; $('invalidateButton').disabled = true; $('mapStatus').textContent = ''; }
  function requireProject() { if (!state.project || state.switching) throw new Error('请先选择并加载项目。'); }
  async function selectProject(project) {
    project = project.trim(); if (!project) throw new Error('请输入项目 ID。'); if (state.switching) return;
    const version = ++state.projectVersion; state.switching = true; state.browseVersion++; state.loading = false;
    $('projectButton').disabled = true; $('projectSelect').disabled = true; clearMaps(); state.bucket = ''; state.prefix = ''; state.items = []; state.selected.clear(); state.buckets = [];
    $('bucketView').hidden = false; $('fileView').hidden = true; $('bucketStatus').textContent = '正在检查项目与权限…'; $('checks').replaceChildren(); renderBuckets(); notice();
    try {
      const result = await api('project', 'POST', { project }); if (version !== state.projectVersion) return;
      state.project = projectId(result.project) || project; $('projectId').value = state.project; $('projectSelect').value = state.project;
      for (const [key, name] of [['storage', '存储'], ['cdn', 'CDN']]) { const c = result.checks?.[key]; if (!c) continue; const el = node('span', name + '：' + ({ available: '可用', checking: '检查中', denied: '无权限', failed: '请求失败', unknown: '未检查', ready: '可用' }[c.state] || c.state) + (c.error ? ' · ' + message(c.error) : ''), $('checks'), 'check'); el.dataset.state = c.state; }
      state.buckets = result.buckets || []; saveView();
    } catch (e) { state.project = ''; throw e; }
    finally { state.switching = false; $('projectButton').disabled = false; $('projectSelect').disabled = false; renderBuckets(); }
  }
  on('projectSelect', 'change', async () => { $('projectId').value = $('projectSelect').value; if ($('projectId').value) await selectProject($('projectId').value); else $('projectId').focus(); });
  on('projectForm', 'submit', e => { e.preventDefault(); return selectProject($('projectId').value); });
  on('projectId', 'input', () => { $('projectSelect').value = $('projectId').value; });
  function renderBuckets() {
    $('buckets').replaceChildren(); $('bucketOptions').replaceChildren(); const filter = $('bucketSearch').value.trim().toLowerCase(); let count = 0;
    for (const bucket of state.buckets) { const name = typeof bucket === 'string' ? bucket : bucket.name; if (!name) continue; node('option', undefined, $('bucketOptions')).value = name; if (!name.toLowerCase().includes(filter)) continue; count++;
      const b = node('button', undefined, $('buckets')); b.type = 'button'; icon('database', b); node('strong', name, b, 'bucket-name'); node('small', bucket.location || bucket.region || '', b, 'muted'); icon('chevron-right', b); b.onclick = guard(async () => { state.bucket = name; state.prefix = ''; await browse(); }); }
    if (!state.switching) $('bucketStatus').textContent = !state.project ? '请先选择项目。' : count ? count + ' 个存储桶' : filter ? '没有匹配的存储桶。' : '暂无存储桶，或当前身份没有列举权限。'; icons();
  }
  on('bucketSearch', 'input', renderBuckets);
  on('refreshBuckets', 'click', async () => { requireProject(); const version = state.projectVersion; $('refreshBuckets').disabled = true; try { const r = await api('buckets?' + query({ project: state.project })); if (version === state.projectVersion) { state.buckets = r.items || []; renderBuckets(); } } finally { $('refreshBuckets').disabled = false; } });
  function crumbs() { $('crumbs').replaceChildren(); const add = (label, prefix) => { const b = node('button', label, $('crumbs')); b.type = 'button'; if (prefix === state.prefix) b.setAttribute('aria-current', 'location'); b.onclick = guard(async () => { state.prefix = prefix; await browse(); }); }; add(state.bucket, ''); let prefix = ''; for (const part of state.prefix.split('/').filter(Boolean)) { node('span', '/', $('crumbs')).setAttribute('aria-hidden', 'true'); prefix += part + '/'; add(part, prefix); } }
  function selection() { $('selection').textContent = state.selected.size + ' 项已选'; for (const id of ['copy', 'move', 'delete']) $(id).disabled = state.loading || !state.selected.size; $('selectAll').checked = !!state.items.length && state.selected.size === state.items.length; $('selectAll').indeterminate = state.selected.size > 0 && state.selected.size < state.items.length; $('selectAll').disabled = state.loading || !state.items.length; }
  function renderFiles() {
    $('objects').replaceChildren();
    for (const item of state.items) { const row = node('tr', undefined, $('objects')); const check = node('input', undefined, node('td', undefined, row)); check.type = 'checkbox'; check.checked = state.selected.has(item.key); check.disabled = state.loading; check.setAttribute('aria-label', '选择 ' + item.key); check.onchange = () => { if (check.checked) state.selected.set(item.key, item); else state.selected.delete(item.key); selection(); };
      const b = node('button', undefined, node('td', undefined, row), 'object-name'); b.type = 'button'; icon(item.folder ? 'folder' : 'file', b); node('span', item.key.slice(state.prefix.length) || item.key, b); b.onclick = guard(async () => { if (item.folder) { state.prefix = prefixOf(item.key); await browse(); } else check.click(); });
      node('td', item.folder ? '-' : size(item.size), row); const date = item.modified || item.updated || item.timeCreated; node('td', date && !Number.isNaN(Date.parse(date)) ? new Date(date).toLocaleString('zh-CN') : '-', row); }
    selection(); icons();
  }
  async function browse(append = false) {
    requireProject(); if (!state.bucket || (append && (state.loading || !state.token))) return;
    const version = ++state.browseVersion; state.loading = true; $('bucketView').hidden = true; $('fileView').hidden = false; $('more').disabled = true;
    if (!append) { state.items = []; state.selected.clear(); state.token = ''; $('more').hidden = true; } crumbs(); renderFiles(); saveView(); $('objectStatus').textContent = '正在加载目录…';
    try { const r = await api('objects?' + query({ bucket: state.bucket, prefix: state.prefix, ...(append ? { token: state.token } : {}) })); if (version !== state.browseVersion) return;
      const items = [...(r.folders || []).map(x => typeof x === 'string' ? { key: x, folder: true } : { ...x, key: x.key || x.prefix || x.name, folder: true }), ...(r.files || []).map(x => ({ ...x, key: x.key || x.name, folder: false }))].filter(x => x.key && x.key !== state.prefix);
      state.items = [...new Map([...state.items, ...items].map(x => [x.key, x])).values()]; state.token = r.token || ''; $('more').hidden = !state.token; $('objectStatus').textContent = state.items.length ? '已加载 ' + state.items.length + ' 项' + (state.token ? '，还有更多对象' : '') : '此目录为空。';
    } catch (e) { if (version === state.browseVersion) $('objectStatus').textContent = '目录加载失败：' + message(e) + '。可点击刷新重试。'; }
    finally { if (version === state.browseVersion) { state.loading = false; $('more').disabled = false; renderFiles(); } }
  }
  on('back', 'click', () => { state.browseVersion++; state.loading = false; state.bucket = ''; state.prefix = ''; state.selected.clear(); $('bucketView').hidden = false; $('fileView').hidden = true; saveView(); });
  on('refresh', 'click', () => browse()); on('more', 'click', () => browse(true));
  on('selectAll', 'change', () => { state.selected.clear(); if ($('selectAll').checked) for (const item of state.items) state.selected.set(item.key, item); renderFiles(); });
  function openModal(context, title, description) {
    if ($('modal').open) throw new Error('请先完成当前确认操作。'); modalContext = context; $('modalForm').reset(); $('modalError').textContent = ''; $('modalTitle').textContent = title; $('modalDescription').textContent = description;
    const target = ['copy', 'move', 'upload'].includes(context.action); $('targetFields').hidden = !target; $('targetBucket').required = target; $('targetBucket').value = context.bucket || ''; $('targetPrefix').value = context.prefix || '';
    $('permissionFields').hidden = !target; for (const radio of $('permissionFields').querySelectorAll('input')) { radio.checked = false; radio.required = target; }
    $('overwriteLabel').hidden = !target; $('publicWarning').hidden = true; $('folderFields').hidden = context.action !== 'folder'; $('folderName').required = context.action === 'folder';
    const wildcard = context.action === 'invalidation' && context.paths.includes('/*'); $('wildcardLabel').hidden = !wildcard; $('wildcardConfirm').required = wildcard;
    $('confirmModal').textContent = context.action === 'delete' ? '确认删除' : '确认执行'; targetPreview(); $('modal').showModal();
  }
  function targetPreview() { $('targetPreview').textContent = '目标：gs://' + $('targetBucket').value.trim() + '/' + prefixOf($('targetPrefix').value); }
  on('targetBucket', 'input', targetPreview); on('targetPrefix', 'input', targetPreview);
  on('permissionFields', 'change', () => { $('publicWarning').hidden = $('modalForm').querySelector('[name=permission]:checked')?.value !== 'public'; });
  on('cancelModal', 'click', () => { if (!modalBusy) $('modal').close(); }); $('modal').addEventListener('cancel', e => { if (modalBusy) e.preventDefault(); }); $('modal').addEventListener('close', () => { modalContext = null; });
  on('newFolder', 'click', () => { requireProject(); openModal({ action: 'folder', bucket: state.bucket, prefix: state.prefix }, '新建文件夹', '所在目录：gs://' + state.bucket + '/' + state.prefix); });
  for (const action of ['copy', 'move', 'delete']) on(action, 'click', () => { const selected = [...state.selected.values()].map(({ key, folder }) => ({ key, folder: !!folder })); if (!selected.length) return; openModal({ action, bucket: state.bucket, prefix: state.prefix, selected }, actionNames[action] + '选中对象', '源：gs://' + state.bucket + '/' + state.prefix + '\n选中 ' + selected.length + ' 项（文件夹及其内容递归处理）：\n' + selected.map(x => x.key).join('\n') + '\n' + (action === 'move' ? '每个对象复制成功后再删除源对象，部分失败请查看任务结果。' : action === 'delete' ? '确认删除以上对象及文件夹内容，此操作无法在此页面撤销。' : '')); });
  on('modalForm', 'submit', async e => {
    e.preventDefault(); if (modalBusy || !modalContext) return; const c = modalContext; modalBusy = true; $('confirmModal').disabled = true; $('cancelModal').disabled = true; $('modalError').textContent = '';
    try {
      if (c.action === 'folder') { const name = $('folderName').value.trim(); if (!name || name.includes(String.fromCharCode(92)) || /[\/\u0000-\u001f]/.test(name) || ['.', '..'].includes(name)) throw new Error('请输入单层文件夹名称，不含斜杠或控制字符。'); await api('folders', 'POST', { bucket: c.bucket, key: c.prefix + name + '/' }); $('modal').close(); if (state.bucket === c.bucket && state.prefix === c.prefix) await browse(); }
      else if (c.action === 'invalidation') { if (c.paths.includes('/*') && !$('wildcardConfirm').checked) throw new Error('请确认清除该主机的全部路径缓存。'); const r = await api('invalidations', 'POST', { project: c.project, map: c.map, host: c.host, paths: c.paths.join('\n'), reference: c.reference }); addJob({ id: r.id, type: 'invalidation', state: 'preparing', done: 0, total: c.paths.length, results: [], project: c.project, map: c.map, host: c.host }); $('modal').close(); notice('缓存失效任务已提交。'); }
      else { const target = c.action !== 'delete'; const permission = $('modalForm').querySelector('[name=permission]:checked')?.value; if (target && !['inherit', 'public'].includes(permission)) throw new Error('请选择目标访问权限。');
        const targetBucket = $('targetBucket').value.trim(); const targetPrefix = prefixOf($('targetPrefix').value); const overwrite = $('overwrite').checked;
        if (target && (!targetBucket || /[\s/]/.test(targetBucket) || /[\u0000-\u001f]/.test(targetPrefix))) throw new Error('请核对目标存储桶和目录，存储桶名称不含空格或斜杠。');
        if (c.action === 'upload') {
          for (const orphan of c.replaceJobs || []) await api('jobs/' + encodeURIComponent(orphan.id) + '/cancel', 'POST');
          for (const item of c.files) enqueue(item, { bucket: targetBucket, prefix: targetPrefix, key: targetPrefix + item.path, overwrite, permission });
          $('modal').close(); pump(); notice('已加入上传队列：' + c.files.length + ' 个文件。');
        }
        else { const payload = { action: c.action, bucket: c.bucket, prefix: c.prefix, selected: c.selected, ...(target ? { targetBucket, targetPrefix, overwrite, permission } : {}) }; const r = await api('jobs', 'POST', payload); addJob({ ...payload, id: r.id, type: c.action, state: 'preparing', done: 0, total: c.selected.length, results: [] }); $('modal').close(); notice('任务已提交。'); }
      }
    } finally { modalBusy = false; $('confirmModal').disabled = false; $('cancelModal').disabled = false; }
  });
  function confirmUpload(files, destination = { bucket: state.bucket, prefix: state.prefix }, replaceJobs = []) {
    requireProject(); if (!destination.bucket) throw new Error('请先打开目标存储桶。'); if (!files.length) throw new Error('没有可上传的文件。空文件夹请使用“新建文件夹”。');
    const paths = new Set(); for (const item of files) { if (!item.path || item.path.startsWith('/') || item.path.split('/').some(x => x === '..' || x === '.') || /[\u0000-\u001f]/.test(item.path)) throw new Error('文件路径无效：' + item.path); if (paths.has(item.path)) throw new Error('存在重复目标路径：' + item.path); paths.add(item.path); }
    openModal({ action: 'upload', ...destination, files, replaceJobs }, '确认上传', '目标：gs://' + destination.bucket + '/' + destination.prefix + '\n文件数量：' + files.length + '\n总大小：' + size(files.reduce((sum, x) => sum + x.file.size, 0)) + '\n' + files.slice(0, 12).map(x => x.path).join('\n') + (files.length > 12 ? '\n…' : '') + (replaceJobs.length ? '\n确认后将取消 ' + replaceJobs.length + ' 个已登记、未开始传输的旧任务。' : ''));
  }
  const picked = files => Array.from(files, file => ({ file, path: file.webkitRelativePath || file.name }));
  on('chooseFiles', 'click', () => $('files').click()); on('chooseFolder', 'click', () => $('folder').click());
  for (const id of ['files', 'folder']) on(id, 'change', () => { const files = picked($(id).files); $(id).value = ''; if (files.length) confirmUpload(files); });
  async function walk(entry, prefix = '') {
    if (entry.isFile) { const file = await new Promise((resolve, reject) => entry.file(resolve, reject)); return [{ file, path: prefix + file.name }]; }
    if (!entry.isDirectory) return []; const reader = entry.createReader(); const files = [];
    // readEntries returns batches; keep reading until the directory is exhausted.
    while (true) { const entries = await new Promise((resolve, reject) => reader.readEntries(resolve, reject)); if (!entries.length) break; for (const child of entries) files.push(...await walk(child, prefix + entry.name + '/')); } return files;
  }
  for (const type of ['dragenter', 'dragover']) $('drop').addEventListener(type, e => { e.preventDefault(); $('drop').classList.add('over'); });
  $('drop').addEventListener('dragleave', e => { if (!$('drop').contains(e.relatedTarget)) $('drop').classList.remove('over'); });
  on('drop', 'drop', async e => {
    e.preventDefault(); $('drop').classList.remove('over'); if ($('drop').dataset.busy === 'true') return;
    const destination = { bucket: state.bucket, prefix: state.prefix }; const version = state.projectVersion;
    const entries = Array.from(e.dataTransfer.items || []).filter(x => x.kind === 'file').map(x => ({ entry: x.webkitGetAsEntry?.(), file: x.getAsFile() })); const fallback = picked(e.dataTransfer.files);
    $('drop').dataset.busy = 'true'; notice('正在读取文件目录…');
    try { const files = []; if (entries.length) { for (const item of entries) { if (item.entry) files.push(...await walk(item.entry)); else if (item.file) files.push({ file: item.file, path: item.file.name }); } } else files.push(...fallback); if (version !== state.projectVersion || !state.connected) throw new Error('读取目录期间项目已切换，请重新选择文件。'); notice(); confirmUpload(files, destination); } finally { $('drop').dataset.busy = 'false'; }
  });
  for (const type of ['dragover', 'drop']) document.addEventListener(type, e => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
  function enqueue(item, config) { const id = 'local-' + crypto.randomUUID(); const record = { id, file: item.file, path: item.path, config, cancelled: false, epoch: state.epoch }; state.uploads.set(id, record); state.queue.push(record); addJob({ id, type: 'upload', state: 'queued', done: 0, total: 1, results: [], size: item.file.size, ...config }); }
  function pump() { while (state.connected && state.workers < 3 && state.queue.length) { const record = state.queue.shift(); if (record.cancelled || record.epoch !== state.epoch) continue; state.workers++; runUpload(record).finally(() => { state.workers--; pump(); }); } }
  async function runUpload(record) {
    let id = record.id;
    try { addJob({ ...state.jobs.get(id), state: 'preparing' }); const r = await api('uploads', 'POST', { ...record.config, size: record.file.size, contentType: record.file.type || 'application/octet-stream' });
      const old = state.jobs.get(id); state.jobs.delete(id); state.uploads.delete(id); id = r.id; record.id = id; if (record.epoch !== state.epoch) return;
      state.uploads.set(id, record); addJob({ ...old, id, state: 'running' }); if (record.cancelled) { await api('jobs/' + encodeURIComponent(id) + '/cancel', 'POST'); addJob({ ...state.jobs.get(id), state: 'cancelled' }); return; }
      record.controller = new AbortController();
      // A raw File body streams through the browser without loading its bytes into JS memory.
      const job = await api('uploads/' + encodeURIComponent(id), 'PUT', undefined, { body: record.file, headers: { 'Content-Type': record.file.type || 'application/octet-stream' }, signal: record.controller.signal });
      if (record.epoch === state.epoch) addJob({ ...state.jobs.get(id), ...job, id });
    } catch (e) { if (record.epoch !== state.epoch) return; let actual; if (!id.startsWith('local-') && !record.cancelled) { try { actual = await api('jobs/' + encodeURIComponent(id)); } catch { /* Keep local file references available for retry. */ } } addJob(actual && ['completed', 'partial', 'failed', 'cancelled'].includes(actual.state) ? actual : { ...state.jobs.get(id), state: record.cancelled ? 'cancelled' : 'failed', error: message(e) }); }
    finally { record.controller = null; }
  }
  on('domain', 'input', clearMaps);
  on('searchForm', 'submit', async e => {
    e.preventDefault(); requireProject(); clearMaps(); const version = state.mapVersion; const project = state.project; $('searchMaps').disabled = true; $('mapStatus').textContent = '正在查找全局 URL Map…';
    try { const r = await api('maps?' + query({ project, domain: $('domain').value.trim() })); if (version !== state.mapVersion || project !== state.project) return;
      state.host = r.host || ''; $('cdnHost').value = state.host; if (r.path) $('paths').value = r.path; validatePaths(false);
      $('mapStatus').textContent = r.items?.length ? '找到 ' + r.items.length + ' 个候选，请选择全局 URL Map。' : '没有找到匹配的全局 URL Map，请核对域名和项目权限。'; $('mapChoices').hidden = !r.items?.length;
      for (const map of r.items || []) { const label = node('label', undefined, $('maps'), 'map-option'); const radio = node('input', undefined, label); radio.type = 'radio'; radio.name = 'urlMap'; radio.value = map.name; const content = node('span', undefined, label); node('strong', map.name, content); node('small', 'ID：' + (map.id || '-') + ' · ' + ((map.hosts || []).join('、') || '未返回主机规则'), content); if (map.description) node('small', map.description, content); radio.onchange = () => { state.map = map.name; $('invalidateButton').disabled = !state.host; }; }
    } catch (e) { if (version === state.mapVersion) $('mapStatus').textContent = '查找失败：' + message(e); } finally { $('searchMaps').disabled = false; }
  });
  function validatePaths(strict = true) {
    const paths = [...new Set($('paths').value.split(/\r?\n/).map(x => x.trim()).filter(Boolean))];
    if (paths.length > 100 || paths.some(path => path.length > 1024)) {
      const error = '每次最多提交 100 条路径，每条最多 1024 字符。';
      $('pathError').textContent = error; $('paths').setAttribute('aria-invalid', 'true');
      if (strict) throw new Error(error);
      return [];
    }
    const invalid = paths.find(x => !x.startsWith('/') || /[\s?#\u0000-\u001f]/.test(x) || (x.includes('*') && (x.indexOf('*') !== x.length - 1 || x.indexOf('*') !== x.lastIndexOf('*'))));
    const error = !paths.length ? '请至少输入一条以 / 开头的路径。' : invalid ? '无效路径：' + invalid + '。路径需以 / 开头，不含空格、查询参数或片段；通配符 * 只能位于末尾。' : '';
    $('pathError').textContent = error; $('paths').setAttribute('aria-invalid', String(!!error)); if (strict && error) throw new Error(error); return paths;
  }
  on('paths', 'input', () => validatePaths(false));
  on('invalidateForm', 'submit', e => { e.preventDefault(); requireProject(); if (!state.map || !state.host) throw new Error('请先查找并选择全局 URL Map。'); const paths = validatePaths(); openModal({ action: 'invalidation', project: state.project, map: state.map, host: state.host, paths, reference: crypto.randomUUID() }, '确认缓存失效', '项目：' + state.project + '\n全局 URL Map：' + state.map + '\n主机：' + state.host + '\n共 ' + paths.length + ' 条路径：\n' + paths.join('\n') + '\n已提交的失效操作无法撤回。'); });
  function normalizeJob(job) {
    return { ...job, results: (job.results || []).map(result => ({ ...result, key: result.key || result.path })) };
  }
  function refreshAfterJob(previous, job) {
    if (!previous || previous.state === job.state || active.has(job.state) || job.state === 'queued' || isCdn(job)) return;
    const affected = state.bucket && (state.bucket === job.bucket || state.bucket === job.targetBucket);
    if (!affected || $('fileView').hidden) return;
    clearTimeout(directoryRefreshTimer);
    const bucket = state.bucket, prefix = state.prefix, version = state.projectVersion;
    directoryRefreshTimer = setTimeout(() => {
      if (state.connected && !state.switching && state.bucket === bucket && state.prefix === prefix && state.projectVersion === version && !$('fileView').hidden) void browse();
    }, 350);
  }
  function addJob(job) {
    if (!job?.id) return;
    const previous = state.jobs.get(job.id);
    const next = normalizeJob({ ...previous, ...job });
    state.jobs.set(job.id, next); refreshAfterJob(previous, next); renderJobs();
  }
  const isCdn = job => ['invalidation', 'invalidations', 'invalidate', 'cdn'].includes(job.type) || !!job.map || (job.results || []).some(x => x.operation || x.queryError);
  const failures = job => { const rows = []; if (job.error) rows.push({ key: job.key || job.prefix || '任务', error: job.error }); for (const item of job.results || []) { if (item.error || item.state === 'failed') rows.push({ ...item, category: '操作失败' }); if (item.queryError) rows.push({ ...item, category: '状态查询失败（操作可能仍在执行）', error: item.queryError }); } return rows; };
  const groupKey = job => isCdn(job) ? 'CDN · ' + (job.project || '') + ' · ' + (job.map || '全局 URL Map') + ' · ' + (job.host || '') : 'gs://' + (job.bucket || '未知存储桶') + '/' + (job.prefix ?? parentOf(job.key));
  function button(parent, text, name, fn, key) { const b = node('button', undefined, parent); b.type = 'button'; if (key) b.dataset.focusKey = key; icon(name, b); node('span', ' ' + text, b); b.onclick = guard(async () => { b.disabled = true; try { await fn(); } finally { b.disabled = false; } }); return b; }
  function showFailures(title, jobs) { $('failureTitle').textContent = title; $('failureItems').replaceChildren(); let count = 0;
    for (const job of jobs) for (const item of failures(job)) { count++; const row = node('tr', undefined, $('failureItems')); node('td', item.key || job.key || '-', row); node('td', item.category || '任务失败', row); node('td', typeof item.operation === 'object' ? item.operation.name || item.operation.id || '-' : item.operation || '-', row); node('td', message(item.error || '操作失败'), row); }
    $('failureSummary').textContent = count + ' 条错误记录。状态查询失败不代表已提交的云端操作失败，可继续查询。'; $('failureDialog').showModal();
  }
  function renderResults(parent, job) {
    const groups = new Map(); for (const item of job.results || []) { const folder = isCdn(job) ? '' : parentOf(item.key) || '根目录'; if (!groups.has(folder)) groups.set(folder, []); groups.get(folder).push(item); }
    for (const [folder, results] of groups) { let box = parent; if (folder) { const d = node('details', undefined, parent, 'result-folder'); d.dataset.detailKey = job.id + ':' + folder; node('summary', folder + ' · ' + results.length + ' 项', d); box = node('div', undefined, d); }
      for (const r of results) { const row = node('div', undefined, box, 'result-row'); node('span', r.key || job.key || '-', row); node('span', labels[r.state] || r.state || '等待结果', row); if (r.operation) node('small', '已提交操作 ID：' + (typeof r.operation === 'object' ? r.operation.name || r.operation.id || JSON.stringify(r.operation) : r.operation), row); if (r.error) node('small', '操作失败：' + message(r.error), row, 'warning'); if (r.queryError) node('small', '状态查询失败：' + message(r.queryError) + '。已提交的操作仍可能执行中。', row, 'warning'); }
    }
  }
  function renderJobs() {
    const opened = new Set([...$('tasks').querySelectorAll('details[open]')].map(x => x.dataset.detailKey)); const focusKey = $('tasks').contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
    const groups = new Map(); for (const job of state.jobs.values()) { const key = groupKey(job); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(job); }
    $('tasks').replaceChildren(); $('jobStatus').textContent = state.jobs.size ? state.jobs.size + ' 个任务 · ' + [...state.jobs.values()].filter(x => active.has(x.state) || x.state === 'queued').length + ' 个执行中' : '暂无任务。';
    for (const [title, jobs] of groups) { const group = node('details', undefined, $('tasks'), 'task-group'); group.dataset.detailKey = title; group.open = opened.has(title); const summary = node('summary', undefined, group); summary.dataset.focusKey = title; node('strong', title, summary); const errors = jobs.reduce((sum, x) => sum + failures(x).length, 0);
      const success = jobs.filter(job => job.state === 'completed').length;
      const failed = jobs.filter(job => ['failed', 'partial'].includes(job.state)).length;
      const skipped = jobs.filter(job => job.state === 'skipped').length;
      const running = jobs.filter(job => active.has(job.state) || job.state === 'queued').length;
      const preparing = jobs.filter(job => job.state === 'preparing').length;
      const waiting = jobs.filter(job => job.state === 'waiting').length;
      const cancelled = jobs.filter(job => job.state === 'cancelled').length;
      node('span', jobs.length + ' 个任务 · 成功 ' + success + ' · 失败 ' + failed + ' · 跳过 ' + skipped + ' · 执行中 ' + running + (preparing ? ' · 等待文件 ' + preparing : '') + (waiting ? ' · 待查询 ' + waiting : '') + (cancelled ? ' · 已取消 ' + cancelled : '') + (errors ? ' · 错误记录 ' + errors : ''), summary);
      const uploads = jobs.filter(job => job.type === 'upload');
      if (uploads.length) {
        let totalBytes = 0, loadedBytes = 0;
        for (const job of uploads) {
          const total = Number(job.size ?? state.uploads.get(job.id)?.file?.size ?? job.total) || 0;
          totalBytes += total;
          loadedBytes += job.state === 'completed' ? total : Math.min(total, Number(job.loaded) || 0);
        }
        const uploadProgress = node('progress', undefined, summary, 'group-progress');
        uploadProgress.max = totalBytes || 1; uploadProgress.value = totalBytes ? loadedBytes : uploads.every(job => job.state === 'completed') ? 1 : 0;
        uploadProgress.setAttribute('aria-label', '文件夹总上传进度');
        node('small', '上传 ' + size(loadedBytes) + ' / ' + size(totalBytes) + ' · ' + Math.round(uploadProgress.value / uploadProgress.max * 100) + '%', summary, 'group-upload-status');
      }
      const controls = node('div', undefined, group, 'job-actions'); if (errors) button(controls, '查看全部失败项', 'list', () => showFailures(title, jobs), title + ':failures');
      const lostUploads = jobs.filter(x => x.type === 'upload' && x.state === 'preparing' && !state.uploads.get(x.id)?.file);
      if (lostUploads.length) {
        node('small', lostUploads.length + ' 个上传已登记，但本机文件未随会话恢复；可取消旧任务并重新选择文件。', group, 'warning');
        button(controls, '取消未开始上传', 'ban', async () => { for (const job of lostUploads) await api('jobs/' + encodeURIComponent(job.id) + '/cancel', 'POST'); for (const job of lostUploads) addJob({ ...job, state: 'cancelled' }); }, title + ':cancel-orphans');
        button(controls, '选择文件', 'file-plus', () => { retryContext = lostUploads; $('retryFiles').click(); });
        button(controls, '选择文件夹', 'folder-open', () => { retryContext = lostUploads; $('retryFolder').click(); });
      }
      const failedUploads = jobs.filter(x => x.type === 'upload' && ['failed', 'partial'].includes(x.state));
      if (failedUploads.length) { button(controls, '重试失败文件', 'rotate-cw', () => retryUploads(failedUploads), title + ':retry'); if (failedUploads.some(x => !state.uploads.get(x.id)?.file)) { button(controls, '重新选择文件', 'file-plus', () => { retryContext = failedUploads; $('retryFiles').click(); }); button(controls, '重新选择文件夹', 'folder-open', () => { retryContext = failedUploads; $('retryFolder').click(); }); } }
      for (const job of jobs) { const box = node('article', undefined, group, 'job'); const heading = node('div', undefined, box, 'job-heading'); node('strong', (actionNames[job.type] || job.type || '任务') + (job.key ? ' · ' + job.key : ''), heading); node('span', labels[job.state] || job.state || '等待结果', heading);
        const progress = node('progress', undefined, box);
        const byteProgress = job.type === 'upload' && job.loaded !== undefined;
        progress.max = Math.max(Number(job.total) || 1, Number(job.done) || 0);
        progress.value = byteProgress ? Number(job.loaded) || 0 : Number(job.done) || 0;
        if (job.state === 'completed') progress.value = progress.max;
        progress.setAttribute('aria-label', '任务进度');
        node('small', (byteProgress ? size(job.loaded) + ' / ' + size(job.total) : (job.done || 0) + ' / ' + (job.total || 0)) + ' · 任务 ' + job.id, box);
        if (job.error) node('p', message(job.error), box, 'warning');
        if (job.type === 'upload' && job.state === 'preparing' && !state.uploads.get(job.id)?.file) node('p', '等待上传文件数据；此文件无法从浏览器会话恢复。请选择“取消未开始上传”或重新选择文件。', box, 'warning');
        const controls = node('div', undefined, box, 'job-actions'); if (failures(job).length) button(controls, '失败详情', 'circle-alert', () => showFailures('任务失败详情', [job]), job.id + ':failure');
        if (isCdn(job) && (job.state === 'waiting' || ['cancelled', 'partial'].includes(job.state) && (job.results || []).some(x => x.queryError || x.state === 'submitted' || x.state === 'pending'))) button(controls, '继续查询', 'refresh-cw', async () => { await api('jobs/' + encodeURIComponent(job.id) + '/resume', 'POST'); addJob({ ...job, state: 'running' }); await refreshJob(job.id); }, job.id + ':resume');
        if (active.has(job.state) || job.state === 'queued' || job.state === 'waiting') button(controls, isCdn(job) ? '停止查询' : '取消任务', 'square', () => cancelJob(job), job.id + ':cancel');
        renderResults(node('div', undefined, box, 'job-results'), job);
        if (job.type === 'upload' && job.state === 'preparing' && !state.uploads.get(job.id)?.file) {
          const recovery = node('div', undefined, box, 'job-actions');
          button(recovery, '取消未开始上传', 'ban', async () => { await api('jobs/' + encodeURIComponent(job.id) + '/cancel', 'POST'); addJob({ ...job, state: 'cancelled' }); }, job.id + ':cancel-orphan');
          button(recovery, '重新选择文件', 'file-plus', () => { retryContext = [job]; $('retryFiles').click(); }, job.id + ':select-file');
          button(recovery, '重新选择文件夹', 'folder-open', () => { retryContext = [job]; $('retryFolder').click(); }, job.id + ':select-folder');
        }
      }
    }
    for (const d of $('tasks').querySelectorAll('details')) if (opened.has(d.dataset.detailKey)) d.open = true;
    if (focusKey) [...$('tasks').querySelectorAll('[data-focus-key]')].find(x => x.dataset.focusKey === focusKey)?.focus({ preventScroll: true }); icons();
  }
  async function cancelJob(job) { if (!confirm(isCdn(job) ? '停止本地查询？已提交的云端失效操作仍会继续执行。' : '取消尚未完成的工作？已完成的操作不会撤销。')) return; const record = state.uploads.get(job.id); if (record) { record.cancelled = true; record.controller?.abort(); } if (!String(job.id).startsWith('local-')) await api('jobs/' + encodeURIComponent(job.id) + '/cancel', 'POST'); addJob({ ...job, state: 'cancelled' }); }
  function retryUploads(jobs, files) {
    const selected = []; let missing = 0; const first = jobs[0]; const prefix = first.prefix ?? parentOf(first.key);
    for (const job of jobs) {
      const relative = job.key?.startsWith(prefix) ? job.key.slice(prefix.length) : job.key;
      const record = state.uploads.get(job.id);
      let matches = files?.filter(x => x.path === relative || x.path.endsWith('/' + relative));
      if (!matches?.length) matches = files?.filter(x => job.key?.endsWith('/' + x.path));
      const file = record?.file || (matches?.length === 1 ? matches[0].file : null);
      if (file) selected.push({ file, path: job.state === 'preparing' ? relative || file.name : relative || file.name }); else missing++;
    }
    if (missing) notice(missing + ' 个失败文件需要重新选择原始文件或文件夹。刷新页面后浏览器不会保留本地文件内容。');
    const replacements = jobs.filter(job => job.state === 'preparing' && selected.some(item => item.path === (job.key?.startsWith(prefix) ? job.key.slice(prefix.length) : job.key)));
    if (selected.length) confirmUpload([...new Map(selected.map(x => [x.path, x])).values()], { bucket: first.bucket, prefix }, replacements); else if (!files) { retryContext = jobs; $('retryFiles').click(); }
  }
  for (const id of ['retryFiles', 'retryFolder']) on(id, 'change', () => { const files = picked($(id).files); $(id).value = ''; const jobs = retryContext; retryContext = null; if (files.length && jobs) retryUploads(jobs, files); });
  async function refreshJob(id) { const epoch = state.epoch; const job = await api('jobs/' + encodeURIComponent(id)); if (epoch === state.epoch && state.connected) addJob(job); }
  async function refreshJobs() {
    const epoch = state.epoch; const r = await api('jobs'); if (epoch !== state.epoch || !state.connected) return;
    for (const job of r.items || []) { const previous = state.jobs.get(job.id); const next = normalizeJob({ ...previous, ...job }); state.jobs.set(job.id, next); refreshAfterJob(previous, next); }
    renderJobs();
  }
  function startPolling() {
    clearTimeout(state.timer); const poll = async () => { if (!state.connected) return;
      const ids = [...state.jobs.values()].filter(x => active.has(x.state) && !String(x.id).startsWith('local-')).map(x => x.id); const results = await Promise.allSettled(ids.map(refreshJob)); const failure = results.find(x => x.status === 'rejected'); if (failure) $('jobStatus').textContent = '任务状态暂时无法更新：' + message(failure.reason) + '。将自动重试。';
      if (state.connected) state.timer = setTimeout(poll, 1800);
    }; state.timer = setTimeout(poll, 500);
  }
  on('refreshJobs', 'click', async () => { $('refreshJobs').disabled = true; try { await refreshJobs(); } finally { $('refreshJobs').disabled = false; } });
  on('disconnect', 'click', async () => { if (!confirm('断开 GCP 连接并停止待执行工作？已提交的云端 CDN 操作仍可能继续执行。')) return; $('disconnect').disabled = true;
    try { await api('disconnect', 'POST'); state.epoch++; state.projectVersion++; state.browseVersion++; clearTimeout(state.timer); for (const record of state.uploads.values()) { record.cancelled = true; record.controller?.abort(); } state.queue = []; state.jobs.clear(); state.uploads.clear(); state.project = ''; state.bucket = ''; state.prefix = ''; state.buckets = []; state.items = []; state.selected.clear(); clearMaps(); try { sessionStorage.removeItem('gcp-view'); } catch { /* Browser storage is optional. */ } connected(false); $('credentialFile').value = ''; notice('已断开连接。'); }
    finally { $('disconnect').disabled = false; }
  });
  window.addEventListener('beforeunload', e => { if (state.queue.length || state.workers) { e.preventDefault(); e.returnValue = ''; } });
  async function init() { icons(); try { const session = await api('session'); if (session.connected) await activate(session, true); else connected(false); } catch (e) { if (!state.connected) connected(false); notice('恢复会话失败：' + message(e)); } }
  init();
})();
