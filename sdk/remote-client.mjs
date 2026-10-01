// Repository-local fetch SDK. The hub's shared closed catalog is authoritative;
// these methods never invent credentials, retry writes or choose a different URL.
export const MAX_BYTES = 64 * 1024;
const messages = {
  UNAUTHENTICATED:'Reconnect with a current integration token.',
  FORBIDDEN:'This connection does not permit that action.',
  NOT_FOUND:'That resource is unavailable to this connection.',
  CONFLICT:'The connection or task changed. Reload before choosing an action.',
  VERSION_CONFLICT:'Reload the current task or packet version before editing.',
  PAYLOAD_TOO_LARGE:'Result exceeds 64 KiB. Narrow the query or open the task in Plexiform. Reuse request_id for an uncertain write.',
  RATE_LIMITED:'The connection is busy. Retry a read later; reuse request_id for an uncertain write.',
  VALIDATION:'Check the closed tool arguments against the connection catalog.',
  TIMEOUT:'The request ended without a confirmed response. Reuse request_id for an uncertain write.',
  NETWORK:'The request ended without a confirmed response. Reuse request_id for an uncertain write.',
  REMOTE_ERROR:'The hub returned an unusable response.',
};
export class PlexiformError extends Error {
  constructor(code,status=0,retryAfter=null){super(messages[code]??messages.REMOTE_ERROR);this.name='PlexiformError';this.code=code;this.status=status;this.retryAfter=retryAfter;}
}
const fail=code=>{throw new PlexiformError(code);};
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
function endpoint(origin){
  let u;try{u=new URL(origin);}catch{fail('VALIDATION');}
  if(typeof origin!=='string'||u.username||u.password||u.search||u.hash||u.pathname!=='/'
    ||!(u.protocol==='https:'||u.protocol==='http:'&&['127.0.0.1','[::1]'].includes(u.hostname)))fail('VALIDATION');
  return `${u.origin}/api/integration/v1`;
}
async function responseJson(response,signal){
  if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??''))throw new PlexiformError('REMOTE_ERROR',response.status);
  const length=Number(response.headers.get('content-length'));
  if(length>MAX_BYTES){await response.body?.cancel();throw new PlexiformError('PAYLOAD_TOO_LARGE',response.status);}
  if(!response.body?.getReader)throw new PlexiformError('REMOTE_ERROR',response.status);
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{for(;;){if(signal.aborted)throw new PlexiformError('TIMEOUT');const {done,value}=await reader.read();if(done)break;
    size+=value.byteLength;if(size>MAX_BYTES){await reader.cancel();throw new PlexiformError('PAYLOAD_TOO_LARGE',response.status);}chunks.push(value);
  }}finally{reader.releaseLock();}
  if(signal.aborted)throw new PlexiformError('TIMEOUT');
  const data=new Uint8Array(size);let at=0;for(const chunk of chunks){data.set(chunk,at);at+=chunk.byteLength;}
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));}catch{throw new PlexiformError('REMOTE_ERROR',response.status);}
}
export function requestId(){return globalThis.crypto.randomUUID();}
export function createPlexiformClient({origin,token,fetchImpl,timeoutMs=20_000}={}){
  const url=endpoint(origin);
  if(typeof token!=='string'||!/^pfi_[A-Za-z0-9_-]{43}$/.test(token)||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30_000)fail('VALIDATION');
  const send=fetchImpl??globalThis.fetch; // privacy-flow: remote-integration-sdk
  if(typeof send!=='function')fail('VALIDATION');
  async function request(tool,args,options={}){
    if(!object(options)||Object.keys(options).some(k=>k!=='signal')||options.signal!=null&&!(options.signal instanceof AbortSignal))fail('VALIDATION');
    if(tool!=null&&!object(args))fail('VALIDATION');
    let body;try{body=tool==null?undefined:JSON.stringify({tool,arguments:args});}catch{fail('VALIDATION');}
    if(body&&new TextEncoder().encode(body).byteLength>MAX_BYTES)fail('PAYLOAD_TOO_LARGE');
    const controller=new AbortController(),abort=()=>controller.abort(),timer=setTimeout(abort,timeoutMs);
    options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
    try{
      if(controller.signal.aborted)throw new PlexiformError('TIMEOUT');
      const response=await send(url,{method:tool==null?'GET':'POST',headers:{accept:'application/json',authorization:`Bearer ${token}`,...(body?{'content-type':'application/json'}:{})},
        body,signal:controller.signal,credentials:'omit',redirect:'error'}); // privacy-flow: remote-integration-sdk
      const result=await responseJson(response,controller.signal);
      if(!response.ok){const code=typeof result?.error?.code==='string'&&/^[A-Z_]{1,80}$/.test(result.error.code)?result.error.code:'REMOTE_ERROR';
        const retry=Number(response.headers.get('retry-after'));throw new PlexiformError(code,response.status,Number.isFinite(retry)&&retry>0?Math.min(retry,86400):null);}
      if(!object(result))throw new PlexiformError('REMOTE_ERROR',response.status);return result;
    }catch(error){if(error instanceof PlexiformError)throw error;throw new PlexiformError(controller.signal.aborted?'TIMEOUT':'NETWORK');}
    finally{controller.abort();clearTimeout(timer);options.signal?.removeEventListener('abort',abort);}
  }
  // Closed conveniences, not another policy engine. Server schemas and current
  // grants decide every read, mutation and receipt replay.
  return Object.freeze({catalog:options=>request(null,null,options),
    listBoards:options=>request('plexiform_list_boards',{},options),
    listCards:(args,options)=>request('plexiform_list_cards',args,options),
    getCard:(args,options)=>request('plexiform_get_card',args,options),
    createCard:(args,options)=>request('plexiform_create_card',args,options),
    updateCard:(args,options)=>request('plexiform_update_card',args,options),
    addComment:(args,options)=>request('plexiform_add_comment',args,options),
    readHandover:(args,options)=>request('plexiform_read_handover',args,options),
    readPacket:(args,options)=>request('plexiform_read_packet',args,options),
    writePacket:(args,options)=>request('plexiform_write_packet',args,options),
    listMessages:(args,options)=>request('plexiform_list_messages',args,options),
    sendMessage:(args,options)=>request('plexiform_send_message',args,options),
    getWorkContext:(args,options)=>request('plexiform_get_work_context',args,options)});
}
