#!/usr/bin/env node
'use strict';
// Explicit self-declarations only; no hook synthesis or private chat reads.
// Usage: node scripts/report-agent-status.js --cwd <exact normalized folder>
//   --id <stable declared agent ID> --name <public name> --task <literal own scope>
//   --status working|waiting|done
// Every call is explicit. No recurring publisher or provider control is created.
const http = require('node:http'); // privacy-flow: agent-self-report
const crypto = require('node:crypto');
const path = require('node:path');
const os = require('node:os');
const Reports = require('../src/agent-self-report');
const Answer = require('../hooks/answer-file');
async function report(options, {rootDir = process.env.CLAUDE_TRAFFIC_LIGHT_HOME || path.join(os.homedir(),'.claude-traffic-light'), host = os.hostname().split('.')[0]} = {}) {
  const deadline = Date.now()+2000;
  const parent = Reports.select({sessionsDir:path.join(rootDir,'sessions'),host,cwd:options.cwd,deadline});
  if (!parent) return {ok:false,status:'unavailable'};
  const request = {schema:1,...parent,cwd:options.cwd,agentId:options.agentId,publicName:options.publicName,taskTitle:options.taskTitle,status:options.status};
  if (!Reports.requestValid(request)) return {ok:false,status:'invalid'};
  const token = Reports.readRegular(path.join(rootDir,'token'),64), rawPort = Reports.readRegular(path.join(rootDir,'port'),5);
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token) || typeof rawPort !== 'string' || !/^[0-9]{1,5}$/.test(rawPort)) return {ok:false,status:'unavailable'};
  const port=Number(rawPort); if (port<1 || port>65535) return {ok:false,status:'unavailable'};
  const send = (url,body,headers={}) => new Promise(resolve => {
    if (Date.now()>=deadline) return resolve(null);
    const bytes=Buffer.from(JSON.stringify(body)); let settled=false, req;
    const finish=x=>{if(settled)return;settled=true;clearTimeout(timer);resolve(x);};
    const timer=setTimeout(()=>{finish(null);req?.destroy();},Math.max(1,deadline-Date.now()));
    req=http.request({host:'127.0.0.1',port,path:url,method:'POST',headers:{'content-type':'application/json','content-length':bytes.length,...headers}},res=>{ // privacy-flow: agent-self-report
      const chunks=[];let size=0;
      res.on('data',chunk=>{size+=chunk.length;if(size>4096){finish(null);res.destroy();req.destroy();}else chunks.push(chunk);});
      res.on('error',()=>finish(null));res.on('end',()=>{let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{}finish({code:res.statusCode,value});});
    });
    req.on('error',()=>finish(null));req.end(bytes);
  });
  const nonce=crypto.randomBytes(32).toString('hex'),challenge=await send('/request-key/challenge',{nonce});
  const proof=challenge?.value?.proof, expected=Buffer.from(Answer.requestKeyProof(token,port,nonce),'hex');
  if(challenge?.code!==200 || typeof proof!=='string' || !/^[0-9a-f]{64}$/.test(proof) || !crypto.timingSafeEqual(Buffer.from(proof,'hex'),expected)) return {ok:false,status:'unavailable'};
  const result=await send('/metadata/agents',request,{'x-buddy-token':token});
  const status=result?.value?.status;
  if(result?.code===200 && result.value?.ok===true && status==='recorded') return {ok:true,status};
  return {ok:false,status:['invalid','stale','busy','full'].includes(status)?status:'unavailable'};
}
function parse(argv) {
  const names=['cwd','id','name','task','status'], values={};
  if(argv.length!==10)return null;
  for(let i=0;i<argv.length;i+=2){const key=argv[i].slice(2);if(argv[i]!==`--${key}`||!names.includes(key)||Object.hasOwn(values,key)||typeof argv[i+1]!=='string')return null;values[key]=argv[i+1];}
  return {cwd:values.cwd,agentId:values.id,publicName:values.name,taskTitle:values.task,status:values.status};
}
if(require.main===module){const options=parse(process.argv.slice(2));Promise.resolve(options?report(options):{ok:false,status:'invalid'}).catch(()=>({ok:false,status:'unavailable'})).then(result=>{process.stdout.write(`${result.status}\n`);process.exitCode=result.ok?0:1;});}
module.exports={report,parse};
