import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('hosted board-only source can import remote collaboration without any desktop files',()=>{
 const root=fileURLToPath(new URL('../../..',import.meta.url)),dir=mkdtempSync(join(tmpdir(),'plexiform-remote-hosted-'));
 try{
  const files=execFileSync('git',['ls-files','-z','--cached','--others','--exclude-standard','--','board'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
  for(const relative of files){const target=join(dir,relative);mkdirSync(dirname(target),{recursive:true});copyFileSync(join(root,relative),target);}
  assert.equal(existsSync(join(dir,'native-board')),false);
  symlinkSync(join(root,'board/node_modules'),join(dir,'board/node_modules'),'dir');
  const module=pathToFileURL(join(dir,'board/hub/remote/actions.js')).href,shared=pathToFileURL(join(dir,'board/shared/collaboration-tools.cjs')).href,http=pathToFileURL(join(dir,'board/hub/remote/http.js')).href;
  const code='const a=await import(process.argv[1]);const s=await import(process.argv[2]);const h=await import(process.argv[3]);const tools=s.default.listTools("collaborate");if(typeof a.RemoteActions!=="function"||tools.length!==12||!tools.some(t=>t.name==="plexiform_get_work_context"&&t.annotations.readOnlyHint)||typeof h.createRemoteHttp!=="function")process.exit(2);';
  execFileSync(process.execPath,['--input-type=module','-e',code,module,shared,http],{cwd:dir,env:{PATH:process.env.PATH,NODE_NO_WARNINGS:'1'},stdio:'pipe',timeout:10000});
 }finally{rmSync(dir,{recursive:true,force:true});}
});
