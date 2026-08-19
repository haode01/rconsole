'use strict';

const pty = require('node-pty');
const { StringDecoder } = require('string_decoder');
const { resolveShell } = require('./config');

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/**
 * Generic bidirectional bridge between one operator connection and a local
 * PTY running an arbitrary command (shell, ssh, serial console, ...).
 *
 * - operator bytes (post telnet-filter) -> pty stdin
 * - pty stdout                            -> operator socket
 * - NAWS window-size updates              -> pty.resize
 * - socket EOF/close/error, pty exit      -> clean up both sides
 *
 * opts:
 *   name, cols, rows, env, cwd
 *   onSocketEnd: 'exit' (write exitCommand on EOF), 'kill' (kill pty) or 'none'
 *   exitCommand: string written to the pty when onSocketEnd === 'exit'
 *   onActivity:  called whenever data flows either way (for idle timers)
 */
class PtyBridge {
  constructor({ socket, filter, log, opts = {} }) {
    this.socket = socket;
    this.filter = filter;
    this.log = log || (() => {});
    this.pty = null;
    this.closed = false;
    this._decoder = new StringDecoder('utf8');
    this._name = opts.name || 'xterm-256color';
    this._cols = opts.cols || DEFAULT_COLS;
    this._rows = opts.rows || DEFAULT_ROWS;
    this._env = opts.env || process.env;
    this._cwd = opts.cwd || undefined;
    this._onSocketEnd = opts.onSocketEnd || 'exit';
    this._exitCommand = opts.exitCommand || (process.platform === 'win32' ? 'exit\r\n' : 'exit\n');
    this._onActivity = opts.onActivity || (() => {});
  }

  spawn(file, args) {
    const o = {
      name: this._name,
      cols: this._cols,
      rows: this._rows,
      env: this._env,
      useConpty: process.platform === 'win32',
    };
    if (this._cwd) o.cwd = this._cwd;

    this.pty = pty.spawn(file, args, o);
    this.log(`spawned pty pid=${this.pty.pid} file=${file}`);
    this._wire();
    return this.pty;
  }

  _wire() {
    this.filter.on('data', (buf) => {
      if (this.closed || !this.pty) return;
      // Decoder handles multibyte characters split across TCP chunks.
      this.pty.write(this._decoder.write(buf));
      this._onActivity();
    });

    this.filter.on('resize', (cols, rows) => this.resize(cols, rows));

    this.pty.onData((data) => {
      if (this.closed || this.socket.destroyed) return;
      this.socket.write(data);
      this._onActivity();
    });

    this.pty.onExit(({ exitCode, signal }) => {
      this.log(`pty exited code=${exitCode} signal=${signal}`);
      this._cleanup();
      if (!this.socket.destroyed) this.socket.end();
    });

    this.socket.on('end', () => {
      if (this.closed || !this.pty) return;
      if (this._onSocketEnd === 'exit') {
        try { this.pty.write(this._exitCommand); } catch { /* ignore */ }
      } else if (this._onSocketEnd === 'kill') {
        this._cleanup();
        if (!this.socket.destroyed) this.socket.end();
      }
    });

    this.socket.on('close', () => this._cleanup());
    this.socket.on('error', () => this._cleanup());
  }

  resize(cols, rows) {
    if (this.closed || !this.pty || cols <= 0 || rows <= 0) return;
    try { this.pty.resize(cols, rows); } catch { /* ignore */ }
  }

  _cleanup() {
    if (this.closed) return;
    this.closed = true;
    if (this.pty) {
      try { this.pty.kill(); } catch { /* ignore */ }
      this.pty = null;
    }
  }

  kill() {
    this._cleanup();
    if (!this.socket.destroyed) this.socket.end();
  }
}

/**
 * Shell mode: a PtyBridge running the configured login shell, with optional
 * Windows codepage normalization and an idle timeout.
 */
class ShellSession extends PtyBridge {
  constructor({ socket, filter, config, log }) {
    super({
      socket,
      filter,
      log,
      opts: {
        name: 'xterm-256color',
        cols: config.shell.cols || DEFAULT_COLS,
        rows: config.shell.rows || DEFAULT_ROWS,
        env: { ...process.env, ...(config.shell.env || {}) },
        cwd: config.shell.cwd || undefined,
        onSocketEnd: 'exit',
        onActivity: () => {},
      },
    });
    this.config = config;
    this._idleTimer = null;
    this._onActivity = () => this._resetIdle();
  }

  start() {
    const shell = resolveShell(this.config);
    this.spawn(shell.file, shell.args);
    if (process.platform === 'win32' && this.config.shell.codepageUtf8) {
      this.pty.write('chcp 65001 >NUL\r\n');
    }
    this._resetIdle();
    return this.pty;
  }

  _resetIdle() {
    const secs = this.config.shell.idleTimeoutSeconds || 0;
    clearTimeout(this._idleTimer);
    if (secs > 0) {
      this._idleTimer = setTimeout(() => this.kill(), secs * 1000);
    }
  }
}

module.exports = { PtyBridge, ShellSession };
