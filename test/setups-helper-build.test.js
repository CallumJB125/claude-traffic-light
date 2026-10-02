'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const ROOT=path.join(__dirname,'..');
test('Setups helper has no inherited Electron/calendar entitlements',()=>{
 const sign=require('../build/sign'),base={entitlements:'/fixture/electron.plist',hardenedRuntime:true},select=sign.withHelperEntitlements(()=>base);
 assert.equal(select('/fixture/app/Contents/Resources/setups/buddy-setups').entitlements,sign.SETUPS_ENTITLEMENTS);
 assert.equal(select('/fixture/app/Contents/Resources/calendar-helper/buddy-calendar').entitlements,sign.HELPER_ENTITLEMENTS);
 assert.deepEqual(select('/fixture/app/Contents/MacOS/Plexiform'),base);
 const plist=fs.readFileSync(sign.SETUPS_ENTITLEMENTS,'utf8');assert.match(plist,/<dict\s*\/>/);assert.doesNotMatch(plist,/<key>/);
});
test('build provenance binds every production C module, all headers and unsigned binary bytes',t=>{
 const {manifest,modules}=require('../scripts/setups-helper-manifest'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'pf-build-provenance-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const input=path.join(dir,'native/setups-targets'),stage=path.join(dir,'stage');fs.mkdirSync(input,{recursive:true});fs.mkdirSync(stage);
 for(const name of modules)fs.writeFileSync(path.join(input,`${name}.c`),`/* synthetic ${name} */`);
 fs.writeFileSync(path.join(input,'protocol.h'),'/* synthetic header1 */');fs.writeFileSync(path.join(stage,'buddy-setups'),'synthetic executable');
 const a=manifest(dir,stage);assert.equal(a.source.length,12);assert.equal(a.protocol,3);assert.equal(a.minimumOS,'12.0');assert.deepEqual(a.architectures,['arm64','x86_64']);
 fs.writeFileSync(path.join(input,'protocol.h'),'/* synthetic header2 */');const b=manifest(dir,stage);
 assert.notEqual(a.source.find(x=>x.file.endsWith('protocol.h')).sha256,b.source.find(x=>x.file.endsWith('protocol.h')).sha256);assert.equal(a.preSignBinarySha256,b.preSignBinarySha256);
 fs.writeFileSync(path.join(stage,'buddy-setups'),'changed synthetic executable');assert.notEqual(b.preSignBinarySha256,manifest(dir,stage).preSignBinarySha256);
 fs.unlinkSync(path.join(input,'writer.c'));assert.throws(()=>manifest(dir,stage));
});
test('packaging includes only fixed Setups helper resources and Mac runtime acceptance is a required gate',()=>{
 const pkg=require('../package.json'),entry=pkg.build.mac.extraResources.find(e=>e.to==='setups');assert.deepEqual(entry,{from:'native/setups-build',to:'setups',filter:['buddy-setups','helper-manifest.json']});
 const yaml=require('js-yaml'),doc=yaml.load(fs.readFileSync(path.join(ROOT,'.github/workflows/release.yml'),'utf8'));
 const step=doc.jobs.build.steps.find(s=>s.name==='Native Setups helper and runtime acceptance (Mac)');assert.ok(step);assert.equal(step.if,"matrix.platform == 'mac'");assert.equal(step['timeout-minutes'],5);assert.equal(step['continue-on-error'],undefined);assert.match(step.run,/npm run test:native-darwin/);
 assert.match(pkg.scripts['test:native-darwin'],/test\/native-darwin\/\*\.test\.js/);assert.match(pkg.scripts['test:native-darwin'],/PLEXIFORM_TEST_HELPER=\$PWD\/native\/setups-build\/buddy-setups/);
 const script=fs.readFileSync(path.join(ROOT,'scripts/build-setups-helper.sh'),'utf8');assert.doesNotMatch(script,/-DPF_.*TEST/);assert.match(script,/-Wall -Wextra -Werror -pedantic/);assert.match(script,/for pf_setups_arch in arm64 x86_64/);
 for(const name of ['setups-native-codec','setups-native-supervisor','setups-transaction-journal','setups-transaction-controller'])assert.ok(fs.existsSync(path.join(ROOT,`test/native-darwin/${name}.test.js`)));
});
