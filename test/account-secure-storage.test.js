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
  return { native, calls, storage: createSecureStorage(native, platform), setAvailable: value => { available = value; } };
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
function vaultFixture(backend, { saved = null, available = true } = {}) {
  const {createAccountVault}=require('../buddy-window/account-vault');
  const f=fixture('linux',backend,available); const writes=[];
  let sealed=saved===null?null:Buffer.from(`sealed:${JSON.stringify(saved)}`),reads=0,removals=0;
  const io={existsSync:()=>sealed!==null,readFileSync:()=>{reads++;return sealed;},mkdirSync:()=>{},writeFileSync:(...args)=>writes.push(args),renameSync:()=>{sealed=writes.at(-1)[1];},rmSync:()=>{sealed=null;removals++;}};
  // Production Linux keeps the established secure backend guard. Its native
  // async provider is deliberately disabled until its fallback is attestable.
  const vault=createAccountVault({origin:'https://hub.example',file:'/fixture/accounts/fixture.bin',storage:{encryptAsync:async text=>f.storage.encrypt(text),decryptAsync:async bytes=>f.storage.decrypt(bytes)},io});
  return {...f, vault,writes,reads:()=>reads,removals:()=>removals};
}
test('account vault starts without Keychain calls and never writes with Linux basic_text', async () => {
  const f=vaultFixture('basic_text'); assert.equal(f.vault.load(),null); assert.deepEqual(f.calls,[]);
  await assert.rejects(f.vault.save({hub:'https://hub.example',token:'synthetic'}));
  assert.deepEqual(f.writes,[]); assert.deepEqual(f.calls,[]);
  const good=vaultFixture('gnome_libsecret'); await good.vault.save({hub:'https://hub.example',token:'synthetic'});
  assert.equal(good.writes.length,1); assert.equal(good.writes[0][2].mode,0o600);
  assert.ok(good.writes[0][1].toString().startsWith('sealed:'));
});
test('saved account survives temporarily unavailable OS storage and explicit clear remains signed out', async () => {
  const saved={hub:'https://hub.example',token:'synthetic',user:{id:'u'}};
  const f=vaultFixture('gnome_libsecret',{saved,available:false});
  assert.equal(f.vault.load(),null);
  await f.vault.retry();
  assert.equal(f.vault.load(),null);
  assert.equal(f.reads(),1,'only ciphertext is read while storage is unavailable');
  assert.deepEqual(f.calls,[]);
  assert.equal(f.removals(),0);
  f.setAvailable(true);
  assert.equal(f.vault.load(),null,'polling cannot repeat authorization');
  await f.vault.retry();
  assert.deepEqual(f.vault.load(),saved,'unlocking retries the saved credential without another sign-in');
  assert.equal(f.reads(),2);
  assert.deepEqual(f.calls,['decrypt']);
  f.vault.clear();
  f.setAvailable(false);
  f.setAvailable(true);
  assert.equal(f.vault.load(),null,'explicit sign-out cannot resurrect the old credential');
  assert.equal(f.removals(),1);
  assert.equal(f.reads(),2);
});
test('a transient native decryption failure can explicitly recover while wrong-hub credentials remain closed', async () => {
  const saved={hub:'https://hub.example',token:'synthetic'};
  const f=vaultFixture('gnome_libsecret',{saved});
  const decrypt=f.native.decryptString;
  let first=true;
  f.native.decryptString=bytes=>{if(first){first=false;throw Error('temporarily locked');}return decrypt(bytes);};
  assert.equal(f.vault.load(),null);
  await f.vault.retry();
  assert.equal(f.vault.load(),null);
  await f.vault.retry();
  assert.deepEqual(f.vault.load(),saved);
  assert.equal(f.removals(),0);
  const other=vaultFixture('gnome_libsecret',{saved:{...saved,hub:'https://other.example'}});
  assert.equal(other.vault.load(),null);
  await other.vault.retry();
  assert.equal(other.vault.load(),null);
  assert.equal(other.reads(),1,'a wrong-hub credential is never made usable');
});
test('temporary credential unavailability hides teams without losing the saved workspace on preference save', t => {
  const {createWorkspaceStore}=require('../buddy-window/workspaces');
  const dir=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'plexiform-workspace-unlock-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'workspaces.json'),hub='https://hub.example';
  const initial=createWorkspaceStore(file);
  initial.addHub(hub);initial.setTeams(hub,{teams:[{id:'team1',name:'Team',role:'owner'}]});
  initial.activateTeam(hub,'team1');
  const active=initial.activeId();let available=false;
  const store=createWorkspaceStore(file,{signedIn:()=>available});
  assert.equal(store.active().kind,'local');
  assert.deepEqual(store.list().map(w=>w.id),['local'],'signed-out team metadata does not expose a usable workspace');
  store.setSharesPresence(hub,true);
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).active,active);
  available=true;
  assert.equal(store.active().id,active);
  store.forgetTeams(hub);
  assert.equal(store.active().kind,'local','confirmed sign-out still forgets the team');
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).active,'local');
});
test('production runner uses the same secure backend guard for availability and cryptography', () => {
  const source=fs.readFileSync(path.join(__dirname,'../buddy-window/index.js'),'utf8');
  const start=source.indexOf('  function makeDevice(ws, { onStatus })'); assert.ok(start>=0);
  const body=source.slice(start,source.indexOf("  // A hub's sealed runner tokens",start));
  const f=fixture('linux','basic_text'); let options;
  const context={loginEnv:()=>null,safeStorage:f.native,fileKey:()=> 'fixture',fs:{mkdirSync:()=>{}},DEVICES_DIR:'/fixture/devices',createDeviceController:x=>(options=x),credentialStorage:f.storage,clientFor:()=>({}),deviceFile:()=>'/fixture/device.bin',path,app:{getAppPath:()=>'/fixture/app'},userData:'/fixture/data',log:()=>{},emitRunnerEvent:()=>{}};
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
