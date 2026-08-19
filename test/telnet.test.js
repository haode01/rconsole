'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { TelnetFilter, IAC, WILL, WONT, DO, DONT, SB, SE, OPT } = require('../src/telnet');

function makeFilter() {
  const sent = [];
  const events = { data: [], resize: [] };
  const filter = new TelnetFilter((buf) => sent.push(Buffer.from(buf)));
  filter.on('data', (b) => events.data.push(b));
  filter.on('resize', (c, r) => events.resize.push([c, r]));
  return { filter, sent, events };
}

test('raw bytes pass through and no negotiation is sent for non-telnet', () => {
  const { filter, events, sent } = makeFilter();
  filter.handleData(Buffer.from('ls -la\n', 'utf8'));
  assert.strictEqual(Buffer.concat(events.data).toString('utf8'), 'ls -la\n');
  assert.strictEqual(sent.length, 0);
});

test('IAC IAC decodes to a literal 0xFF byte', () => {
  const { filter, events } = makeFilter();
  filter.handleData(Buffer.from([0x41, IAC, IAC, 0x42]));
  assert.deepStrictEqual([...Buffer.concat(events.data)], [0x41, 0xff, 0x42]);
});

test('NAWS subnegotiation emits resize and is stripped from the data stream', () => {
  const { filter, events } = makeFilter();
  const naws = Buffer.from([IAC, SB, OPT.NAWS, 0x00, 0x50, 0x00, 0x18, IAC, SE]); // 80x24
  filter.handleData(Buffer.concat([naws, Buffer.from('echo hi', 'utf8')]));
  assert.strictEqual(Buffer.concat(events.data).toString('utf8'), 'echo hi');
  assert.deepStrictEqual(events.resize, [[80, 24]]);
});

test('DO ECHO is answered with WILL ECHO; unknown options are refused', () => {
  const { filter, sent } = makeFilter();
  filter.handleData(Buffer.from([IAC, DO, OPT.ECHO])); // also triggers lazy negotiation
  const last = sent[sent.length - 1];
  assert.deepStrictEqual([...last], [IAC, WILL, OPT.ECHO]);

  sent.length = 0;
  filter.handleData(Buffer.from([IAC, DO, 42]));
  assert.deepStrictEqual([...sent[0]], [IAC, WONT, 42]);
});

test('WILL NAWS is answered with DO NAWS', () => {
  const { filter, sent } = makeFilter();
  filter.handleData(Buffer.from([IAC, WILL, OPT.NAWS]));
  const last = sent[sent.length - 1];
  assert.deepStrictEqual([...last], [IAC, DO, OPT.NAWS]);
});

test('lazy negotiation fires only once on the first IAC byte', () => {
  const { filter, sent } = makeFilter();
  filter.handleData(Buffer.from([IAC, DONT, OPT.ECHO])); // first IAC -> negotiate + DONT->WONT
  const before = sent.length;
  filter.handleData(Buffer.from([IAC, DO, OPT.SGA]));
  assert.strictEqual(sent.length, before + 1); // no second negotiation burst
});
