'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),{spawnSync,execFileSync}=require('node:child_process');
const {fixture}=require('./helpers/setups-transactions');
const {TARGETS,FILE_BYTES,recipeFor,recipeById,profile,readRegular,observeTarget,mergeJSON,jsonObject}=require('../src/borrow/transaction-targets');

test('closed target tuple map rejects encoded, extracted, directory, wrong format and platform aliases',()=>{
  const good={source_id:'codex',relative_path:'.codex/AGENTS.md',format:'text'};
  assert.equal(recipeFor(good,'darwin').id,'codex-instructions-v1');
  for(const relative of ['.codex/%41GENTS.md','.codex/../AGENTS.md','/.codex/AGENTS.md','.codex\\AGENTS.md','.codex/ＡGENTS.md','.codex/AGENTS.md#url'])assert.equal(recipeFor({...good,relative_path:relative},'darwin'),null);
  assert.equal(recipeFor({...good,format:'shell'},'darwin'),null);
  assert.equal(recipeFor({source_id:'claude-code',relative_path:'.claude.json#mcpServers',format:'json'},'darwin'),null);
  assert.equal(recipeFor({source_id:'codex',relative_path:'.codex/prompts/start.md',format:'text'},'darwin'),null);
  assert.equal(recipeFor({source_id:'ghostty',relative_path:'.config/ghostty/config',format:'text'},'win32'),null);
  assert.ok(Object.isFrozen(TARGETS));assert.ok(TARGETS.every(Object.isFrozen));
});
test('JSON merge preserves all untouched local bytes and keeps conflicts by default',()=>{
  const before='{\r\n  "owned" : { "level": 1e2 },\r\n  "theme" : "light"\r\n}\r\n';
  const result=mergeJSON(before,'{"theme":"dark","added":true}');
  assert.deepEqual(result.conflicts,['theme']);assert.match(result.content,/"owned" : \{ "level": 1e2 \}/);
  assert.match(result.content,/"theme" : "light"/);assert.ok(result.content.endsWith('\r\n}\r\n'));
  assert.deepEqual(JSON.parse(result.content),{owned:{level:100},theme:'light',added:true});
});
test('explicit JSON conflict replacement edits only the selected value range',()=>{
  const before='{ "foreign" : [ 1, 2 ], "theme" : "light" }';
  assert.equal(mergeJSON(before,'{"theme":"dark"}',['theme']).content,'{ "foreign" : [ 1, 2 ], "theme" : "dark" }');
});
test('nested objects and arrays are atomic conflict values',()=>{
  const result=mergeJSON('{"tools":{"own":1},"list":[1,2]}','{"tools":{"other":2},"list":[3]}');
  assert.equal(result.content,'{"tools":{"own":1},"list":[1,2]}');assert.deepEqual(result.conflicts,['list','tools']);
});
test('empty and compact JSON insertion is valid without deleting original whitespace',()=>{
  for(const before of ['{}','{ }','{\n}','{\r\n}',' {"own":1} \n']){
    const result=mergeJSON(before,'{"new":"hello"}');assert.equal(JSON.parse(result.content).new,'hello');
    if(before.includes('"own"'))assert.match(result.content,/"own":1/);
  }
});
test('duplicate decoded JSON keys, nonfinite numbers, invalid structures and unknown replace keys refuse',()=>{
  for(const text of ['{"name":1,"na\\u006de":2}','{"nested":{"x":1,"x":2}}','{"x":1e999}','[]','{"x":1,}'])assert.throws(()=>jsonObject(text));
  assert.throws(()=>mergeJSON('{}','{"x":1}',['foreign']));assert.throws(()=>mergeJSON('{}','{"x":1}',['x','x']));
  assert.throws(()=>mergeJSON('{}',JSON.stringify({huge:'x'.repeat(FILE_BYTES)})));
});
test('JSON __proto__ is data and cannot mutate object prototypes',()=>{
  const result=mergeJSON('{}','{"__proto__":{"polluted":true}}');
  assert.ok(Object.hasOwn(JSON.parse(result.content),'__proto__'));assert.equal({}.polluted,undefined);
});
test('regular reader supports exact empty and CRLF file bytes',t=>{
  const f=fixture(t,{before:''});assert.deepEqual(readRegular(f.filename).bytes,Buffer.alloc(0));
  fs.writeFileSync(f.filename,'one\r\ntwo\r\n');assert.equal(readRegular(f.filename).bytes.toString(),'one\r\ntwo\r\n');
});
test('missing fixed target observation never creates target directories',t=>{
  const f=fixture(t,{before:null}),captured=profile(f.home,process.platform,String(process.getuid?.()??'windows-fixture'));
  const result=observeTarget(captured,recipeById('codex-instructions-v1'));
  assert.equal(result.exists,false);assert.equal(fs.existsSync(path.join(f.home,'.codex')),false);assert.deepEqual(result.bytes,Buffer.alloc(0));
});
test('target hardlinks, child-directory symlinks and nonregular leaves refuse without altering originals',t=>{
  const f=fixture(t),captured=()=>profile(f.home,process.platform,String(process.getuid?.()??'windows-fixture')),recipe=recipeById('codex-instructions-v1');
  const linked=path.join(f.temp,'linked');fs.linkSync(f.filename,linked);assert.throws(()=>observeTarget(captured(),recipe));assert.equal(fs.readFileSync(linked,'utf8'),'Keep existing notes.\n');fs.unlinkSync(linked);
  fs.renameSync(path.dirname(f.filename),path.join(f.home,'preserved'));fs.symlinkSync(path.join(f.home,'preserved'),path.dirname(f.filename));assert.throws(()=>observeTarget(captured(),recipe));
  fs.unlinkSync(path.dirname(f.filename));fs.mkdirSync(path.dirname(f.filename),{mode:0o700});fs.mkdirSync(f.filename);assert.throws(()=>observeTarget(captured(),recipe));
});
test('parent retarget during an actual read refuses and preserves the displaced local file',t=>{
  const f=fixture(t),captured=profile(f.home,process.platform,String(process.getuid?.()??'windows-fixture'));let changed=false;
  const api=new Proxy(fs,{get(target,key){if(key==='readSync')return (...args)=>{const n=target.readSync(...args);if(!changed){changed=true;fs.renameSync(path.dirname(f.filename),path.join(f.home,'preserved'));fs.mkdirSync(path.dirname(f.filename),{mode:0o700});fs.writeFileSync(f.filename,'Keep existing notes.\n');}return n;};return target[key];}});
  assert.throws(()=>observeTarget(captured,recipeById('codex-instructions-v1'),api));
  assert.equal(fs.readFileSync(path.join(f.home,'preserved','AGENTS.md'),'utf8'),'Keep existing notes.\n');
});
test('actual FIFO replacement cannot hang the new bounded reader or read the pipe',t=>{
  const f=fixture(t);
  if(process.platform==='win32'){assert.throws(()=>readRegular(f.filename));return;}
  const modulePath=path.resolve(__dirname,'../src/borrow/transaction-targets.js');
  const code=`const fs=require('node:fs'),cp=require('node:child_process');const {readRegular}=require(${JSON.stringify(modulePath)});const file=${JSON.stringify(f.filename)};let reads=0;const api=new Proxy(fs,{get(t,k){if(k==='openSync')return (...args)=>{fs.renameSync(file,file+'.preserved');cp.execFileSync('mkfifo',[file]);return t.openSync(...args);};if(k==='readSync')return (...args)=>{reads++;return t.readSync(...args);};return t[k];}});try{readRegular(file,262144,api);process.exitCode=2;}catch{if(reads!==0)process.exitCode=3;else process.stdout.write('refused-before-read');}`;
  const child=spawnSync(process.execPath,['-e',code],{timeout:1000,encoding:'utf8'});
  assert.equal(child.error,undefined);assert.equal(child.status,0);assert.equal(child.stdout,'refused-before-read');assert.equal(fs.readFileSync(f.filename+'.preserved','utf8'),'Keep existing notes.\n');
});
