// An inert human preview schema. A recipe, plan hash or saved preview never
// grants execution, permission answers, provider credentials or a paid retry.
export const WORKFLOW_PLAN_LIMITS = Object.freeze({ steps:8, edges:28, plans:1000, bytes:32*1024, lifetimeMs:24*60*60*1000 });
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const invalid = () => { throw Object.assign(new Error('Check the closed workflow preview fields and same-instance graph.'),{code:'VALIDATION'}); };
export function canonical(value) {
  return JSON.stringify(value,(_key,item)=>item && typeof item==='object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])) : item);
}
function closed(value,keys,required=keys) {
  if(!value || typeof value!=='object' || ![Object.prototype,null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).some(key=>!keys.includes(key)) || required.some(key=>!Object.hasOwn(value,key))) invalid();
}
const integer = (value,min=0,max=Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value>=min && value<=max;
export function validatePreview(body) {
  const fields=['request_id','board_id','repo_id','recipe_version','content_hash','concurrency','steps','dependencies'];
  closed(body,fields,fields.filter(key=>key!=='dependencies'));
  if(![body.request_id,body.board_id,body.repo_id].every(value=>typeof value==='string' && UUID.test(value))
    || !integer(body.recipe_version,1,50) || typeof body.content_hash!=='string' || !/^[0-9a-f]{64}$/.test(body.content_hash)
    || ![1,2].includes(body.concurrency) || !Array.isArray(body.steps) || body.steps.length<1 || body.steps.length>8) invalid();
  const ids=new Set(),steps=body.steps.map((step,position)=>{
    closed(step,['position','card_id','version','fence','ai','target_member_id','budget_usd','plan_approval']);
    if(step.position!==position || ![step.card_id,step.target_member_id].every(value=>typeof value==='string' && UUID.test(value))
      || ids.has(step.card_id) || !integer(step.version) || !integer(step.fence) || !['codex','claude'].includes(step.ai)
      || typeof step.plan_approval!=='boolean' || !(step.budget_usd===null || typeof step.budget_usd==='number'
        && Number.isFinite(step.budget_usd) && step.budget_usd>=0.5 && step.budget_usd<=1000)) invalid();
    ids.add(step.card_id);
    return {...step,budget_usd:step.budget_usd===null?null:Math.round(step.budget_usd*100)/100};
  });
  const supplied=Object.hasOwn(body,'dependencies')?body.dependencies:steps.slice(1).map((_step,index)=>[index,index+1]);
  if(!Array.isArray(supplied) || supplied.length>28) invalid();
  const edges=new Set(),dependencies=supplied.map(edge=>{
    if(!Array.isArray(edge) || edge.length!==2 || !edge.every(value=>integer(value,0,steps.length-1)) || edge[0]===edge[1]) invalid();
    const key=edge.join(':');if(edges.has(key))invalid();edges.add(key);return [...edge];
  }).sort((a,b)=>a[0]-b[0] || a[1]-b[1]);
  const degree=steps.map(()=>0),next=steps.map(()=>[]);for(const [from,to] of dependencies){degree[to]++;next[from].push(to);}
  const ready=degree.flatMap((value,index)=>value===0?[index]:[]);let visited=0;
  for(let at=0;at<ready.length;at++){visited++;for(const to of next[ready[at]])if(--degree[to]===0)ready.push(to);}
  if(visited!==steps.length)invalid();
  const out={request_id:body.request_id,board_id:body.board_id,repo_id:body.repo_id,recipe_version:body.recipe_version,
    content_hash:body.content_hash,concurrency:body.concurrency,steps,dependencies};
  if(new TextEncoder().encode(canonical(out)).byteLength>WORKFLOW_PLAN_LIMITS.bytes)invalid();
  return out;
}
