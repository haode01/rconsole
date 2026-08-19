'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { ServiceRegistry, substitute, buildArrayCommand } = require('../src/services');
const { load } = require('../src/config');

test('substitute replaces {args} and appends when absent', () => {
  assert.strictEqual(substitute('echo {args}', ['a', 'b']), 'echo a b');
  assert.strictEqual(substitute('echo fixed', ['x']), 'echo fixed x');
  assert.strictEqual(substitute('echo fixed', []), 'echo fixed');
});

test('buildArrayCommand expands {args} element and appends trailing args', () => {
  assert.deepStrictEqual(buildArrayCommand(['echo', '{args}'], ['a', 'b']), ['echo', 'a', 'b']);
  assert.deepStrictEqual(buildArrayCommand(['echo', '--x={args}'], ['v']), ['echo', '--x=v']);
  assert.deepStrictEqual(buildArrayCommand(['ls'], ['-l']), ['ls', '-l']);
});

test('resolve handles builtins, unknown names and args range', () => {
  const reg = new ServiceRegistry(load({}));
  assert.deepStrictEqual(reg.resolve('list'), { builtin: 'list' });
  assert.ok(reg.resolve('nope').error.includes('unknown service'));

  const cfg = load({});
  cfg.services = [{ name: 's', command: 'echo {args}', args: { min: 1, max: 2 } }];
  const reg2 = new ServiceRegistry(cfg);
  assert.ok(reg2.resolve('s').error); // 0 args < min
  assert.strictEqual(reg2.resolve('s a').args.length, 1);
  assert.ok(reg2.resolve('s a b c').error); // 3 args > max
});

test('run a preset service and capture its output', async () => {
  const cfg = load({});
  cfg.services = [{ name: 'hello', command: 'echo {args}', args: { min: 1, max: 5 } }];
  const reg = new ServiceRegistry(cfg);
  let out = '';
  const { code } = await reg.run('hello world', (b) => { out += b.toString('utf8'); });
  assert.strictEqual(code, 0);
  assert.ok(out.includes('world'));
});

test('run the builtin list service', async () => {
  const cfg = load({});
  cfg.services = [{ name: 'a', command: 'echo a', description: 'A svc' }];
  const reg = new ServiceRegistry(cfg);
  let out = '';
  await reg.run('list', (b) => { out += b.toString('utf8'); });
  assert.ok(out.includes('a'));
  assert.ok(out.includes('A svc'));
});

test('unknown service returns a non-zero exit code', async () => {
  const reg = new ServiceRegistry(load({}));
  let out = '';
  const { code } = await reg.run('does-not-exist', (b) => { out += b.toString('utf8'); });
  assert.strictEqual(code, 1);
  assert.ok(out.includes('unknown service'));
});
