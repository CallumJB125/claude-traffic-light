#include "protocol-private.h"
#include <stdlib.h>
#include <string.h>
#if defined(__APPLE__)
#include <CommonCrypto/CommonHMAC.h>
#endif
struct PFProtocol {
  PFRoot *profile,*app_parent;
  PFStoreRoot *store;
  PFStoreTxn *txn;
  PFSnapshot *snapshot;
  PFWriteSession *session;
  PFRecovery *recovery;
  PFPrivateBootstrap bootstrap;
  unsigned prepared_attempt, recovery_attempt, restore_attempt;
  uint32_t sequence,frames,aggregate;
  unsigned char seen[PF_PROTOCOL_MAX_FRAMES][16];
  unsigned dead;
}
;
uint64_t pf_private_protocol_cutoff(const PFProtocol *p){
  return p&&!p->dead?p->bootstrap.authority.cutoff:0;
}
void pf_private_protocol_stop(PFProtocol *p){
  if(p)p->dead=1;
}
static uint32_t read32(const unsigned char *p){
  uint32_t n=0;
  for(unsigned i=0;i<4;i++)n=(n<<8)|p[i];
  return n;
}
static void write32(unsigned char *p,uint32_t n){
  for(unsigned i=0;i<4;i++)p[i]=(unsigned char)(n>>(24u-i*8u));
}
static int nz(const unsigned char *p,size_t n){
  unsigned v=0;
  for(size_t i=0;i<n;i++)v|=p[i];
  return v!=0;
}
static int equal_mac(const unsigned char *a,const unsigned char *b){
  unsigned diff=0;
  for(unsigned i=0;i<32;i++)diff|=a[i]^b[i];
  return diff==0;
}
static PFResult mac(const PFPrivateBootstrap *b,const unsigned char *bytes,uint32_t n,unsigned char out[32]){
#if defined(__APPLE__)
  CCHmacContext c;
  static const char domain[]="PF-CHANNEL-V1";
  CCHmacInit(&c,kCCHmacAlgSHA256,b->key,32);
  CCHmacUpdate(&c,domain,sizeof(domain));
  CCHmacUpdate(&c,b->authority.session_nonce,16);
  CCHmacUpdate(&c,bytes,n);
  CCHmacFinal(&c,out);
  pf_packet_wipe(&c,sizeof(c));
  return PF_OK;
#else
  (void)b;
  (void)bytes;
  (void)n;
  memset(out,0,32);
  return PF_UNSUPPORTED;
#endif
}
static PFResult frame(const PFPrivateBootstrap *b,uint16_t op,uint32_t sequence,const unsigned char nonce[16],PFByteView payload,unsigned char *out,uint32_t cap,uint32_t *written){
  if(written)*written=0;
  if(!b||!nonce||!out||!written||(!payload.data&&payload.size)||payload.size>PF_FRAME_PAYLOAD||cap<PF_FRAME_OVERHEAD||payload.size>cap-PF_FRAME_OVERHEAD)return PF_TOO_LARGE;
  memcpy(out,"PFFRME02",8);
  out[8]=0;
  out[9]=2;
  out[10]=(unsigned char)(op>>8);
  out[11]=(unsigned char)op;
  memcpy(out+12,nonce,16);
  write32(out+28,sequence);
  write32(out+32,0);
  write32(out+36,payload.size);
  if(payload.size)memcpy(out+40,payload.data,payload.size);
  PFResult r=mac(b,out,40+payload.size,out+40+payload.size);
  if(r!=PF_OK){
    pf_packet_wipe(out,cap);
    return r;
  }
  *written=payload.size+PF_FRAME_OVERHEAD;
  return PF_OK;
}
#ifdef PF_PACKET_FIXTURE
PFResult pf_fixture_frame(const PFPrivateBootstrap *b,uint16_t op,uint32_t s,const unsigned char nonce[16],PFByteView p,unsigned char *o,uint32_t c,uint32_t *n){
  return frame(b,op,s,nonce,p,o,c,n);
}
#endif
PFResult pf_private_protocol_open(PFRoot *profile,PFRoot *app_parent,const PFPrivateBootstrap *b,PFProtocol **out){
  if(!out)return PF_INVALID;
  *out=NULL;
  uint64_t now=pf_packet_now();
  if(!b||!now||!b->authority.generation||(b->authority.mode!=1&&b->authority.mode!=2)||!nz(b->key,32)||!nz(b->authority.session_nonce,16)||!nz(b->authority.authority_hash,32)||b->authority.cutoff<=now||b->authority.cutoff-now>UINT64_C(8000000000))return PF_INVALID;
  PFProtocol *p=calloc(1,sizeof(*p));
  if(!p)return PF_IO;
  p->bootstrap=*b;
  PFResult r=pf_native_root_duplicate(profile,&p->profile);
  if(r==PF_OK)r=pf_native_root_duplicate(app_parent,&p->app_parent);
  if(r!=PF_OK){
    pf_protocol_close(p);
    return r;
  }
  *out=p;
  return PF_OK;
}
void pf_protocol_close(PFProtocol *p){
  if(!p)return;
  pf_snapshot_close(p->snapshot);
  pf_session_close(p->session);
  pf_recovery_close(p->recovery);
  pf_store_txn_close(p->txn);
  pf_store_close(p->store);
  pf_root_close(p->profile);
  pf_root_close(p->app_parent);
  pf_packet_wipe(p,sizeof(*p));
  free(p);
}
void pf_private_preparation_codec(PFCodec *c,PFPreparationFields *f){
  pf_codec_bytes(c,f->transaction.bytes,16);
  pf_codec_u32(c,&f->target_index);
  pf_codec_u32(c,&f->recipe);
  pf_codec_u64(c,&f->generation);
  pf_codec_u64(c,&f->cutoff);
  pf_codec_bytes(c,f->session_nonce,16);
  pf_codec_bytes(c,f->nonce,16);
  pf_codec_bytes(c,f->plan_hash,32);
  pf_codec_bytes(c,f->before_hash,32);
  pf_codec_bytes(c,f->after_hash,32);
  pf_codec_bytes(c,f->binding_hash,32);
  pf_codec_bytes(c,f->prepared_record_hash,32);
}
void pf_private_permit_codec(PFCodec *c,PFPermitFields *f){
  pf_codec_bytes(c,f->transaction.bytes,16);
  pf_codec_u32(c,&f->target_index);
  pf_codec_u32(c,&f->recipe);
  pf_codec_u32(c,&f->action);
  pf_codec_u32(c,&f->sequence);
  pf_codec_u64(c,&f->generation);
  pf_codec_u64(c,&f->cutoff);
  pf_codec_bytes(c,f->session_nonce,16);
  pf_codec_bytes(c,f->nonce,16);
  pf_codec_bytes(c,f->plan_hash,32);
  pf_codec_bytes(c,f->before_hash,32);
  pf_codec_bytes(c,f->stage_hash,32);
  pf_codec_bytes(c,f->binding_hash,32);
  pf_codec_bytes(c,f->intent_hash,32);
  pf_codec_bytes(c,f->native_record_hash,32);
  pf_codec_bytes(c,f->record_hash,32);
  pf_codec_bytes(c,f->previous_hash,32);
}
void pf_private_recovery_codec(PFCodec *c,PFRecoveryFields *f){
  pf_codec_bytes(c,f->transaction.bytes,16);
  pf_codec_u32(c,&f->target_index);
  pf_codec_u32(c,&f->recipe);
  pf_codec_u32(c,&f->schema);
  pf_codec_u64(c,&f->generation);
  pf_codec_u64(c,&f->cutoff);
  pf_codec_bytes(c,f->session_nonce,16);
  pf_codec_bytes(c,f->confirmation_nonce,16);
  pf_codec_bytes(c,f->profile_hash,32);
  pf_codec_bytes(c,f->plan_hash,32);
  pf_codec_bytes(c,f->record_hash,32);
  pf_codec_bytes(c,f->before_hash,32);
}
void pf_private_restore_codec(PFCodec *c,PFRestoreFields *f){
  pf_codec_bytes(c,f->transaction.bytes,16);
  pf_codec_u32(c,&f->target_index);
  pf_codec_u64(c,&f->generation);
  pf_codec_u64(c,&f->cutoff);
  pf_codec_bytes(c,f->session_nonce,16);
  pf_codec_bytes(c,f->confirmation_nonce,16);
  pf_codec_bytes(c,f->inspection_hash,32);
  pf_codec_bytes(c,f->record_hash,32);
}
static PFByteView blob(PFCodec *c,uint32_t max){
  uint32_t n=0;
  pf_codec_u32(c,&n);
  PFByteView v={
    NULL,0
  }
  ;
  if(c->failed||n>max||n>c->size-c->at){
    c->failed=1;
    return v;
  }
  v.data=c->in+c->at;
  v.size=n;
  c->at+=n;
  return v;
}
static int done(PFCodec *c){
  return !c->failed&&c->at==c->size;
}
static PFResult output_snapshot(PFSnapshot *s,unsigned char *out,uint32_t cap,uint32_t *written){
  uint32_t n=0;
  if(cap<4)return PF_TOO_LARGE;
  uint32_t available=cap-4;
  if(available>PF_SNAPSHOT_BYTES)available=PF_SNAPSHOT_BYTES;
  PFResult r=pf_snapshot_encode(s,out+4,available,&n);
  if(r==PF_OK){
    write32(out,n);
    *written=n+4;
  }
  return r;
}
static PFResult output_receipt(PFObservedReceipt *r,unsigned char *out,uint32_t cap,uint32_t *written){
  uint32_t n=0;
  if(cap<4)return PF_TOO_LARGE;
  uint32_t available=cap-4;
  if(available>PF_RECEIPT_BYTES)available=PF_RECEIPT_BYTES;
  PFResult result=pf_receipt_encode(r,out+4,available,&n);
  if(result==PF_OK){
    write32(out,n);
    *written=n+4;
  }
  return result;
}
static uint32_t worst_reply(uint16_t op){
  if(op==0x30)return PF_SNAPSHOT_BYTES+32;
  if(op==0x31)return PF_RECEIPT_BYTES+16384+32;
  if(op==0x35)return PF_RECEIPT_BYTES+16384+32;
  if(op>=0x32&&op<=0x34)return PF_RECEIPT_BYTES+32;
  if(op==0x44)return PF_STORE_BLOB_BYTES+32;
  if(op==0x41)return 16*16+32;
  if(op==0x48)return PF_STORE_MAX_CHILDREN*20+24+32;
  return 32;
}
static PFResult dispatch(PFProtocol *p,uint16_t op,PFByteView input,unsigned char *out,uint32_t cap,uint32_t *written,uint32_t *effects){
  *written=0;
  *effects=0;
  PFCodec c={
    NULL,input.data,input.size,0,0
  }
  ;
  PFResult result=PF_INVALID;
  if(op==0x30){
    uint32_t recipe=0;
    pf_codec_u32(&c,&recipe);
    if(!done(&c))return PF_INVALID;
    PFSnapshot *s=NULL;
    result=pf_snapshot_fixed(p->profile,(PFRecipe)recipe,NULL,&s);
    if(result==PF_OK){
      pf_snapshot_close(p->snapshot);
      p->snapshot=s;
      result=output_snapshot(s,out,cap,written);
    }
    return result;
  }
  if(op==0x31){
    if(p->session||p->recovery||p->prepared_attempt)return PF_INVALID;
    p->prepared_attempt=1;
    PFPreparationFields f={0};
    pf_private_preparation_codec(&c,&f);
    PFByteView before_bytes=blob(&c,PF_SNAPSHOT_BYTES),after=blob(&c,PF_READER_MAX_BYTES);
    if(!done(&c))return PF_INVALID;
    PFSnapshot *before=NULL;
    result=pf_snapshot_decode(before_bytes,&before);
    PFPrepareGrant *g=NULL;
    if(result==PF_OK)result=pf_private_prepare_grant(&p->bootstrap.authority,&f,&g);
    PFObservedReceipt *receipt=NULL;
    PFIntent *intent=NULL;
    if(result==PF_OK){
      *effects=4;
      result=pf_session_prepare(p->profile,(PFRecipe)f.recipe,g,before,after,&p->session,&receipt);
    }
    if(result==PF_OK)result=pf_session_intent(p->session,&intent);
    uint32_t a=0,b=0;
    if(receipt){
      PFResult encoded=output_receipt(receipt,out,cap,&a);
      if(encoded!=PF_OK)result=encoded;
    }
    if(result==PF_OK&&intent){
      if(a+4>cap)result=PF_TOO_LARGE;
      else{
        uint32_t available=cap-a-4;
        if(available>16384)available=16384;
        result=pf_intent_encode(intent,out+a+4,available,&b);
        if(result==PF_OK){
          write32(out+a,b);
          a+=4+b;
        }
      }
    }
    *written=a;
    pf_prepare_grant_close(g);
    pf_snapshot_close(before);
    pf_receipt_close(receipt);
    pf_intent_close(intent);
    return result;
  }
  if(op==0x35){
    if(!p->recovery)return PF_INVALID;
    uint32_t phase=0;
    pf_codec_u32(&c,&phase);
    if(phase==0){
      if(p->restore_attempt)return PF_INVALID;
      p->restore_attempt=1;
      PFRestoreFields f={0};
      pf_private_restore_codec(&c,&f);
      if(!done(&c))return PF_INVALID;
      PFRestoreGrant *g=NULL;
      PFIntent *intent=NULL;
      result=pf_private_restore_grant(&p->bootstrap.authority,&f,&g);
      if(result==PF_OK){
        *effects=4;
        result=pf_recovery_intent(p->recovery,g,&intent);
      }
      PFObservedReceipt *current=NULL;
      PFResult observed=pf_recovery_observe(p->recovery,&current);
      uint32_t a=0,b=0;
      if(current){
        PFResult encoded=output_receipt(current,out,cap,&a);
        if(encoded!=PF_OK)result=encoded;
      }
      if(result==PF_OK&&intent){
        if(a+4>cap)result=PF_TOO_LARGE;
        else{
          uint32_t available=cap-a-4;
          if(available>16384)available=16384;
          result=pf_intent_encode(intent,out+a+4,available,&b);
          if(result==PF_OK){
            write32(out+a,b);
            a+=4+b;
          }
        }
      }
      if(result==PF_OK&&observed!=PF_OK)result=observed;
      *written=a;
      pf_intent_close(intent);
      pf_restore_grant_close(g);
      pf_receipt_close(current);
      return result;
    }
    if(phase!=1)return PF_INVALID;
    PFPermitFields f={0};
    pf_private_permit_codec(&c,&f);
    if(!done(&c))return PF_INVALID;
    PFPermit *permit=NULL;
    result=pf_private_permit(&p->bootstrap.authority,&f,&permit);
    PFObservedReceipt *r=NULL;
    if(result==PF_OK){
      *effects=2;
      result=pf_recovery_restore(p->recovery,permit,&r);
    }
    if(r){
      *effects=r->effect;
      PFResult encoded=output_receipt(r,out,cap,written);
      if(encoded!=PF_OK)result=encoded;
    }
    pf_receipt_close(r);
    pf_permit_close(permit);
    return result;
  }
  if(op==0x32){
    if(!p->session)return PF_INVALID;
    PFPermitFields f={0};
    pf_private_permit_codec(&c,&f);
    if(!done(&c))return PF_INVALID;
    PFPermit *permit=NULL;
    result=pf_private_permit(&p->bootstrap.authority,&f,&permit);
    PFObservedReceipt *r=NULL;
    if(result==PF_OK){
      *effects=2;
      result=pf_session_apply(p->session,permit,&r);
    }
    if(r){
      *effects=r->effect;
      PFResult encoded=output_receipt(r,out,cap,written);
      if(encoded!=PF_OK)result=encoded;
    }
    pf_receipt_close(r);
    pf_permit_close(permit);
    return result;
  }
  if(op==0x33){
    if(input.size)return PF_INVALID;
    PFObservedReceipt *r=NULL;
    if(p->session)result=pf_session_check(p->session,&r);
    else if(p->recovery)result=pf_recovery_observe(p->recovery,&r);
    if(r){
      *effects=r->effect;
      PFResult encoded=output_receipt(r,out,cap,written);
      if(encoded!=PF_OK)result=encoded;
    }
    pf_receipt_close(r);
    return result;
  }
  if(op==0x34){
    if(p->session||p->recovery||p->recovery_attempt)return PF_INVALID;
    p->recovery_attempt=1;
    PFRecoveryFields f={0};
    pf_private_recovery_codec(&c,&f);
    PFObservedReceipt anchor={0};
    anchor.schema=2;
    anchor.transaction=f.transaction;
    anchor.target_index=f.target_index;
    memcpy(anchor.plan_hash,f.plan_hash,32);
    memcpy(anchor.record_hash,f.record_hash,32);
    result=pf_native_state_codec(&c,&anchor.native);
    PFByteView bytes=blob(&c,PF_SNAPSHOT_BYTES);
    if(result!=PF_OK||!done(&c))return PF_INVALID;
    PFSnapshot *before=NULL;
    result=pf_snapshot_decode(bytes,&before);
    PFRecoveryGrant *grant=NULL;
    if(result==PF_OK)result=pf_private_recovery_grant(&p->bootstrap.authority,&f,&anchor,before,&grant);
    PFObservedReceipt *current=NULL;
    if(result==PF_OK)result=pf_recovery_inspect(p->profile,grant,&p->recovery,&current);
    /* Inspection is read-only. Restore intent is deliberately a later request. */
    if(current){
      PFResult encoded=output_receipt(current,out,cap,written);
      if(encoded!=PF_OK)result=encoded;
    }
    pf_receipt_close(current);
    pf_recovery_grant_close(grant);
    pf_snapshot_close(before);
    return result;
  }
  if(op==0x40){
    if(input.size||p->store)return PF_INVALID;
    *effects=4;
    return pf_store_open_fixed(p->app_parent,&p->store);
  }
  if(op==0x48){
    if(input.size||!p->store)return PF_INVALID;
    PFStoreInventory *inventory=calloc(1,sizeof(*inventory));if(!inventory)return PF_IO;
    result=pf_store_inventory(p->store,p->txn,inventory);
    if(result==PF_OK){PFCodec encoded={out,NULL,cap,0,0};
      pf_codec_u32(&encoded,&inventory->namespaces);pf_codec_u64(&encoded,&inventory->total_bytes);pf_codec_u64(&encoded,&inventory->transaction_bytes);pf_codec_u32(&encoded,&inventory->children);
      for(uint32_t i=0;i<inventory->children;i++){PFStoreEntry *e=&inventory->entries[i];pf_codec_u32(&encoded,&e->role);pf_codec_u32(&encoded,&e->target);pf_codec_u32(&encoded,&e->sequence);pf_codec_u64(&encoded,&e->bytes);}
      if(encoded.failed){pf_packet_wipe(out,cap);result=PF_TOO_LARGE;}else *written=encoded.at;
    }
    pf_packet_wipe(inventory,sizeof(*inventory));free(inventory);return result;
  }
  if(op==0x41){
    if(input.size||!p->store)return PF_INVALID;
    PFUuid ids[16];
    uint32_t n=0;
    result=pf_store_list(p->store,ids,16,&n);
    if(result==PF_OK){
      if(cap<4+n*16)return PF_TOO_LARGE;
      write32(out,n);
      for(uint32_t i=0;i<n;i++)memcpy(out+4+i*16,ids[i].bytes,16);
      *written=4+n*16;
    }
    return result;
  }
  if(op==0x42||op==0x43){
    PFUuid id;
    pf_codec_bytes(&c,id.bytes,16);
    if(!done(&c)||!p->store||p->txn)return PF_INVALID;
    if(op==0x42)*effects=4;
    return op==0x42?pf_store_create_txn(p->store,id,&p->txn):pf_store_open_txn(p->store,id,&p->txn);
  }
  if(op==0x44||op==0x45){
    uint32_t role=0,index=0,seq=0;
    pf_codec_u32(&c,&role);
    pf_codec_u32(&c,&index);
    pf_codec_u32(&c,&seq);
    PFByteView bytes={
      NULL,0
    }
    ;
    if(op==0x45)bytes=blob(&c,PF_STORE_BLOB_BYTES);
    if(!done(&c)||!p->txn)return PF_INVALID;
    if(op==0x45){
      *effects=4;
      return pf_store_write_exclusive(p->txn,(PFStoreRole)role,index,seq,bytes);
    }
    if(cap<4)return PF_TOO_LARGE;
    uint32_t n=0,available=cap-4;
    if(available>PF_STORE_BLOB_BYTES)available=PF_STORE_BLOB_BYTES;
    result=pf_store_read(p->txn,(PFStoreRole)role,index,seq,out+4,available,&n);
    if(result==PF_OK){
      write32(out,n);
      *written=4+n;
    }
    return result;
  }
  if(op==0x46){
    if(input.size||!p->txn)return PF_INVALID;
    return pf_store_sync(p->txn);
  }
  if(op==0x47){
    if(input.size)return PF_INVALID;
    pf_store_txn_close(p->txn);
    p->txn=NULL;
    pf_store_close(p->store);
    p->store=NULL;
    return PF_OK;
  }
  return PF_UNSUPPORTED;
}
PFResult pf_protocol_process(PFProtocol *p,PFByteView incoming,unsigned char *out,uint32_t cap,uint32_t *written){
  if(written)*written=0;
  if(!p||!out||!written||p->dead||!incoming.data)return PF_INVALID;
  if(cap<PF_FRAME_OVERHEAD+12||incoming.size<PF_FRAME_OVERHEAD||incoming.size>PF_FRAME_PAYLOAD+PF_FRAME_OVERHEAD||p->frames>=PF_PROTOCOL_MAX_FRAMES||incoming.size>PF_FRAME_AGGREGATE-p->aggregate){
    p->dead=1;
    return PF_TOO_LARGE;
  }
  const unsigned char *h=incoming.data;
  uint32_t len=read32(h+36),seq=read32(h+28);
  uint16_t op=(uint16_t)(((uint16_t)h[10]<<8)|h[11]);
  if(memcmp(h,"PFFRME02",8)||h[8]!=0||h[9]!=2||read32(h+32)||len>PF_FRAME_PAYLOAD||len!=incoming.size-PF_FRAME_OVERHEAD||seq!=p->sequence||!nz(h+12,16)||!((op>=0x30&&op<=0x35)||(op>=0x40&&op<=0x48))){
    p->dead=1;
    return PF_INVALID;
  }
  for(uint32_t i=0;i<p->frames;i++)if(!memcmp(p->seen[i],h+12,16)){
    p->dead=1;
    return PF_INVALID;
  }
  unsigned char expected[32];
  PFResult result=mac(&p->bootstrap,h,40+len,expected);
  if(result!=PF_OK||!equal_mac(expected,h+40+len)){
    pf_packet_wipe(expected,32);
    p->dead=1;
    return result==PF_OK?PF_UNSAFE:result;
  }
  pf_packet_wipe(expected,32);
  uint32_t worst=worst_reply(op)+PF_FRAME_OVERHEAD;
  if(worst>cap||incoming.size>PF_FRAME_AGGREGATE-p->aggregate||worst>PF_FRAME_AGGREGATE-p->aggregate-incoming.size){
    p->dead=1;
    return PF_TOO_LARGE;
  }
  uint64_t now=pf_packet_now();
  if(!now||now>=p->bootstrap.authority.cutoff){
    p->dead=1;
    return PF_DEADLINE;
  }
  result=pf_native_root_current(p->profile);
  if(result==PF_OK)result=pf_native_root_current(p->app_parent);
  if(result!=PF_OK){
    p->dead=1;
    return result;
  }
  memcpy(p->seen[p->frames++],h+12,16);
  p->sequence++;
  p->aggregate+=incoming.size;
  unsigned char *payload=calloc(PF_FRAME_PAYLOAD,1);
  if(!payload){
    p->dead=1;
    return PF_IO;
  }
  uint32_t bytes=0,effects=0;
  result=dispatch(p,op,(PFByteView){
    h+40,len
  }
  ,payload+12,PF_FRAME_PAYLOAD-12,&bytes,&effects);
  now=pf_packet_now();
  if(!now||now>=p->bootstrap.authority.cutoff){
    result=PF_DEADLINE;
    bytes=0;
    p->dead=1;
  }
  if(result==PF_INVALID)p->dead=1;
  write32(payload,(uint32_t)result);
  write32(payload+4,effects);
  write32(payload+8,bytes);
  PFResult encoded=frame(&p->bootstrap,(uint16_t)(op|0x8000),seq,h+12,(PFByteView){
    payload,bytes+12
  }
  ,out,cap,written);
  pf_packet_wipe(payload,PF_FRAME_PAYLOAD);
  free(payload);
  if(encoded!=PF_OK){
    p->dead=1;
    return encoded;
  }
  p->aggregate+=*written;
  return PF_OK;
}
