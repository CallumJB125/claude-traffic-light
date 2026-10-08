'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createSecureStorage, storageHelp } = require('../buddy-window/secure-storage');
function fixture(platform, backend, available = true) {
  const calls = [];
  const native = { isEncryptionAvailable: () => available, getSelectedStorageBackend: () => backend,
    encryptString: text => { calls.push('encrypt'); return Buffer.from(`sealed:${text}`); },
    decryptString: bytes => { calls.push('decrypt'); return bytes.toString().slice(7); } };
  return { native, calls, storage: createSecureStorage(native, platform) };
}
test('credential storage refuses missing, plaintext and unrecognized Linux backends before reading or writing credentials', () => {
  for (const backend of ['basic_text', undefined, '', 'unknown']) {
    const f = fixture('linux', backend);
    assert.equal(f.storage.available(), false);
    assert.throws(() => f.storage.encrypt('synthetic'), /secure password store/);
    assert.throws(() => f.storage.decrypt(Buffer.from('synthetic')), /secure password store/);
    assert.deepEqual(f.calls, []);
  }
});
test('supported OS stores allow native encryption and decryption only on demand', () => {
  for (const [platform, backend] of [['darwin','keychain'],['win32','dpapi'],...['gnome_libsecret','kwallet','kwallet5','kwallet6'].map(b=>['linux',b])]) {
    const f=fixture(platform,backend); assert.deepEqual(f.calls,[]);
    assert.equal(f.storage.available(),true); assert.deepEqual(f.calls,[]);
    const bytes=f.storage.encrypt('synthetic'); assert.equal(f.storage.decrypt(bytes),'synthetic');
    assert.deepEqual(f.calls,['encrypt','decrypt']);
  }
});
test('unavailable or throwing OS store stays closed and gives graphical recovery guidance', () => {
  for(const platform of ['darwin','linux','win32']) {
    const f=fixture(platform,'keychain',false);
    assert.throws(()=>f.storage.encrypt('synthetic')); assert.throws(()=>f.storage.decrypt(Buffer.from('synthetic')));
    assert.deepEqual(f.calls,[]);
  }
  const f=createSecureStorage({isEncryptionAvailable(){throw Error('private native detail');}},'darwin');
  assert.equal(f.available(),false); assert.throws(()=>f.encrypt('synthetic'),/Keychain Access/);
  assert.match(storageHelp('linux'),/Passwords and Keys or KWallet/);
});
function vaultFixture(backend) {
  const source=fs.readFileSync(path.join(__dirname,'../buddy-window/index.js'),'utf8');
  const start=source.indexOf('  const credentialStorage = createSecureStorage(safeStorage);');
  assert.ok(start>=0);
  const body=source.slice(start,source.indexOf('  const signedIn =',start));
  const f=fixture('linux',backend); const writes=[];
  const context={safeStorage:f.native,createSecureStorage:s=>createSecureStorage(s,'linux'),Map,JSON,process:{pid:1},path,ACCOUNTS_DIR:'/fixture/accounts',fileKey:()=> 'fixture',log:()=>{},fs:{existsSync:()=>false,mkdirSync:()=>{},writeFileSync:(...args)=>writes.push(args),renameSync:()=>{},rmSync:()=>{}}};
  vm.createContext(context); vm.runInContext(`${body}\nthis.result = vault('https://hub.example');`,context);
  return {...f, vault:context.result,writes};
}
test('production account vault starts without Keychain calls and never writes with Linux basic_text', () => {
  const f=vaultFixture('basic_text'); assert.equal(f.vault.load(),null); assert.deepEqual(f.calls,[]);
  assert.throws(()=>f.vault.save({hub:'https://hub.example',token:'synthetic'}));
  assert.deepEqual(f.writes,[]); assert.deepEqual(f.calls,[]);
  const good=vaultFixture('gnome_libsecret'); good.vault.save({hub:'https://hub.example',token:'synthetic'});
  assert.equal(good.writes.length,1); assert.equal(good.writes[0][2].mode,0o600);
  assert.ok(good.writes[0][1].toString().startsWith('sealed:'));
});
test('production runner uses the same secure backend guard for availability and cryptography', () => {
  const source=fs.readFileSync(path.join(__dirname,'../buddy-window/index.js'),'utf8');
  const start=source.indexOf('  function makeDevice(ws, { onStatus })'); assert.ok(start>=0);
  const body=source.slice(start,source.indexOf("  // A hub's sealed runner tokens",start));
  const f=fixture('linux','basic_text'); let options;
  const context={safeStorage:f.native,fileKey:()=> 'fixture',fs:{mkdirSync:()=>{}},DEVICES_DIR:'/fixture/devices',createDeviceController:x=>(options=x),credentialStorage:f.storage,clientFor:()=>({}),deviceFile:()=>'/fixture/device.bin',path,app:{getAppPath:()=>'/fixture/app'},userData:'/fixture/data',log:()=>{},emitRunnerEvent:()=>{}};
  vm.createContext(context);vm.runInContext(`${body}\nmakeDevice({hub:'https://hub.example',teamId:'team'}, {onStatus:()=>{}});`,context);
  assert.equal(options.canSeal(),false);assert.throws(()=>options.seal('synthetic'));assert.throws(()=>options.unseal(Buffer.from('synthetic')));assert.deepEqual(f.calls,[]);
});
test('failed account storage leaves sign-in unsuccessful and shows recovery in the app without native error details',async()=>{
  const {createAccountClient}=require('../buddy-window/accounts');
  const client=createAccountClient({origin:'https://hub.example',store:{load:()=>null,save:()=>{throw Error('private path or native error');}},fetchImpl:async url=>({status:200,json:async()=>url.endsWith('/start')?{flow_id:'fixture'}:{device_token:'synthetic',user:{id:'u'}}})});
  assert.equal((await client.startEmail('person@example.com')).ok,true);
  const result=await client.verifyCode('123456');assert.equal(result.ok,false);
  assert.match(result.error,/Plexiform couldn’t save your sign-in securely/);
  assert.ok(result.error.includes(storageHelp()));assert.doesNotMatch(result.error,/private path/);assert.equal(client.signedIn(),false);
});
