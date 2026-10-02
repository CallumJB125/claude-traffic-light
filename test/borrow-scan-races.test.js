'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const {spawnSync} = require('node:child_process');
const {scan} = require('../src/borrow/scan.js');
const scanner = require.resolve('../src/borrow/scan.js');

function fixture(t) {
  const targetHome = fs.mkdtempSync(path.join(os.tmpdir(), 'setups-scan-races-'));
  t.after(() => fs.rmSync(targetHome, {recursive:true, force:true}));
  fs.mkdirSync(path.join(targetHome, '.codex'));
  return targetHome;
}

for (const boundary of ['file-fifo', 'file-directory', 'file-symlink', 'file-regular', 'directory-fifo', 'directory-file', 'directory-symlink']) {
  test(`actual scanner child refuses ${boundary} replacement within the original one-second bound`, t => {
    const targetHome = fixture(t), directory = boundary.startsWith('directory-');
    const target = path.join(targetHome, directory ? '.codex/prompts' : '.codex/AGENTS.md');
    if (directory) fs.mkdirSync(target); else fs.writeFileSync(target, 'Synthetic original, never executed.');
    const replacement = path.join(targetHome, 'replacement');
    if (boundary.endsWith('fifo')) assert.equal(spawnSync('/usr/bin/mkfifo', [replacement], {shell:false, timeout:1000}).status, 0);
    if (boundary.endsWith('directory')) fs.mkdirSync(replacement);
    if (boundary.endsWith('regular') || boundary === 'directory-file') fs.writeFileSync(replacement, 'Synthetic different file.');
    if (boundary.endsWith('symlink')) {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'setups-scan-outside-'));
      t.after(() => fs.rmSync(outside, {recursive:true, force:true}));
      if (!directory) fs.writeFileSync(path.join(outside, 'foreign.md'), 'Outside synthetic text.');
      fs.symlinkSync(directory ? outside : path.join(outside, 'foreign.md'), replacement);
    }
    const code = String.raw`const fs=require('node:fs');const {scan}=require(process.argv[1]);const [home,target,replacement,directory]=process.argv.slice(2);let changed=false,reads=0;const api=new Proxy(fs,{get(object,key){if(key===(directory==='true'?'readdirSync':'openSync'))return(...args)=>{if(!changed){changed=true;fs.renameSync(target,target+'.preserved');fs.renameSync(replacement,target);}return object[key](...args);};if(key==='readSync')return(...args)=>{reads++;return object.readSync(...args);};return object[key];}});const result=scan({home,only:['codex'],exec:null,fsApi:api});const files=result.sources.flatMap(source=>source.files);process.stdout.write(JSON.stringify({changed,reads,files:files.length}));process.exitCode=changed&&reads===0&&files.length===0?0:2;`;
    const child = spawnSync(process.execPath, ['-e', code, scanner, targetHome, target, replacement, String(directory)], {shell:false, encoding:'utf8', timeout:1000, maxBuffer:4096});
    assert.equal(child.status, 0, JSON.stringify({boundary, status:child.status, signal:child.signal, error:child.error?.code, stdout:child.stdout, stderr:child.stderr}));
    assert.deepEqual(JSON.parse(child.stdout), {changed:true, reads:0, files:0});
    assert.ok(fs.existsSync(target+'.preserved'), 'original remains intact');
  });
}

for (const [flag, value] of [['O_NOFOLLOW', undefined], ['O_NOFOLLOW', 0], ['O_NONBLOCK', undefined], ['O_NONBLOCK', 0]]) {
  test(`missing ${flag}=${String(value)} fails closed before open rather than weakening file protection`, t => {
    const targetHome = fixture(t), target = path.join(targetHome, '.codex/AGENTS.md');
    fs.writeFileSync(target, 'Synthetic normal source.');
    const required = createRequire(scanner), source = fs.readFileSync(scanner, 'utf8');
    const module = {exports:{}};
    vm.runInNewContext(source, {module, exports:module.exports, Buffer, process,
      require:name => name === 'fs' ? {...fs, constants:{...fs.constants, [flag]:value}} : required(name),
    }, {filename:scanner});
    let opened = 0, reads = 0;
    const fsApi = new Proxy(fs, {get(object, key) {
      if (key === 'openSync') return (...args) => {opened++; return object.openSync(...args);};
      if (key === 'readSync') return (...args) => {reads++; return object.readSync(...args);};
      return object[key];
    }});
    const result = module.exports.scan({home:targetHome, only:['codex'], exec:null, fsApi});
    assert.equal(opened, 0); assert.equal(reads, 0);
    assert.equal(result.sources.flatMap(source => source.files).length, 0);
    assert.equal(result.lookedAt.find(item => item.path === '~/.codex/AGENTS.md').reason, 'safe nonblocking file reads are unavailable on this platform');
    assert.equal(fs.readFileSync(target, 'utf8'), 'Synthetic normal source.');
  });
}

test('unchanged single-link files still use real no-follow/nonblocking opens and preserve bytes', t => {
  const targetHome = fixture(t), target = path.join(targetHome, '.codex/AGENTS.md');
  const content = 'Synthetic observed instructions.\r\nNo tool is executed.\r\n';
  fs.writeFileSync(target, content);
  const flags = [];
  const fsApi = new Proxy(fs, {get(object, key) {
    if (key === 'openSync') return (...args) => {flags.push(args[1]); return object.openSync(...args);};
    return object[key];
  }});
  const result = scan({home:targetHome, only:['codex'], exec:null, fsApi});
  assert.equal(result.sources.flatMap(source => source.files)[0].content, content);
  assert.equal(flags.length, 1);
  assert.ok(flags[0] & fs.constants.O_NOFOLLOW); assert.ok(flags[0] & fs.constants.O_NONBLOCK);
  assert.equal(fs.readFileSync(target, 'utf8'), content);
});
