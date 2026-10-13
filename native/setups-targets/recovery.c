#include "recovery-private.h"
#include <stdlib.h>
#include <string.h>
static int uuid_valid(PFUuid u){
  return (u.bytes[6]&0xf0)==0x40&&(u.bytes[8]&0xc0)==0x80;
}
static int nz(const unsigned char *b,size_t n){
  unsigned v=0;
  for(size_t i=0;i<n;i++)v|=b[i];
  return v!=0;
}
PFResult pf_private_recovery_grant(const PFChannelBinding *c,const PFRecoveryFields *f,const PFObservedReceipt *observed,const PFSnapshot *before,PFRecoveryGrant **out){
  if(!out)return PF_INVALID;
  *out=NULL;
  if(!c||!f||!observed||!before||c->mode!=2||!c->generation||c->cutoff<=pf_packet_now()||f->generation!=c->generation||f->cutoff>c->cutoff||f->cutoff<=pf_packet_now()||memcmp(f->session_nonce,c->session_nonce,16)||!nz(f->confirmation_nonce,16)||!nz(c->authority_hash,32)||!uuid_valid(f->transaction)||f->schema!=2||observed->schema!=2||f->recipe<1||f->recipe>3||f->recipe!=(unsigned)before->recipe||f->recipe!=(unsigned)observed->native.recipe||f->target_index>=128||f->target_index!=observed->target_index||memcmp(f->transaction.bytes,observed->transaction.bytes,16)||memcmp(f->profile_hash,before->bindings.profile_hash,32)||memcmp(f->before_hash,before->digest,32)||memcmp(f->plan_hash,observed->plan_hash,32)||!nz(f->record_hash,32)||memcmp(f->record_hash,observed->record_hash,32))return PF_INVALID;
  PFRecoveryGrant *g=calloc(1,sizeof(*g));
  if(!g)return PF_IO;
  g->before=malloc(sizeof(*before));
  if(!g->before){
    free(g);
    return PF_IO;
  }
  *g->before=*before;
  g->channel=*c;
  g->fields=*f;
  g->anchor=observed->native;
  *out=g;
  return PF_OK;
}
void pf_recovery_grant_close(PFRecoveryGrant *g){
  if(!g)return;
  pf_snapshot_close(g->before);
  pf_packet_wipe(g,sizeof(*g));
  free(g);
}
PFResult pf_recovery_inspect(PFRoot *root,PFRecoveryGrant *g,PFRecovery **out,PFObservedReceipt **current){
  if(out)*out=NULL;
  if(current)*current=NULL;
  if(!out||!current||!g||g->used)return PF_INVALID;
  g->used=1;
  if(g->fields.cutoff<=pf_packet_now())return PF_DEADLINE;
  PFRecovery *r=calloc(1,sizeof(*r));
  if(!r)return PF_IO;
  r->channel=g->channel;
  r->channel.cutoff=g->fields.cutoff;
  r->prepared.transaction=g->fields.transaction;
  r->prepared.recipe=g->fields.recipe;
  r->prepared.target_index=g->fields.target_index;
  r->prepared.generation=g->fields.generation;
  r->prepared.cutoff=g->fields.cutoff;
  memcpy(r->prepared.plan_hash,g->fields.plan_hash,32);
  memcpy(r->prepared.before_hash,g->fields.before_hash,32);
  memcpy(r->prepared.prepared_record_hash,g->fields.record_hash,32);
  memcpy(r->prepared.session_nonce,g->fields.session_nonce,16);
  memcpy(r->confirmation_nonce,g->fields.confirmation_nonce,16);
  memcpy(r->record_hash,g->fields.record_hash,32);
  PFResult result=pf_private_binding_hash(&g->before->bindings,r->prepared.binding_hash);
  if(result==PF_OK)result=pf_native_writer_recover(root,&g->anchor,g->before,r->channel.cutoff,&r->writer);
  if(result==PF_OK)result=pf_receipt_capture(r->writer,PF_OK,0,current);
  if(*current){
    (*current)->transaction=r->prepared.transaction;
    (*current)->target_index=r->prepared.target_index;
    memcpy((*current)->plan_hash,r->prepared.plan_hash,32);
    memcpy((*current)->record_hash,g->fields.record_hash,32);
  }
  if(result==PF_OK){
    unsigned char *bytes=malloc(PF_RECEIPT_BYTES);
    uint32_t size=0;
    if(!bytes)result=PF_IO;
    else{
      result=pf_receipt_encode(*current,bytes,PF_RECEIPT_BYTES,&size);
      if(result==PF_OK)pf_packet_hash(bytes,size,r->inspection_hash);
      pf_packet_wipe(bytes,PF_RECEIPT_BYTES);
      free(bytes);
    }
  }
  if(result!=PF_OK){
    pf_receipt_close(*current);
    *current=NULL;
    pf_recovery_close(r);
    return result;
  }
  *out=r;
  return PF_OK;
}
PFResult pf_private_restore_grant(const PFChannelBinding *c,const PFRestoreFields *f,PFRestoreGrant **out){
  if(!out)return PF_INVALID;
  *out=NULL;
  if(!c||!f||c->mode!=2||c->cutoff<=pf_packet_now()||!c->generation||!uuid_valid(f->transaction)||f->target_index>=128||f->generation!=c->generation||f->cutoff>c->cutoff||f->cutoff<=pf_packet_now()||memcmp(f->session_nonce,c->session_nonce,16)||!nz(f->confirmation_nonce,16)||!nz(f->inspection_hash,32)||!nz(f->record_hash,32))return PF_INVALID;
  PFRestoreGrant *g=calloc(1,sizeof(*g));
  if(!g)return PF_IO;
  g->channel=*c;
  g->fields=*f;
  *out=g;
  return PF_OK;
}
void pf_restore_grant_close(PFRestoreGrant *g){
  if(g){
    pf_packet_wipe(g,sizeof(*g));
    free(g);
  }
}
PFResult pf_recovery_observe(PFRecovery *r,PFObservedReceipt **out){
  if(!out)return PF_INVALID;
  *out=NULL;
  if(!r)return PF_INVALID;
  if(r->channel.cutoff<=pf_packet_now())return PF_DEADLINE;
  PFResult result=pf_receipt_capture(r->writer,PF_OK,0,out);
  if(*out){
    (*out)->transaction=r->prepared.transaction;
    (*out)->target_index=r->prepared.target_index;
    memcpy((*out)->plan_hash,r->prepared.plan_hash,32);
    memcpy((*out)->record_hash,r->record_hash,32);
  }
  return result;
}
PFResult pf_recovery_intent(PFRecovery *r,PFRestoreGrant *g,PFIntent **out){
  if(!out)return PF_INVALID;
  *out=NULL;
  if(!g||g->used)return PF_INVALID;
  g->used=1;
  if(!r||r->attempted||r->intent)return PF_INVALID;
  r->attempted=1;
  const PFRestoreFields *f=&g->fields;
  if(g->channel.mode!=r->channel.mode||g->channel.generation!=r->channel.generation||memcmp(g->channel.session_nonce,r->channel.session_nonce,16)||memcmp(g->channel.authority_hash,r->channel.authority_hash,32)||f->generation!=r->channel.generation||f->cutoff>r->channel.cutoff||f->cutoff<=pf_packet_now()||memcmp(f->session_nonce,r->channel.session_nonce,16)||memcmp(f->transaction.bytes,r->prepared.transaction.bytes,16)||f->target_index!=r->prepared.target_index||!memcmp(f->confirmation_nonce,r->confirmation_nonce,16)||memcmp(f->inspection_hash,r->inspection_hash,32)||memcmp(f->record_hash,r->record_hash,32))return PF_INVALID;
  PFObservedReceipt *current=NULL;
  PFResult result=pf_recovery_observe(r,&current);
  unsigned char *bytes=NULL;
  uint32_t size=0;
  unsigned char hash[32]={0};
  if(result==PF_OK){
    bytes=malloc(PF_RECEIPT_BYTES);
    if(!bytes)result=PF_IO;
    else result=pf_receipt_encode(current,bytes,PF_RECEIPT_BYTES,&size);
  }
  if(result==PF_OK){
    pf_packet_hash(bytes,size,hash);
    if(memcmp(hash,r->inspection_hash,32))result=PF_CHANGED;
  }
  if(bytes){
    pf_packet_wipe(bytes,PF_RECEIPT_BYTES);
    free(bytes);
  }
  pf_receipt_close(current);
  if(result==PF_OK){
    r->channel.cutoff=f->cutoff;
    result=pf_native_writer_restrict_cutoff(r->writer,f->cutoff);
  }
  if(result==PF_OK)result=pf_private_intent(r->writer,&r->channel,&r->prepared,2,&r->intent);
  if(result!=PF_OK)return result;
  PFIntent *copy=malloc(sizeof(*copy));
  if(!copy)return PF_IO;
  *copy=*r->intent;
  *out=copy;
  r->attempted=0;
  return PF_OK;
}
PFResult pf_recovery_restore(PFRecovery *r,PFPermit *permit,PFObservedReceipt **out){
  if(!out)return PF_INVALID;
  *out=NULL;
  if(!r||r->attempted)return PF_INVALID;
  r->attempted=1;
  PFResult result=pf_private_permit_consume(permit,&r->channel,r->intent);
  PFWriteReceipt actual;
  if(result==PF_OK)result=pf_native_writer_restrict_cutoff(r->writer,permit->fields.cutoff);
  if(result==PF_OK)result=pf_writer_undo(r->writer,&actual);
  PFResult observed=pf_receipt_capture(r->writer,result,2,out);
  if(*out){
    (*out)->transaction=r->prepared.transaction;
    (*out)->target_index=r->prepared.target_index;
    memcpy((*out)->plan_hash,r->prepared.plan_hash,32);
    if(r->intent)memcpy((*out)->intent_hash,r->intent->digest,32);
    if(permit&&result==PF_OK){
      memcpy(r->record_hash,permit->fields.record_hash,32);
    }
    memcpy((*out)->record_hash,r->record_hash,32);
  }
  return observed!=PF_OK?observed:result;
}
void pf_recovery_close(PFRecovery *r){
  if(!r)return;
  pf_writer_close(r->writer);
  pf_intent_close(r->intent);
  pf_packet_wipe(r,sizeof(*r));
  free(r);
}
