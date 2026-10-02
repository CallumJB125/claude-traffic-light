'use strict';
const api=window.setupsApi,teams=document.getElementById('teams'),review=document.getElementById('review'),status=document.getElementById('status');
let sources=[],draft=null,chosen=null,generation=0,reviewGeneration=0,requestGeneration=0;
const local=document.getElementById('local')??document.body.appendChild(document.createElement('section'));
let localCapability=null,localGeneration=0,localSequence=0,localBusy=null,localUpdate=()=>{};
const localButtons=new Map();
function refreshLocalControls(){localUpdate();for(const [node,allowed] of localButtons){if(!node.isConnected)localButtons.delete(node);else node.disabled=!!localBusy||!allowed();}}
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const sha=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
const el=(tag,text)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=String(text);return node;};
const begin=()=>({generation,review:reviewGeneration,request:++requestGeneration});
const current=token=>token.generation===generation&&token.review===reviewGeneration&&token.request===requestGeneration;
function clearReview(){reviewGeneration++;requestGeneration++;draft=null;chosen=null;localUpdate=()=>{};review.querySelectorAll('.local-values input').forEach(n=>n.value='');review.replaceChildren();}
function clearAll(){generation++;sources=[];clearReview();teams.replaceChildren();clearLocal();}
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
  renderLocalPlan(selection);
  review.scrollIntoView({block:'start'});
}
// Local capability is checked only by an explicit click. Merely loading a
// hidden embedded view or listing locked metadata must not prompt Keychain.
function localButton(text,fn,allowed=()=>true){
 const node=el('button',text),account=generation;node.type='button';node.disabled=!!localBusy||!allowed();localButtons.set(node,allowed);
 node.onclick=async()=>{if(account!==generation||!node.isConnected||localBusy||!allowed())return;const lease={};localBusy=lease;node.disabled=true;refreshLocalControls();try{await fn();}catch{if(account===generation&&node.isConnected)node.closest('section')?.append(el('p','Local action unavailable. Review current access and retained history.'));}finally{if(localBusy===lease)localBusy=null;refreshLocalControls();}};
 return node;
}
function clearLocal(){
 localGeneration++;localSequence++;localCapability=null;localBusy=null;
 const message=el('p','Check local capability before planning changes. Locked history lists metadata without unlocking contents.'),history=el('div');message.setAttribute('role','status');message.setAttribute('aria-live','polite');history.className='local-history';
 local.replaceChildren(el('h2','Local changes and recovery'),message);
 local.append(localButton('Check local capability',async()=>{
  const account=generation,epoch=localGeneration,sequence=++localSequence;let value;try{value=await api.localState?.();}catch{}
  if(account!==generation||epoch!==localGeneration||sequence!==localSequence)return;
  localCapability=value?.ok===true&&Array.isArray(value.supported_recipes)&&value.supported_recipes.length<=8&&value.supported_recipes.every(x=>typeof x==='string')?value:null;
  message.textContent=value?.status==='reap_pending'?'Cleanup is awaiting an observed process exit. New local work is blocked.':value?.status==='review_available'?'Read-only local review is available. OS encryption is uninspected; Apply, recovery and Undo require explicit native confirmation.':'Local changes are unavailable. OS encryption, supported platform or the trusted helper may need attention.';refreshLocalControls();
 }),localButton('Load locked local history',()=>loadLocked(history)),history);
}
async function localRequest(fn,identity=()=>true){
 const account=generation,epoch=localGeneration,sequence=++localSequence;let value;try{value=await fn();}catch{value={ok:false,status:'unavailable'};}
 return account===generation&&epoch===localGeneration&&sequence===localSequence&&identity()?value:null;
}
function outcome(node,value){
 if(value?.ok===true&&value.phase==='verified'&&value.target_files_changed===true)node.textContent='Apply verified for every selected file.';
 else if(value?.ok===true&&value.phase==='undone'&&value.target_files_changed===true)node.textContent='Undo verified. Original supported files were restored.';
 else {const phase=['prepared','incomplete','unknown'].includes(value?.phase)?value.phase:'unavailable';node.textContent=`Local operation ${phase}.${value?.retained===true?' Evidence is retained. Load locked history for a fresh recovery review.':' Review current access and create a fresh plan.'}`;}
}
async function loadLocked(history){
 const value=await localRequest(()=>api.listLocked?.());if(!value)return;
 history.replaceChildren();if(value.ok!==true||value.status!=='locked'||!Array.isArray(value.transactions)||value.transactions.length>16||value.transactions.some(t=>!uuid(t.id)||t.locked!==true)||new Set(value.transactions.map(t=>t.id)).size!==value.transactions.length){history.append(el('p','Locked local history is unavailable. Contents have not been unlocked.'));return;}
 if(!value.transactions.length){history.append(el('p','No retained local transactions.'));return;}
 for(const transaction of value.transactions){const row=el('section'),message=el('p','Locked; not freshly inspected.');row.append(el('h3',`Local transaction ${transaction.id}`),message);
  row.append(localButton('Inspect locked status',async()=>{const r=await localRequest(()=>api.localStatus?.(transaction.id),()=>row.isConnected);if(r)message.textContent=r.ok===true&&r.status==='locked'?'Locked; not freshly inspected.':'Current locked status is unavailable.';}));
  row.append(localButton('Review local recovery',async()=>{
   clearReview();const r=await localRequest(()=>api.recover?.(transaction.id),()=>row.isConnected);if(!r)return;
   if(r.ok!==true||!uuid(r.handle)||r.transaction_id!==transaction.id||r.phase!=='inspected'||r.recovery_authority!=='own_local_review_only'||r.local_previews!=='withheld_local_values'){outcome(message,r);return;}
   message.textContent='Fresh local inspection completed. Local values and previous text stay withheld. Undo requires a separate native confirmation and rechecks current files.';
   let recoveryUsed=false;row.append(localButton('Confirm conditional Undo',async()=>{recoveryUsed=true;const handle=r.handle;row.querySelectorAll('button').forEach(n=>n.disabled=true);const undo=await localRequest(()=>api.confirmUndo?.(handle),()=>row.isConnected);if(undo)outcome(message,undo);},()=>!localBusy&&!recoveryUsed));
  }));history.append(row);
 }
}
const localRecipe=file=>[
 {source:'codex',path:'.codex/AGENTS.md',format:'text',id:'codex-instructions-v1',instructions:true,code:true},
 {source:'claude-code',path:'.claude/settings.json',format:'json',id:'claude-settings-v1',instructions:false,code:true},
 {source:'gemini-cli',path:'.gemini/settings.json',format:'json',id:'gemini-settings-v1',instructions:false,code:true},
].find(r=>r.source===file.source_id&&r.path===file.relative_path&&r.format===file.format);
function renderLocalPlan(selection){
 const panel=el('section'),message=el('p','Check local capability, then select supported files. No inventory entries are applied.'),choices=[],values=el('div'),preview=el('div');panel.className='local-plan';values.className='local-values';preview.className='local-preview';message.setAttribute('role','status');message.setAttribute('aria-live','polite');
 const code=el('input'),instructions=el('input');code.type=instructions.type='checkbox';
 const codeLabel=el('label'),instructionLabel=el('label');codeLabel.append(code,document.createTextNode(' I reviewed the selected configuration that can influence tool behavior.'));instructionLabel.append(instructions,document.createTextNode(' I separately reviewed the selected instruction text.'));
 panel.append(el('h2','Review a local plan'),el('p','Only supported existing parent directories can be changed. Review masked before/after text and conflicts. Applying configuration does not launch tools or execute commands.'),message,codeLabel,instructionLabel);
 let plan=null,revision=0,used=false;
 const same=()=>chosen===selection&&panel.isConnected;
 const available=()=>same()&&localCapability?.status==='review_available'&&localCapability?.busy!==true;
 const supported=recipe=>recipe&&localCapability?.supported_recipes.includes(recipe.id);
 const eligible=row=>available()&&supported(row.recipe)&&(!row.recipe.code||code.checked)&&(!row.recipe.instructions||instructions.checked);
 function invalidatePlan(){revision++;plan=null;used=false;preview.replaceChildren();localUpdate();}
 function fields(){values.querySelectorAll('input').forEach(n=>n.value='');values.replaceChildren();const needed=new Set();for(const row of choices.filter(r=>r.check.checked&&eligible(r)))for(const match of row.file.content.matchAll(/\{\{(HOME|USER|HOSTNAME|NAME|EMAIL(?::\d+)?|IP:\d+|HOST:\d+|PRIVATE:\d+|SSH_USER|SECRET:[\w.-]{1,64})\}\}/g))if(match[1]!=='HOME')needed.add(match[1]);
  for(const key of needed){const label=el('label',`Local value for ${key}`),input=el('input');input.type=key.startsWith('SECRET:')?'password':'text';input.autocomplete='off';input.spellcheck=false;input.maxLength=4096;input.dataset.placeholder=key;input.setAttribute('aria-label',`Local value ${key}`);input.oninput=invalidatePlan;label.append(input);values.append(label);}
  if(needed.size)values.prepend(el('p','Values stay in this local plan and encrypted recovery. They are masked in previews and never included in team sharing or activity receipts.'));
 }
 for(const file of selection.data.payload.files){const recipe=localRecipe(file),row=el('div'),check=el('input'),label=el('label'),mode=el('select'),keys=el('textarea');check.type='checkbox';check.dataset.localFile=file.id;label.append(check,document.createTextNode(` Apply ${file.relative_path}`));
  for(const type of recipe?.format==='json'?['merge','replace']:['replace']){const option=el('option',type==='merge'?'Merge; preserve unrelated keys':'Replace the complete selected file');option.value=type;mode.append(option);}mode.setAttribute('aria-label',`Local mode ${file.relative_path}`);keys.setAttribute('aria-label',`Explicit replacement keys ${file.relative_path}`);keys.placeholder='For JSON merge conflicts, explicitly list approved top-level keys, one per line.';keys.maxLength=201000;
  const item={file,recipe,check,mode,keys};choices.push(item);const changed=()=>{invalidatePlan();fields();};check.onchange=changed;mode.onchange=changed;keys.oninput=invalidatePlan;row.className='local-file';row.append(label,mode);if(recipe?.format==='json')row.append(keys);if(!recipe)row.append(el('p','This format has no local Apply adapter yet. Its shared review remains available.'));panel.append(row);
 }
 const selected=()=>choices.filter(r=>r.check.checked&&eligible(r));
 const all=localButton('Select eligible supported files',()=>{for(const row of choices)row.check.checked=eligible(row);invalidatePlan();fields();},()=>available()&&!localBusy);panel.append(all,values);
 const build=localButton('Create masked local plan',async()=>{
  const selectedRows=selected(),at=revision,request={files:selectedRows.map(r=>({id:r.file.id,mode:r.mode.value,replace_keys:r.mode.value==='merge'?r.keys.value.split('\n').map(k=>k.trim()).filter(Boolean):[],instructions:r.recipe.instructions,code:r.recipe.code})),values:Object.fromEntries([...values.querySelectorAll('input')].map(n=>[n.dataset.placeholder,n.value]))};
  values.querySelectorAll('input').forEach(n=>n.value='');plan=null;preview.replaceChildren();const r=await localRequest(()=>api.plan?.(selection.profile.handle,request),()=>same()&&revision===at);if(!r)return;
  if(r.ok!==true||!uuid(r.handle)||!sha(r.plan_hash)||!sha(r.source_hash)||!Array.isArray(r.targets)||r.targets.length>128){clearReview();status.textContent='Local operation unavailable. Refresh current team access and create a fresh review.';return;}
  if(r.kind!=='read_only_plan'||!Number.isSafeInteger(r.expires_at)||r.expires_at<=Date.now()||typeof r.ready!=='boolean'||r.targets.length!==selectedRows.length||r.targets.some(t=>!selectedRows.some(row=>row.file.id===t.file_id&&row.recipe.id===t.recipe)||!['reviewable','adapter_unavailable','local_review_unavailable'].includes(t.status)||(t.status==='reviewable'&&(!['merge','replace'].includes(t.mode)||typeof t.exists!=='boolean'||!sha(t.before_hash)||!sha(t.after_hash)||!Array.isArray(t.conflicts)||t.conflicts.length>1000||t.conflicts.some(k=>typeof k!=='string'||k.length>200)||['before','shared','after'].some(k=>t[k]?.status!=='reviewable'||typeof t[k]?.content!=='string'||t[k].content.length>262144))))||new Set(r.targets.map(t=>t.file_id)).size!==r.targets.length){clearReview();status.textContent='Local operation unavailable. Refresh current team access and create a fresh review.';return;}
  plan=r;used=false;message.textContent=r.ready===true?'Review every masked target, replacement and conflict before Apply.':'This selection is not ready to apply. Review the unavailable targets.';
  const reference=el('details');reference.append(el('summary','Plan reference'),el('p',`Source ${r.source_hash} · plan ${r.plan_hash}`));preview.append(reference);
  for(const target of r.targets){const section=el('section');section.append(el('h3',selectedRows.find(row=>row.file.id===target.file_id)?.file.relative_path??'Unsupported target'),el('p',target.status==='reviewable'?`Mode: ${target.mode}. ${target.exists?'Existing file':'New file in existing parents'}.`:`Unavailable: ${target.status}`));if(target.status==='reviewable'){section.append(el('p',`Conflicts: ${(target.conflicts??[]).join(', ')||'none'}`));for(const [name,content] of [['Before',target.before],['Shared template',target.shared],['After',target.after]])section.append(el('h4',name),el('pre',content?.status==='reviewable'?content.content:'Local text withheld.'));}preview.append(section);}
  const reviewed=el('input'),reviewLabel=el('label');reviewed.type='checkbox';reviewLabel.append(reviewed,document.createTextNode(' I reviewed every displayed masked target, conflict and replacement choice for this exact plan.'));reviewed.onchange=refreshLocalControls;preview.append(reviewLabel);
  const check=localButton('Check this plan is current',async()=>{const active=plan;const r=await localRequest(()=>api.check?.(active.handle),()=>same()&&plan===active);if(r){if(r.ok===true&&r.current===true)message.textContent='Current read-only check passed. Apply still requires native confirmation.';else{clearReview();status.textContent='The plan is unavailable or changed. Create a fresh review.';}}},()=>available()&&!localBusy&&!!plan&&!used);
  const apply=localButton('Apply reviewed local plan',async()=>{const active=plan;used=true;const r=await localRequest(()=>api.apply?.(active.handle,active.plan_hash),()=>same()&&plan===active);if(r){if(r.ok!==true&&r.retained!==true){clearReview();status.textContent='Local operation unavailable. Refresh current team access and create a fresh review.';}else outcome(message,r);}},()=>available()&&!localBusy&&plan?.ready===true&&!used&&reviewed.checked&&Date.now()<plan.expires_at);
  preview.append(check,apply);refreshLocalControls();
 },()=>available()&&!localBusy&&selected().length>0);
 panel.append(build,preview);review.append(panel);
 localUpdate=()=>{if(!same())return;for(const row of choices){row.check.disabled=localBusy||!eligible(row);row.mode.disabled=localBusy||!row.check.checked||!eligible(row);row.keys.disabled=row.mode.disabled||row.mode.value!=='merge';}code.disabled=instructions.disabled=localBusy;all.disabled=localBusy||!available();build.disabled=localBusy||!available()||!selected().length;values.querySelectorAll('input').forEach(n=>n.disabled=localBusy);};
 const consent=()=>{for(const row of choices)if(!eligible(row))row.check.checked=false;invalidatePlan();fields();};code.onchange=instructions.onchange=consent;localUpdate();
}

document.getElementById('refresh').onclick=refresh;
api.changed(()=>{clearAll();status.textContent='Your account changed. Refresh to load current team access.';});void refresh();
