import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {lstartOf,sameProcess,killTree} from '../procs.js';

const identityModule=new URL('../procs.js',import.meta.url).href;
function identityIn(pid,TZ,LC_ALL) {
  return JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',`const {lstartOf}=await import(process.argv[1]);process.stdout.write(JSON.stringify(lstartOf(Number(process.argv[2]))));`,identityModule,String(pid)],{
    env:{PATH:process.env.PATH,TZ,LC_ALL,LANG:LC_ALL},encoding:'utf8',timeout:5000,
  }));
}
test('start identity is fixed across timezone and locale; an unavailable native identity stays closed',()=>{
  const a=identityIn(process.pid,'UTC','C'),b=identityIn(process.pid,'Africa/Johannesburg','fr_FR.UTF-8'),c=identityIn(process.pid,'America/Los_Angeles','de_DE.UTF-8');
  assert.equal(a,b);assert.equal(a,c);
  if(process.platform==='win32'&&a===null){assert.equal(sameProcess(process.pid,a),false);return;}
  assert.ok(a);assert.equal(sameProcess(process.pid,a),true);
});
test('identity mismatch cannot kill a live child and a dead child never matches its recorded identity',async()=>{
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  const closed=new Promise(resolve=>child.once('close',resolve));
  try {
    const identity=lstartOf(child.pid);assert.equal(sameProcess(child.pid,'Thu Jan  1 00:00:00 1970'),false);
    assert.deepEqual(killTree(child.pid,'Thu Jan  1 00:00:00 1970'),{groups:[],pids:[]});assert.equal(child.exitCode,null);
    process.kill(child.pid,0);child.kill();await closed;assert.equal(sameProcess(child.pid,identity),false);
  }finally{if(child.exitCode===null&&child.signalCode===null){child.kill();await closed;}}
});
test('invalid process identities refuse without invoking a process query',()=>{
  for(const pid of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1,'1',null])assert.equal(lstartOf(pid),null);
});
