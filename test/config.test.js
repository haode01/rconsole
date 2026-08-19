'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { load, resolveExecCommand } = require('../src/config');

test('defaults provide three listeners on 9000/9001/9002', () => {
  const c = load({});
  assert.deepStrictEqual(
    c.listeners.map((l) => [l.mode, l.port]),
    [['shell', 9000], ['exec', 9001], ['service', 9002]],
  );
  assert.strictEqual(c.shell.windows, 'cmd.exe');
  assert.strictEqual(c.shell.linux, 'bash');
});

test('CLI port overrides update the matching listener', () => {
  const c = load({ port: 7000, execPort: 7001, servicePort: 7002 });
  const byMode = Object.fromEntries(c.listeners.map((l) => [l.mode, l.port]));
  assert.strictEqual(byMode.shell, 7000);
  assert.strictEqual(byMode.exec, 7001);
  assert.strictEqual(byMode.service, 7002);
});

test('CLI host applies to every listener', () => {
  const c = load({ host: '127.0.0.1' });
  assert.ok(c.listeners.every((l) => l.host === '127.0.0.1'));
});

test('CLI shell override targets the current platform', () => {
  const c = load({ shell: 'zsh' });
  if (process.platform === 'win32') {
    assert.strictEqual(c.shell.windows, 'zsh');
  } else {
    assert.strictEqual(c.shell.linux, 'zsh');
  }
});

test('duplicate service names are rejected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-'));
  const f = path.join(dir, 'c.json');
  fs.writeFileSync(f, JSON.stringify({
    services: [{ name: 'a', command: 'x' }, { name: 'a', command: 'y' }],
  }));
  assert.throws(() => load({ configPath: f }), /duplicate service/);
});

test('port out of range is rejected', () => {
  assert.throws(() => load({ port: 70000 }), /port out of range/);
});

test('auth enabled without token is rejected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-'));
  const f = path.join(dir, 'c.json');
  fs.writeFileSync(f, JSON.stringify({ auth: { enabled: true, token: null } }));
  assert.throws(() => load({ configPath: f }), /auth/);
});

test('resolveExecCommand wraps input with -c on linux/macos', () => {
  const c = load({});
  const spec = resolveExecCommand(c, 'echo hi');
  assert.strictEqual(typeof spec.file, 'string');
  if (process.platform === 'win32') {
    assert.ok(spec.args.includes('echo hi'));
  } else {
    assert.deepStrictEqual(spec.args, ['-c', 'echo hi']);
  }
});
