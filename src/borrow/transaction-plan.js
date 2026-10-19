'use strict';
const {scrubFile}=require('./scrub');
const {jsonObject,FILE_BYTES}=require('./transaction-targets');
const LOCAL_VALUE_BYTES=16*1024;
const PLACEHOLDER=/\{\{(HOME|USER|HOSTNAME|NAME|EMAIL(?::\d+)?|IP:\d+|HOST:\d+|PRIVATE:\d+|SSH_USER|SECRET:[\w.-]{1,64})\}\}/g;
const refuse=()=>{throw new Error('Setups transaction is unavailable');};
const textOf=bytes=>new TextDecoder('utf-8',{fatal:true}).decode(bytes);
function localValues(payloadFiles,provided,captured) {
  if(!provided||typeof provided!=='object'||Array.isArray(provided))refuse();
  const needed=new Set(payloadFiles.flatMap(file=>[...file.content.matchAll(PLACEHOLDER)].map(match=>match[1])));needed.delete('HOME');
  if(Object.keys(provided).some(key=>!needed.has(key))||[...needed].some(key=>!Object.hasOwn(provided,key)))refuse();
  let bytes=0;const values=new Map([['HOME',captured.profile.root]]);
  for(const name of needed){const value=provided[name];if(typeof value!=='string'||value.includes('\0')||Buffer.byteLength(value)>4096)refuse();bytes+=Buffer.byteLength(value);values.set(name,value);}
  if(bytes>LOCAL_VALUE_BYTES)refuse();return values;
}
function fill(content,format,values) {
  const replace=text=>text.replace(PLACEHOLDER,(_match,name)=>{if(!values.has(name))refuse();return values.get(name);});
  if(format==='json') {
    const value=jsonObject(content);
    const walk=item=>{
      if(typeof item==='string')return replace(item);
      if(Array.isArray(item))return item.map(walk);
      if(item&&typeof item==='object')return Object.fromEntries(Object.entries(item).map(([key,value])=>{if(/\{\{|\}\}/.test(key))refuse();return [key,walk(value)];}));
      return item;
    };
    const result=JSON.stringify(walk(value),null,2);if(Buffer.byteLength(result)>FILE_BYTES)refuse();return result;
  }
  const result=replace(content);if(Buffer.byteLength(result)>FILE_BYTES)refuse();return result;
}
function maskedPreview(bytes,recipe,values,captured) {
  const result=scrubFile({path:'~/'+recipe.relative,format:recipe.format,content:textOf(bytes),machine:{home:captured.profile.root}});
  if(result.status!=='ok')return {status:'withheld',content:null};
  let text=result.content;
  // Explicit local values stay out of UI previews even when they do not match a
  // known credential pattern. Unknown pre-existing prose still needs review.
  const ordered=[...values].filter(([,value])=>value).sort((a,b)=>b[1].length-a[1].length);
  const mask=value=>{for(const [name,local] of ordered)value=value.split(local).join(`{{${name}}}`);return value;};
  if(recipe.format==='json') {
    // Mask decoded JSON strings, so quotes/backslashes/Unicode escapes cannot
    // make a local value evade preview masking. Leave unedited preview bytes
    // alone when none of the explicit values occur.
    let changed=false;
    const walk=value=>{
      if(typeof value==='string'){const next=mask(value);changed ||= next!==value;return next;}
      if(Array.isArray(value))return value.map(walk);
      if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>{if(mask(key)!==key)refuse();return [key,walk(item)];}));
      return value;
    };
    try{const masked=walk(jsonObject(text));if(changed)text=JSON.stringify(masked,null,2);}catch{return {status:'withheld',content:null};}
  } else text=mask(text);
  return {status:'reviewable',content:text};
}

module.exports={LOCAL_VALUE_BYTES,localValues,fill,maskedPreview};
