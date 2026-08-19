'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const net = require('net');
const { load } = require('../src/config');
const { RConsoleServer } = require('../src/server');

let server;
let shellPort;
let execPort;
let servicePort;

function getFreePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function waitFor(cond, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (cond()) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        reject(new Error('waitFor timeout'));
      }
    }, 20);
  });
}

/** Write a payload then half-close; resolve with all received output once closed. */
function oneShot(port, payload, halfClose = true) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const chunks = [];
    socket.on('data', (d) => chunks.push(d));
    const finish = () => resolve(Buffer.concat(chunks).toString('utf8'));
    socket.on('end', finish);
    socket.on('close', finish);
    socket.on('error', reject);
    socket.on('connect', () => {
      socket.write(payload);
      if (halfClose) socket.end();
    });
    setTimeout(() => { socket.destroy(); reject(new Error('oneShot timeout')); }, 5000);
  });
}

before(async () => {
  shellPort = await getFreePort();
  execPort = await getFreePort();
  servicePort = await getFreePort();

  const config = load({ host: '127.0.0.1', port: shellPort, execPort, servicePort });
  config.services = [
    { name: 'greet', command: 'echo hello-from-service', args: { min: 0, max: 0 } },
    { name: 'echo', command: 'echo {args}', args: { min: 1, max: 5 } },
  ];
  config.banner = 'rconsole: test banner {hostname}\r\n';

  server = new RConsoleServer(config);
  await server.start();
});

after(() => {
  if (server) server.close();
});

test('shell mode: banner + interactive command', async () => {
  const socket = net.connect(shellPort, '127.0.0.1');
  let out = '';
  socket.on('data', (d) => { out += d.toString('utf8'); });
  socket.on('error', () => {});
  await new Promise((res) => socket.on('connect', res));

  await waitFor(() => out.includes('rconsole: test banner'));
  socket.write('echo __RCSHELL_OK__\n');
  await waitFor(() => out.includes('__RCSHELL_OK__'));
  socket.write('exit\n');
  await new Promise((res) => socket.on('close', res));
  socket.destroy();
});

test('exec mode: one-shot command with clean output', async () => {
  const out = await oneShot(execPort, 'echo __RCEXEC_OK__\n');
  assert.ok(out.includes('__RCEXEC_OK__'));
});

test('service mode: preset service returns output + exit code', async () => {
  const out = await oneShot(servicePort, 'greet\n', false);
  assert.ok(out.includes('hello-from-service'));
  assert.ok(out.includes('[exit: 0]'));
});

test('service mode: args are substituted into the command', async () => {
  const out = await oneShot(servicePort, 'echo hello args\n', false);
  assert.ok(out.includes('hello args'));
});

test('service mode: unknown service lists available services', async () => {
  const out = await oneShot(servicePort, 'nope\n', false);
  assert.ok(out.includes('unknown service: nope'));
  assert.ok(out.includes('greet'));
});

test('service mode: builtin list shows services', async () => {
  const out = await oneShot(servicePort, 'list\n', false);
  assert.ok(out.includes('available services'));
  assert.ok(out.includes('greet'));
});

test('auth: wrong token rejected, correct token proceeds', async () => {
  const port = await getFreePort();
  const cfg = load({ host: '127.0.0.1', port: await getFreePort(), execPort: port, servicePort: await getFreePort() });
  cfg.auth = { enabled: true, token: 'secret123' };
  const srv = new RConsoleServer(cfg);
  await srv.start();
  try {
    const bad = await oneShot(port, 'wrongtoken\n', false);
    assert.ok(bad.includes('auth failed'));

    const good = await oneShot(port, 'secret123\necho __AUTH_OK__\n', true);
    assert.ok(good.includes('__AUTH_OK__'));
  } finally {
    srv.close();
  }
});

test('concurrent shell sessions are isolated', async () => {
  const open = (marker) => new Promise((resolve, reject) => {
    const socket = net.connect(shellPort, '127.0.0.1');
    let out = '';
    socket.on('data', (d) => { out += d.toString('utf8'); });
    socket.on('error', () => {});
    socket.on('connect', () => {
      (async () => {
        try {
          await waitFor(() => out.includes('rconsole: test banner'));
          socket.write(`echo ${marker}\n`);
          await waitFor(() => out.includes(marker));
          resolve(out);
          socket.write('exit\n');
          socket.destroy();
        } catch (e) { reject(e); }
      })();
    });
  });

  const [a, b] = await Promise.all([open('AAA_SESSION'), open('BBB_SESSION')]);
  assert.ok(a.includes('AAA_SESSION') && !a.includes('BBB_SESSION'));
  assert.ok(b.includes('BBB_SESSION') && !b.includes('AAA_SESSION'));
});
