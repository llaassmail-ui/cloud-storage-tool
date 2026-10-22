// Only imported by local browser tests; never used by the production server.
export function browserGCP() {
  return {
    authenticate: async () => {},
    projects: async () => [{ id: 'demo-project', name: 'Browser test project' }],
    buckets: async () => [{ name: 'gcp-browser-bucket', region: 'ASIA-SOUTH1' }],
    list: async (_, prefix = '', token) => ({
      folders: prefix ? [] : [{ key: 'assets/', folder: true }],
      files: [{ key: prefix + (token ? 'page-two.txt' : '中文 空格"#.txt'), size: 12, modified: '2026-10-22T10:00:00Z', generation: '123' }], token: prefix || token ? null : 'next'
    }),
    snapshot: async (_, selected) => selected.flatMap(item => item.folder ? [{ key: item.key + 'ok.txt', generation: '123' }, { key: item.key + 'denied.txt', generation: '124' }] : [{ key: item.key, generation: '123' }]),
    head: async () => null,
    copy: async (_, key) => { if (key.includes('denied')) throw Object.assign(new Error('Simulated permission denied'), { code: 403 }); },
    remove: async () => {}, createFolder: async () => {}, close: async () => {},
    upload: async (_, key, stream, size, type, progress) => {
      let bytes = 0; for await (const chunk of stream) { bytes += chunk.length; progress(bytes); }
      if (key.includes('denied')) throw Object.assign(new Error('Simulated public access prevention'), { code: 403 });
    },
    maps: async () => [{ name: 'demo-map', id: '456', hosts: ['cdn.example.com'], description: 'Simulated global URL map' }, { name: 'wildcard-map', id: '457', hosts: ['*.example.com'] }],
    invalidate: async (_, map, options) => ({ name: 'operation-' + map + '-' + options.path.replaceAll('/', '-'), status: 'PENDING' }),
    operation: async (_, id) => ({ name: id, status: 'DONE' })
  };
}
