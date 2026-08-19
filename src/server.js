'use strict';

const net = require('net');
const fs = require('fs');
const crypto = require('crypto');
const { TelnetFilter } = require('./telnet');
const { ShellSession, PtyBridge } = require('./session');
const { ServiceRegistry, spawnSpec } = require('./services');
const { resolveExecCommand, renderBanner } = require('./config');

function createLogger(cfg) {
  const file = cfg.log && cfg.log.file;
  return (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    if (file) {
      try { fs.appendFileSync(file, line + '\n'); } catch { /* ignore */ }
    }
    process.stderr.write(line + '\n');
  };
}

function writeSafe(socket, buf) {
  if (!socket.destroyed) socket.write(buf);
}

function tokenMatches(input, expected) {
  const a = Buffer.from(input, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** When auth is enabled, read one line from the (filtered) connection and check it. */
function authenticate(socket, filter, config) {
  return new Promise((resolve) => {
    writeSafe(socket, Buffer.from('Password: ', 'utf8'));
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (ok, leftover) => {
      if (done) return;
      done = true;
      filter.removeListener('data', onData);
      socket.removeListener('close', onClose);
      socket.removeListener('error', onClose);
      resolve({ ok, leftover });
    };
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const nl = buf.indexOf(0x0a);
      if (nl >= 0) {
        const line = buf.slice(0, nl).toString('utf8').trim();
        finish(tokenMatches(line, config.auth.token), buf.slice(nl + 1));
      } else if (buf.length > 4096) {
        finish(false, Buffer.alloc(0));
      }
    };
    const onClose = () => finish(false, Buffer.alloc(0));
    filter.on('data', onData);
    socket.once('close', onClose);
    socket.once('error', onClose);
  });
}

/** Collect clean (post-filter) input until a newline (line mode) or EOF (exec).
 *  Resolves { data, leftover } — leftover holds bytes after the first newline. */
function collectInput(filter, socket, maxBytes, untilEof) {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (data, leftover) => {
      if (done) return;
      done = true;
      filter.removeListener('data', onData);
      socket.removeListener('end', onEof);
      socket.removeListener('close', onEof);
      socket.removeListener('error', onEof);
      resolve({ data, leftover });
    };
    const onEof = () => finish(buf, Buffer.alloc(0));
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (!untilEof) {
        const nl = buf.indexOf(0x0a);
        if (nl >= 0) {
          finish(buf.slice(0, nl), buf.slice(nl + 1));
          return;
        }
      }
      if (buf.length >= maxBytes) finish(buf, Buffer.alloc(0));
    };
    filter.on('data', onData);
    socket.once('end', onEof);
    socket.once('close', onEof);
    socket.once('error', onEof);
  });
}

class RConsoleServer {
  constructor(config) {
    this.config = config;
    this.log = createLogger(config);
    this.services = new ServiceRegistry(config);
    this.servers = [];
    this.sockets = new Set();
    this.shellSessions = new Set();
    this._shellCount = 0;
    this._closing = false;
  }

  start() {
    return new Promise((resolve, reject) => {
      let pending = this.config.listeners.length;
      if (pending === 0) return resolve();
      let failed = false;
      for (const listener of this.config.listeners) {
        // allowHalfOpen lets a piped client (`echo cmd | nc host port`) half-close
        // its write side while we still stream the command output back.
        const server = net.createServer({ allowHalfOpen: true }, (socket) => this._accept(listener, socket));
        this.servers.push(server);
        server.once('error', (err) => {
          if (!failed) {
            failed = true;
            reject(err);
          }
        });
        server.listen(listener.port, listener.host, () => {
          this.log(`listening [${listener.mode}] ${listener.host}:${listener.port}`);
          pending -= 1;
          if (pending === 0 && !failed) resolve();
        });
      }
    });
  }

  async _accept(listener, socket) {
    socket.setNoDelay(true);
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));

    const send = (buf) => writeSafe(socket, buf);
    const filter = new TelnetFilter(send);
    socket.on('data', (d) => filter.handleData(d));

    if (this.config.auth && this.config.auth.enabled) {
      const { ok, leftover } = await authenticate(socket, filter, this.config);
      if (!ok || socket.destroyed) {
        send(Buffer.from('\r\nauth failed\r\n', 'utf8'));
        socket.end();
        return;
      }
      send(Buffer.from('\r\n', 'utf8'));
      this._route(listener, socket, filter, send);
      // Bytes that arrived in the same packet as the token must not be lost.
      if (leftover && leftover.length) filter.handleData(leftover);
      return;
    }

    this._route(listener, socket, filter, send);
  }

  _route(listener, socket, filter, send) {
    switch (listener.mode) {
      case 'shell':
        this._handleShell(socket, filter, send);
        break;
      case 'exec':
        this._handleExec(socket, filter, send);
        break;
      case 'service':
        this._handleService(socket, filter, send);
        break;
      default:
        break;
    }
  }

  _handleShell(socket, filter, send) {
    const cfg = this.config;
    if (cfg.shell.maxSessions > 0 && this._shellCount >= cfg.shell.maxSessions) {
      send(Buffer.from('server busy: max sessions reached\r\n', 'utf8'));
      socket.end();
      return;
    }
    this._shellCount += 1;

    const banner = renderBanner(cfg);
    if (banner) send(Buffer.from(banner, 'utf8'));

    const session = new ShellSession({ socket, filter, config: cfg, log: this.log });
    try {
      session.start();
    } catch (err) {
      this.log(`shell spawn failed: ${err.message}`);
      send(Buffer.from(`\r\nshell spawn failed: ${err.message}\r\n`, 'utf8'));
      socket.end();
      this._shellCount -= 1;
      return;
    }

    this.shellSessions.add(session);
    socket.once('close', () => {
      this.shellSessions.delete(session);
      this._shellCount -= 1;
    });
  }

  async _handleExec(socket, filter, send) {
    const cfg = this.config;
    const maxBytes = cfg.exec.maxInputBytes || 65536;
    const { data } = await collectInput(filter, socket, maxBytes, true);
    if (this._closing || socket.destroyed) return;

    const input = data.toString('utf8').trim();
    if (input) {
      const spec = resolveExecCommand(cfg, input);
      await spawnSpec(spec, cfg.exec.timeoutSeconds || 0, cfg.exec.windowsHide, send);
    }
    socket.end();
  }

  async _handleService(socket, filter, send) {
    const cfg = this.config;
    const maxBytes = cfg.exec.maxInputBytes || 65536;
    const { data, leftover } = await collectInput(filter, socket, maxBytes, false);
    if (this._closing || socket.destroyed) return;

    const line = data.toString('utf8').trim();
    if (!line) {
      socket.end();
      return;
    }

    const r = this.services.resolve(line);
    if (r.error) {
      send(Buffer.from(`${r.error}\r\n`, 'utf8'));
      socket.end();
      return;
    }
    if (r.builtin === 'list') {
      send(Buffer.from(this.services.helpText(), 'utf8'));
      socket.end();
      return;
    }

    // Interactive service: run it inside a real PTY (ConPTY/forkpty) so that
    // ssh, serial consoles etc. get a TTY and can be used interactively.
    if (r.service.pty) {
      let spec;
      try {
        spec = this.services.buildSpawn(r.service, r.args);
      } catch (err) {
        send(Buffer.from(`${err.message}\r\n`, 'utf8'));
        socket.end();
        return;
      }
      const bridge = new PtyBridge({
        socket,
        filter,
        log: this.log,
        opts: {
          cols: cfg.shell.cols,
          rows: cfg.shell.rows,
          env: { ...process.env, ...(cfg.shell.env || {}) },
          cwd: cfg.shell.cwd || undefined,
          onSocketEnd: 'kill',
        },
      });
      try {
        bridge.spawn(spec.file, spec.args);
      } catch (err) {
        this.log(`service pty spawn failed: ${err.message}`);
        send(Buffer.from(`\r\nservice spawn failed: ${err.message}\r\n`, 'utf8'));
        socket.end();
        return;
      }
      // Bytes typed right after the service line must reach the PTY.
      if (leftover && leftover.length) filter.handleData(leftover);
      return;
    }

    const { code } = await this.services.execResolved(r, send);
    send(Buffer.from(`\r\n[exit: ${code}]\r\n`, 'utf8'));
    socket.end();
  }

  close() {
    this._closing = true;
    for (const s of this.shellSessions) {
      try { s.kill(); } catch { /* ignore */ }
    }
    this.shellSessions.clear();
    for (const socket of this.sockets) {
      try { socket.destroy(); } catch { /* ignore */ }
    }
    this.sockets.clear();
    for (const server of this.servers) {
      try { server.close(); } catch { /* ignore */ }
    }
    this.servers = [];
  }
}

module.exports = { RConsoleServer, collectInput };
