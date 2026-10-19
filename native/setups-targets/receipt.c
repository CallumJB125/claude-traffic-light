#include "receipt-private.h"
#include <stdlib.h>
#include <string.h>
static void meta_codec(PFCodec *c,PFWriteMeta *m){
  pf_codec_stamp(c,&m->stamp);
  pf_codec_u64(c,&m->gid);
  pf_codec_u64(c,&m->flags);
  pf_codec_bytes(c,m->acl_hash,32);
  pf_codec_bytes(c,m->hash,32);
  for(unsigned i=0;i<2;i++){
    pf_codec_u64(c,&m->attrs[i].present);
    pf_codec_u64(c,&m->attrs[i].size);
    pf_codec_bytes(c,m->attrs[i].hash,32);
    if(m->attrs[i].present>1||m->attrs[i].size>PF_SNAPSHOT_ATTR_BYTES||(!m->attrs[i].present&&m->attrs[i].size))c->failed=1;
  }
  if(m->stamp.size>PF_READER_MAX_BYTES)c->failed=1;
}
PFResult pf_native_state_codec(PFCodec *c,PFNativeWriterState *s){
  uint32_t recipe=(uint32_t)s->recipe,phase=(uint32_t)s->receipt.phase,result=(uint32_t)s->receipt.result,seq=s->receipt.sequence,effect=s->receipt.namespace_effect,existed=s->receipt.existed;
  pf_codec_u32(c,&recipe);
  pf_codec_u32(c,&phase);
  pf_codec_u32(c,&result);
  pf_codec_u32(c,&seq);
  pf_codec_u32(c,&effect);
  pf_codec_u32(c,&existed);
  s->recipe=(PFRecipe)recipe;
  s->receipt.phase=(PFWritePhase)phase;
  s->receipt.result=(PFResult)result;
  s->receipt.sequence=seq;
  s->receipt.namespace_effect=effect;
  s->receipt.existed=existed;
  if(recipe<1||recipe>3||phase>PF_WRITE_UNKNOWN||result>PF_UNSUPPORTED||seq>PF_NATIVE_RECORDS||effect>2||existed>1)c->failed=1;
  pf_codec_stamp(c,&s->receipt.target);
  pf_codec_stamp(c,&s->receipt.displaced);
  pf_codec_bytes(c,s->receipt.target_hash,32);
  pf_codec_bytes(c,s->receipt.displaced_hash,32);
  pf_codec_bytes(c,s->receipt.hold_id,PF_WRITER_HOLD_ID_BYTES);
  pf_codec_stamp(c,&s->profile);
  pf_codec_stamp(c,&s->parent);
  pf_codec_stamp(c,&s->hold);
  PFNativeBinding *b=&s->hold_binding;
  pf_codec_u64(c,&b->device);
  pf_codec_u64(c,&b->inode);
  pf_codec_u64(c,&b->uid);
  pf_codec_u64(c,&b->mode);
  pf_codec_u64(c,&b->gid);
  pf_codec_u64(c,&b->flags);
  pf_codec_bytes(c,b->acl_hash,32);
  pf_codec_bytes(c,s->hold_id,PF_WRITER_HOLD_ID_BYTES);
  meta_codec(c,&s->before);
  meta_codec(c,&s->stage);
  meta_codec(c,&s->accepted_after);
  meta_codec(c,&s->restore_stage);
  for(unsigned i=0;i<2;i++)meta_codec(c,&s->snapshots[i]);
  pf_codec_u32(c,&s->record_count);
  if(s->record_count>PF_NATIVE_RECORDS)c->failed=1;
  if(c->failed)return PF_INVALID;
  for(uint32_t i=0;i<s->record_count;i++)meta_codec(c,&s->records[i]);
  return c->failed?PF_INVALID:PF_OK;
}
void pf_receipt_close(PFObservedReceipt *r){
  if(!r)return;
  for(unsigned i=0;i<2;i++)pf_snapshot_close(r->objects[i].snapshot);
  pf_packet_wipe(r,sizeof(*r));
  free(r);
}
PFResult pf_receipt_capture(PFWriteTxn *t,PFResult result,unsigned action,PFObservedReceipt **out){
  if(!out)return PF_INVALID;
  *out=NULL;
  if(!t||action>2)return PF_INVALID;
  PFObservedReceipt *r=calloc(1,sizeof(*r));
  if(!r)return PF_IO;
  r->schema=2;
  r->result=result;
  r->action=action;
  PFResult state=pf_native_writer_state(t,&r->native);
  if(state!=PF_OK){
    pf_receipt_close(r);
    return state;
  }
  r->sequence=r->native.receipt.sequence;
  r->effect=r->native.receipt.namespace_effect;
  unsigned second=1;
  if(r->native.receipt.phase==PF_WRITE_UNDONE)second=r->native.receipt.existed?2u:3u;
  for(unsigned i=0;i<2;i++){
    unsigned role=i?second:0u;
    PFObservedObject *o=&r->objects[i];
    o->result=pf_native_writer_snapshot(t,role,&o->snapshot);
    if(o->result==PF_OK){
      o->tag=o->snapshot->exists?2u:1u;
      o->identity=o->snapshot->meta.stamp;
    }
    else{
      PFStamp stamp;
      PFResult observed=pf_native_writer_stamp(t,role,&stamp);
      if(observed==PF_OK){
        o->identity=stamp;
        o->tag=3;
      }
      else o->tag=0;
    }
  }
  r->hold_status=r->native.hold.inode?1u:0u;
  /* Bytes are withheld if the current capability/bindings cannot be checked. */
  PFResult checked=pf_native_writer_current(t);
  for(unsigned i=0;checked==PF_OK&&i<2;i++)if(r->objects[i].snapshot){
    PFSnapshot *fresh=NULL;
    PFResult current=pf_native_writer_snapshot(t,i?second:0u,&fresh);
    if(current!=PF_OK)checked=current;
    else checked=pf_snapshot_compare(r->objects[i].snapshot,fresh,0);
    pf_snapshot_close(fresh);
  }
  if(checked!=PF_OK){
    for(unsigned i=0;i<2;i++){
      pf_snapshot_close(r->objects[i].snapshot);
      r->objects[i].snapshot=NULL;
      r->objects[i].tag=r->objects[i].identity.inode?3u:0u;
    }
  }
  else if(r->native.hold.inode)r->hold_status=2;
  *out=r;
  return PF_OK;
}
static PFResult receipt_codec(PFCodec *c,PFObservedReceipt *r){
  pf_codec_u32(c,&r->schema);
  pf_codec_u32(c,&r->action);
  pf_codec_u32(c,&r->target_index);
  pf_codec_u32(c,&r->sequence);
  pf_codec_u32(c,&r->effect);
  pf_codec_u32(c,&r->hold_status);
  uint32_t result=(uint32_t)r->result;
  pf_codec_u32(c,&result);
  r->result=(PFResult)result;
  if(r->schema!=2||r->action>2||r->target_index>=128||r->sequence>PF_NATIVE_RECORDS||r->effect>2||r->hold_status>2||result>PF_UNSUPPORTED)return PF_INVALID;
  pf_codec_bytes(c,r->transaction.bytes,16);
  pf_codec_bytes(c,r->plan_hash,32);
  pf_codec_bytes(c,r->intent_hash,32);
  pf_codec_bytes(c,r->record_hash,32);
  PFResult status=pf_native_state_codec(c,&r->native);
  if(status!=PF_OK)return status;
  for(unsigned i=0;i<2;i++){
    PFObservedObject *o=&r->objects[i];
    uint32_t result_code=(uint32_t)o->result;
    pf_codec_u32(c,&o->tag);
    pf_codec_u32(c,&result_code);
    o->result=(PFResult)result_code;
    pf_codec_stamp(c,&o->identity);
    if(o->tag>3||result_code>PF_UNSUPPORTED)return PF_INVALID;
    uint32_t n=0;
    unsigned char *buf=NULL;
    if(c->out&&o->snapshot){
      buf=malloc(PF_SNAPSHOT_BYTES);
      if(!buf)return PF_IO;
      status=pf_snapshot_encode(o->snapshot,buf,PF_SNAPSHOT_BYTES,&n);
      if(status!=PF_OK){
        pf_packet_wipe(buf,PF_SNAPSHOT_BYTES);
        free(buf);
        return status;
      }
    }
    pf_codec_u32(c,&n);
    if(n>PF_SNAPSHOT_BYTES||((o->tag==1||o->tag==2)!=!!n)){
      if(buf){
        pf_packet_wipe(buf,PF_SNAPSHOT_BYTES);
        free(buf);
      }
      return PF_INVALID;
    }
    if(!c->out&&n){
      buf=malloc(n);
      if(!buf)return PF_IO;
    }
    if(n)pf_codec_bytes(c,buf,n);
    if(!c->out&&n&&!c->failed)status=pf_snapshot_decode((PFByteView){
      buf,n
    }
    ,&o->snapshot);
    if(buf){
      pf_packet_wipe(buf,c->out?PF_SNAPSHOT_BYTES:n);
      free(buf);
    }
    if(status!=PF_OK)return status;
    if(o->snapshot&&((o->tag==2)!=!!o->snapshot->exists||memcmp(&o->identity,&o->snapshot->meta.stamp,sizeof(o->identity))))return PF_INVALID;
  }
  return c->failed?PF_TOO_LARGE:PF_OK;
}
PFResult pf_receipt_encode(const PFObservedReceipt *r,unsigned char *out,uint32_t cap,uint32_t *written){
  if(written)*written=0;
  if(!r||!out||!written||cap>PF_RECEIPT_BYTES)return PF_INVALID;
  PFObservedReceipt copy=*r;
  PFCodec c={
    out,NULL,cap,0,0
  }
  ;
  PFResult result=receipt_codec(&c,&copy);
  if(result!=PF_OK){
    pf_packet_wipe(out,cap);
    return result;
  }
  *written=c.at;
  return PF_OK;
}
PFResult pf_receipt_decode(PFByteView bytes,PFObservedReceipt **out){
  if(!out)return PF_INVALID;
  *out=NULL;
  if(!bytes.data||!bytes.size||bytes.size>PF_RECEIPT_BYTES)return PF_INVALID;
  PFObservedReceipt *r=calloc(1,sizeof(*r));
  if(!r)return PF_IO;
  PFCodec c={
    NULL,bytes.data,bytes.size,0,0
  }
  ;
  PFResult result=receipt_codec(&c,r);
  if(result!=PF_OK||c.at!=bytes.size){
    pf_receipt_close(r);
    return result==PF_OK?PF_INVALID:result;
  }
  *out=r;
  return PF_OK;
}
