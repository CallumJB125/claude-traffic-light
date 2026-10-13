// Separate inert execution preview and fixed human command shapes.039 stays
// unchanged; parsing a command never supplies launch or permission authority.
import { canonical, UUID, WORKFLOW_PLAN_LIMITS } from './workflow-execution.js';
import { packetRelativePath } from './packet-text.js';
export const EXECUTION_LIMITS=Object.freeze({...WORKFLOW_PLAN_LIMITS,paths:16,pathChars:200,attempts:8,receipts:128});
const bad=()=>{throw Object.assign(new Error('Check the closed workflow command and reviewed path/hash fields.'),{code:'VALIDATION'});};
const id=v=>typeof v==='string'&&UUID.test(v);
const hash=v=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
const revision=v=>Number.isSafeInteger(v)&&v>=0;
function closed(v,keys){if(!v||typeof v!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(v))
 ||Object.keys(v).some(k=>!keys.includes(k))||keys.some(k=>!Object.hasOwn(v,k)))bad();}
function bounded(v){if(new TextEncoder().encode(canonical(v)).byteLength>EXECUTION_LIMITS.bytes)bad();return v;}
export function declaredPaths(value){
 if(!Array.isArray(value)||!value.length||value.length>8)bad();
 return value.map((s,position)=>{closed(s,['position','paths']);if(s.position!==position||!Array.isArray(s.paths)||s.paths.length>16)bad();
  const paths=s.paths.map(value=>{if(typeof value!=='string'||value.length>200)bad();const p=packetRelativePath(value);
   if(!p||/[\s<>"'`;&|{}()[\]#]/u.test(p)||(/[*?]/.test(p)&&!(p.endsWith('/**')&&!/[*?]/.test(p.slice(0,-3)))))bad();return p;});
  if(new Set(paths).size!==paths.length)bad();return {position,paths:paths.sort()};
 });
}
export function validateExecutionPreview(body){
 closed(body,['request_id','plan_hash','purpose','declared_paths']);
 if(!id(body.request_id)||!hash(body.plan_hash)||body.purpose!=='start')bad();
 return bounded({...body,declared_paths:declaredPaths(body.declared_paths)});
}
export function validateControlPreview(body){
 const keys=['request_id','source_plan_id','plan_hash','expected_revision','purpose','declared_paths'];
 if(body?.purpose==='retry')keys.push('position','previous_attempt_id');closed(body,keys);
 if(!id(body.request_id)||!id(body.source_plan_id)||!hash(body.plan_hash)||!revision(body.expected_revision)
  ||!['resume','retry'].includes(body.purpose)||body.purpose==='retry'&&(!id(body.previous_attempt_id)||!Number.isInteger(body.position)||body.position<0||body.position>7))bad();
 return bounded({...body,declared_paths:declaredPaths(body.declared_paths)});
}
export function validateCommand(kind,body){
 let keys=['request_id','expected_revision'];
 if(['start','resume','retry'].includes(kind))keys.push('execution_preview_id','execution_preview_hash','path_intent_hash','confirm');
 else if(!['pause','cancel'].includes(kind))bad();
 if(kind==='start')keys.push('plan_hash');if(kind==='retry')keys.push('previous_attempt_id');closed(body,keys);
 if(!id(body.request_id)||!revision(body.expected_revision)||kind==='start'&&body.expected_revision!==0)bad();
 if(['start','resume','retry'].includes(kind)&&(!id(body.execution_preview_id)||!hash(body.execution_preview_hash)||!hash(body.path_intent_hash)||body.confirm!==true))bad();
 if(kind==='start'&&!hash(body.plan_hash)||kind==='retry'&&!id(body.previous_attempt_id))bad();return bounded({...body});
}
// Conservative advisory segment overlap; it never opens/locks a filesystem.
export function pathOverlap(a,b){const clean=p=>p.replace(/\/\*\*$/,'');a=clean(a);b=clean(b);return a===b||a.startsWith(b+'/')||b.startsWith(a+'/');}
