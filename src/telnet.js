'use strict';

const { EventEmitter } = require('events');

// Telnet protocol control bytes.
const IAC = 255;
const DONT = 254;
const DO = 253;
const WONT = 252;
const WILL = 251;
const SB = 250;
const SE = 240;

// Options we negotiate.
const OPT = {
  ECHO: 1,
  SGA: 3, // SUPPRESS-GO-AHEAD
  TTYPE: 24,
  NAWS: 31,
};

const STATE = { DATA: 0, IAC: 1, CMD: 2, SUB: 3, SUB_IAC: 4 };

/**
 * Minimal telnet option negotiator + IAC filter.
 *
 * The operator may connect with a real `telnet` client (which sends IAC
 * option negotiation and NAWS window-size updates) or a plain `nc`/raw
 * socket (which sends no IAC bytes). This filter strips every IAC sequence
 * from the incoming stream so the PTY only ever receives real bytes, and it
 * answers option negotiation just enough to make `telnet` behave (echo is
 * left to the remote shell, window size is forwarded as `resize` events).
 *
 * @param {function(Buffer):void} send  callback used to write responses to
 *                                      the socket (the caller makes it a
 *                                      no-op once the socket is closed).
 */
class TelnetFilter extends EventEmitter {
  constructor(send) {
    super();
    this._send = typeof send === 'function' ? send : () => {};
    this._state = STATE.DATA;
    this._cmd = 0;
    this._sub = [];
    this._buf = Buffer.alloc(0);
    this._negotiated = false;
  }

  /**
   * Negotiate options. Called lazily on the first IAC byte so a raw `nc`
   * client (which never sends IAC) sees no protocol bytes at all.
   */
  _negotiate() {
    this._command(WILL, OPT.ECHO);
    this._command(WILL, OPT.SGA);
    this._command(DO, OPT.NAWS);
    this._command(DO, OPT.TTYPE);
  }

  _command(cmd, opt) {
    try {
      this._send(Buffer.from([IAC, cmd, opt]));
    } catch {
      /* socket closed; ignore */
    }
  }

  /** Feed a raw socket chunk; clean data is emitted as `data`, `resize(cols,rows)` on NAWS. */
  handleData(chunk) {
    if (!chunk || chunk.length === 0) return;
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    const buf = this._buf;
    const out = [];
    let i = 0;
    while (i < buf.length) {
      const b = buf[i++];
      switch (this._state) {
        case STATE.DATA:
          if (b === IAC) {
            if (!this._negotiated) {
              this._negotiated = true;
              this._negotiate();
            }
            this._state = STATE.IAC;
          } else {
            out.push(b);
          }
          break;
        case STATE.IAC:
          if (b === IAC) {
            out.push(IAC); // IAC IAC -> literal 0xFF
            this._state = STATE.DATA;
          } else if (b === WILL || b === WONT || b === DO || b === DONT) {
            this._cmd = b;
            this._state = STATE.CMD;
          } else if (b === SB) {
            this._sub = [];
            this._state = STATE.SUB;
          } else {
            this._state = STATE.DATA; // unknown IAC command: drop it
          }
          break;
        case STATE.CMD:
          this._option(this._cmd, b);
          this._state = STATE.DATA;
          break;
        case STATE.SUB:
          if (b === IAC) this._state = STATE.SUB_IAC;
          else this._sub.push(b);
          break;
        case STATE.SUB_IAC:
          if (b === IAC) {
            this._sub.push(IAC);
            this._state = STATE.SUB;
          } else if (b === SE) {
            this._subnegotiation(Buffer.from(this._sub));
            this._state = STATE.DATA;
          } else {
            this._state = STATE.SUB; // malformed sequence: ignore
          }
          break;
      }
    }
    this._buf = buf.slice(i);
    if (out.length) this.emit('data', Buffer.from(out));
  }

  _option(cmd, opt) {
    switch (cmd) {
      case WILL:
        this._command(opt === OPT.NAWS || opt === OPT.TTYPE ? DO : DONT, opt);
        break;
      case WONT:
        this._command(DONT, opt);
        break;
      case DO:
        this._command(opt === OPT.ECHO || opt === OPT.SGA ? WILL : WONT, opt);
        break;
      case DONT:
        this._command(WONT, opt);
        break;
      default:
        break;
    }
  }

  _subnegotiation(buf) {
    // We only care about NAWS (window size): IAC SB NAWS <cols:2> <rows:2> IAC SE.
    if (buf[0] === OPT.NAWS && buf.length >= 5) {
      const cols = buf.readUInt16BE(1);
      const rows = buf.readUInt16BE(3);
      if (cols > 0 && rows > 0) this.emit('resize', cols, rows);
    }
  }
}

module.exports = { TelnetFilter, IAC, WILL, WONT, DO, DONT, SB, SE, OPT };
