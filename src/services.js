'use strict';

const { spawn } = require('child_process');
const { resolveExecCommand } = require('./config');

const BUILTINS = new Set(['list', 'help', '?']);

function substitute(template, args) {
  const joined = args.join(' ');
  if (template.includes('{args}')) {
    return template.split('{args}').join(joined);
  }
  return args.length ? `${template} ${joined}`.trim() : template;
}

function buildArrayCommand(cmd, args) {
  const joined = args.join(' ');
  let hasPlaceholder = false;
  const out = [];
  for (const part of cmd) {
    if (part === '{args}') {
      hasPlaceholder = true;
      out.push(...args);
    } else if (part.includes('{args}')) {
      hasPlaceholder = true;
      out.push(part.split('{args}').join(joined));
    } else {
      out.push(part);
    }
  }
  if (!hasPlaceholder && args.length) out.push(...args);
  return out;
}

function spawnSpec(spec, timeoutSec, windowsHide, onOutput) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(spec.file, spec.args, { shell: false, windowsHide: !!windowsHide });
    } catch (err) {
      onOutput(Buffer.from(`spawn failed: ${err.message}\r\n`, 'utf8'));
      resolve({ code: 1 });
      return;
    }

    let timer = null;
    if (timeoutSec > 0) {
      timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, timeoutSec * 1000);
    }

    child.stdout.on('data', (d) => onOutput(d));
    child.stderr.on('data', (d) => onOutput(d));
    child.on('error', (err) => onOutput(Buffer.from(`exec error: ${err.message}\r\n`, 'utf8')));
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code === null ? -1 : code });
    });
  });
}

/**
 * Preset "services": a name -> command mapping configured on the server.
 * The operator sends `serviceName [args...]` and the matching command runs.
 */
class ServiceRegistry {
  constructor(config) {
    this.config = config;
    this.byName = new Map((config.services || []).map((s) => [s.name, s]));
  }

  list() {
    return (this.config.services || [])
      .filter((s) => !s.hidden)
      .map((s) => ({ name: s.name, description: s.description || '' }));
  }

  helpText() {
    const rows = this.list().map((s) => `  ${s.name.padEnd(16)} ${s.description}`);
    const body = rows.length ? rows.join('\r\n') : '  (no services configured)';
    return `available services:\r\n${body}\r\n`;
  }

  resolve(line) {
    const parts = String(line).split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
      return { error: 'empty command; use "list" to see available services' };
    }
    const name = parts[0];
    const args = parts.slice(1);

    if (BUILTINS.has(name)) return { builtin: 'list' };

    const svc = this.byName.get(name);
    if (!svc) {
      return { error: `unknown service: ${name}\r\n${this.helpText()}` };
    }

    const min = (svc.args && svc.args.min) || 0;
    const max = (svc.args && svc.args.max != null) ? svc.args.max : Infinity;
    if (args.length < min || args.length > max) {
      const hi = max === Infinity ? 'any' : max;
      return { error: `service "${name}" expects ${min}..${hi} arg(s), got ${args.length}\r\n` };
    }
    return { service: svc, args };
  }

  buildSpawn(svc, args) {
    if (typeof svc.command === 'string') {
      return resolveExecCommand(this.config, substitute(svc.command, args));
    }
    const cmd = buildArrayCommand(svc.command, args);
    if (cmd.length === 0) {
      throw new Error(`service "${svc.name}" has an empty command`);
    }
    return { file: cmd[0], args: cmd.slice(1) };
  }

  /** Run one line; onOutput(Buffer) streams stdout/stderr; resolves {code}. */
  async run(line, onOutput) {
    const r = this.resolve(line);
    if (r.error) {
      onOutput(Buffer.from(`${r.error}\r\n`, 'utf8'));
      return { code: 1 };
    }
    if (r.builtin === 'list') {
      onOutput(Buffer.from(this.helpText(), 'utf8'));
      return { code: 0 };
    }

    let spec;
    try {
      spec = this.buildSpawn(r.service, r.args);
    } catch (err) {
      onOutput(Buffer.from(`${err.message}\r\n`, 'utf8'));
      return { code: 1 };
    }

    const timeout = (r.service.timeoutSeconds != null ? r.service.timeoutSeconds : this.config.exec.timeoutSeconds) || 0;
    return spawnSpec(spec, timeout, this.config.exec.windowsHide, onOutput);
  }
}

module.exports = { ServiceRegistry, substitute, buildArrayCommand, spawnSpec };
