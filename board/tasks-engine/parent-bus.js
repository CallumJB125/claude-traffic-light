// Main's note ops over the Electron utilityProcess parentPort (PR B, closing PR #37's R1 residual): a same-user
// process can reach tasks.sock (and could stand in for it), but never this process's parentPort. So the note ops
// (MAIN_ONLY) come only this way, and the socket refuses them whatever a frame says.
//
// One request: {type:'tasks.bus', id, op, args}, answered {type:'tasks.busResult', id, ok, result} or
// {type:'tasks.busResult', id, ok:false, code}. Only a fixed code crosses back, never an error's message (it can
// carry SQLite text or a path).
import { ApiError, MAIN_ONLY } from './engine.js';

export const BUS_REQUEST = 'tasks.bus';
export const BUS_RESULT = 'tasks.busResult';
const CODES = new Set(['POLICY_DENIED', 'VALIDATION', 'HALTED', 'RATE', 'INTERNAL']);
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** engine: the TasksEngine (or null before it starts); data: the message's data. A reply, or null to ignore it. */
export async function parentBus(engine, data) {
  if (!data || typeof data !== 'object' || data.type !== BUS_REQUEST || typeof data.id !== 'string' || !ID.test(data.id)) return null;
  const reply = (body) => ({ type: BUS_RESULT, id: data.id, ...body });
  if (typeof data.op !== 'string' || !MAIN_ONLY.has(data.op)) return reply({ ok: false, code: 'VALIDATION' });
  const args = data.args === undefined ? {} : data.args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return reply({ ok: false, code: 'VALIDATION' });
  if (!engine) return reply({ ok: false, code: 'INTERNAL' });
  try {
    // parentPort data is a structured clone: plain data, no prototypes or getters from main.
    const result = await engine.bus({ op: data.op, args, caller: null }, { viaParent: true });
    return reply({ ok: true, result });
  } catch (e) {
    return reply({ ok: false, code: e instanceof ApiError && CODES.has(e.code) ? e.code : 'INTERNAL' });
  }
}
