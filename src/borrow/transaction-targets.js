'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { strictJSON, hash, canonical } = require('../plugins/index-verify');

const FILE_BYTES = 256 * 1024;
const refuse = () => { throw new Error('Setups target is unavailable or changed'); };
const identity = stat => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
const all = Object.freeze(['darwin', 'linux', 'win32']);
// A shared path is a selector for this closed map, never a destination path.
// Unsupported formats keep their full review intent, without a merge claim.
const TARGETS = Object.freeze([
  { id:'codex-instructions-v1', source:'codex', relative:'.codex/AGENTS.md', format:'text', platforms:all, adapter:'text', instructions:true, code:true },
  { id:'claude-settings-v1', source:'claude-code', relative:'.claude/settings.json', format:'json', platforms:all, adapter:'json', instructions:false, code:true },
  { id:'gemini-settings-v1', source:'gemini-cli', relative:'.gemini/settings.json', format:'json', platforms:all, adapter:'json', instructions:false, code:true },
  { id:'codex-config-v1', source:'codex', relative:'.codex/config.toml', format:'toml', platforms:all, adapter:null, instructions:false, code:true },
  { id:'git-home-config-v1', source:'git', relative:'.gitconfig', format:'gitconfig', platforms:all, adapter:null, instructions:false, code:false },
  { id:'git-xdg-config-v1', source:'git', relative:'.config/git/config', format:'gitconfig', platforms:all, adapter:null, instructions:false, code:false },
  { id:'ghostty-xdg-config-v1', source:'ghostty', relative:'.config/ghostty/config', format:'text', platforms:['darwin','linux'], adapter:null, instructions:false, code:false },
  { id:'ghostty-mac-config-v1', source:'ghostty', relative:'Library/Application Support/com.mitchellh.ghostty/config', format:'text', platforms:['darwin'], adapter:null, instructions:false, code:false },
].map(target => Object.freeze({...target, platforms:Object.freeze([...target.platforms])})));
function recipeFor(file, platform) {
  if (!file || typeof file.relative_path !== 'string' || file.relative_path.includes('%') || file.relative_path.normalize('NFKC') !== file.relative_path) return null;
  return TARGETS.find(target => target.source === file.source_id && target.relative === file.relative_path && target.format === file.format && target.platforms.includes(platform)) ?? null;
}
const recipeById = id => TARGETS.find(target => target.id === id) ?? null;

// These are bounded read-only observations, not descriptor-relative mutation
// primitives. OS/profile aliases are canonicalized once; target child links,
// hardlinks and every absent/zero safety flag are refused.
function profile(pathname, platform, osUser, fsApi=fs) {
  if (typeof pathname !== 'string' || !path.isAbsolute(pathname) || !all.includes(platform) || typeof osUser !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(osUser)) refuse();
  const root = fsApi.realpathSync(pathname), stat = fsApi.lstatSync(root, {bigint:true});
  if (!stat.isDirectory() || stat.isSymbolicLink()) refuse();
  return {root, platform, osUser, identity:identity(stat), id:hash({schema:1, root, platform, osUser})};
}
function sameProfile(captured, current, fsApi=fs) {
  return captured.id === current.id && captured.root === current.root && captured.platform === current.platform && captured.osUser === current.osUser &&
    fsApi.realpathSync(captured.root) === captured.root && identity(fsApi.lstatSync(captured.root, {bigint:true})) === captured.identity;
}
function readRegular(filename, max=FILE_BYTES, fsApi=fs) {
  const before = fsApi.lstatSync(filename, {bigint:true});
  if (!before.isFile() || before.nlink !== 1n || before.size < 0n || before.size > BigInt(max)) refuse();
  const noFollow=fs.constants.O_NOFOLLOW, nonblock=fs.constants.O_NONBLOCK;
  if (!Number.isInteger(noFollow) || noFollow<=0 || !Number.isInteger(nonblock) || nonblock<=0) refuse();
  const fd = fsApi.openSync(filename, fs.constants.O_RDONLY|noFollow|nonblock);
  try {
    const opened = fsApi.fstatSync(fd, {bigint:true});
    if (!opened.isFile() || opened.nlink!==1n || identity(opened)!==identity(before)) refuse();
    const buffer=Buffer.alloc(Number(opened.size)+1); let count=0, n;
    do { n=fsApi.readSync(fd, buffer, count, buffer.length-count, null); count+=n; } while(n && count<buffer.length);
    if (count!==Number(before.size) || identity(fsApi.fstatSync(fd, {bigint:true}))!==identity(before) || identity(fsApi.lstatSync(filename, {bigint:true}))!==identity(before)) refuse();
    return {bytes:buffer.subarray(0,count), identity:identity(before), mode:Number(before.mode & 0o777n)};
  } finally { fsApi.closeSync(fd); }
}
function observeTarget(captured, recipe, fsApi=fs) {
  if (!TARGETS.includes(recipe) || !recipe.platforms.includes(captured.platform)) refuse();
  const parents=[], components=recipe.relative.split('/'); let current=captured.root, absent=false;
  const remember=directory => { const stat=fsApi.lstatSync(directory,{bigint:true}); if(!stat.isDirectory()||stat.isSymbolicLink())refuse(); parents.push({path:directory, identity:identity(stat)}); };
  remember(current);
  for (const component of components.slice(0,-1)) {
    current=path.join(current,component);
    try { remember(current); } catch(error) { if(error.code==='ENOENT'){absent=true;break;} throw error; }
  }
  const filename=path.join(captured.root,...components); let read;
  if (!absent) try { read=readRegular(filename,FILE_BYTES,fsApi); } catch(error) { if(error.code!=='ENOENT')throw error; absent=true; }
  const stable=()=>fsApi.realpathSync(captured.root)===captured.root && parents.every(parent=>identity(fsApi.lstatSync(parent.path,{bigint:true}))===parent.identity);
  if (!stable()) refuse();
  // A formerly absent path appearing during an observation also invalidates it.
  if (absent) { try { fsApi.lstatSync(filename); refuse(); } catch(error) { if(error.code!=='ENOENT')throw error; } }
  if (!stable()) refuse();
  return {exists:!absent, bytes:read?.bytes??Buffer.alloc(0), hash:hash(read?.bytes??''), identity:read?.identity??null, mode:read?.mode??null, parents};
}
function observationEqual(a,b) {
  return a.exists===b.exists && a.hash===b.hash && a.identity===b.identity && a.mode===b.mode && canonical(a.parents)===canonical(b.parents);
}

function finiteJSON(value, depth=0) {
  if (depth>32 || (typeof value==='number' && !Number.isFinite(value))) refuse();
  if (value && typeof value==='object') for (const item of Object.values(value)) finiteJSON(item,depth+1);
}
function jsonObject(text) {
  const value=strictJSON(Buffer.from(text),FILE_BYTES); finiteJSON(value);
  if (!value || typeof value!=='object' || Array.isArray(value)) refuse();
  return value;
}
// Parse only top-level value ranges after the complete duplicate-key-refusing
// JSON parser has validated the document. Untouched foreign bytes remain exact.
function ranges(text) {
  const members=new Map(); let at=text.indexOf('{')+1;
  const ws=()=>{while(/[\t\n\r ]/.test(text[at]??'!'))at++;};
  const string=()=>{const start=at++;while(at<text.length){const c=text[at++];if(c==='"')return {start,end:at};if(c==='\\')at++;}refuse();};
  ws();
  while(text[at]!=='}') {
    const key=string(), name=JSON.parse(text.slice(key.start,key.end)); ws();at++;ws();
    const start=at;let depth=0;
    while(at<text.length) { const c=text[at];if(c==='"'){string();continue;}if(c==='{'||c==='[')depth++;else if(c===']'||c==='}') {if(!depth)break;depth--;}else if(c===','&&!depth)break;at++; }
    let end=at;while(/[\t\n\r ]/.test(text[end-1]??'!'))end--;
    members.set(name,{start,end,keyStart:key.start});ws();if(text[at]===','){at++;ws();}
  }
  return {members,close:at};
}
function mergeJSON(current, proposed, replaceKeys=[]) {
  const before=jsonObject(current), incoming=jsonObject(proposed), layout=ranges(current);
  if (!Array.isArray(replaceKeys) || new Set(replaceKeys).size!==replaceKeys.length || replaceKeys.some(key=>typeof key!=='string'||!Object.hasOwn(incoming,key))) refuse();
  const conflicts=[], edits=[], additions=[];
  for (const key of Object.keys(incoming)) {
    const encoded=JSON.stringify(incoming[key]);
    if (!Object.hasOwn(before,key)) additions.push([key,encoded]);
    else if (canonical(before[key])!==canonical(incoming[key])) {
      if (replaceKeys.includes(key)) edits.push({...layout.members.get(key),text:encoded}); else conflicts.push(key);
    }
  }
  if (additions.length) {
    const first=[...layout.members.values()][0], last=[...layout.members.values()].at(-1);
    const newline=current.includes('\r\n')?'\r\n':'\n', multiline=/[\r\n]/.test(current.slice(current.indexOf('{')+1,layout.close));
    const indent=first?(/(?:\r?\n)([ \t]*)$/.exec(current.slice(0,first.keyStart))?.[1]??'  '):'  ';
    const separator=multiline?newline+indent:' ';
    const inserted=additions.map(([key,value])=>JSON.stringify(key)+': '+value).join(','+separator);
    if (last) edits.push({start:last.end,end:last.end,text:','+separator+inserted});
    else edits.push({start:layout.close,end:layout.close,text:(multiline?indent:'')+inserted+(multiline?newline:'')});
  }
  let result=current;for(const edit of edits.sort((a,b)=>b.start-a.start))result=result.slice(0,edit.start)+edit.text+result.slice(edit.end);
  jsonObject(result);if(Buffer.byteLength(result)>FILE_BYTES)refuse();
  return {content:result, conflicts:conflicts.sort()};
}
module.exports={TARGETS,FILE_BYTES,recipeFor,recipeById,identity,profile,sameProfile,readRegular,observeTarget,observationEqual,jsonObject,mergeJSON};
