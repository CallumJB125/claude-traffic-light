'use strict';
const net = require('node:net'); // privacy-flow: terminal-keeper-local
const { EventEmitter } = require('node:events');
const MAX = 65536;
function frame(type, payload) { const b = Buffer.alloc(5); b.writeUInt32BE(payload.length + 1); b[4] = type; return Buffer.concat([b, payload]); }
class KeeperClient extends EventEmitter {
  constructor(socket) {
    super(); this.socket = socket; this.buffer = Buffer.alloc(0); this.requests = new Map(); this.counter = 0;
    socket.on('error', (e) => this.emit('notice', e.message));
    socket.on('close', () => { for (const r of this.requests.values()) { clearTimeout(r.timer); r.reject(Error('Keeper disconnected; existing tabs may still be running.')); } this.requests.clear(); this.emit('closed'); });
    socket.on('data', (d) => this.read(d));
  }
  read(d) {
    this.buffer = Buffer.concat([this.buffer, d]);
    while (this.buffer.length >= 4) {
      const n = this.buffer.readUInt32BE();
      if (n < 1 || n > MAX) { this.socket.destroy(Error('Invalid keeper frame.')); return; }
      if (this.buffer.length < n + 4) return;
      const type = this.buffer[4], p = this.buffer.subarray(5, n + 4); this.buffer = this.buffer.subarray(n + 4);
      try {
        if (type === 1) {
          const m = JSON.parse(p.toString('utf8'));
          if (m.v !== 1) throw Error('Keeper protocol mismatch.');
          if (Number.isSafeInteger(m.re)) {
            const r = this.requests.get(m.re); if (!r) continue; this.requests.delete(m.re); clearTimeout(r.timer);
            if (m.ok) { this.emit('reply', { op: r.op, fields: r.fields, result: m }); r.resolve(m); } else r.reject(Object.assign(Error(m.text || 'Keeper request refused.'), { code: m.code }));
          } else this.emit('event', m);
        } else if (type === 2 && p.length >= 4) this.emit('data', { channel: p.readUInt32BE(), data: p.subarray(4) });
        else throw Error('Invalid keeper frame type.');
      } catch (e) { this.socket.destroy(e); return; }
    }
  }
  call(op, fields = {}) {
    if (this.socket.destroyed) return Promise.reject(Error('Keeper is disconnected.'));
    const id = ++this.counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(id); reject(Error('Keeper request timed out; nothing will be retried.')); }, 5000);
      this.requests.set(id, { resolve, reject, timer, op, fields }); this.socket.write(frame(1, Buffer.from(JSON.stringify({ ...fields, v: 1, op, id }))));
    });
  }
  write(channel, data) {
    const p = Buffer.alloc(4); p.writeUInt32BE(channel); const bytes = Buffer.from(data, 'utf8');
    if (bytes.length > 60000 || this.socket.writableLength > 256 * 1024) return false;
    this.socket.write(frame(2, Buffer.concat([p, bytes]))); return true;
  }
  close() { this.socket.end(); }
  static async connect({ socketPath, native, development, team, minimum = 1 }) {
    const fd = native.connectVerified(socketPath, development, team, minimum);
    const client = new KeeperClient(new net.Socket({ fd, readable: true, writable: true }));
    try {
      const hello = await client.call('hello', { minor: 0, app: 'terminal', version: '0.1.0' });
      if (hello.welcome?.role !== 'driver') throw Error('Keeper did not grant the Terminal driver role.');
      return client;
    } catch (error) { client.close(); throw error; }
  }
}
module.exports = { KeeperClient, frame };
