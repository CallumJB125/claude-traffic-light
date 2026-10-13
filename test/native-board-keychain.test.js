'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function production({available=true,platform='darwin',backend='keychain'}={}){
 const src=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8'),at=src.indexOf('let nativeBoardService = null;');
 const body=src.slice(at,src.indexOf('const fromNativeBoardSettings',at));
 const seen={availability:0,encrypt:0,decrypt:0,creates:0};let options;
 const context={path,process:{platform},os:{homedir:()=>'/fixture'},IS_DEV_RUN:true,HOOK_PATHS:{},__dirname:'/fixture/app',app:{getPath:()=>'/fixture/user-data'},getBuddy:()=>({nativeBoardContext:()=>null,nativeBoardWorkspaces:()=>[]}),
  require:()=>({safeStorage:{isEncryptionAvailable:()=>{seen.availability++;return available;},getSelectedStorageBackend:()=>backend,encryptString:s=>{seen.encrypt++;return Buffer.from(s);},decryptString:b=>{seen.decrypt++;return b.toString();}}}),
  NativeBoard:{createService:o=>{seen.creates++;options=o;return {status:()=>({ok:true,connections:[]})};}}};
 vm.createContext(context);vm.runInContext(`${body}\nthis.getService = getNativeBoard;`,context);
 return {get:context.getService,seen,options:()=>options};
}
test('production empty connector status does not request a Keychain key and retains one private service',()=>{
 const f=production();assert.equal(f.get().status().ok,true);assert.equal(f.get().status().ok,true);
 assert.deepEqual(f.seen,{availability:0,encrypt:0,decrypt:0,creates:1});
});
test('production actual connector seal and unseal each require OS encryption availability',()=>{
 const f=production();f.get();assert.deepEqual(f.options().seal('synthetic'),Buffer.from('synthetic'));assert.equal(f.options().unseal(Buffer.from('synthetic')),'synthetic');
 assert.deepEqual(f.seen,{availability:2,encrypt:1,decrypt:1,creates:1});
});
test('unavailable OS encryption and Linux plaintext backend refuse before any crypto operation',()=>{
 for(const options of [{available:false},{platform:'linux',backend:'basic_text'}]){
  const f=production(options);f.get();assert.throws(()=>f.options().seal('synthetic'),/Secure account storage is unavailable/);assert.throws(()=>f.options().unseal(Buffer.from('synthetic')),/Secure account storage is unavailable/);
  assert.deepEqual(f.seen,{availability:2,encrypt:0,decrypt:0,creates:1});
 }
});
