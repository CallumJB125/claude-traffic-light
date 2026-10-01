import http from 'node:http';
import { once } from 'node:events';
import { S3Store } from '../s3.mjs';
const config = { bucket:'fixture-private', accessKeyId:'fixture-access', secretAccessKey:'fixture-secret' };

export async function fakeS3(t) {
  const bytes=new Map(),calls=[];
  const server=http.createServer(async(req,res)=>{
    const key=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname);
    calls.push({method:req.method,key,conditional:req.headers['if-none-match'],authorization:req.headers.authorization});
    if(req.method==='PUT'){
      const parts=[];for await(const b of req)parts.push(b);
      if(req.headers['if-none-match']!=='*'){res.writeHead(400);res.end();return;}
      if(bytes.has(key)){res.writeHead(412,{'content-type':'application/xml'});res.end('<Error><Code>PreconditionFailed</Code></Error>');return;}
      bytes.set(key,Buffer.concat(parts));res.writeHead(200,{etag:'"fixture"'});res.end();
    }else if(req.method==='GET'){
      const b=bytes.get(key);if(!b){res.writeHead(404,{'content-type':'application/xml'});res.end('<Error><Code>NoSuchKey</Code></Error>');return;}
      res.writeHead(200,{'content-type':'application/octet-stream','content-length':b.length,etag:'"fixture"'});res.end(b);
    }else{res.writeHead(405);res.end();}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const store=new S3Store({...config,endpoint:`http://127.0.0.1:${server.address().port}`},{testLoopback:true});
  t.after(async()=>{store.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  return {store,bytes,calls};
}
