#define _DARWIN_C_SOURCE
#include "protocol-private.h"
#include <errno.h>
#include <fcntl.h>
#include <ftw.h>
#include <limits.h>
#include <membership.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/acl.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <sys/xattr.h>
#include <unistd.h>
#if !defined(__APPLE__) || !defined(PF_PACKET_FIXTURE)
#error Native fixture keys are test injection only, not production bootstrap.
#endif
static unsigned cases, failures, crash_stage;
int pf_writer_test_fault(unsigned stage){
  (void)stage;
  return 0;
}
void pf_writer_test_barrier(unsigned stage){
  if(crash_stage==stage)_exit(40);
}
void pf_reader_test_barrier(unsigned stage){
  (void)stage;
}
static const unsigned char original[]="SYNTHETIC BEFORE\r\n\0private fixture";
static const unsigned char desired[]="SYNTHETIC REVIEWED AFTER\r\n";
static char base[PATH_MAX], profile[PATH_MAX], app[PATH_MAX], file[PATH_MAX], folder[PATH_MAX];
static void must(int yes){
  if(!yes){
    perror("interface fixture");
    fprintf(stderr,"retained %s\n",base);
    exit(99);
  }
}
static void check(int yes,const char *name){
  printf("%s %u - %s\n",yes?"ok":"not ok",++cases,name);
  fflush(stdout);
  if(!yes)failures++;
}
static void join(char out[PATH_MAX],const char *a,const char *b){
  char v[PATH_MAX];
  int n=snprintf(v,sizeof(v),"%s/%s",a,b);
  must(n>0&&n<PATH_MAX);
  memcpy(out,v,(size_t)n+1);
}
static void put(const char *p,const unsigned char *b,size_t n){
  int fd=open(p,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600);
  must(fd>=0);
  must(write(fd,b,n)==(ssize_t)n&&close(fd)==0);
}
static int equal_file(const char *p,const unsigned char *b,size_t n){
  unsigned char got[1024];
  int fd=open(p,O_RDONLY|O_NONBLOCK|O_NOFOLLOW);
  if(fd<0)return 0;
  struct stat st;
  int regular=fstat(fd,&st)==0&&S_ISREG(st.st_mode);
  ssize_t size=regular?read(fd,got,sizeof(got)):-1;
  close(fd);
  return size==(ssize_t)n&&!memcmp(got,b,n);
}
static PFUuid uuid(void){
  PFUuid id={
    {
      1,2,3,4,5,6,0x40,8,0x80,10,11,12,13,14,15,16
    }
  }
  ;
  return id;
}
static void fixture(void){
  char p[]="/private/tmp/pf-interface-XXXXXX";
  must(mkdtemp(p)!=NULL);
  must(realpath(p,base)!=NULL);
  join(profile,base,"profile");
  join(app,base,"app");
  must(mkdir(profile,0700)==0&&mkdir(app,0700)==0);
  join(folder,profile,".codex");
  must(mkdir(folder,0700)==0);
  join(file,folder,"AGENTS.md");
  put(file,original,sizeof(original)-1);
  char other[PATH_MAX];
  join(other,profile,".claude");
  must(mkdir(other,0700)==0);
  join(other,profile,".gemini");
  must(mkdir(other,0700)==0);
}
static PFRoot *opened(const char *p){
  PFRoot *r=NULL;
  must(pf_root_open(p,NULL,&r)==PF_OK);
  return r;
}
static PFPrivateBootstrap bootstrap(unsigned mode){
  PFPrivateBootstrap b={0};
  b.authority.generation=12;
  b.authority.mode=mode;
  b.authority.cutoff=pf_packet_now()+UINT64_C(5000000000);
  memset(b.authority.session_nonce,5,16);
  memset(b.authority.authority_hash,6,32);
  memset(b.key,7,32);
  return b;
}
static PFSnapshot *snapshot(PFRoot *r,PFRecipe recipe){
  PFSnapshot *s=NULL;
  PFResult result=pf_snapshot_fixed(r,recipe,NULL,&s);
  if(result!=PF_OK)fprintf(stderr,"snapshot %s\n",pf_result_name(result));
  must(result==PF_OK);
  return s;
}
static PFPreparationFields preparation(PFPrivateBootstrap b,const PFSnapshot *s){
  PFPreparationFields p={0};
  p.transaction=uuid();
  p.recipe=(uint32_t)s->recipe;
  p.generation=b.authority.generation;
  p.cutoff=b.authority.cutoff;
  memcpy(p.session_nonce,b.authority.session_nonce,16);
  memset(p.nonce,8,16);
  memset(p.plan_hash,9,32);
  memcpy(p.before_hash,s->digest,32);
  pf_packet_hash(desired,sizeof(desired)-1,p.after_hash);
  must(pf_private_binding_hash(&s->bindings,p.binding_hash)==PF_OK);
  memset(p.prepared_record_hash,10,32);
  return p;
}
static PFWriteSession *prepare(PFRoot *r,PFPrivateBootstrap b,PFSnapshot *before){
  PFPreparationFields f=preparation(b,before);
  PFPrepareGrant *g=NULL;
  must(pf_private_prepare_grant(&b.authority,&f,&g)==PF_OK);
  PFWriteSession *session=NULL;
  PFObservedReceipt *o=NULL;
  PFResult result=pf_session_prepare(r,before->recipe,g,before,(PFByteView){
    desired,sizeof(desired)-1
  }
  ,&session,&o);
  if(result!=PF_OK)fprintf(stderr,"prepare %s\n",pf_result_name(result));
  must(result==PF_OK&&o!=NULL);
  pf_receipt_close(o);
  pf_prepare_grant_close(g);
  return session;
}
static PFPermitFields permit_fields(const PFIntent *i){
  PFPermitFields p=i->fields;
  memset(p.nonce,11,16);
  memset(p.record_hash,12,32);
  memset(p.previous_hash,13,32);
  memcpy(p.intent_hash,i->digest,32);
  return p;
}
static PFPermit *permit(PFPrivateBootstrap b,PFIntent *i){
  PFPermitFields p=permit_fields(i);
  PFPermit *out=NULL;
  must(pf_private_permit(&b.authority,&p,&out)==PF_OK);
  return out;
}
static PFRecoveryFields recovery_fields(PFPrivateBootstrap b,PFObservedReceipt *o,PFSnapshot *before){
  PFRecoveryFields f={0};
  f.transaction=o->transaction;
  f.recipe=(uint32_t)before->recipe;
  f.target_index=o->target_index;
  f.schema=2;
  f.generation=b.authority.generation;
  f.cutoff=b.authority.cutoff;
  memcpy(f.session_nonce,b.authority.session_nonce,16);
  memset(f.confirmation_nonce,14,16);
  memcpy(f.profile_hash,before->bindings.profile_hash,32);
  memcpy(f.plan_hash,o->plan_hash,32);
  memcpy(f.record_hash,o->record_hash,32);
  memcpy(f.before_hash,before->digest,32);
  return f;
}
static PFRestoreFields restore_fields(PFPrivateBootstrap b,PFObservedReceipt *o){
  PFRestoreFields f={0};
  f.transaction=o->transaction;
  f.target_index=o->target_index;
  f.generation=b.authority.generation;
  f.cutoff=b.authority.cutoff;
  memcpy(f.session_nonce,b.authority.session_nonce,16);
  memset(f.confirmation_nonce,15,16);
  memcpy(f.record_hash,o->record_hash,32);
  unsigned char *bytes=malloc(PF_RECEIPT_BYTES);
  uint32_t size=0;
  must(bytes!=NULL&&pf_receipt_encode(o,bytes,PF_RECEIPT_BYTES,&size)==PF_OK);
  pf_packet_hash(bytes,size,f.inspection_hash);
  pf_packet_wipe(bytes,PF_RECEIPT_BYTES);
  free(bytes);
  return f;
}
static void set_current_acl(const char *p){
  int fd=open(p,O_RDONLY|O_NOFOLLOW|O_NONBLOCK);
  must(fd>=0);
  uuid_t u;
  must(mbr_uid_to_uuid(getuid(),u)==0);
  acl_t a=acl_init(1);
  must(a!=NULL);
  acl_entry_t e;
  must(acl_create_entry(&a,&e)==0&&acl_set_tag_type(e,ACL_EXTENDED_ALLOW)==0&&acl_set_qualifier(e,u)==0&&acl_set_permset_mask_np(e,ACL_READ_DATA|ACL_WRITE_DATA|ACL_READ_SECURITY)==0&&acl_set_fd_np(fd,a,ACL_TYPE_EXTENDED)==0);
  acl_free(a);
  close(fd);
}
static void full_snapshot_cases(void){
  fixture();
  set_current_acl(file);
  int fd=open(file,O_RDONLY|O_NOFOLLOW);
  must(fd>=0);
  const unsigned char attr[]={
    0,3,8,0,255
  }
  ;
  must(fsetxattr(fd,"com.apple.quarantine",attr,sizeof(attr),0,0)==0);
  close(fd);
  PFRoot *root=opened(profile);
  PFSnapshot *s=snapshot(root,PF_CODEX_INSTRUCTIONS);
  check(s->acl_tag==2&&s->acl_size>0&&s->attrs[1].present&&s->attrs[1].size==sizeof(attr)&&!memcmp(s->attrs[1].bytes,attr,sizeof(attr)),"full descriptor raw ACL and opaque quarantine bytes");
  unsigned char *bytes=calloc(PF_SNAPSHOT_BYTES,1);
  uint32_t n=0;
  must(bytes!=NULL&&pf_snapshot_encode(s,bytes,PF_SNAPSHOT_BYTES,&n)==PF_OK);
  PFSnapshot *decoded=NULL;
  check(pf_snapshot_decode((PFByteView){
    bytes,n
  }
  ,&decoded)==PF_OK&&pf_snapshot_compare(s,decoded,0)==PF_OK,"supported raw metadata and embedded NUL exact codec roundtrip");
  check(pf_snapshot_current(root,PF_CODEX_INSTRUCTIONS,decoded)==PF_OK,"decoded data only accepted against fresh live descriptors");
  PFSnapshot *bad=NULL;
  check(pf_snapshot_decode((PFByteView){
    bytes,n-1
  }
  ,&bad)!=PF_OK&&bad==NULL,"truncated snapshot refuses with zero capability");
  bytes[n]=0;
  check(pf_snapshot_decode((PFByteView){
    bytes,n+1
  }
  ,&bad)!=PF_OK&&bad==NULL,"trailing snapshot refuses");
  bytes[n-1]^=1;
  check(pf_snapshot_decode((PFByteView){
    bytes,n
  }
  ,&bad)!=PF_OK&&bad==NULL,"content hash tampering refuses");
  fd=open(file,O_WRONLY|O_NOFOLLOW);
  must(fd>=0&&pwrite(fd,"X",1,0)==1&&close(fd)==0);
  check(pf_snapshot_current(root,PF_CODEX_INSTRUCTIONS,s)==PF_CHANGED,"changed exact target bytes invalidate prior full snapshot");
  pf_snapshot_close(s);
  pf_snapshot_close(decoded);
  pf_packet_wipe(bytes,PF_SNAPSHOT_BYTES);
  free(bytes);
  pf_root_close(root);
  fixture();
  root=opened(profile);
  s=snapshot(root,PF_CLAUDE_SETTINGS);
  check(!s->exists&&s->meta.stamp.inode==0,"absent leaf is first class full snapshot");
  pf_snapshot_close(s);
  must(rmdir(folder)==0||errno==ENOTEMPTY);
  char missing[PATH_MAX];
  join(missing,profile,".gemini");
  must(rmdir(missing)==0);
  s=NULL;
  check(pf_snapshot_fixed(root,PF_GEMINI_SETTINGS,NULL,&s)==PF_UNAVAILABLE&&s==NULL,"missing fixed parent refuses rather than creating directories");
  pf_root_close(root);
  fixture();
  root=opened(profile);
  must(unlink(file)==0&&mkfifo(file,0600)==0);
  s=NULL;
  uint64_t start=pf_packet_now();
  check(pf_snapshot_fixed(root,PF_CODEX_INSTRUCTIONS,NULL,&s)==PF_UNSAFE&&s==NULL&&pf_packet_now()-start<UINT64_C(1000000000),"actual FIFO refuses promptly before blocking read");
  pf_root_close(root);
  fixture();
  root=opened(profile);
  char foreign[PATH_MAX];
  join(foreign,base,"foreign");
  put(foreign,desired,sizeof(desired)-1);
  must(unlink(file)==0&&symlink(foreign,file)==0);
  s=NULL;
  check(pf_snapshot_fixed(root,PF_CODEX_INSTRUCTIONS,NULL,&s)==PF_UNSAFE&&s==NULL&&equal_file(foreign,desired,sizeof(desired)-1),"actual leaf link refuses without touching foreign bytes");
  pf_root_close(root);
}
static void session_recovery_cases(void){
  fixture();
  set_current_acl(file);
  int fd=open(file,O_RDONLY|O_NOFOLLOW);
  must(fd>=0);
  unsigned char attr[]={
    0,2,255
  }
  ;
  must(fsetxattr(fd,"com.apple.quarantine",attr,sizeof(attr),0,0)==0);
  close(fd);
  PFRoot *root=opened(profile);
  PFSnapshot *before=snapshot(root,PF_CODEX_INSTRUCTIONS);
  PFPrivateBootstrap b=bootstrap(1);
  PFWriteSession *s=prepare(root,b,before);
  check(equal_file(file,original,sizeof(original)-1),"preparation holds cannot replace target");
  PFIntent *intent=NULL;
  check(pf_session_intent(s,&intent)==PF_OK&&intent!=NULL&&equal_file(file,original,sizeof(original)-1),"durable native intent still leaves target unchanged");
  PFPermit *p=permit(b,intent);
  PFObservedReceipt *o=NULL;
  PFResult result=pf_session_apply(s,p,&o);
  fprintf(stderr,"apply=%s\n",pf_result_name(result));
  check(result==PF_OK&&o&&o->native.receipt.phase==PF_WRITE_APPLIED&&equal_file(file,desired,sizeof(desired)-1),"one-target authenticated permit applies exact reviewed bytes");
  check(o&&o->objects[0].tag==2&&o->objects[1].tag==2&&o->objects[0].snapshot->acl_tag==2&&!memcmp(o->objects[0].snapshot->acl,before->acl,before->acl_size)&&o->objects[0].snapshot->attrs[1].size==sizeof(attr)&&!memcmp(o->objects[0].snapshot->attrs[1].bytes,attr,sizeof(attr)),"observed installed and displaced full raw metadata preserved");
  unsigned char *encoded=malloc(PF_RECEIPT_BYTES);
  uint32_t n=0;
  PFObservedReceipt *decoded=NULL;
  must(encoded!=NULL);
  check(pf_receipt_encode(o,encoded,PF_RECEIPT_BYTES,&n)==PF_OK&&pf_receipt_decode((PFByteView){
    encoded,n
  }
  ,&decoded)==PF_OK&&decoded->objects[1].snapshot->meta.stamp.size==sizeof(original)-1,"full actual receipt codec retains displaced bytes");
  pf_receipt_close(decoded);
  free(encoded);
  PFObservedReceipt *replayed=NULL;
  check(pf_session_apply(s,p,&replayed)==PF_INVALID&&replayed==NULL,"successful permit cannot repeat paid target work");
  pf_permit_close(p);
  pf_intent_close(intent);
  pf_session_close(s);
  /* Simulated helper exit; all disk variants remain. */
  PFPrivateBootstrap local=bootstrap(2);
  PFRecoveryFields f=recovery_fields(local,o,before);
  PFRecoveryGrant *g=NULL;
  must(pf_private_recovery_grant(&local.authority,&f,o,before,&g)==PF_OK);
  PFRecovery *r=NULL;
  PFObservedReceipt *current=NULL;
  result=pf_recovery_inspect(root,g,&r,&current);
  fprintf(stderr,"recovery=%s\n",pf_result_name(result));
  check(result==PF_OK&&r&&current&&equal_file(file,desired,sizeof(desired)-1),"fresh authenticated own-local restart inspection is read-only");
  PFIntent *undo=NULL;
  check(pf_recovery_intent(r,NULL,&undo)==PF_INVALID&&undo==NULL&&equal_file(file,desired,sizeof(desired)-1),"inspection handle alone cannot stage Undo");
  PFRestoreFields restore=restore_fields(local,current);
  PFRestoreGrant *confirmed=NULL;
  must(pf_private_restore_grant(&local.authority,&restore,&confirmed)==PF_OK);
  check(pf_recovery_intent(r,confirmed,&undo)==PF_OK&&undo&&equal_file(file,desired,sizeof(desired)-1),"separate fresh exact-inspection confirmation permits private Undo stage only");
  pf_restore_grant_close(confirmed);
  p=permit(local,undo);
  PFObservedReceipt *undone=NULL;
  result=pf_recovery_restore(r,p,&undone);
  fprintf(stderr,"undo=%s\n",pf_result_name(result));
  check(result==PF_OK&&undone&&undone->native.receipt.phase==PF_WRITE_UNDONE&&equal_file(file,original,sizeof(original)-1),"authenticated conditional Undo restores exact prior bytes");
  check(undone&&undone->objects[0].snapshot&&undone->objects[0].snapshot->acl_size==before->acl_size&&!memcmp(undone->objects[0].snapshot->acl,before->acl,before->acl_size)&&undone->objects[1].snapshot&&undone->objects[1].snapshot->meta.stamp.size==sizeof(desired)-1,"Undo preserves raw original metadata and actual removed replacement");
  replayed=NULL;
  check(pf_recovery_restore(r,p,&replayed)==PF_INVALID&&replayed==NULL,"Undo single attempt refuses replay");
  pf_permit_close(p);
  pf_intent_close(undo);
  pf_recovery_close(r);
  pf_recovery_grant_close(g);
  pf_receipt_close(current);
  pf_receipt_close(undone);
  pf_receipt_close(o);
  pf_snapshot_close(before);
  pf_root_close(root);
}
static uint32_t u32(const unsigned char *b){
  uint32_t n=0;
  for(unsigned i=0;i<4;i++)n=(n<<8)|b[i];
  return n;
}
static void be32(unsigned char *b,uint32_t n){
  for(unsigned i=0;i<4;i++)b[i]=(unsigned char)(n>>(24u-i*8u));
}
static unsigned char *wire_out,*wire_in,*wire_payload;
static uint32_t wire_body,wire_effect;
static PFResult exchange(PFProtocol *p,PFPrivateBootstrap b,uint16_t op,uint32_t seq,PFByteView body){
  unsigned char nonce[16]={0};
  nonce[0]=1;
  nonce[15]=(unsigned char)(seq+1);
  uint32_t n=0,written=0;
  must(pf_fixture_frame(&b,op,seq,nonce,body,wire_in,PF_FRAME_PAYLOAD+PF_FRAME_OVERHEAD,&n)==PF_OK);
  PFResult r=pf_protocol_process(p,(PFByteView){
    wire_in,n
  }
  ,wire_out,PF_FRAME_PAYLOAD+PF_FRAME_OVERHEAD,&written);
  if(r!=PF_OK){
    wire_body=wire_effect=0;
    return r;
  }
  must(written>=84&&u32(wire_out+36)==written-PF_FRAME_OVERHEAD&&u32(wire_out+48)==written-84);
  wire_body=u32(wire_out+48);
  wire_effect=u32(wire_out+44);
  return (PFResult)u32(wire_out+40);
}
static PFByteView response_blob(uint32_t *at,uint32_t bound){
  must(*at+4<=wire_body);
  uint32_t n=u32(wire_out+52+*at);
  *at+=4;
  must(n<=bound&&n<=wire_body-*at);
  PFByteView b={
    wire_out+52+*at,n
  }
  ;
  *at+=n;
  return b;
}
static PFProtocol *protocol(PFRoot *profile_root,PFRoot *app_root,PFPrivateBootstrap b){
  PFProtocol *p=NULL;
  must(pf_private_protocol_open(profile_root,app_root,&b,&p)==PF_OK);
  return p;
}
static void protocol_cases(void){
  wire_in=calloc(PF_FRAME_PAYLOAD+PF_FRAME_OVERHEAD,1);
  wire_out=calloc(PF_FRAME_PAYLOAD+PF_FRAME_OVERHEAD,1);
  wire_payload=calloc(PF_FRAME_PAYLOAD,1);
  must(wire_in&&wire_out&&wire_payload);
  fixture();
  PFRoot *root=opened(profile),*aroot=opened(app);
  PFPrivateBootstrap b=bootstrap(1);
  PFProtocol *p=protocol(root,aroot,b);
  unsigned char request[4]={
    0,0,0,1
  }
  ;
  check(exchange(p,b,0x30,0,(PFByteView){
    request,4
  }
  )==PF_OK,"actual signed frame reads fixed full snapshot");
  uint32_t at=0;
  PFSnapshot *before=NULL;
  PFByteView snap=response_blob(&at,PF_SNAPSHOT_BYTES);
  must(pf_snapshot_decode(snap,&before)==PF_OK);
  check(at==wire_body&&before->exists&&before->meta.stamp.size==sizeof(original)-1,"framed reply has closed exact full snapshot");
  unsigned char reply_nonce[16]={
    1
  }
  ;
  reply_nonce[15]=1;
  uint32_t verify=0;
  must(pf_fixture_frame(&b,0x8030,0,reply_nonce,(PFByteView){
    wire_out+40,u32(wire_out+36)
  }
  ,wire_in,PF_FRAME_PAYLOAD+PF_FRAME_OVERHEAD,&verify)==PF_OK);
  check(!memcmp(wire_in,wire_out,verify),"actual response HMAC binds body and original request nonce");
  PFPreparationFields f=preparation(b,before);
  PFCodec c={
    wire_payload,NULL,PF_FRAME_PAYLOAD,0,0
  }
  ;
  pf_private_preparation_codec(&c,&f);
  unsigned char *snap_bytes=malloc(PF_SNAPSHOT_BYTES);
  uint32_t sn=0;
  must(snap_bytes&&pf_snapshot_encode(before,snap_bytes,PF_SNAPSHOT_BYTES,&sn)==PF_OK);
  pf_codec_u32(&c,&sn);
  pf_codec_bytes(&c,snap_bytes,sn);
  uint32_t after_n=sizeof(desired)-1;
  pf_codec_u32(&c,&after_n);
  pf_codec_bytes(&c,(void *)desired,after_n);
  check(exchange(p,b,0x31,1,(PFByteView){
    wire_payload,c.at
  }
  )==PF_OK&&wire_effect==4&&equal_file(file,original,sizeof(original)-1),"authenticated wire prepare stages only and replies with bounded intent");
  at=0;
  PFObservedReceipt *prep=NULL;
  must(pf_receipt_decode(response_blob(&at,PF_RECEIPT_BYTES),&prep)==PF_OK);
  PFByteView ib=response_blob(&at,16384);
  PFIntent i={0};
  PFCodec ic={
    NULL,ib.data,ib.size,0,0
  }
  ;
  must(pf_private_intent_codec(&ic,&i)==PF_OK&&!ic.failed&&ic.at==ic.size);
  pf_packet_hash(ib.data,ib.size,i.digest);
  PFPermitFields fields=permit_fields(&i);
  c=(PFCodec){
    wire_payload,NULL,PF_FRAME_PAYLOAD,0,0
  }
  ;
  pf_private_permit_codec(&c,&fields);
  check(exchange(p,b,0x32,2,(PFByteView){
    wire_payload,c.at
  }
  )==PF_OK&&wire_effect==1&&equal_file(file,desired,sizeof(desired)-1),"authenticated wire permit consumes exact intent and replaces target");
  at=0;
  PFObservedReceipt *applied=NULL;
  must(pf_receipt_decode(response_blob(&at,PF_RECEIPT_BYTES),&applied)==PF_OK);
  check(exchange(p,b,0x33,3,(PFByteView){
    NULL,0
  }
  )==PF_OK,"wire observation retains current account-session record binding");
  at=0;
  PFObservedReceipt *observed=NULL;
  must(pf_receipt_decode(response_blob(&at,PF_RECEIPT_BYTES),&observed)==PF_OK);
  check(!memcmp(observed->record_hash,fields.record_hash,32),"observation identifies last authenticated durable record");
  pf_receipt_close(observed);
  pf_protocol_close(p);
  PFPrivateBootstrap local=bootstrap(2);
  p=protocol(root,aroot,local);
  PFRecoveryFields rf=recovery_fields(local,applied,before);
  c=(PFCodec){
    wire_payload,NULL,PF_FRAME_PAYLOAD,0,0
  }
  ;
  pf_private_recovery_codec(&c,&rf);
  PFNativeWriterState anchor=applied->native;
  must(pf_native_state_codec(&c,&anchor)==PF_OK);
  pf_codec_u32(&c,&sn);
  pf_codec_bytes(&c,snap_bytes,sn);
  check(exchange(p,local,0x34,0,(PFByteView){
    wire_payload,c.at
  }
  )==PF_OK&&wire_effect==0&&equal_file(file,desired,sizeof(desired)-1),"new local channel compact authenticated recovery anchor is read-only");
  at=0;
  PFObservedReceipt *inspection=NULL;
  must(pf_receipt_decode(response_blob(&at,PF_RECEIPT_BYTES),&inspection)==PF_OK);
  PFRestoreFields restore=restore_fields(local,inspection);
  c=(PFCodec){
    wire_payload,NULL,PF_FRAME_PAYLOAD,0,0
  }
  ;
  uint32_t phase=0;
  pf_codec_u32(&c,&phase);
  pf_private_restore_codec(&c,&restore);
  check(exchange(p,local,0x35,1,(PFByteView){
    wire_payload,c.at
  }
  )==PF_OK&&wire_effect==4&&equal_file(file,desired,sizeof(desired)-1),"wire restore intent requires separate fresh confirmation before staging");
  at=0;
  PFObservedReceipt *ri=NULL;
  must(pf_receipt_decode(response_blob(&at,PF_RECEIPT_BYTES),&ri)==PF_OK);
  ib=response_blob(&at,16384);
  i=(PFIntent){0};
  ic=(PFCodec){
    NULL,ib.data,ib.size,0,0
  }
  ;
  must(pf_private_intent_codec(&ic,&i)==PF_OK&&ic.at==ic.size);
  pf_packet_hash(ib.data,ib.size,i.digest);
  fields=permit_fields(&i);
  c=(PFCodec){
    wire_payload,NULL,PF_FRAME_PAYLOAD,0,0
  }
  ;
  phase=1;
  pf_codec_u32(&c,&phase);
  pf_private_permit_codec(&c,&fields);
  check(exchange(p,local,0x35,2,(PFByteView){
    wire_payload,c.at
  }
  )==PF_OK&&wire_effect==1&&equal_file(file,original,sizeof(original)-1),"wire authenticated conditional Undo completes full physical journey");
  pf_protocol_close(p);
  pf_receipt_close(ri);
  pf_receipt_close(inspection);
  pf_receipt_close(applied);
  pf_receipt_close(prep);
  pf_snapshot_close(before);
  free(snap_bytes);
  for(unsigned variant=0;variant<8;variant++){
    b=bootstrap(1);
    p=protocol(root,aroot,b);
    unsigned char nonce[16]={
      1
    }
    ;
    uint32_t n=0,written=777;
    uint16_t op=variant==1?0x99:0x30;
    uint32_t sequence=variant==2?1:0;
    PFByteView body={
      request,4
    }
    ;
    if(variant==3)memset(nonce,0,16);
    must(pf_fixture_frame(&b,op,sequence,nonce,body,wire_in,PF_FRAME_PAYLOAD+PF_FRAME_OVERHEAD,&n)==PF_OK);
    if(variant==0)wire_in[n-1]^=1;
    if(variant==4)wire_in[35]=1;
    if(variant==5)be32(wire_in+36,PF_FRAME_PAYLOAD+1);
    if(variant==6)n--;
    if(variant==7){
      uint32_t original_n=n;
      must(pf_protocol_process(p,(PFByteView){
        wire_in,n
      }
      ,wire_out,PF_FRAME_PAYLOAD+PF_FRAME_OVERHEAD,&written)==PF_OK);
      n=original_n;
    }
    PFResult result=pf_protocol_process(p,(PFByteView){
      wire_in,n
    }
    ,wire_out,PF_FRAME_PAYLOAD+PF_FRAME_OVERHEAD,&written);
    check(result!=PF_OK&&written==0,"wrong MAC/op/sequence/nonce/flags/size/truncation/replay withholds response");
    written=777;
    check(pf_protocol_process(p,(PFByteView){
      wire_in,n
    }
    ,wire_out,PF_FRAME_PAYLOAD+PF_FRAME_OVERHEAD,&written)==PF_INVALID&&written==0,"malformed channel cannot continue with a new capability");
    pf_protocol_close(p);
  }
  b=bootstrap(1);
  b.authority.cutoff=pf_packet_now()+UINT64_C(50000000);
  p=protocol(root,aroot,b);
  usleep(60000);
  check(exchange(p,b,0x30,0,(PFByteView){
    request,4
  }
  )==PF_DEADLINE&&wire_body==0,"absolute expired channel refuses even read-only bytes");
  pf_protocol_close(p);
  pf_root_close(root);
  pf_root_close(aroot);
}
static uint32_t sealed(unsigned char *bytes,uint32_t cap,PFUuid id,PFStoreRole role,uint32_t target,uint32_t sequence){
  must(cap>=60);
  memset(bytes,0,cap);
  PFCodec c={
    bytes,NULL,cap,0,0
  }
  ;
  unsigned char magic[8]={
    'P','F','S','E','A','L','0','2'
  }
  ;
  uint32_t schema=2,r=(uint32_t)role,size=cap-44;
  pf_codec_bytes(&c,magic,8);
  pf_codec_u32(&c,&schema);
  pf_codec_u32(&c,&r);
  pf_codec_u32(&c,&target);
  pf_codec_u32(&c,&sequence);
  pf_codec_bytes(&c,id.bytes,16);
  pf_codec_u32(&c,&size);
  for(uint32_t i=c.at;i<cap;i++)bytes[i]=(unsigned char)(i*13u);
  return cap;
}
static void store_cases(void){
  fixture();
  PFRoot *root=opened(app);
  PFStoreRoot *store=NULL;
  check(pf_store_open_fixed(root,&store)==PF_OK,"fixed app-owned store positively private directory");
  PFStoreTxn *txn=NULL;
  PFUuid id=uuid();
  check(pf_store_create_txn(store,id,&txn)==PF_OK,"canonical UUID exclusive private namespace");
  unsigned char bytes[60],out[60];
  uint32_t n=sealed(bytes,sizeof(bytes),id,PF_STORE_MANIFEST,0,0),got=777;
  check(pf_store_write_exclusive(txn,PF_STORE_MANIFEST,0,0,(PFByteView){
    bytes,n
  }
  )==PF_OK&&pf_store_read(txn,PF_STORE_MANIFEST,0,0,out,sizeof(out),&got)==PF_OK&&got==n&&!memcmp(bytes,out,n),"closed ciphertext-role exact durable descriptor write/read");
  check(pf_store_write_exclusive(txn,PF_STORE_MANIFEST,0,0,(PFByteView){
    bytes,n
  }
  )==PF_CHANGED,"store collision preserves original immutable bytes");
  PFUuid wrong=id;
  wrong.bytes[0]^=1;
  sealed(bytes,sizeof(bytes),wrong,PF_STORE_BEFORE,0,0);
  check(pf_store_write_exclusive(txn,PF_STORE_BEFORE,0,0,(PFByteView){
    bytes,sizeof(bytes)
  }
  )==PF_INVALID,"wrong transaction sealed header refuses before effects");
  check(pf_store_write_exclusive(txn,PF_STORE_EVENT,0,64,(PFByteView){
    bytes,sizeof(bytes)
  }
  )==PF_INVALID,"event role/index bounds are closed");
  check(pf_store_read(txn,(PFStoreRole)99,0,0,out,sizeof(out),&got)==PF_INVALID&&got==0,"unknown role refuses zero length");
  PFStoreTxn *same=NULL;
  check(pf_store_create_txn(store,id,&same)==PF_CHANGED&&same==NULL,"UUID creation is exclusive without existing-object adoption");
  PFUuid ids[16];
  uint32_t count=777;
  check(pf_store_list(store,ids,16,&count)==PF_OK&&count==1&&!memcmp(ids[0].bytes,id.bytes,16),"store lists retained opaque IDs only");
  pf_store_close(store);
  got=777;
  check(pf_store_read(txn,PF_STORE_MANIFEST,0,0,out,sizeof(out),&got)==PF_INVALID&&got==0,"root closure invalidates retained transaction without freed descriptor use");
  pf_store_txn_close(txn);
  pf_root_close(root);
  for(unsigned variant=0;variant<6;variant++){
    fixture();
    root=opened(app);
    must(pf_store_open_fixed(root,&store)==PF_OK&&pf_store_create_txn(store,id,&txn)==PF_OK);
    char dir[PATH_MAX],target[PATH_MAX],other[PATH_MAX];
    join(dir,app,"setups-transactions/01020304-0506-4008-800a-0b0c0d0e0f10");
    join(target,dir,"manifest.sealed");
    sealed(bytes,sizeof(bytes),id,PF_STORE_MANIFEST,0,0);
    put(target,bytes,sizeof(bytes));
    join(other,base,"outside");
    put(other,desired,sizeof(desired)-1);
    if(variant==0)must(chmod(target,0644)==0);
    if(variant==1){
      must(unlink(target)==0&&symlink(other,target)==0);
    }
    if(variant==2){
      must(unlink(target)==0&&mkfifo(target,0600)==0);
    }
    if(variant==3)must(link(target,other)==-1&&errno==EEXIST);
    /* replace below without touching the sentinel */
    if(variant==3){
      char linkname[PATH_MAX];
      join(linkname,base,"hardlink");
      must(link(target,linkname)==0);
    }
    if(variant==4)set_current_acl(target);
    if(variant==5){
      int fd=open(target,O_WRONLY|O_NOFOLLOW);
      must(fd>=0&&ftruncate(fd,12)==0&&close(fd)==0);
    }
    memset(out,0xa5,sizeof(out));
    got=777;
    uint64_t start=pf_packet_now();
    PFResult result=pf_store_read(txn,PF_STORE_MANIFEST,0,0,out,sizeof(out),&got);
    check(result!=PF_OK&&got==0&&pf_packet_now()-start<UINT64_C(1000000000)&&equal_file(other,desired,sizeof(desired)-1),"mode/link/FIFO/hardlink/nonempty ACL/truncation refuses private read promptly");
    pf_store_txn_close(txn);
    pf_store_close(store);
    pf_root_close(root);
  }
  fixture();
  root=opened(app);
  must(pf_store_open_fixed(root,&store)==PF_OK);
  for(unsigned i=0;i<16;i++){
    PFUuid each=id;
    each.bytes[0]=(unsigned char)(i+1);
    must(pf_store_create_txn(store,each,&txn)==PF_OK);
    pf_store_txn_close(txn);
  }
  id.bytes[0]=99;
  txn=NULL;
  check(pf_store_create_txn(store,id,&txn)==PF_TOO_LARGE&&txn==NULL,"retained namespace bound refuses without pruning existing transactions");
  pf_store_close(store);
  pf_root_close(root);
  fixture();
  root=opened(app);
  id=uuid();
  must(pf_store_open_fixed(root,&store)==PF_OK&&pf_store_create_txn(store,id,&txn)==PF_OK);
  char dir[PATH_MAX];
  join(dir,app,"setups-transactions/01020304-0506-4008-800a-0b0c0d0e0f10");
  for(unsigned i=0;i<93;i++){
    char child[PATH_MAX],name[48];
    snprintf(name,sizeof(name),"target%03u-before.sealed",i);
    join(child,dir,name);
    int fd=open(child,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW,0600);
    must(fd>=0&&ftruncate(fd,PF_STORE_BLOB_BYTES)==0&&close(fd)==0);
  }
  unsigned char *large=malloc(PF_STORE_BLOB_BYTES);
  must(large!=NULL);
  sealed(large,PF_STORE_BLOB_BYTES,id,PF_STORE_AFTER,0,0);
  check(pf_store_write_exclusive(txn,PF_STORE_AFTER,0,0,(PFByteView){
    large,PF_STORE_BLOB_BYTES
  }
  )==PF_TOO_LARGE,"actual bounded sparse-file logical byte quota admission refuses overflow");
  free(large);
  pf_store_txn_close(txn);
  pf_store_close(store);
  pf_root_close(root);
  fixture();
  root=opened(app);
  must(pf_store_open_fixed(root,&store)==PF_OK);
  char private_dir[PATH_MAX];
  join(private_dir,app,"setups-transactions");
  set_current_acl(private_dir);
  count=777;
  memset(ids,0xa5,sizeof(ids));
  check(pf_store_list(store,ids,16,&count)!=PF_OK&&count==0&&ids[0].bytes[0]==0,"late store ACL change withholds names without clearing foreign ACL");
  pf_store_close(store);
  pf_root_close(root);
}
static void authority_cases(void){
  fixture();
  PFRoot *root=opened(profile);
  PFSnapshot *before=snapshot(root,PF_CODEX_INSTRUCTIONS);
  PFPrivateBootstrap b=bootstrap(1);
  PFPreparationFields fields=preparation(b,before);
  PFPrepareGrant *grant=NULL;
  fields.generation++;
  check(pf_private_prepare_grant(&b.authority,&fields,&grant)==PF_INVALID&&grant==NULL,"captured generation mismatch cannot create preparation grant");
  fields=preparation(b,before);
  fields.transaction.bytes[6]=0;
  check(pf_private_prepare_grant(&b.authority,&fields,&grant)==PF_INVALID&&grant==NULL,"noncanonical transaction cannot create target authority");
  fields=preparation(b,before);
  must(pf_private_prepare_grant(&b.authority,&fields,&grant)==PF_OK);
  int fd=open(file,O_WRONLY|O_NOFOLLOW);
  must(fd>=0&&pwrite(fd,"Z",1,0)==1&&close(fd)==0);
  PFWriteSession *s=NULL;
  PFObservedReceipt *o=NULL;
  check(pf_session_prepare(root,before->recipe,grant,before,(PFByteView){
    desired,sizeof(desired)-1
  }
  ,&s,&o)==PF_CHANGED&&s==NULL&&o==NULL,"fresh current full target precedes any private preparation effect");
  check(pf_session_prepare(root,before->recipe,grant,before,(PFByteView){
    desired,sizeof(desired)-1
  }
  ,&s,&o)==PF_INVALID,"failed preparation consumes grant attempt");
  pf_prepare_grant_close(grant);
  pf_snapshot_close(before);
  pf_root_close(root);
  fixture();
  root=opened(profile);
  before=snapshot(root,PF_CODEX_INSTRUCTIONS);
  b=bootstrap(1);
  s=prepare(root,b,before);
  PFIntent *i=NULL;
  must(pf_session_intent(s,&i)==PF_OK);
  PFPermitFields pfields=permit_fields(i);
  pfields.stage_hash[0]^=1;
  PFPermit *permit_wrong=NULL;
  must(pf_private_permit(&b.authority,&pfields,&permit_wrong)==PF_OK);
  check(pf_session_apply(s,permit_wrong,&o)==PF_INVALID&&equal_file(file,original,sizeof(original)-1),"wrong exact pending stage hash consumes attempt without target effect");
  pf_receipt_close(o);
  o=NULL;
  PFPermit *correct=permit(b,i);
  check(pf_session_apply(s,correct,&o)==PF_INVALID&&o==NULL,"ordinary retry cannot resurrect failed target attempt");
  pf_permit_close(correct);
  pf_permit_close(permit_wrong);
  pf_intent_close(i);
  pf_session_close(s);
  pf_snapshot_close(before);
  pf_root_close(root);
  fixture();
  root=opened(profile);
  before=snapshot(root,PF_CODEX_INSTRUCTIONS);
  b=bootstrap(1);
  s=prepare(root,b,before);
  must(pf_session_intent(s,&i)==PF_OK);
  correct=permit(b,i);
  int old_fd=open(file,O_RDWR|O_NOFOLLOW);
  must(old_fd>=0);
  must(pf_session_apply(s,correct,&o)==PF_OK);
  must(pwrite(old_fd,"FOREIGN",7,0)==7);
  PFPrivateBootstrap local=bootstrap(2);
  PFRecoveryFields rf=recovery_fields(local,o,before);
  PFRecoveryGrant *rg=NULL;
  must(pf_private_recovery_grant(&local.authority,&rf,o,before,&rg)==PF_OK);
  PFRecovery *r=NULL;
  PFObservedReceipt *current=NULL;
  check(pf_recovery_inspect(root,rg,&r,&current)==PF_CHANGED&&r==NULL&&current==NULL&&equal_file(file,desired,sizeof(desired)-1),"old-open-fd writes into retained displaced inode refuse conditional recovery");
  unsigned char got[7];
  must(pread(old_fd,got,7,0)==7);
  check(!memcmp(got,"FOREIGN",7),"foreign old-descriptor variant remains retained exact");
  close(old_fd);
  pf_recovery_grant_close(rg);
  pf_permit_close(correct);
  pf_intent_close(i);
  pf_session_close(s);
  pf_receipt_close(o);
  pf_snapshot_close(before);
  pf_root_close(root);
}
static int reap_bounded(pid_t child,int *status,uint64_t cutoff){
  for(;;){
    pid_t got=waitpid(child,status,WNOHANG);
    if(got==child)return 1;
    if(got<0)return 0;
    if(pf_packet_now()>=cutoff){
      kill(child,SIGKILL);
      must(waitpid(child,status,0)==child);
      return 0;
    }
    usleep(1000);
  }
}
static void short_deadline_cases(void){
  fixture();
  PFRoot *root=opened(profile);
  PFSnapshot *before=snapshot(root,PF_CODEX_INSTRUCTIONS);
  PFPrivateBootstrap b=bootstrap(1);
  PFPreparationFields f=preparation(b,before);
  f.cutoff-=UINT64_C(1000000000);
  PFPrepareGrant *g=NULL;
  must(pf_private_prepare_grant(&b.authority,&f,&g)==PF_OK);
  PFWriteSession *s=NULL;
  PFObservedReceipt *o=NULL;
  must(pf_session_prepare(root,before->recipe,g,before,(PFByteView){
    desired,sizeof(desired)-1
  }
  ,&s,&o)==PF_OK);
  pf_receipt_close(o);
  o=NULL;
  PFIntent *i=NULL;
  must(pf_session_intent(s,&i)==PF_OK);
  PFPermitFields fields=permit_fields(i);
  fields.cutoff-=UINT64_C(1000000000);
  PFPermit *p=NULL;
  must(pf_private_permit(&b.authority,&fields,&p)==PF_OK);
  check(pf_session_apply(s,p,&o)==PF_OK&&equal_file(file,desired,sizeof(desired)-1),"shorter prepared/permit deadlines narrow authority without rejecting fresh session identity");
  pf_receipt_close(o);
  pf_permit_close(p);
  pf_intent_close(i);
  pf_prepare_grant_close(g);
  pf_session_close(s);
  pf_snapshot_close(before);
  pf_root_close(root);
  fixture();
  root=opened(profile);
  before=snapshot(root,PF_CODEX_INSTRUCTIONS);
  b=bootstrap(1);
  s=prepare(root,b,before);
  must(pf_session_intent(s,&i)==PF_OK);
  fields=permit_fields(i);
  fields.cutoff=pf_packet_now()+UINT64_C(30000000);
  must(pf_private_permit(&b.authority,&fields,&p)==PF_OK);
  usleep(40000);
  o=NULL;
  check(pf_session_apply(s,p,&o)==PF_DEADLINE&&equal_file(file,original,sizeof(original)-1),"expired shorter permit consumes attempt without target mutation");
  pf_receipt_close(o);
  pf_permit_close(p);
  pf_intent_close(i);
  pf_session_close(s);
  pf_snapshot_close(before);
  pf_root_close(root);
}
static void transport_cases(void){
  for(unsigned variant=0;variant<7;variant++){
    fixture();
    if(variant==4){
      int fd=open(file,O_WRONLY|O_NOFOLLOW);
      must(fd>=0&&ftruncate(fd,240*1024)==0&&close(fd)==0);
    }
    PFRoot *root=opened(profile),*aroot=opened(app);
    PFPrivateBootstrap b=bootstrap(1);
    b.authority.cutoff=pf_packet_now()+UINT64_C(300000000);
    PFProtocol *p=protocol(root,aroot,b);
    int incoming[2],outgoing[2];
    must(pipe(incoming)==0&&pipe(outgoing)==0);
    if(variant!=6)must(fcntl(incoming[0],F_SETFL,O_NONBLOCK)==0);
    must(fcntl(outgoing[1],F_SETFL,O_NONBLOCK)==0);
    uint64_t start=pf_packet_now();
    pid_t child=fork();
    must(child>=0);
    if(!child){
      close(incoming[1]);
      close(outgoing[0]);
      PFResult r=pf_private_protocol_serve(p,incoming[0],outgoing[1]);
      close(incoming[0]);
      close(outgoing[1]);
      pf_protocol_close(p);
      _exit((int)r);
    }
    close(incoming[0]);
    close(outgoing[1]);
    unsigned char request[4]={
      0,0,0,1
    }
    ,nonce[16]={
      1
    }
    ;
    uint32_t n=0;
    must(pf_fixture_frame(&b,0x30,0,nonce,(PFByteView){
      request,4
    }
    ,wire_in,PF_FRAME_PAYLOAD+PF_FRAME_OVERHEAD,&n)==PF_OK);
    if(variant==0){
      must(write(incoming[1],wire_in,19)==19);
      usleep(1000);
      must(write(incoming[1],wire_in+19,n-19)==(ssize_t)n-19);
      close(incoming[1]);
      incoming[1]=-1;
    }
    if(variant==1){
      must(write(incoming[1],wire_in,7)==7);
      close(incoming[1]);
      incoming[1]=-1;
    }
    if(variant==2){
      be32(wire_in+36,PF_FRAME_PAYLOAD+1);
      must(write(incoming[1],wire_in,40)==40);
    }
    if(variant==4||variant==5){
      if(variant==5){
        close(outgoing[0]);
        outgoing[0]=-1;
      }
      must(write(incoming[1],wire_in,n)==(ssize_t)n);
    }
    if(variant==0){
      must(fcntl(outgoing[0],F_SETFL,O_NONBLOCK)==0);
      unsigned char got[2048];
      uint32_t at=0;
      uint64_t cutoff=pf_packet_now()+UINT64_C(700000000);
      for(;;){
        ssize_t count=read(outgoing[0],got+at,sizeof(got)-at);
        if(count>0){
          at+=(uint32_t)count;
          if(at>=40&&at==u32(got+36)+PF_FRAME_OVERHEAD)break;
          must(at<sizeof(got));
        }
        else if(count==0)break;
        else if(errno!=EAGAIN&&errno!=EINTR)break;
        if(pf_packet_now()>=cutoff)break;
        usleep(1000);
      }
      check(at>=84&&u32(got+40)==PF_OK&&at==u32(got+36)+PF_FRAME_OVERHEAD,"actual fragmented anonymous-pipe frames yield one complete bounded response");
    }
    int status=0,finished=reap_bounded(child,&status,start+UINT64_C(1000000000));
    PFResult expected=variant==0?PF_OK:variant==1?PF_IO:variant==2?PF_TOO_LARGE:variant==3||variant==4?PF_DEADLINE:variant==5?PF_IO:PF_UNSAFE;
    const char *labels[]={
      "owned fixture process reaps after clean EOF","partial frame EOF refuses without parsing uninitialized bytes","oversized declared pipe body refuses before allocation/read","silent pipe absolute deadline cannot reset","blocked response pipe shares owned absolute deadline","closed output refuses without SIGPIPE termination","blocking inherited pipe refuses before I/O"
    }
    ;
    check(finished&&WIFEXITED(status)&&WEXITSTATUS(status)==(int)expected&&pf_packet_now()-start<UINT64_C(1000000000),labels[variant]);
    if(incoming[1]>=0)close(incoming[1]);
    if(outgoing[0]>=0)close(outgoing[0]);
    pf_protocol_close(p);
    pf_root_close(root);
    pf_root_close(aroot);
  }
}
static void crash_cases(void){
  for(unsigned variant=0;variant<3;variant++){
    fixture();
    if(variant==2)must(unlink(file)==0);
    PFRoot *root=opened(profile);
    PFSnapshot *before=snapshot(root,PF_CODEX_INSTRUCTIONS);
    PFPrivateBootstrap b=bootstrap(1);
    PFWriteSession *s=prepare(root,b,before);
    PFIntent *i=NULL;
    must(pf_session_intent(s,&i)==PF_OK);
    PFPermit *p=permit(b,i);
    PFObservedReceipt *anchor=NULL;
    if(variant==0){
      anchor=calloc(1,sizeof(*anchor));
      must(anchor!=NULL);
      anchor->schema=2;
      anchor->transaction=uuid();
      anchor->native=i->native;
      memcpy(anchor->plan_hash,i->fields.plan_hash,32);
      memset(anchor->record_hash,12,32);
      crash_stage=4;
      pid_t child=fork();
      must(child>=0);
      if(!child){
        PFObservedReceipt *o=NULL;
        (void)pf_session_apply(s,p,&o);
        _exit(99);
      }
      int status;
      must(waitpid(child,&status,0)==child&&WIFEXITED(status));
      check(WEXITSTATUS(status)==40&&equal_file(file,desired,sizeof(desired)-1),"actual child exits after Apply namespace effect before receipt sealing");
      crash_stage=0;
      pf_session_close(s);
      s=NULL;
    }
    else{
      must(pf_session_apply(s,p,&anchor)==PF_OK);
    }
    PFPrivateBootstrap local=bootstrap(2);
    PFRecoveryFields rf=recovery_fields(local,anchor,before);
    PFRecoveryGrant *g=NULL;
    must(pf_private_recovery_grant(&local.authority,&rf,anchor,before,&g)==PF_OK);
    PFRecovery *r=NULL;
    PFObservedReceipt *current=NULL;
    PFResult result=pf_recovery_inspect(root,g,&r,&current);
    check(result==PF_OK&&current&&current->native.receipt.phase==PF_WRITE_APPLIED,"sealed exact intent/receipt plus physical bindings recover actual applied state");
    PFRestoreFields restore=restore_fields(local,current);
    PFRestoreGrant *fresh=NULL;
    must(pf_private_restore_grant(&local.authority,&restore,&fresh)==PF_OK);
    PFIntent *undo=NULL;
    must(pf_recovery_intent(r,fresh,&undo)==PF_OK);
    pf_restore_grant_close(fresh);
    if(variant==0){
      /* Exit after authenticated Undo staging, before target effect. */PFObservedReceipt pending={0};
      pending.schema=2;
      pending.transaction=uuid();
      pending.native=undo->native;
      memcpy(pending.plan_hash,undo->fields.plan_hash,32);
      memset(pending.record_hash,16,32);
      pf_recovery_close(r);
      r=NULL;
      pf_receipt_close(current);
      current=NULL;
      pf_recovery_grant_close(g);
      g=NULL;
      local=bootstrap(2);
      rf=recovery_fields(local,&pending,before);
      must(pf_private_recovery_grant(&local.authority,&rf,&pending,before,&g)==PF_OK);
      result=pf_recovery_inspect(root,g,&r,&current);
      check(result==PF_OK&&equal_file(file,desired,sizeof(desired)-1),"authenticated staged Undo survives descriptor teardown without target effect");
      restore=restore_fields(local,current);
      restore.confirmation_nonce[0]^=1;
      must(pf_private_restore_grant(&local.authority,&restore,&fresh)==PF_OK);
      pf_intent_close(undo);
      undo=NULL;
      check(pf_recovery_intent(r,fresh,&undo)==PF_OK&&undo!=NULL,"fresh confirmation rebinds existing authenticated Undo stage without collision");
      pf_restore_grant_close(fresh);
      PFPermit *up=permit(local,undo);
      PFObservedReceipt *done=NULL;
      check(pf_recovery_restore(r,up,&done)==PF_OK&&equal_file(file,original,sizeof(original)-1),"crash-staged Undo conditionally completes with new durable permit");
      pf_receipt_close(done);
      pf_permit_close(up);
    }
    else{
      PFObservedReceipt pending={0};
      pending.schema=2;
      pending.transaction=uuid();
      pending.native=undo->native;
      memcpy(pending.plan_hash,undo->fields.plan_hash,32);
      memset(pending.record_hash,16,32);
      PFPermit *up=permit(local,undo);
      crash_stage=7;
      pid_t child=fork();
      must(child>=0);
      if(!child){
        PFObservedReceipt *done=NULL;
        (void)pf_recovery_restore(r,up,&done);
        _exit(99);
      }
      int status;
      must(waitpid(child,&status,0)==child&&WIFEXITED(status));
      check(WEXITSTATUS(status)==40,"actual child exits after Undo namespace effect before receipt sealing");
      crash_stage=0;
      pf_permit_close(up);
      pf_recovery_close(r);
      r=NULL;
      pf_receipt_close(current);
      current=NULL;
      pf_recovery_grant_close(g);
      g=NULL;
      local=bootstrap(2);
      rf=recovery_fields(local,&pending,before);
      must(pf_private_recovery_grant(&local.authority,&rf,&pending,before,&g)==PF_OK);
      result=pf_recovery_inspect(root,g,&r,&current);
      fprintf(stderr,"postUndo variant%u=%s\n",variant,pf_result_name(result));
      struct stat st;
      int target_ok=variant==2?lstat(file,&st)!=0&&errno==ENOENT:equal_file(file,original,sizeof(original)-1);
      check(result==PF_OK&&current&&current->native.receipt.phase==PF_WRITE_UNDONE&&target_ok,"authenticated restore-stage identity classifies completed Undo read-only");
    }
    pf_intent_close(undo);
    pf_recovery_close(r);
    pf_recovery_grant_close(g);
    pf_receipt_close(current);
    pf_receipt_close(anchor);
    pf_intent_close(i);
    pf_permit_close(p);
    pf_session_close(s);
    pf_snapshot_close(before);
    pf_root_close(root);
  }
}
int main(void){
  alarm(30);
  puts("TAP version 13");
  full_snapshot_cases();
  session_recovery_cases();
  protocol_cases();
  store_cases();
  authority_cases();
  short_deadline_cases();
  transport_cases();
  crash_cases();
  pf_packet_wipe(wire_in,PF_FRAME_PAYLOAD+PF_FRAME_OVERHEAD);
  pf_packet_wipe(wire_out,PF_FRAME_PAYLOAD+PF_FRAME_OVERHEAD);
  pf_packet_wipe(wire_payload,PF_FRAME_PAYLOAD);
  free(wire_in);
  free(wire_out);
  free(wire_payload);
  printf("1..%u\n",cases);
  return failures?1:0;
}
