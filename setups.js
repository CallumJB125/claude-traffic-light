'use strict';
const api=window.setupsApi,teams=document.getElementById('teams'),review=document.getElementById('review'),status=document.getElementById('status');
let sources=[],draft=null,chosen=null,generation=0,reviewGeneration=0,requestGeneration=0;
const el=(tag,text)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=String(text);return node;};
const begin=()=>({generation,review:reviewGeneration,request:++requestGeneration});
const current=token=>token.generation===generation&&token.review===reviewGeneration&&token.request===requestGeneration;
function clearReview(){reviewGeneration++;requestGeneration++;draft=null;chosen=null;review.replaceChildren();}
function clearAll(){generation++;sources=[];clearReview();teams.replaceChildren();}
const button=(text,fn)=>{const node=el('button',text),created=generation;node.type='button';node.onclick=async()=>{
  if(created!==generation||!node.isConnected)return;
  node.disabled=true;try{await fn();}catch{if(created===generation&&node.isConnected)status.textContent='This operation is unavailable. Refresh current team access.';}
  finally{if(created===generation&&node.isConnected)node.disabled=node.textContent==='Share reviewed setup'&&(!draft?.content_hash||draft.approved_files.length!==draft.payload.files.length);}
};return node;};
const tell=result=>{status.textContent=result?.ok?'Saved.':result?.error??'This operation is unavailable. Refresh current team access.';return result?.ok;};
// A reply cannot repaint a different account, review or draft. Failures from a
// retired operation are ignored too; a current failure hides its old content.
async function request(fn,token,identity=()=>true){
  if(!current(token)||!identity())return null;
  let result;try{result=await fn();}catch{result={ok:false,error:'This operation is unavailable. Refresh current team access.'};}
  if(!current(token)||!identity())return null;
  if(!result?.ok){clearReview();tell(result);return null;}return result;
}
async function refresh(){
  clearAll();const token=generation;
  status.textContent='Loading current team access…';
  let state;try{state=await api.state();}catch{state={status:'unavailable',teams:[],sources:[]};}
  if(token!==generation)return;
  sources=state?.sources??[];status.textContent=state?.status==='complete'?'Current team access loaded.':state?.teams?.length?'Some team setups are unavailable.':state?.status==='partial'||state?.status==='unavailable'?'Current team access is unavailable. Refresh after signing in or reconnecting.':'Sign in and join a team to share or review setups.';
  for(const team of state?.teams??[]){
    const section=el('section');section.append(el('h2',team.name),el('p',team.status==='complete'?`${team.role} · ${team.profiles.length} shared setups`:'Setups unavailable or incomplete. Refresh to retry.'));
    if(team.baseline)section.append(el('p',team.baseline.required?'Team baseline is a required reminder. It does not enforce installation.':'Team baseline is an optional reminder.'));
    for(const profile of team.profiles??[]){const row=el('div');row.className='row';row.append(el('span',`${profile.own?'Your setup':'Team setup'} · version ${profile.version} · ${profile.files} files · ${profile.items} inventory entries`),button('Review',()=>openProfile(profile,team)));section.append(row);}
    if(team.handle&&team.role!=='viewer'&&team.status!=='unavailable')section.append(button('Select files to share',()=>chooseSources(team)));
    teams.append(section);
  }
}
function chooseSources(team){
  clearReview();const view=reviewGeneration,account=generation;
  review.replaceChildren(el('h2',`Share with ${team.name}`),el('p','Choose allowlisted tools to inspect on this Mac. Raw files stay local. Only scrubbed text reaches this review. No listing commands will run.'));
  const checks=[],list=el('div');list.className='sources';
  for(const source of sources){const label=el('label'),check=el('input');check.type='checkbox';check.value=source.id;label.append(check,document.createTextNode(` ${source.label}${source.optIn?' (sensitive; opt in)':''}`));list.append(label);checks.push(check);}review.append(list);
  const label=el('label'),inventory=el('input');inventory.type='checkbox';label.append(inventory,document.createTextNode(' Include saved plugin and extension inventory files. No package listing commands.'));review.append(label);
  review.append(button('Inspect selected files',async()=>{
    if(account!==generation||view!==reviewGeneration)return;
    const picked=checks.filter(c=>c.checked).map(c=>c.value),token=begin();
    const result=await request(()=>api.draft(team.handle,{sources:picked,inventory:inventory.checked,ssh:picked.includes('ssh-config')}),token,()=>account===generation&&view===reviewGeneration);
    if(result){draft=result;renderDraft();}
  }));review.scrollIntoView({block:'start'});
}
function renderDraft(){
  const rendered=draft,view=++reviewGeneration;requestGeneration++;
  const same=()=>view===reviewGeneration&&draft?.handle===rendered.handle;
  review.replaceChildren(el('h2','Review every complete file'),el('p','Review filenames and remove private details from the full text and notes. Every edit clears file approvals. Unknown private prose needs your review; automated scrubbing cannot identify everything.'));
  if(rendered.error)review.append(el('p',rendered.error));
  if(rendered.scan_summary?.limited||rendered.scan_summary?.skipped)review.append(el('p',`Inspection skipped ${rendered.scan_summary.skipped} entries${rendered.scan_summary.limited?' after reaching a scan limit':''}. Only displayed entries can be shared.`));
  const dirty=()=>{
    if(!same())return;
    // Replace rather than mutate the captured draft: an old edit/approval reply
    // cannot overwrite a newer unsaved local change on the same handle.
    draft={...draft,content_hash:null};requestGeneration++;
    review.querySelectorAll('input[type=checkbox],button').forEach(node=>{if(node.textContent==='Share reviewed setup'||node.type==='checkbox')node.disabled=true;});
  };
  async function edit(input){
    if(!same())return;const active=draft,token=begin();
    const result=await request(()=>api.edit(active.handle,input),token,()=>same()&&draft===active);
    if(result){draft=result;renderDraft();}
  }
  for(const file of rendered.payload.files){
    const section=el('section');section.append(el('h3',`${file.source_id} · ${file.relative_path}`));
    const text=el('textarea');text.className='file-text';text.value=file.content;text.setAttribute('aria-label',`Complete ${file.relative_path} text`);text.oninput=dirty;
    const note=el('textarea');note.value=file.note;note.setAttribute('aria-label',`${file.relative_path} note`);note.oninput=dirty;
    section.append(text,note,button('Save reviewed edits',()=>edit({file_id:file.id,content:text.value,note:note.value})),button('Exclude this file',()=>edit({file_id:file.id,remove:true})));
    const label=el('label'),check=el('input');check.type='checkbox';check.checked=rendered.approved_files.includes(file.id);check.disabled=check.checked||!rendered.content_hash;
    check.onchange=async()=>{
      if(!same()||!draft.content_hash||check.disabled)return;
      const active=draft,token=begin(),hash=active.file_hashes.find(h=>h.file_id===file.id)?.hash;
      const result=await request(()=>api.approve(active.handle,file.id,hash),token,()=>same()&&draft===active);
      if(result){draft=result;renderDraft();}
    };
    label.append(check,document.createTextNode(' I reviewed the full saved text and note for secrets and private details.'));section.append(label);review.append(section);
  }
  review.append(el('h3','Inventory'),el('pre',rendered.payload.items.map(i=>`${i.kind}: ${i.name}${i.version?` (${i.version})`:''}`).join('\n')||'No inventory entries selected.'));
  for(const item of rendered.payload.items)review.append(button(`Exclude ${item.name}`,()=>edit({item_id:item.id,remove:true})));
  const note=el('textarea');note.value=rendered.payload.note;note.setAttribute('aria-label','Profile note');note.oninput=dirty;
  review.append(el('h3','Profile note'),note,button('Save profile note',()=>edit({profile_note:note.value})));
  const label=el('label'),check=el('input');check.type='checkbox';label.append(check,document.createTextNode(' I reviewed all saved inventory, notes and full file text, and want to share this exact setup with the selected team.'));
  const share=button('Share reviewed setup',async()=>{
    if(!same()||!draft.content_hash)return;const active=draft,token=begin();
    const result=await request(()=>api.publish(active.handle,active.content_hash),token,()=>same()&&draft===active);
    if(result){tell(result);await refresh();}
  });share.disabled=true;
  check.onchange=()=>{if(same())share.disabled=!check.checked||!draft.content_hash||draft.approved_files.length!==draft.payload.files.length;};review.append(label,share);
}
async function openProfile(profile,team){
  clearReview();const selection={profile,team};chosen=selection;const token=begin();
  const data=await request(()=>api.read(profile.handle),token,()=>chosen===selection&&chosen.profile.handle===profile.handle);
  if(!data)return;selection.data=data;tell(data);
  review.replaceChildren(el('h2',`Setup version ${data.version}`));
  const versionRow=el('div');versionRow.className='row';
  for(const version of data.versions??[])versionRow.append(button(`Review version ${version.number}`,()=>openProfile({...profile,handle:version.handle},team)));review.append(versionRow);
  const ids=[];
  for(const file of data.payload.files){const section=el('section'),label=el('label'),check=el('input');check.type='checkbox';check.value=file.id;ids.push(check);label.append(check,document.createTextNode(` ${file.relative_path}`));section.append(label,el('pre',file.content),el('p',file.note));review.append(section);}
  for(const item of data.payload.items){const label=el('label'),check=el('input');check.type='checkbox';check.value=item.id;ids.push(check);label.append(check,document.createTextNode(` ${item.kind}: ${item.name} ${item.version??''}`));review.append(label);}review.append(el('p',data.payload.note));
  const selected=()=>ids.filter(c=>c.checked).map(c=>c.value);
  async function action(op,input,after){
    if(chosen!==selection)return;const active=chosen,token=begin();
    const result=await request(()=>api.action(active.profile.handle,op,input),token,()=>chosen===active&&active.profile.handle===profile.handle);
    if(result){tell(result);if(after)await after(result);}
  }
  review.append(button('Record selected entries as reviewed',()=>action('receipt',{selection:selected(),outcome:'reviewed'})));
  if(['owner','admin'].includes(team.role)){
    const label=el('label'),required=el('input');required.type='checkbox';label.append(required,document.createTextNode(' Required reminder for the team'));
    review.append(label,button('Set selected team baseline',()=>action('baseline',{selection:selected(),required:required.checked},refresh)));
  }
  if(data.own)review.append(button('Export your shared setup',async()=>{
    if(chosen!==selection)return;const active=chosen,token=begin();
    const result=await request(()=>api.export(active.profile.handle),token,()=>chosen===active&&active.profile.handle===profile.handle);if(result)tell(result);
  }));
  if(data.own||['owner','admin'].includes(team.role)){
    review.append(button('Show sharing activity',()=>action('activity',{},result=>review.append(el('pre',result.activity.map(a=>`${a.created_at}: ${a.kind}${a.version?` · version ${a.version}`:''}`).join('\n')||'No activity.')))),button('Unpublish and remove shared versions',async()=>{
      if(chosen!==selection||!window.confirm('Remove all shared versions, receipts and baseline details for this setup?'))return;
      await action('unpublish',{},refresh);
    }));
  }
  review.scrollIntoView({block:'start'});
}
document.getElementById('refresh').onclick=refresh;
api.changed(()=>{clearAll();status.textContent='Your account changed. Refresh to load current team access.';});void refresh();
