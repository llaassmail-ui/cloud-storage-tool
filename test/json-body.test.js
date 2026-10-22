import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../server.js';

test('JSON request decoding preserves a UTF-8 filename split across network chunks', async t => {
  let received;
  const server = createServer(() => ({ buckets: async () => [], distributionList: async () => [], close: async () => {}, createFolder: async (_, key) => { received = key; } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const login = await fetch(origin + '/api/connect', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ accessKeyId: 'mock', secretAccessKey: 'mock' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const bytes = Buffer.from(JSON.stringify({ bucket: 'mock-bucket', key: '中文 空格\"#/' }));
  const split = bytes.indexOf(Buffer.from('中')) + 1;
  await new Promise((resolve, reject) => {
    const req = http.request(origin + '/api/folders', { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' } }, res => {
      res.resume(); res.on('end', () => { try { assert.equal(res.statusCode, 201); resolve(); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.write(bytes.subarray(0, split));
    setTimeout(() => req.end(bytes.subarray(split)), 20);
  });
  assert.equal(received, '中文 空格\"#/');
});
