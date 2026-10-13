#include "journal-gate-private.h"
#include <stdlib.h>
#include <string.h>
static int uuid_valid(PFUuid u){
  return (u.bytes[6]&0xf0)==0x40&&(u.bytes[8]&0xc0)==0x80;
}
static int nonzero(const unsigned char *p,size_t n){
  unsigned value=0;
  for(size_t i=0;i<n;i++)value|=p[i];
  return value!=0;
}
static PFResult channel_current(const PFChannelBinding *b){
  uint64_t now=pf_packet_now();
  if(!b||!now||!b->generation||(b->mode!=1&&b->mode!=2)||!nonzero(b->session_nonce,16)||!nonzero(b->authority_hash,32))return PF_INVALID;
  return now>=b->cutoff?PF_DEADLINE:PF_OK;
}
PFResult pf_private_binding_hash(const PFBindingSet *b,unsigned char out[32]){
  if(!b||!out||!b->count||b->count>PF_SNAPSHOT_BINDINGS)return PF_INVALID;
  unsigned char bytes[8192]={0};
  PFCodec c={
    bytes,NULL,sizeof(bytes),0,0
  }
  ;
  unsigned char domain[16]="PF-BINDINGS-V1";
  pf_codec_bytes(&c,domain,16);
  uint32_t count=b->count;
  pf_codec_u32(&c,&count);
  pf_codec_bytes(&c,(void *)b->profile_hash,32);
  for(uint32_t i=0;i<count;i++){
    PFNativeBinding x=b->entries[i];
    pf_codec_u64(&c,&x.device);
    pf_codec_u64(&c,&x.inode);
    pf_codec_u64(&c,&x.uid);
    pf_codec_u64(&c,&x.mode);
    pf_codec_u64(&c,&x.gid);
    pf_codec_u64(&c,&x.flags);
    pf_codec_bytes(&c,x.acl_hash,32);
  }
  if(c.failed)return PF_TOO_LARGE;
  pf_packet_hash(bytes,c.at,out);
  pf_packet_wipe(bytes,sizeof(bytes));
  return PF_OK;
}
PFResult pf_private_prepare_grant(const PFChannelBinding *c,const PFPreparationFields *f,PFPrepareGrant **out){
  if(!out)return PF_INVALID;
  *out=NULL;
  PFResult r=channel_current(c);
  if(r!=PF_OK)return r;
  if(!f||!uuid_valid(f->transaction)||c->mode!=1||f->generation!=c->generation||memcmp(f->session_nonce,c->session_nonce,16)||f->cutoff>c->cutoff||f->cutoff<=pf_packet_now()||f->target_index>=128||f->recipe<1||f->recipe>3||!nonzero(f->nonce,16)||!nonzero(f->plan_hash,32)||!nonzero(f->before_hash,32)||!nonzero(f->after_hash,32)||!nonzero(f->binding_hash,32)||!nonzero(f->prepared_record_hash,32))return PF_INVALID;
  PFPrepareGrant *g=calloc(1,sizeof(*g));
  if(!g)return PF_IO;
  g->channel=*c;
  g->fields=*f;
  *out=g;
  return PF_OK;
}
PFResult pf_private_permit(const PFChannelBinding *c,const PFPermitFields *f,PFPermit **out){
  if(!out)return PF_INVALID;
  *out=NULL;
  PFResult r=channel_current(c);
  if(r!=PF_OK)return r;
  if(!f||!uuid_valid(f->transaction)||f->generation!=c->generation||memcmp(f->session_nonce,c->session_nonce,16)||f->cutoff>c->cutoff||f->cutoff<=pf_packet_now()||f->target_index>=128||f->recipe<1||f->recipe>3||(f->action!=1&&f->action!=2)||(c->mode==2&&f->action!=2)||!nonzero(f->nonce,16)||!nonzero(f->record_hash,32)||!nonzero(f->previous_hash,32)||!nonzero(f->intent_hash,32))return PF_INVALID;
  PFPermit *p=calloc(1,sizeof(*p));
  if(!p)return PF_IO;
  p->channel=*c;
  p->fields=*f;
  *out=p;
  return PF_OK;
}
void pf_prepare_grant_close(PFPrepareGrant *g){
  if(g){
    pf_packet_wipe(g,sizeof(*g));
    free(g);
  }
}
void pf_permit_close(PFPermit *g){
  if(g){
    pf_packet_wipe(g,sizeof(*g));
    free(g);
  }
}
void pf_intent_close(PFIntent *i){
  if(i){
    pf_packet_wipe(i,sizeof(*i));
    free(i);
  }
}
PFResult pf_private_intent_codec(PFCodec *c,PFIntent *i){
  uint32_t schema=2;
  pf_codec_u32(c,&schema);
  if(schema!=2)return PF_INVALID;
  PFPermitFields *f=&i->fields;
  pf_codec_bytes(c,f->transaction.bytes,16);
  pf_codec_u32(c,&f->target_index);
  pf_codec_u32(c,&f->recipe);
  pf_codec_u32(c,&f->action);
  pf_codec_u32(c,&f->sequence);
  pf_codec_u64(c,&f->generation);
  pf_codec_u64(c,&f->cutoff);
  pf_codec_bytes(c,f->session_nonce,16);
  pf_codec_bytes(c,f->plan_hash,32);
  pf_codec_bytes(c,f->before_hash,32);
  pf_codec_bytes(c,f->stage_hash,32);
  pf_codec_bytes(c,f->binding_hash,32);
  pf_codec_bytes(c,f->native_record_hash,32);
  return pf_native_state_codec(c,&i->native);
}
PFResult pf_intent_encode(const PFIntent *i,unsigned char *out,uint32_t cap,uint32_t *written){
  if(written)*written=0;
  if(!i||!out||!written||cap>16384)return PF_INVALID;
  PFIntent copy=*i;
  PFCodec c={
    out,NULL,cap,0,0
  }
  ;
  PFResult r=pf_private_intent_codec(&c,&copy);
  if(r!=PF_OK||c.failed){
    pf_packet_wipe(out,cap);
    return r==PF_OK?PF_TOO_LARGE:r;
  }
  *written=c.at;
  return PF_OK;
}
PFResult pf_private_intent(PFWriteTxn *writer,const PFChannelBinding *channel,const PFPreparationFields *prepared,unsigned action,PFIntent **out){
  if(!out)return PF_INVALID;
  *out=NULL;
  PFResult r=channel_current(channel);
  if(r!=PF_OK)return r;
  PFIntent *i=calloc(1,sizeof(*i));
  if(!i)return PF_IO;
  i->fields.transaction=prepared->transaction;
  i->fields.target_index=prepared->target_index;
  i->fields.recipe=prepared->recipe;
  i->fields.action=action;
  i->fields.generation=channel->generation;
  i->fields.cutoff=channel->cutoff;
  memcpy(i->fields.session_nonce,channel->session_nonce,16);
  memcpy(i->fields.plan_hash,prepared->plan_hash,32);
  memcpy(i->fields.before_hash,prepared->before_hash,32);
  memcpy(i->fields.binding_hash,prepared->binding_hash,32);
  r=pf_native_writer_intent(writer,action,&i->native);
  PFSnapshot *stage=NULL;
  if(r==PF_OK&&i->native.receipt.phase!=PF_WRITE_NOOP)r=pf_native_writer_snapshot(writer,action==1?1u:i->native.receipt.existed?2u:0u,&stage);
  if(r==PF_OK){
    if(stage)memcpy(i->fields.stage_hash,stage->digest,32);
    else memcpy(i->fields.stage_hash,prepared->after_hash,32);
    i->fields.sequence=i->native.record_count;
    unsigned n=i->native.record_count;
    if(n)memcpy(i->fields.native_record_hash,i->native.records[n-1].hash,32);
    else memcpy(i->fields.native_record_hash,prepared->prepared_record_hash,32);
  }
  pf_snapshot_close(stage);
  if(r==PF_OK){
    unsigned char encoded[16384];
    uint32_t n=0;
    r=pf_intent_encode(i,encoded,sizeof(encoded),&n);
    if(r==PF_OK){
      /* Distinct canonical schema/action/closed body supplies the intent domain. */pf_packet_hash(encoded,n,i->digest);
      memcpy(i->fields.intent_hash,i->digest,32);
    }
    pf_packet_wipe(encoded,sizeof(encoded));
  }
  if(r!=PF_OK){
    pf_intent_close(i);
    return r;
  }
  *out=i;
  return PF_OK;
}
PFResult pf_private_permit_consume(PFPermit *p,const PFChannelBinding *c,const PFIntent *i){
  if(!p||p->used)return PF_INVALID;
  p->used=1;
  PFResult r=channel_current(c);
  if(r!=PF_OK)return r;
  if(!i)return PF_INVALID;
  if(p->channel.mode!=c->mode||p->channel.generation!=c->generation||memcmp(p->channel.session_nonce,c->session_nonce,16)||memcmp(p->channel.authority_hash,c->authority_hash,32)||p->fields.cutoff>i->fields.cutoff||p->fields.cutoff<=pf_packet_now())return PF_DEADLINE;
  const PFPermitFields *a=&p->fields,*b=&i->fields;
  if(memcmp(a->transaction.bytes,b->transaction.bytes,16)||a->target_index!=b->target_index||a->recipe!=b->recipe||a->action!=b->action||a->sequence!=b->sequence||a->generation!=b->generation||memcmp(a->session_nonce,b->session_nonce,16)||memcmp(a->plan_hash,b->plan_hash,32)||memcmp(a->before_hash,b->before_hash,32)||memcmp(a->stage_hash,b->stage_hash,32)||memcmp(a->binding_hash,b->binding_hash,32)||memcmp(a->native_record_hash,b->native_record_hash,32)||memcmp(a->intent_hash,i->digest,32))return PF_INVALID;
  return PF_OK;
}
PFResult pf_session_prepare(PFRoot *root,PFRecipe recipe,PFPrepareGrant *g,const PFSnapshot *before,PFByteView after,PFWriteSession **out,PFObservedReceipt **observed){
  if(out)*out=NULL;
  if(observed)*observed=NULL;
  if(!out||!observed||!g||g->used)return PF_INVALID;
  g->used=1;
  PFResult r=channel_current(&g->channel);
  if(r!=PF_OK)return r;
  if(g->fields.cutoff<=pf_packet_now())return PF_DEADLINE;
  if(!before||before->recipe!=recipe||g->fields.recipe!=(uint32_t)recipe||!after.data||after.size>PF_READER_MAX_BYTES)return PF_INVALID;
  unsigned char hash[32],binding[32];
  pf_packet_hash(after.data,after.size,hash);
  r=pf_private_binding_hash(&before->bindings,binding);
  if(r==PF_OK&&(memcmp(before->digest,g->fields.before_hash,32)||memcmp(hash,g->fields.after_hash,32)||memcmp(binding,g->fields.binding_hash,32)))r=PF_INVALID;
  if(r==PF_OK)r=pf_snapshot_current(root,recipe,before);
  if(r!=PF_OK)return r;
  PFWriteSession *s=calloc(1,sizeof(*s));
  if(!s)return PF_IO;
  s->before=malloc(sizeof(*before));
  if(!s->before){
    free(s);
    return PF_IO;
  }
  *s->before=*before;
  s->channel=g->channel;
  s->channel.cutoff=g->fields.cutoff;
  s->prepared=g->fields;
  memcpy(s->record_hash,g->fields.prepared_record_hash,32);
  r=pf_native_root_duplicate(root,&s->root);
  PFNativeWriterState failure={0};
  if(r==PF_OK)r=pf_native_writer_prepare_observed(root,recipe,before->exists?&before->meta.stamp:NULL,(PFByteView){
    before->bytes,(uint32_t)before->meta.stamp.size
  }
  ,after,s->channel.cutoff,&s->writer,&failure);
  if(r==PF_OK)r=pf_receipt_capture(s->writer,PF_OK,0,observed);
  else if(failure.hold.inode){
    PFObservedReceipt *f=calloc(1,sizeof(*f));
    if(f){
      f->schema=2;
      f->result=r;
      f->native=failure;
      f->hold_status=1;
      *observed=f;
    }
  }
  if(*observed){
    (*observed)->transaction=s->prepared.transaction;
    (*observed)->target_index=s->prepared.target_index;
    memcpy((*observed)->plan_hash,s->prepared.plan_hash,32);
    memcpy((*observed)->record_hash,s->prepared.prepared_record_hash,32);
  }
  if(r!=PF_OK){
    pf_session_close(s);
    return r;
  }
  *out=s;
  return PF_OK;
}
PFResult pf_session_intent(PFWriteSession *s,PFIntent **out){
  if(!out)return PF_INVALID;
  *out=NULL;
  if(!s||s->attempted||s->intent)return PF_INVALID;
  PFResult r=pf_private_intent(s->writer,&s->channel,&s->prepared,1,&s->intent);
  if(r!=PF_OK){
    s->attempted=1;
    return r;
  }
  PFIntent *copy=malloc(sizeof(*copy));
  if(!copy){
    s->attempted=1;
    return PF_IO;
  }
  *copy=*s->intent;
  *out=copy;
  return PF_OK;
}
PFResult pf_session_apply(PFWriteSession *s,PFPermit *p,PFObservedReceipt **out){
  if(!out)return PF_INVALID;
  *out=NULL;
  if(!s||s->attempted)return PF_INVALID;
  s->attempted=1;
  PFResult r=pf_private_permit_consume(p,&s->channel,s->intent);
  PFWriteReceipt receipt;
  if(r==PF_OK)r=pf_native_writer_restrict_cutoff(s->writer,p->fields.cutoff);
  if(r==PF_OK)r=pf_writer_apply(s->writer,&receipt);
  PFResult observed=pf_receipt_capture(s->writer,r,1,out);
  if(*out){
    (*out)->transaction=s->prepared.transaction;
    (*out)->target_index=s->prepared.target_index;
    memcpy((*out)->plan_hash,s->prepared.plan_hash,32);
    if(s->intent)memcpy((*out)->intent_hash,s->intent->digest,32);
    if(p&&r==PF_OK)memcpy(s->record_hash,p->fields.record_hash,32);
    memcpy((*out)->record_hash,s->record_hash,32);
  }
  return observed!=PF_OK?observed:r;
}
PFResult pf_session_check(PFWriteSession *s,PFObservedReceipt **out){
  if(!out)return PF_INVALID;
  *out=NULL;
  if(!s)return PF_INVALID;
  PFResult r=channel_current(&s->channel);
  if(r!=PF_OK)return r;
  PFResult result=pf_receipt_capture(s->writer,PF_OK,s->attempted?1u:0u,out);
  if(*out){
    (*out)->transaction=s->prepared.transaction;
    (*out)->target_index=s->prepared.target_index;
    memcpy((*out)->plan_hash,s->prepared.plan_hash,32);
    memcpy((*out)->record_hash,s->record_hash,32);
    if(s->intent)memcpy((*out)->intent_hash,s->intent->digest,32);
  }
  return result;
}
void pf_session_close(PFWriteSession *s){
  if(!s)return;
  pf_writer_close(s->writer);
  pf_snapshot_close(s->before);
  pf_root_close(s->root);
  pf_intent_close(s->intent);
  pf_packet_wipe(s,sizeof(*s));
  free(s);
}
