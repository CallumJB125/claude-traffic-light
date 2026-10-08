'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
test('Opted token-authenticated local model signal reports structured task/model only; browser request refuses',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'plex-overview-')),quits=[];
 const S=require('../src/signal-server')({rootDir:dir,sessionsDir:dir,requestsDir:dir,aggregateState:()=>({sessions:[]}),broadcastStatus:()=>{},port:0,app:{on:(_,fn)=>quits.push(fn)}});
 const server=S.startSignalServer();await new Promise(r=>server.once('listening',r));
 try{const url=`http://127.0.0.1:${server.address().port}/signal`,token=fs.readFileSync(path.join(dir,'token'),'utf8'),payload={source:'ollama',session:'selected-model',signal:'tool-use',model:'qwen3:8b',taskId:'task-1',taskTitle:'Build selected feature',prompt:'Private prompt must not be stored'};
  const r=await fetch(url,{method:'POST',headers:{'x-buddy-token':token,'Content-Type':'application/json'},body:JSON.stringify(payload)});assert.equal(r.status,200,await r.text());
  const files=fs.readdirSync(dir).filter(f=>f.endsWith('.json'));assert.equal(files.length,1);const raw=fs.readFileSync(path.join(dir,files[0]),'utf8'),row=JSON.parse(raw);assert.equal(row.model,'qwen3:8b');assert.equal(row.taskTitle,'Build selected feature');assert.equal(row.taskId,'task-1');assert(!raw.includes(payload.prompt));
  const denied=await fetch(url,{method:'POST',headers:{'x-buddy-token':token,Origin:'http://fixture.invalid'},body:JSON.stringify(payload)});assert.equal(denied.status,403);
 }finally{await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});
