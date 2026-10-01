// Import the real engine without constructing it or starting any backend.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const board = fileURLToPath(new URL('../../', import.meta.url));

test('engine imports its complete schema from an escaped installation directory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-module-'));
  try {
    const fixture = path.join(root, 'Plexiform space #100% café');
    const engineDir = path.join(fixture, 'tasks-engine');
    fs.mkdirSync(engineDir, { recursive: true });
    fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ type: 'module' }));
    // Existing source and dependencies stay read-only. Junctions also let the
    // same import fixture run on Windows without symbolic-link privileges.
    for (const name of ['tasks-api', 'shared', 'runner', 'mcp']) {
      fs.symlinkSync(path.join(board, name), path.join(fixture, name), process.platform === 'win32' ? 'junction' : 'dir');
    }
    const engineFile = path.join(engineDir, 'engine.js');
    for (const name of fs.readdirSync(path.join(board, 'tasks-engine'))) {
      if (name.endsWith('.js')) fs.copyFileSync(path.join(board, 'tasks-engine', name), path.join(engineDir, name));
    }
    const imported = await import(pathToFileURL(engineFile).href);
    assert.equal(typeof imported.TasksEngine, 'function');
    assert.deepEqual(imported.SCHEMA, JSON.parse(fs.readFileSync(path.join(board, 'tasks-api', 'schema.json'), 'utf8')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Node decodes escaped Windows drive file URLs into native schema paths', () => {
  const url = new URL('file:///D:/Plexiform%20%23100%25%20caf%C3%A9/board/tasks-engine/engine.js');
  const decoded = fileURLToPath(url, { windows: true });
  assert.equal(decoded, 'D:\\Plexiform #100% café\\board\\tasks-engine\\engine.js');
  assert.equal(path.win32.join(path.win32.dirname(decoded), '..', 'tasks-api', 'schema.json'),
    'D:\\Plexiform #100% café\\board\\tasks-api\\schema.json');
});

test('Node retains a Windows UNC share when decoding an escaped engine file URL', () => {
  const url = new URL('file://fixture-server/fixture-share/Plexiform%20%23100%25/board/tasks-engine/engine.js');
  const decoded = fileURLToPath(url, { windows: true });
  assert.equal(decoded, '\\\\fixture-server\\fixture-share\\Plexiform #100%\\board\\tasks-engine\\engine.js');
  assert.equal(path.win32.join(path.win32.dirname(decoded), '..', 'tasks-api', 'schema.json'),
    '\\\\fixture-server\\fixture-share\\Plexiform #100%\\board\\tasks-api\\schema.json');
});
