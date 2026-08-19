'use strict';

const pty = require('node-pty');
const { StringDecoder } = require('string_decoder');
const { resolveShell } = require('./config');

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/**
 * Bridges one operator connection to a local PTY (the "free shell").
 *
 * - operator bytes (post telnet-filter)  -> pty stdin
 * - pty stdout                            -> operator socket
 * - NAWS window-size updates              -> pty.resize
 * - socket EOF (piped one-shot `echo|nc`) -> writes the shell exit command
 * - socket close/error or pty exit        -> clean up both sides
 */
class ShellSession {
  constructor({ socket, filter, config, log }) {
    this.socket = socket;
    this.filter = filter;
    this.config = config;
    this.log = log || (() => {});
    this.pty = null;
    this.closed = false;
    this._exitCmd = process.platform === 'win32' ? 'exit\r\n' : 'exit\n';
    this._decoder = new StringDecoder('utf8');
    this._idleTimer = null;
  }

  start() {
    const shell = resolveShell(this.config);
    const opts = {
      name: 'xterm-256color',
      cols: this.config.shell.cols || DEFAULT_COLS,
      rows: this.config.shell.rows || DEFAULT_ROWS,
      env: { ...process.env, ...(this.config.shell.env || {}) },
      useConpty: process.platform === 'win32',
    };
    if (this.config.shell.cwd) opts.cwd = this.config.shell.cwd;

    this.pty = pty.spawn(shell.file, shell.args, opts);
    this.log(`spawned shell pid=${this.pty.pid} file=${shell.file}`);
    this._wire();

    if (process.platform === 'win32' && this.config.shell.codepageUtf8) {
      this.pty.write('chcp 65001 >NUL\r\n');
    }
    this._resetIdle();
    return this.pty;
  }

  _wire() {
    this.filter.on('data', (buf) => {
      if (this.closed || !this.pty) return;
      // Decoder handles multibyte characters split across TCP chunks.
      this.pty.write(this._decoder.write(buf));
      this._resetIdle();
    });

    this.filter.on('resize', (cols, rows) => this.resize(cols, rows));

    this.pty.onData((data) => {
      if (this.closed) return;
      if (!this.socket.destroyed) this.socket.write(data);
      this._resetIdle();
    });

    this.pty.onExit(({ exitCode, signal }) => {
      this.log(`shell exited code=${exitCode} signal=${signal}`);
      this._cleanup();
      if (!this.socket.destroyed) this.socket.end();
    });

    this.socket.on('end', () => {
      // Half-close from a piped client (`echo cmd | nc host port`): ask the
      // shell to exit so the session terminates instead of hanging at prompt.
      if (!this.closed && this.pty) {
        try { this.pty.write(this._exitCmd); } catch { /* ignore */ }
      }
    });

    this.socket.on('close', () => this._cleanup());
    this.socket.on('error', () => this._cleanup());
  }

  resize(cols, rows) {
    if (this.closed || !this.pty || cols <= 0 || rows <= 0) return;
    try { this.pty.resize(cols, rows); } catch { /* ignore */ }
  }

  _resetIdle() {
    const secs = this.config.shell.idleTimeoutSeconds || 0;
    clearTimeout(this._idleTimer);
    if (secs > 0) {
      this._idleTimer = setTimeout(() => this._cleanup(true), secs * 1000);
    }
  }

  _cleanup(fromIdle = false) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this._idleTimer);
    if (this.pty) {
      try { this.pty.kill(); } catch { /* ignore */ }
      this.pty = null;
    }
    if (fromIdle && !this.socket.destroyed) this.socket.end();
  }

  kill() {
    if (this.closed) return;
    this._cleanup();
    if (!this.socket.destroyed) this.socket.end();
  }
}

module.exports = { ShellSession };
