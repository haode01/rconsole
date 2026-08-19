'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_CONFIG = {
  listeners: [
    { name: 'shell', mode: 'shell', host: '0.0.0.0', port: 9000 },
    { name: 'exec', mode: 'exec', host: '0.0.0.0', port: 9001 },
    { name: 'service', mode: 'service', host: '0.0.0.0', port: 9002 },
  ],
  shell: {
    windows: 'cmd.exe',
    windowsArgs: [],
    linux: 'bash',
    linuxArgs: [],
    env: {},
    cwd: null,
    cols: 80,
    rows: 24,
    codepageUtf8: true,
    idleTimeoutSeconds: 0,
    maxSessions: 0,
  },
  exec: {
    maxInputBytes: 65536,
    timeoutSeconds: 0,
    windowsHide: true,
  },
  services: [],
  banner: 'rconsole: connected to {hostname}\r\n',
  auth: { enabled: false, token: null },
  log: { file: null, level: 'info' },
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(target, ...sources) {
  const out = Array.isArray(target) ? target.slice() : { ...target };
  for (const src of sources) {
    if (!isPlainObject(src)) continue;
    for (const key of Object.keys(src)) {
      const sv = src[key];
      if (isPlainObject(sv) && isPlainObject(out[key])) {
        out[key] = deepMerge(out[key], sv);
      } else {
        out[key] = sv;
      }
    }
  }
  return out;
}

function readJsonFile(p) {
  const abs = path.resolve(p);
  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    throw new Error(`cannot read config file "${abs}": ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid JSON in config file "${abs}": ${err.message}`);
  }
}

/**
 * Convert parsed CLI flags into config-shaped overrides.
 * cli = { host, port, execPort, servicePort, shell, auth, banner, log, config }
 */
function cliOverrides(cli) {
  const o = {};
  if (cli.host) o.host = cli.host;
  if (cli.banner) o.banner = cli.banner;
  if (cli.log) o.log = { file: cli.log };
  if (cli.auth) o.auth = { enabled: true, token: cli.auth };

  // shell executable override applies to the current platform only.
  if (cli.shell) {
    o.shell = process.platform === 'win32'
      ? { windows: cli.shell }
      : { linux: cli.shell };
  }

  o._cliPorts = {};
  if (cli.port !== undefined) o._cliPorts.shell = cli.port;
  if (cli.execPort !== undefined) o._cliPorts.exec = cli.execPort;
  if (cli.servicePort !== undefined) o._cliPorts.service = cli.servicePort;

  return o;
}

function applyCliPorts(config) {
  const ports = config._cliPorts || {};
  delete config._cliPorts;
  const listeners = config.listeners.slice();
  for (const mode of Object.keys(ports)) {
    const port = ports[mode];
    if (port === undefined || port === null) continue;
    const idx = listeners.findIndex((l) => l.mode === mode);
    if (idx >= 0) {
      listeners[idx] = { ...listeners[idx], port };
    } else {
      listeners.push({ name: mode, mode, host: config.host || '0.0.0.0', port });
    }
  }
  config.listeners = listeners;
  return config;
}

function assertInt(v, label) {
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new Error(`${label} must be an integer (got ${JSON.stringify(v)})`);
  }
}

function validate(config) {
  if (!Array.isArray(config.listeners) || config.listeners.length === 0) {
    throw new Error('at least one listener is required');
  }
  const seenNames = new Set();
  for (const l of config.listeners) {
    if (!['shell', 'exec', 'service'].includes(l.mode)) {
      throw new Error(`unknown listener mode: ${JSON.stringify(l.mode)}`);
    }
    assertInt(l.port, `listener "${l.name}" port`);
    if (l.port < 1 || l.port > 65535) {
      throw new Error(`listener "${l.name}" port out of range: ${l.port}`);
    }
    if (l.name && seenNames.has(l.name)) {
      throw new Error(`duplicate listener name: ${l.name}`);
    }
    seenNames.add(l.name || l.mode);
  }

  if (!config.shell || typeof config.shell.windows !== 'string' || typeof config.shell.linux !== 'string') {
    throw new Error('shell.windows and shell.linux must be strings');
  }

  if (!Array.isArray(config.services)) {
    throw new Error('services must be an array');
  }
  const svcNames = new Set();
  for (const s of config.services) {
    if (!s || typeof s.name !== 'string' || s.name.trim() === '') {
      throw new Error('every service needs a non-empty string "name"');
    }
    if (svcNames.has(s.name)) {
      throw new Error(`duplicate service name: ${s.name}`);
    }
    svcNames.add(s.name);
    const ok = typeof s.command === 'string'
      || (Array.isArray(s.command) && s.command.every((x) => typeof x === 'string'));
    if (!ok) {
      throw new Error(`service "${s.name}" command must be a string or an array of strings`);
    }
    if (s.args) {
      assertInt(s.args.min, `service "${s.name}" args.min`);
      assertInt(s.args.max, `service "${s.name}" args.max`);
      if (s.args.min < 0 || s.args.max < s.args.min) {
        throw new Error(`service "${s.name}" invalid args range`);
      }
    }
  }

  if (config.auth && config.auth.enabled && !config.auth.token) {
    throw new Error('auth.enabled is true but auth.token is empty');
  }
  return config;
}

function load(opts = {}) {
  const fileCfg = opts.configPath ? readJsonFile(opts.configPath) : {};
  const overrides = cliOverrides(opts);
  let config = deepMerge({}, DEFAULT_CONFIG, fileCfg, overrides);
  // --host from CLI applies to every listener for convenience.
  if (opts.host) {
    config.listeners = config.listeners.map((l) => ({ ...l, host: opts.host }));
  }
  config = applyCliPorts(config);
  return validate(config);
}

/** Return the shell executable + args for the current platform. */
function resolveShell(config) {
  if (process.platform === 'win32') {
    return { file: config.shell.windows, args: config.shell.windowsArgs || [] };
  }
  return { file: config.shell.linux, args: config.shell.linuxArgs || [] };
}

const WINDOWS_POWERSHELL = /(powershell|pwsh)(\.exe)?$/i;

/** Build {file, args} to execute a one-shot command string (exec mode). */
function resolveExecCommand(config, input) {
  const { file, args } = resolveShell(config);
  if (process.platform === 'win32') {
    if (WINDOWS_POWERSHELL.test(file)) {
      return { file, args: ['-NoLogo', '-NoProfile', '-Command', input] };
    }
    return { file, args: ['/d', '/s', '/c', input] };
  }
  return { file, args: ['-c', input] };
}

function renderBanner(config) {
  const banner = config.banner || '';
  return banner.replace(/\{hostname\}/g, os.hostname());
}

module.exports = {
  DEFAULT_CONFIG,
  load,
  validate,
  resolveShell,
  resolveExecCommand,
  renderBanner,
  deepMerge,
};
