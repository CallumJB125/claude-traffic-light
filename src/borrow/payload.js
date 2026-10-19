// Private reviewed Setups schema. No browser/MCP/journal content registration.
'use strict';
const { createHash, randomBytes } = require('node:crypto');
const { SOURCES } = require('./registry.js');
const { blockedReason, fold } = require('./blocklist.js');
const { scrubFile, formatOf, looksRandom } = require('./scrub.js');
const { findSecrets } = require('../../board/shared/secret-patterns.mjs');
const SETUP_LIMITS = Object.freeze({ files:128, fileBytes:256*1024, profileBytes:2*1024*1024, items:1000, noteBytes:2048, versions:50, teamBytes:100*1024*1024, requests:2000 });
const SETUP_BODY_MAX = SETUP_LIMITS.profileBytes + 64*1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const PH = /\{\{(?:HOME|USER|HOSTNAME|NAME|EMAIL(?::\d+)?|IP:\d+|HOST:\d+|PRIVATE:\d+|SSH_USER|SECRET:[\w.-]{1,64})\}\}/g;
const sourceMap = new Map(SOURCES.map(source=>[source.id,source]));
const fail = () => { throw new Error('Setups payload is not valid reviewed content'); };
const closed = (value, fields) => { if (!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(key=>!fields.includes(key)) || fields.some(key=>!Object.hasOwn(value,key))) fail(); };
function canonical(value) { return JSON.stringify(value,(_key,item)=>item && typeof item==='object' && !Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item); }
const hash = value => createHash('sha256').update(typeof value==='string'?value:canonical(value)).digest('hex');
const fileHash = file => hash({schema:1,...file});
function reviewed(text, format, path='~/.setups-review') {
  if(typeof text!=='string' || text.includes('\0')) fail();
  // Placeholders are exempt only here. The original-input engine remains closed.
  // An unpredictable reference makes any additional engine redaction detectable.
  const marker='$PLEXIFORM_REVIEW_'+[...randomBytes(32)].map(byte=>'GHIJKLMNOPQRSTUVWXYZ'[byte%20]).join('');
  const replace = value => value.replace(PH, placeholder=>{ const name=placeholder.slice(2,-2).replace(/^SECRET:/,''); if(findSecrets(name,{docExamples:false}).length || looksRandom(name)) fail(); return placeholder==='{{HOME}}'?'$HOME':marker; });
  const masked=replace(text);
  if (/\{\{|\}\}|<redacted:|\[redacted\]/i.test(masked)) fail();
  const decoded=masked.replace(/(?:%[0-9a-f]{2})+/gi,part=>{try{return decodeURIComponent(part);}catch{return part;}});
  if (/(?:\/Users\/|\/home\/|[A-Za-z]:[\\/]Users[\\/])/i.test(decoded)) fail();
  const result=scrubFile({path,content:masked,format});
  if(result.status!=='ok' || replace(result.content)!==masked) fail();
}
function sourcePath(source, relative) {
  if(typeof relative!=='string' || relative.length<1 || relative.length>240 || /[\p{C}\\]/u.test(relative) || relative.startsWith('/') || relative.startsWith('~') || relative.split('/').some(part=>!part || part==='.' || part==='..')) fail();
  const full='~/'+relative;
  reviewed(relative,'text');
  if(blockedReason(full,{sshConfig:source.id==='ssh-config'})) fail();
  const paths=list=>(list??[]).map(item=>typeof item==='string'?item:item.path);
  const fixed=paths(source.files), dirs=paths(source.dirs);
  const extracted=Object.entries(source.extract??{}).map(([p,keys])=>p+'#'+keys.join(','));
  if(!fixed.includes(full) && !extracted.includes(full) && !dirs.some(dir=>full.startsWith(dir+'/'))) fail();
  return full;
}
function validatePayload(input) {
  closed(input,['schema','files','items','note']);
  if(input.schema!==1 || !Array.isArray(input.files) || !Array.isArray(input.items) || input.files.length>SETUP_LIMITS.files || input.items.length>SETUP_LIMITS.items || input.files.length+input.items.length<1) fail();
  const ids=new Set(), paths=new Set();
  const files=input.files.map(file=>{
    closed(file,['id','source_id','relative_path','format','content','note']);
    const source=sourceMap.get(file.source_id);
    if(typeof file.id!=='string' || !UUID.test(file.id) || ids.has(file.id) || !source || typeof file.content!=='string' || Buffer.byteLength(file.content)>SETUP_LIMITS.fileBytes) fail();
    const full=sourcePath(source,file.relative_path), spelling=fold(full);
    if(paths.has(spelling)) fail(); ids.add(file.id); paths.add(spelling);
    const expected=source.format?.[full]??(full.includes('#')?'json':formatOf(full));
    if(file.format!==expected) fail();
    if(full.includes('#')) {let value;try{value=JSON.parse(file.content);}catch{fail();}const allowed=full.split('#')[1].split(',');if(!value||typeof value!=='object'||Array.isArray(value)||!Object.keys(value).length||Object.keys(value).some(key=>!allowed.includes(key)))fail();}
    reviewed(file.content,file.format,full); note(file.note);
    return {...file};
  }).sort((a,b)=>a.id.localeCompare(b.id));
  const itemNames=new Set();
  const items=input.items.map(item=>{
    closed(item,['id','source_id','kind','name','version']);
    const source=sourceMap.get(item.source_id);
    if(typeof item.id!=='string' || !UUID.test(item.id) || ids.has(item.id) || !source || !source.items?.some(spec=>spec.kind===item.kind) || typeof item.name!=='string' || !/^(?:[A-Za-z0-9][A-Za-z0-9@._/+:-]{0,159}|@[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.test(item.name) || item.name.split('/').some(part=>part==='..'||part==='.') || /^(?:file|git|https?):/i.test(item.name) || (item.version!==null && (typeof item.version!=='string'||!/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,79}$/.test(item.version)))) fail();
    const key=canonical([item.source_id,item.kind,item.name.toLowerCase()]);
    if(itemNames.has(key)) fail(); itemNames.add(key);
    reviewed(item.name,'text'); if(item.version!==null) reviewed(item.version,'text');
    ids.add(item.id); return {...item};
  }).sort((a,b)=>a.id.localeCompare(b.id));
  note(input.note);
  const payload={schema:1,files,items,note:input.note}, bytes=Buffer.byteLength(canonical(payload));
  if(bytes>SETUP_LIMITS.profileBytes) fail();
  return {payload,bytes,content_hash:hash(payload),file_hashes:files.map(file=>({file_id:file.id,hash:fileHash(file)})),sources:[...new Set([...files,...items].map(item=>item.source_id))].sort()};
}
function note(value) { if(typeof value!=='string' || Buffer.byteLength(value)>SETUP_LIMITS.noteBytes) fail(); reviewed(value,'text'); }
function validateReview(review, checked) {
  closed(review,['schema','content_hash','file_hashes','approved']);
  if(review.schema!==1 || review.approved!==true || review.content_hash!==checked.content_hash || canonical(review.file_hashes)!==canonical(checked.file_hashes)) fail();
}
function selection(input,payload) {
  if(!Array.isArray(input) || !input.length || input.length>SETUP_LIMITS.files+SETUP_LIMITS.items || input.some(id=>typeof id!=='string'||!UUID.test(id)) || new Set(input).size!==input.length) fail();
  const available=new Set([...payload.files,...payload.items].map(item=>item.id));
  if(input.some(id=>!available.has(id))) fail(); return [...input].sort();
}
function sources() { return SOURCES.map(({id,label,area,optIn,items,runsCode,runsAtShellStart})=>({id,label,area,optIn:!!optIn,inventory:!!items?.some(item=>item.from==='exec'),runsCode:!!runsCode,runsAtShellStart:!!runsAtShellStart})); }

module.exports = { SETUP_LIMITS, SETUP_BODY_MAX, UUID, SHA, canonical, hash, fileHash, validatePayload, validateReview, selection, sources };
