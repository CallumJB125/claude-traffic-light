import http from 'node:http';
import { once } from 'node:events';
import { S3Store } from '../s3.mjs';
const config = { bucket:'fixture-private', accessKeyId:'fixture-access', secretAccessKey:'fixture-secret' };
const xml = (res, status, code) => { res.writeHead(status, {'content-type':'application/xml'}); res.end(`<Error><Code>${code}</Code></Error>`); };

// In-process S3 stub. It reads (does not cryptographically verify) the SigV4
// access key and x-amz-date, so it can model credential scopes, object lock,
// clock skew and faults. It is never a real off-site target.
// permissions: accessKeyId -> subset of ['put','get','delete'].
export async function fakeS3(t, { permissions = { 'fixture-access': ['put','get','delete'] }, objectLock = false, clockOffsetMs = 0, faults = {} } = {}) {
  const bytes=new Map(),calls=[];
  const server=http.createServer(async(req,res)=>{
    const key=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname);
    const access=/Credential=([^/]+)\//.exec(req.headers.authorization??'')?.[1];
    calls.push({method:req.method,key,access,conditional:req.headers['if-none-match'],authorization:req.headers.authorization});
    const amz=/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(req.headers['x-amz-date']??'');
    const signedAt=amz?Date.UTC(amz[1],amz[2]-1,amz[3],amz[4],amz[5],amz[6]):NaN;
    if(!(Math.abs(Date.now()+clockOffsetMs-signedAt)<=15*60_000)){for await(const _ of req);return xml(res,403,'RequestTimeTooSkewed');}
    const allowed=permissions[access]??[];
    if(req.method==='PUT'){
      if(faults.dropPut?.(key,access)){let n=0;for await(const b of req){n+=b.length;if(n>8){req.socket.destroy();return;}}req.socket.destroy();return;}
      const parts=[];for await(const b of req)parts.push(b);
      if(!allowed.includes('put'))return xml(res,403,'AccessDenied');
      if(req.headers['if-none-match']!=='*'){res.writeHead(400);res.end();return;}
      if(bytes.has(key))return xml(res,412,'PreconditionFailed');
      bytes.set(key,Buffer.concat(parts));res.writeHead(200,{etag:'"fixture"'});res.end();
    }else if(req.method==='GET'){
      if(!allowed.includes('get'))return xml(res,403,'AccessDenied');
      let b=bytes.get(key);if(!b)return xml(res,404,'NoSuchKey');
      b=faults.tamperGet?.(key,b,access)??b;
      res.writeHead(200,{'content-type':'application/octet-stream','content-length':b.length,etag:'"fixture"'});
      if(faults.truncateGet?.(key,access)){res.write(b.subarray(0,Math.floor(b.length/2)));res.socket.destroy();return;}
      res.end(b);
    }else if(req.method==='DELETE'){
      if(!allowed.includes('delete'))return xml(res,403,'AccessDenied');
      if(objectLock&&bytes.has(key))return xml(res,403,'ObjectLockedByBucketPolicy');
      bytes.delete(key);res.writeHead(204);res.end();
    }else{res.writeHead(405);res.end();}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const endpoint=`http://127.0.0.1:${server.address().port}`,stores=[];
  const storeFor=(accessKeyId)=>{const s=new S3Store({...config,accessKeyId,endpoint},{testLoopback:true});stores.push(s);return s;};
  const store=storeFor(config.accessKeyId);
  t.after(async()=>{for(const s of stores)s.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  return {store,storeFor,bytes,calls};
}
