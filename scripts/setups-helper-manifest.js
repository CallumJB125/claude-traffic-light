'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const modules=['reader','snapshot','writer','receipt','journal-gate','recovery','store','protocol','protocol-transport','bootstrap','helper'];
function manifest(root,stage){
 const hash=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');
 const inputs=[...modules.map(n=>`${n}.c`),...fs.readdirSync(path.join(root,'native/setups-targets')).filter(n=>/^[a-z-]+\.h$/.test(n))].sort();
 return {schema:1,protocol:3,platform:'darwin',architectures:['arm64','x86_64'],minimumOS:'12.0',source:inputs.map(n=>({file:`native/setups-targets/${n}`,sha256:hash(path.join(root,`native/setups-targets/${n}`))})),preSignBinarySha256:hash(path.join(stage,'buddy-setups'))};
}
if(require.main===module){const root=path.resolve(__dirname,'..'),stage=process.argv[2];if(process.argv.length!==3||!stage)throw Error('One owned build stage required');fs.writeFileSync(path.join(stage,'helper-manifest.json'),JSON.stringify(manifest(root,stage),null,2)+'\n',{mode:0o644});}
module.exports={manifest,modules};
