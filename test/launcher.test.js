import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openSync, closeSync, readFileSync } from 'node:fs';
import net from 'node:net';

test('Windows launcher starts, reuses, restarts, and rejects unrelated listeners', { skip: process.platform !== 'win32', timeout: 120000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'aws-tool-launcher-'));
  const pids = new Set();
  const blocker = net.createServer();
  const launch = (port, restart = false) => {
    // Detached servers can retain pipe handles; capture launcher output in a file.
    const outputPath = path.join(root, 'launcher-output.log');
    const output = openSync(outputPath, 'w');
    let result;
    try { result = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    "& ([scriptblock]::Create([IO.File]::ReadAllText((Join-Path (Get-Location) 'launcher.ps1'), [Text.Encoding]::UTF8))) -NoBrowser -Yes" + (restart ? ' -Restart' : ''),
    ], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', output, output], timeout: 40000 });
    } finally { closeSync(output); }
    return { ...result, stdout: readFileSync(outputPath, 'utf8'), stderr: result.error?.message || '' };
  };
  try {
    await copyFile(new URL('../launcher.ps1', import.meta.url), path.join(root, 'launcher.ps1'));
    await mkdir(path.join(root, 'node_modules/@aws-sdk/client-s3'), { recursive: true });
    await writeFile(path.join(root, 'node_modules/@aws-sdk/client-s3/package.json'), '{}');
    for (const dependency of ['@google-cloud/storage', 'google-auth-library']) {
      await mkdir(path.join(root, 'node_modules', dependency), { recursive: true });
      await writeFile(path.join(root, 'node_modules', dependency, 'package.json'), '{}');
    }
    await writeFile(path.join(root, 'server.js'), "require('node:http').createServer((req,res)=>res.end(String(process.pid))).listen(Number(process.env.PORT),'127.0.0.1');");
    await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
    const port = blocker.address().port;
    await new Promise(resolve => blocker.close(resolve));
    const first = launch(port);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const firstPid = Number(await (await fetch(`http://127.0.0.1:${port}`)).text());
    pids.add(firstPid);
    const second = launch(port);
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.equal(Number(await (await fetch(`http://127.0.0.1:${port}`)).text()), firstPid);
    const restarted = launch(port, true);
    assert.equal(restarted.status, 0, restarted.stdout + restarted.stderr);
    const newPid = Number(await (await fetch(`http://127.0.0.1:${port}`)).text());
    pids.delete(firstPid);
    pids.add(newPid);
    assert.notEqual(newPid, firstPid);
    await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
    const rejected = launch(blocker.address().port, true);
    assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
    assert.equal(blocker.listening, true);
  } finally {
    if (blocker.listening) await new Promise(resolve => blocker.close(resolve));
    for (const pid of pids) { try { process.kill(pid); } catch {} }
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('aws-tool-launcher-'));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
