#!/usr/bin/env node
'use strict';

const { load } = require('../src/config');
const { RConsoleServer } = require('../src/server');
const pkg = require('../package.json');

function printHelp() {
  const out = `
rconsole ${pkg.version} — cross-platform remote console server (server side only)

The operator connects with a plain telnet/nc client. No custom client is needed.

Usage:
  rconsole [options]

Options:
  --config <file>        JSON config file (see config.example.json)
  --host <addr>          bind host for all listeners (default 0.0.0.0)
  --port <n>             port for the interactive shell listener (default 9000)
  --exec-port <n>        port for one-shot command execution (default 9001)
  --service-port <n>     port for preset services (default 9002)
  --shell <cmd>          shell executable for this platform (cmd.exe / powershell.exe / bash)
  --auth <token>         enable token auth with this token (off by default)
  --banner <text>        connection banner ({hostname} is substituted)
  --log <file>           also append log lines to this file
  -h, --help             show this help
  -v, --version          show version

Examples:
  rconsole --port 9000
  rconsole --config ./config.example.json
  rconsole --shell powershell.exe --port 9000 --service-port 9002

Client usage (from any machine):
  telnet <host> 9000                 # interactive shell
  echo 'ipconfig' | nc <host> 9001   # one-shot arbitrary command
  echo 'status' | nc <host> 9002     # run preset service "status"
  echo 'list'   | nc <host> 9002     # list preset services
`;
  process.stdout.write(out.trimEnd() + '\n');
}

function parseArgs(argv) {
  const opts = {};
  const next = (i) => {
    if (i + 1 >= argv.length) throw new Error(`missing value for ${argv[i]}`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--config': opts.configPath = next(i); i += 1; break;
      case '--host': opts.host = next(i); i += 1; break;
      case '--port': opts.port = parseInt(next(i), 10); i += 1; break;
      case '--exec-port': opts.execPort = parseInt(next(i), 10); i += 1; break;
      case '--service-port': opts.servicePort = parseInt(next(i), 10); i += 1; break;
      case '--shell': opts.shell = next(i); i += 1; break;
      case '--auth': opts.auth = next(i); i += 1; break;
      case '--banner': opts.banner = next(i); i += 1; break;
      case '--log': opts.log = next(i); i += 1; break;
      case '-h':
      case '--help': opts.help = true; break;
      case '-v':
      case '--version': opts.version = true; break;
      default: throw new Error(`unknown argument: ${a}`);
    }
  }
  return opts;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    printHelp();
    process.exit(2);
  }

  if (opts.help) { printHelp(); return; }
  if (opts.version) { process.stdout.write(pkg.version + '\n'); return; }

  let config;
  try {
    config = load(opts);
  } catch (err) {
    process.stderr.write(`config error: ${err.message}\n`);
    process.exit(1);
  }

  const server = new RConsoleServer(config);
  try {
    await server.start();
  } catch (err) {
    process.stderr.write(`failed to start: ${err.message}\n`);
    process.exit(1);
  }

  const shutdown = () => {
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
