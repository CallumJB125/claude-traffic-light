'use strict';
// POSIX uses Unix sockets. Windows uses only the bundled native broker:
// protected local pipes, verified helper peers and bounded framed stdio.
const net = require('node:net'); // privacy-flow: local-board-sockets
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Duplex } = require('node:stream');
const { spawn, spawnSync } = require('node:child_process');
const Private = require('./windows-private-directory.cjs');
const BLOCK = 65536, LIMIT = 32, READY = 1, OPEN = 2, DATA = 3, CLOSE = 4, WRITTEN = 5, READ = 7, END = 8;
const executable = () => path.join(path.dirname(Private.helperPath()), 'windows-local-transport.exe');
function request(mode, socketPath) {
  if (!['S', 'C', 'T', 'R'].includes(mode) || typeof socketPath !== 'string' || socketPath.length > 4096 || !/^[A-Za-z]:\\/.test(socketPath) || /[\0\r\n/]/.test(socketPath) || !['tasks.sock', 'runner.sock', 'ipc.sock'].includes(path.win32.basename(socketPath))) throw new Error('Invalid Windows local endpoint');
  const bytes = Buffer.from(socketPath, 'utf16le'), header = Buffer.alloc(5);
  header[0] = mode.charCodeAt(0); header.writeUInt32LE(bytes.length, 1);
  return Buffer.concat([header, bytes]);
}
function packet(type, id, data = Buffer.alloc(0)) {
  if (data.length > BLOCK) throw new Error('Local transport block exceeds limit');
  const header = Buffer.alloc(9); header[0] = type; header.writeUInt32LE(id, 1); header.writeUInt32LE(data.length, 5);
  return Buffer.concat([header, data]);
}
class Peer extends Duplex {
  constructor(bridge, id = null) {
    super({ allowHalfOpen: false, readableHighWaterMark: BLOCK, writableHighWaterMark: BLOCK });
    this.bridge = bridge; this.id = id; this.connected = false; this.readPending = false; this.pendingWrite = null; this.finalCallback = null;
  }
  _construct(callback) { if (this.startupError) callback(this.startupError); else if (this.connected) callback(); else this.constructCallback = callback; }
  opened(id) {
    this.id = id; this.connected = true;
    const callback = this.constructCallback; this.constructCallback = null; callback?.();
    this.emit('connect');
  }
  _read() { if (this.readPending) { this.readPending = false; this.bridge.send(READ, this.id); } }
  received(bytes) {
    if (this.readPending) return this.bridge.fail(new Error('Local transport read window exceeded'));
    if (this.push(bytes)) this.bridge.send(READ, this.id); else this.readPending = true;
  }
  _write(bytes, encoding, callback) {
    this.pendingWrite = { bytes, offset: 0, callback };
    this.writeNext();
  }
  writeNext() {
    const pending = this.pendingWrite;
    if (!pending) return;
    if (pending.offset === pending.bytes.length) { this.pendingWrite = null; pending.callback(); return; }
    const end = Math.min(pending.offset + BLOCK, pending.bytes.length);
    this.bridge.send(DATA, this.id, pending.bytes.subarray(pending.offset, end)); pending.offset = end;
  }
  written() { if (!this.pendingWrite) return this.bridge.fail(new Error('Unexpected local transport write receipt')); this.writeNext(); }
  _final(callback) { this.finalCallback = callback; this.bridge.send(END, this.id); }
  closed(error) {
    if (!this.connected) this.startupError = error || new Error('Local transport closed before connection');
    const construct = this.constructCallback; this.constructCallback = null;
    construct?.(error || new Error('Local transport closed before connection'));
    const pending = this.pendingWrite; this.pendingWrite = null; pending?.callback(error || new Error('Local transport closed during write'));
    const final = this.finalCallback; this.finalCallback = null; final?.(error);
    this.push(null); this.destroy(error);
  }
  _destroy(error, callback) {
    if (this.id != null) this.bridge.send(CLOSE, this.id);
    this.bridge.peers.delete(this.id);
    if (!this.bridge.server) this.bridge.stop();
    callback(error);
  }
}
class Bridge {
  constructor(socketPath, server, events, options = {}) {
    this.server = server; this.events = events; this.peers = new Map(); this.ended = false; this.ready = false; this.buffer = Buffer.alloc(0);
    const start = options.spawn || spawn;
    this.child = start(options.executable || executable(), [], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }); // privacy-flow: windows-local-transport
    this.deadline = setTimeout(() => this.fail(new Error('Windows local transport startup timed out')), 5000);
    this.child.stderr?.resume();
    this.child.once('error', error => this.fail(error));
    const finished = () => {
      if (this.finished) return;
      this.finished = true;
      if (!this.ended) this.fail(new Error('Windows local transport exited'));
      clearTimeout(this.deadline); clearTimeout(this.killTimer);
      if (this.server) this.events.emit('close');
    };
    this.child.once('exit', finished);
    this.child.once('close', finished); // spawn failure emits close without exit
    this.child.stdin.on('error', error => this.fail(error));
    this.child.stdout.on('data', bytes => this.consume(bytes));
    this.child.stdin.write(request(server ? 'S' : 'C', socketPath));
  }
  consume(bytes) {
    if (this.ended) return;
    this.buffer = Buffer.concat([this.buffer, bytes]);
    while (this.buffer.length >= 9) {
      const type = this.buffer[0], id = this.buffer.readUInt32LE(1), length = this.buffer.readUInt32LE(5);
      if (length > BLOCK || (type !== DATA && length) || ![READY, OPEN, DATA, CLOSE, WRITTEN].includes(type)) return this.fail(new Error('Invalid Windows local transport frame'));
      if (this.buffer.length < 9 + length) break;
      const data = this.buffer.subarray(9, 9 + length); this.buffer = this.buffer.subarray(9 + length);
      if (type === READY) {
        if (!this.server || this.ready || id !== 0) return this.fail(new Error('Invalid local listener receipt'));
        this.ready = true; clearTimeout(this.deadline); this.events.emit('listening');
      } else if (type === OPEN) {
        if (!id || this.peers.has(id) || this.peers.size >= LIMIT || (this.server && !this.ready) || (!this.server && this.ready)) return this.fail(new Error('Invalid local connection receipt'));
        this.ready = true; clearTimeout(this.deadline);
        const peer = this.server ? new Peer(this, id) : this.events;
        this.peers.set(id, peer);
        if (this.server) this.events.emit('connection', peer);
        peer.opened(id);
      } else {
        const peer = this.peers.get(id);
        if (!peer) continue; // late data/close receipts for a locally destroyed stream
        if (type === DATA) peer.received(Buffer.from(data));
        else if (type === WRITTEN) peer.written();
        else { this.peers.delete(id); peer.closed(); }
      }
    }
    if (this.buffer.length > BLOCK + 9) this.fail(new Error('Windows local transport frame exceeds limit'));
  }
  send(type, id, bytes) {
    if (this.ended || !id) return;
    if (this.child.stdin.writableLength > LIMIT * (BLOCK + 9)) return this.fail(new Error('Windows local transport write queue exceeded limit'));
    this.child.stdin.write(packet(type, id, bytes));
  }
  fail(error) {
    if (this.ended) return;
    this.stop();
    for (const peer of this.peers.values()) peer.closed(error);
    this.peers.clear();
    if (this.server) this.events.emit('error', error); else this.events.closed(error);
  }
  stop() {
    if (this.ended) return;
    this.ended = true; clearTimeout(this.deadline); this.child.stdin.end();
    this.killTimer = setTimeout(() => this.child.kill(), 2000); this.killTimer.unref?.();
  }
}
class WindowsServer extends EventEmitter {
  constructor(listener, options) { super(); if (listener) this.on('connection', listener); this.options = options; }
  listen(socketPath, callback) {
    if (this.bridge) throw new Error('Local server already started');
    request('S', socketPath); this.socketPath = socketPath;
    if (callback) this.once('listening', callback);
    this.bridge = new Bridge(socketPath, true, this, this.options); return this;
  }
  address() { return this.socketPath; }
  close(callback) {
    if (this.bridge?.finished) { if (callback) queueMicrotask(callback); return this; }
    if (callback) this.once('close', callback);
    if (!this.bridge) { queueMicrotask(() => this.emit('close')); return this; }
    for (const peer of this.bridge.peers.values()) peer.closed();
    this.bridge.stop(); return this;
  }
}
function createConnection(socketPath, options = {}) {
  if ((options.platform || process.platform) !== 'win32') return net.createConnection(socketPath); // privacy-flow: local-board-sockets
  request('C', socketPath);
  const peer = new Peer(null);
  peer.bridge = new Bridge(socketPath, false, peer, options);
  return peer;
}
function createServer(listener, options = {}) {
  return (options.platform || process.platform) === 'win32' ? new WindowsServer(listener, options) : net.createServer(listener);
}
function token(socketPath, create, options = {}) {
  const input = request(create ? 'T' : 'R', socketPath);
  let result;
  try { result = (options.spawnSync || spawnSync)(options.executable || executable(), [], { input, encoding: 'utf8', windowsHide: true, shell: false, timeout: 5000, maxBuffer: 256 }); } // privacy-flow: windows-local-transport
  finally { input.fill(0); }
  if (!result || result.error || result.signal || result.status !== 0 || typeof result.stdout !== 'string' || !/^btk_[A-Za-z0-9_-]{43}\n$/.test(result.stdout)) throw new Error('Windows private Tasks token unavailable');
  return result.stdout.trim();
}
module.exports = { createConnection, createServer, token, request, packet, BLOCK };
