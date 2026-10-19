#define _DARWIN_C_SOURCE
#include "snapshot-private.h"
#include "codec-private.h"
#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#if defined(__APPLE__)
#include <CommonCrypto/CommonDigest.h>
#include <membership.h>
#include <sys/acl.h>
#include <sys/kauth.h>
#include <sys/xattr.h>
#include <time.h>
#if defined(__arm64__)
#define PF_ARCH 1u
#elif defined(__x86_64__)
#define PF_ARCH 2u
#else
#define PF_ARCH 0u
#endif
#endif
static PFResult snapshot_digest(const unsigned char *,uint32_t,unsigned char[32]);
void pf_packet_wipe(void *p, size_t n) {
  volatile unsigned char *b=p;
  while(n--)*b++=0;
}
#if defined(__APPLE__)
void pf_packet_hash(const void *p,size_t n,unsigned char out[32]) {
  static const unsigned char empty=0;
  (void)CC_SHA256(n?p:&empty,(CC_LONG)n,out);
}
uint64_t pf_packet_now(void) {
  struct timespec t;
  if(clock_gettime(CLOCK_MONOTONIC,&t)!=0)return 0;
  return (uint64_t)t.tv_sec*UINT64_C(1000000000)+(uint64_t)t.tv_nsec;
}
PFStamp pf_packet_stamp(const struct stat *s) {
  PFStamp p={0};
  p.device=s->st_dev;
  p.inode=s->st_ino;
  p.size=s->st_size<0?UINT64_MAX:(uint64_t)s->st_size;
  p.uid=s->st_uid;
  p.mode=s->st_mode;
  p.links=s->st_nlink;
  p.mtime_seconds=s->st_mtimespec.tv_sec;
  p.mtime_nanoseconds=s->st_mtimespec.tv_nsec;
  p.ctime_seconds=s->st_ctimespec.tv_sec;
  p.ctime_nanoseconds=s->st_ctimespec.tv_nsec;
  return p;
}
PFResult pf_packet_error(void) {
  if(errno==ENOENT)return PF_UNAVAILABLE;
  if(errno==EEXIST)return PF_CHANGED;
  if(errno==ELOOP||errno==ENOTDIR)return PF_UNSAFE;
  if(errno==ENOTSUP||errno==EOPNOTSUPP||errno==EINVAL||errno==EXDEV)return PF_UNSUPPORTED;
  return PF_IO;
}
PFResult pf_packet_empty_acl(int fd) {
  PFResult r=pf_native_acl_safe(fd);
  if(r!=PF_OK)return r;
  errno=0;
  acl_t a=acl_get_fd_np(fd,ACL_TYPE_EXTENDED);
  if(!a)return errno==ENOENT?PF_OK:pf_packet_error();
  ssize_t n=acl_size(a);
  acl_entry_t e;
  errno=0;
  r=n<0||n>PF_SNAPSHOT_ACL_BYTES||acl_valid(a)!=0?PF_UNSAFE:PF_OK;
  if(r==PF_OK){
    if(acl_get_entry(a,ACL_FIRST_ENTRY,&e)==0)r=PF_UNSAFE;
    else if(errno!=EINVAL)r=PF_IO;
  }
  if(acl_free(a)!=0)r=PF_IO;
  return r;
}
static const char *const attrs[2]={
  "com.apple.provenance","com.apple.quarantine"
}
;
static PFResult acl_capture(int fd,PFSnapshot *s) {
  errno=0;
  acl_t a=acl_get_fd_np(fd,ACL_TYPE_EXTENDED);
  if(!a){
    if(errno!=ENOENT)return pf_packet_error();
    s->acl_tag=0;
    s->acl_size=0;
    pf_packet_hash(NULL,0,s->meta.acl_hash);
    return PF_OK;
  }
  ssize_t n=acl_size(a);
  PFResult r=n<0||n>PF_SNAPSHOT_ACL_BYTES||acl_valid(a)!=0?PF_UNSAFE:PF_OK;
  acl_entry_t e;
  errno=0;
  int populated=acl_get_entry(a,ACL_FIRST_ENTRY,&e)==0;
  if(!populated&&errno!=EINVAL)r=PF_IO;
  if(r==PF_OK){
    ssize_t got=acl_copy_ext_native(s->acl,a,n);
    if(got<0||got>n)r=PF_IO;
    else{
      s->acl_size=(uint32_t)got;
      s->acl_tag=populated?2u:1u;
      pf_packet_hash(populated?s->acl:NULL,populated?(size_t)got:0,s->meta.acl_hash);
    }
  }
  if(acl_free(a)!=0)r=PF_IO;
  return r;
}
PFResult pf_snapshot_acl_validate(PFByteView v,uint32_t tag) {
  if(tag>2||v.size>PF_SNAPSHOT_ACL_BYTES||(!v.data&&v.size))return PF_INVALID;
  if(tag==0)return v.size?PF_INVALID:PF_OK;
  /* acl_copy_int_native has no size argument. Validate the SDK's complete
  * filesec header/count/size before calling it, using an aligned bounded copy. */
  const size_t header=KAUTH_FILESEC_SIZE(0);
  if(v.size<header||!KAUTH_FILESEC_VALID(v.size))return PF_INVALID;
  unsigned char *copy=calloc(v.size,1);
  if(!copy)return PF_IO;
  memcpy(copy,v.data,v.size);
  struct kauth_filesec *f=(struct kauth_filesec *)(void *)copy;
  PFResult r=PF_OK;
  uint32_t count=f->fsec_entrycount;
  if(f->fsec_magic!=KAUTH_FILESEC_MAGIC||count>ACL_MAX_ENTRIES||KAUTH_FILESEC_SIZE(count)!=v.size||(tag==1&&count!=0)||(tag==2&&count==0))r=PF_INVALID;
  if(r==PF_OK&&(f->fsec_flags&~(KAUTH_ACL_FLAGS_PRIVATE|KAUTH_ACL_DEFER_INHERIT|KAUTH_ACL_NO_INHERIT)))r=PF_UNSUPPORTED;
  acl_t a=r==PF_OK?acl_copy_int_native(copy):NULL;
  if(r==PF_OK&&(!a||acl_valid(a)!=0))r=PF_INVALID;
  const acl_permset_mask_t writes=ACL_WRITE_DATA|ACL_APPEND_DATA|ACL_DELETE|ACL_DELETE_CHILD|ACL_WRITE_ATTRIBUTES|ACL_WRITE_EXTATTRIBUTES|ACL_WRITE_SECURITY|ACL_CHANGE_OWNER;
  const acl_permset_mask_t known=writes|ACL_READ_DATA|ACL_EXECUTE|ACL_READ_ATTRIBUTES|ACL_READ_EXTATTRIBUTES|ACL_READ_SECURITY|ACL_SYNCHRONIZE;
  for(uint32_t i=0;a&&r==PF_OK&&i<count;i++){
    acl_entry_t e;
    acl_tag_t t;
    acl_permset_mask_t mask;
    if(acl_get_entry(a,i?ACL_NEXT_ENTRY:ACL_FIRST_ENTRY,&e)!=0||acl_get_tag_type(e,&t)!=0||acl_get_permset_mask_np(e,&mask)!=0){
      r=PF_INVALID;
      break;
    }
    if((t!=ACL_EXTENDED_ALLOW&&t!=ACL_EXTENDED_DENY)||(mask&~known)){
      r=PF_UNSAFE;
      break;
    }
    if(t==ACL_EXTENDED_ALLOW&&(mask&writes)){
      void *q=acl_get_qualifier(e);
      id_t id=0;
      int type=-1;
      if(!q)r=PF_IO;
      else{
        int mapped=mbr_uuid_to_id(q,&id,&type);
        if(acl_free(q)!=0)r=PF_IO;
        if(mapped!=0)r=PF_IO;
        else if(type!=ID_TYPE_UID||id!=getuid())r=PF_UNSAFE;
      }
    }
  }
  if(r==PF_OK){
    unsigned char again[PF_SNAPSHOT_ACL_BYTES];
    ssize_t got=acl_copy_ext_native(again,a,v.size);
    if(got!=(ssize_t)v.size||memcmp(again,v.data,v.size)!=0)r=PF_INVALID;
    pf_packet_wipe(again,sizeof(again));
  }
  if(a&&acl_free(a)!=0)r=PF_IO;
  pf_packet_wipe(copy,v.size);
  free(copy);
  return r;
}
static PFResult attribute_capture(int fd,PFSnapshot *s) {
  char names[128];
  ssize_t n=flistxattr(fd,names,sizeof(names),0);
  if(n<0)return errno==ERANGE?PF_TOO_LARGE:PF_IO;
  if(n>(ssize_t)sizeof(names))return PF_TOO_LARGE;
  unsigned seen[2]={
    0,0
  }
  ;
  for(size_t at=0;at<(size_t)n;){
    size_t len=strnlen(names+at,(size_t)n-at);
    if(!len||len==(size_t)n-at)return PF_CHANGED;
    unsigned i;
    for(i=0;i<2;i++)if(strcmp(names+at,attrs[i])==0)break;
    if(i==2)return PF_UNSUPPORTED;
    if(seen[i]++)return PF_CHANGED;
    at+=len+1;
  }
  for(unsigned i=0;i<2;i++){
    errno=0;
    ssize_t want=fgetxattr(fd,attrs[i],NULL,0,0,0);
    if(want<0){
      if(errno==ENOATTR&&!seen[i])continue;
      return errno==ENOATTR?PF_CHANGED:PF_IO;
    }
    if(!seen[i])return PF_CHANGED;
    if(want>PF_SNAPSHOT_ATTR_BYTES)return PF_TOO_LARGE;
    ssize_t got=fgetxattr(fd,attrs[i],s->attrs[i].bytes,sizeof(s->attrs[i].bytes),0,0);
    if(got<0||got!=want)return PF_CHANGED;
    s->attrs[i].present=1;
    s->attrs[i].size=(size_t)got;
    s->meta.attrs[i].present=1;
    s->meta.attrs[i].size=(uint64_t)got;
    pf_packet_hash(s->attrs[i].bytes,(size_t)got,s->meta.attrs[i].hash);
  }
  return PF_OK;
}
PFResult pf_snapshot_metadata_fd(int fd,PFSnapshot *s) {
  if(!s)return PF_INVALID;
  struct stat before,after;
  if(fstat(fd,&before)!=0)return PF_IO;
  if(!S_ISREG(before.st_mode)||before.st_uid!=getuid()||before.st_nlink!=1||(before.st_mode&0022))return PF_UNSAFE;
  if((before.st_mode&07000)||before.st_flags)return PF_UNSUPPORTED;
  if(before.st_size<0||(uint64_t)before.st_size>PF_READER_MAX_BYTES)return PF_TOO_LARGE;
  PFResult r=pf_native_acl_safe(fd);
  if(r==PF_OK)r=acl_capture(fd,s);
  if(r==PF_OK)r=attribute_capture(fd,s);
  if(r==PF_OK&&fstat(fd,&after)!=0)r=PF_IO;
  if(r==PF_OK){
    PFStamp a=pf_packet_stamp(&before),b=pf_packet_stamp(&after);
    if(memcmp(&a,&b,sizeof(a))||before.st_gid!=after.st_gid||before.st_flags!=after.st_flags)r=PF_CHANGED;
    else{
      s->meta.stamp=b;
      s->meta.gid=after.st_gid;
      s->meta.flags=after.st_flags;
      s->exists=1;
    }
  }
  return r;
}
PFResult pf_snapshot_fd(int fd,PFSnapshot *s) {
  if(!s)return PF_INVALID;
  PFResult r=pf_snapshot_metadata_fd(fd,s);
  uint64_t start=pf_packet_now();
  if(!start)return PF_IO;
  size_t at=0;
  while(r==PF_OK&&at<s->meta.stamp.size){
    if(pf_packet_now()-start>=UINT64_C(1000000000)){
      r=PF_DEADLINE;
      break;
    }
    size_t want=(size_t)s->meta.stamp.size-at;
    if(want>4096)want=4096;
    ssize_t n=pread(fd,s->bytes+at,want,(off_t)at);
    if(n<0&&errno==EINTR)continue;
    if(n<=0){
      r=n==0?PF_CHANGED:PF_IO;
      break;
    }
    at+=(size_t)n;
  }
  if(r==PF_OK){
    unsigned char extra;
    ssize_t n=pread(fd,&extra,1,(off_t)at);
    if(n!=0)r=n>0?PF_CHANGED:PF_IO;
  }
  PFSnapshot *fresh=r==PF_OK?calloc(1,sizeof(*fresh)):NULL;
  if(r==PF_OK&&!fresh)r=PF_IO;
  if(r==PF_OK)r=pf_snapshot_metadata_fd(fd,fresh);
  if(r==PF_OK&&(memcmp(&s->meta,&fresh->meta,sizeof(s->meta))||s->acl_tag!=fresh->acl_tag||s->acl_size!=fresh->acl_size||memcmp(s->acl,fresh->acl,s->acl_size)||memcmp(s->attrs,fresh->attrs,sizeof(s->attrs))))r=PF_CHANGED;
  if(fresh){
    pf_packet_wipe(fresh,sizeof(*fresh));
    free(fresh);
  }
  if(r==PF_OK){
    pf_packet_hash(s->bytes,at,s->meta.hash);
    if(pf_packet_now()-start>=UINT64_C(1000000000))r=PF_DEADLINE;
  }
  if(r!=PF_OK){
    pf_packet_wipe(s,sizeof(*s));
  }
  return r;
}
PFResult pf_snapshot_bindings(PFNativeParent *p,PFBindingSet *b) {
  if(!b)return PF_INVALID;
  memset(b,0,sizeof(*b));
  size_t count=0;
  PFResult r=pf_native_parent_bindings(p,b->entries,PF_SNAPSHOT_BINDINGS,&count,b->profile_hash);
  if(r==PF_OK)b->count=(uint32_t)count;
  return r;
}
PFResult pf_snapshot_native(PFNativeParent *p,int directory,const char *name,PFRecipe recipe,PFSnapshot **out) {
  if(!out)return PF_INVALID;
  *out=NULL;
  if(!p||directory<0||!name)return PF_INVALID;
  PFResult r=pf_native_parent_current(p);
  if(r!=PF_OK)return r;
  PFSnapshot *s=calloc(1,sizeof(*s));
  if(!s)return PF_IO;
  s->recipe=recipe;
  r=pf_snapshot_bindings(p,&s->bindings);
  struct stat named,again;
  if(r==PF_OK&&fstatat(directory,name,&named,AT_SYMLINK_NOFOLLOW)!=0){
    r=errno==ENOENT?PF_UNAVAILABLE:pf_packet_error();
  }
  if(r==PF_UNAVAILABLE){
    r=pf_native_parent_current(p);
    if(r==PF_OK&&fstatat(directory,name,&again,AT_SYMLINK_NOFOLLOW)==0)r=PF_CHANGED;
    else if(r==PF_OK&&errno!=ENOENT)r=PF_IO;
  }
  else if(r==PF_OK){
    if(!S_ISREG(named.st_mode))r=PF_UNSAFE;
    int fd=r==PF_OK?openat(directory,name,O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC):-1;
    if(r==PF_OK&&fd<0)r=pf_packet_error();
    if(r==PF_OK)r=pf_snapshot_fd(fd,s);
    if(r==PF_OK){
      PFStamp before=pf_packet_stamp(&named);
      if(memcmp(&before,&s->meta.stamp,sizeof(before)))r=PF_CHANGED;
    }
    if(r==PF_OK&&s->meta.stamp.device!=s->bindings.entries[s->bindings.count-1].device)r=PF_UNSAFE;
    if(r==PF_OK&&fstatat(directory,name,&again,AT_SYMLINK_NOFOLLOW)!=0)r=PF_CHANGED;
    if(r==PF_OK){
      PFStamp last=pf_packet_stamp(&again);
      if(memcmp(&last,&s->meta.stamp,sizeof(last)))r=PF_CHANGED;
    }
    if(fd>=0)close(fd);
  }
  PFBindingSet current;
  if(r==PF_OK)r=pf_snapshot_bindings(p,&current);
  if(r==PF_OK&&memcmp(&current,&s->bindings,sizeof(current)))r=PF_CHANGED;
  if(r==PF_OK){
    unsigned char *encoded=malloc(PF_SNAPSHOT_BYTES);
    uint32_t n=0;
    if(!encoded)r=PF_IO;
    else{
      r=pf_snapshot_encode(s,encoded,PF_SNAPSHOT_BYTES,&n);
      if(r==PF_OK)r=snapshot_digest(encoded,n,s->digest);
      pf_packet_wipe(encoded,PF_SNAPSHOT_BYTES);
      free(encoded);
    }
  }
  if(r!=PF_OK){
    pf_snapshot_close(s);
    return r;
  }
  *out=s;
  return PF_OK;
}
PFResult pf_snapshot_fixed(PFRoot *root,PFRecipe recipe,const PFBindingSet *expected,PFSnapshot **out) {
  if(!out)return PF_INVALID;
  *out=NULL;
  PFNativeParent *p=NULL;
  PFResult r=pf_native_parent_open(root,recipe,&p);
  if(r!=PF_OK)return r;
  r=pf_snapshot_native(p,pf_native_parent_fd(p),pf_native_leaf(p),recipe,out);
  if(r==PF_OK&&expected&&memcmp(expected,&(*out)->bindings,sizeof(*expected))){
    pf_snapshot_close(*out);
    *out=NULL;
    r=PF_CHANGED;
  }
  pf_native_parent_close(p);
  return r;
}
PFResult pf_snapshot_apply_metadata(int fd,const PFSnapshot *s,int original_time) {
  if(!s||!s->exists)return PF_INVALID;
  PFResult r=pf_snapshot_acl_validate((PFByteView){
    s->acl,s->acl_size
  }
  ,s->acl_tag);
  if(r!=PF_OK)return r;
  if(fchown(fd,(uid_t)s->meta.stamp.uid,(gid_t)s->meta.gid)!=0||fchmod(fd,(mode_t)(s->meta.stamp.mode&0777))!=0)return PF_IO;
  acl_t a=s->acl_tag?acl_copy_int_native(s->acl):acl_init(0);
  if(!a)return PF_IO;
  r=acl_set_fd_np(fd,a,ACL_TYPE_EXTENDED)==0?PF_OK:PF_IO;
  if(acl_free(a)!=0)r=PF_IO;
  for(unsigned i=0;r==PF_OK&&i<2;i++)if(s->attrs[i].present&&fsetxattr(fd,attrs[i],s->attrs[i].bytes,s->attrs[i].size,0,0)!=0)r=PF_IO;
  if(r==PF_OK&&original_time){
    struct timespec t[2]={
      {
        0,UTIME_OMIT
      }
      ,{
        s->meta.stamp.mtime_seconds,s->meta.stamp.mtime_nanoseconds
      }
    }
    ;
    if(futimens(fd,t)!=0)r=PF_IO;
  }
  return r;
}
#else
void pf_packet_hash(const void *p,size_t n,unsigned char out[32]){
  (void)p;
  (void)n;
  memset(out,0,32);
}
uint64_t pf_packet_now(void){
  return 0;
}
PFStamp pf_packet_stamp(const struct stat *s){
  (void)s;
  PFStamp p={0};
  return p;
}
PFResult pf_packet_error(void){
  return PF_UNSUPPORTED;
}
PFResult pf_packet_empty_acl(int f){
  (void)f;
  return PF_UNSUPPORTED;
}
PFResult pf_snapshot_acl_validate(PFByteView v,uint32_t t){
  (void)v;
  (void)t;
  return PF_UNSUPPORTED;
}
PFResult pf_snapshot_fd(int f,PFSnapshot *s){
  (void)f;
  (void)s;
  return PF_UNSUPPORTED;
}
PFResult pf_snapshot_metadata_fd(int f,PFSnapshot *s){
  (void)f;
  (void)s;
  return PF_UNSUPPORTED;
}
PFResult pf_snapshot_apply_metadata(int f,const PFSnapshot *s,int t){
  (void)f;
  (void)s;
  (void)t;
  return PF_UNSUPPORTED;
}
PFResult pf_snapshot_bindings(PFNativeParent *p,PFBindingSet *b){
  (void)p;
  if(b)memset(b,0,sizeof(*b));
  return PF_UNSUPPORTED;
}
PFResult pf_snapshot_native(PFNativeParent *p,int f,const char *n,PFRecipe r,PFSnapshot **o){
  (void)p;
  (void)f;
  (void)n;
  (void)r;
  if(o)*o=NULL;
  return PF_UNSUPPORTED;
}
PFResult pf_snapshot_fixed(PFRoot *r,PFRecipe p,const PFBindingSet *e,PFSnapshot **o){
  (void)r;
  (void)p;
  (void)e;
  if(o)*o=NULL;
  return PF_UNSUPPORTED;
}
#endif
void pf_snapshot_close(PFSnapshot *s){
  if(s){
    pf_packet_wipe(s,sizeof(*s));
    free(s);
  }
}
static PFResult snapshot_digest(const unsigned char *bytes,uint32_t size,unsigned char out[32]) {
  static const unsigned char domain[]="PF-SNAPSHOT-V1";
  if(size>PF_SNAPSHOT_BYTES)return PF_TOO_LARGE;
  unsigned char *input=malloc(sizeof(domain)+size);
  if(!input)return PF_IO;
  memcpy(input,domain,sizeof(domain));
  memcpy(input+sizeof(domain),bytes,size);
  pf_packet_hash(input,sizeof(domain)+size,out);
  pf_packet_wipe(input,sizeof(domain)+size);
  free(input);
  return PF_OK;
}
static void snapshot_codec(PFCodec *c,PFSnapshot *s) {
  uint32_t version=1,os=1,arch=0,format=1;
#if defined(__APPLE__)
  arch=PF_ARCH;
#endif
  pf_codec_u32(c,&version);
  pf_codec_u32(c,&os);
  pf_codec_u32(c,&arch);
  pf_codec_u32(c,&format);
#if defined(__APPLE__)
  if(version!=1||os!=1||arch!=PF_ARCH||!arch||format!=1)c->failed=1;
#else
  c->failed=1;
#endif
  uint32_t recipe=(uint32_t)s->recipe;
  pf_codec_u32(c,&recipe);
  s->recipe=(PFRecipe)recipe;
  pf_codec_u32(c,&s->exists);
  pf_codec_u32(c,&s->bindings.count);
  if(recipe<1||recipe>3||s->exists>1||!s->bindings.count||s->bindings.count>PF_SNAPSHOT_BINDINGS)c->failed=1;
  if(c->failed)return;
  pf_codec_bytes(c,s->bindings.profile_hash,32);
  for(uint32_t i=0;i<s->bindings.count;i++){
    PFNativeBinding *b=&s->bindings.entries[i];
    pf_codec_u64(c,&b->device);
    pf_codec_u64(c,&b->inode);
    pf_codec_u64(c,&b->uid);
    pf_codec_u64(c,&b->mode);
    pf_codec_u64(c,&b->gid);
    pf_codec_u64(c,&b->flags);
    pf_codec_bytes(c,b->acl_hash,32);
  }
  pf_codec_stamp(c,&s->meta.stamp);
  pf_codec_u64(c,&s->meta.gid);
  pf_codec_u64(c,&s->meta.flags);
  pf_codec_bytes(c,s->meta.hash,32);
  pf_codec_bytes(c,s->meta.acl_hash,32);
  pf_codec_u32(c,&s->acl_tag);
  pf_codec_u32(c,&s->acl_size);
  if(s->acl_tag>2||s->acl_size>PF_SNAPSHOT_ACL_BYTES||s->meta.stamp.size>PF_READER_MAX_BYTES)c->failed=1;
  if(c->failed)return;
  pf_codec_bytes(c,s->acl,s->acl_size);
  for(unsigned i=0;i<2;i++){
    PFAttribute *a=&s->attrs[i];
    uint32_t present=a->present,size=(uint32_t)a->size;
    pf_codec_u32(c,&present);
    pf_codec_u32(c,&size);
    if(present>1||size>PF_SNAPSHOT_ATTR_BYTES||(!present&&size)){
      c->failed=1;
      return;
    }
    a->present=present;
    a->size=size;
    pf_codec_bytes(c,s->meta.attrs[i].hash,32);
    pf_codec_bytes(c,a->bytes,size);
    s->meta.attrs[i].present=present;
    s->meta.attrs[i].size=size;
  }
  pf_codec_bytes(c,s->bytes,(uint32_t)s->meta.stamp.size);
}
static PFResult snapshot_valid(const PFSnapshot *s) {
  if(!s||s->recipe<1||s->recipe>3||s->exists>1||!s->bindings.count||s->bindings.count>PF_SNAPSHOT_BINDINGS)return PF_INVALID;
  if(s->meta.stamp.size>PF_READER_MAX_BYTES||s->meta.stamp.mtime_nanoseconds<0||s->meta.stamp.mtime_nanoseconds>999999999||s->meta.stamp.ctime_nanoseconds<0||s->meta.stamp.ctime_nanoseconds>999999999)return PF_INVALID;
  for(uint32_t i=0;i<s->bindings.count;i++){
    const PFNativeBinding *b=&s->bindings.entries[i];
    if(b->uid>UINT32_MAX||b->gid>UINT32_MAX||b->flags>UINT32_MAX||b->mode>0177777u)return PF_INVALID;
#if defined(__APPLE__)
    if(!S_ISDIR(b->mode))return PF_INVALID;
#endif
  }
  if(!s->exists){
    PFWriteMeta zero={0};
    if(memcmp(&zero,&s->meta,sizeof(zero))||s->acl_tag||s->acl_size)return PF_INVALID;
    for(unsigned i=0;i<2;i++)if(s->attrs[i].present||s->attrs[i].size)return PF_INVALID;
    return PF_OK;
  }
#if defined(__APPLE__)
  if(!S_ISREG(s->meta.stamp.mode)||s->meta.stamp.uid!=getuid()||s->meta.stamp.links!=1||(s->meta.stamp.mode&0022))return PF_UNSAFE;
  if((s->meta.stamp.mode&07000)||s->meta.flags||s->meta.gid>UINT32_MAX)return PF_UNSUPPORTED;
#endif
  PFResult r=pf_snapshot_acl_validate((PFByteView){
    s->acl,s->acl_size
  }
  ,s->acl_tag);
  if(r!=PF_OK)return r;
  unsigned char h[32];
  pf_packet_hash(s->bytes,(size_t)s->meta.stamp.size,h);
  if(memcmp(h,s->meta.hash,32))return PF_INVALID;
  pf_packet_hash(s->acl_tag==2?s->acl:NULL,s->acl_tag==2?s->acl_size:0,h);
  if(memcmp(h,s->meta.acl_hash,32))return PF_INVALID;
  for(unsigned i=0;i<2;i++){
    const PFAttribute *a=&s->attrs[i];
    if(a->present>1||a->size>PF_SNAPSHOT_ATTR_BYTES||s->meta.attrs[i].present!=a->present||s->meta.attrs[i].size!=a->size)return PF_INVALID;
    if(a->present)pf_packet_hash(a->bytes,a->size,h);
    else memset(h,0,32);
    if(memcmp(h,s->meta.attrs[i].hash,32))return PF_INVALID;
  }
  return PF_OK;
}
PFResult pf_snapshot_encode(const PFSnapshot *s,unsigned char *out,uint32_t capacity,uint32_t *written) {
  if(written)*written=0;
  if(!s||!out||!written||capacity>PF_SNAPSHOT_BYTES)return PF_INVALID;
  PFResult r=snapshot_valid(s);
  if(r!=PF_OK)return r;
  PFSnapshot *copy=malloc(sizeof(*copy));
  if(!copy)return PF_IO;
  *copy=*s;
  PFCodec c={
    out,NULL,capacity,0,0
  }
  ;
  snapshot_codec(&c,copy);
  pf_snapshot_close(copy);
  if(c.failed){
    pf_packet_wipe(out,capacity);
    return PF_TOO_LARGE;
  }
  *written=c.at;
  return PF_OK;
}
PFResult pf_snapshot_decode(PFByteView bytes,PFSnapshot **out) {
  if(!out)return PF_INVALID;
  *out=NULL;
  if(!bytes.data||!bytes.size||bytes.size>PF_SNAPSHOT_BYTES)return PF_INVALID;
  PFSnapshot *s=calloc(1,sizeof(*s));
  if(!s)return PF_IO;
  PFCodec c={
    NULL,bytes.data,bytes.size,0,0
  }
  ;
  snapshot_codec(&c,s);
  PFResult r=c.failed||c.at!=bytes.size?PF_INVALID:snapshot_valid(s);
  if(r!=PF_OK){
    pf_snapshot_close(s);
    return r;
  }
  r=snapshot_digest(bytes.data,bytes.size,s->digest);
  if(r!=PF_OK){
    pf_snapshot_close(s);
    return r;
  }
  *out=s;
  return PF_OK;
}
PFResult pf_snapshot_compare(const PFSnapshot *a,const PFSnapshot *b,int moved) {
  if(!a||!b)return PF_INVALID;
  PFSnapshot *x=malloc(sizeof(*x)),*y=malloc(sizeof(*y));
  if(!x||!y){
    free(x);
    free(y);
    return PF_IO;
  }
  *x=*a;
  *y=*b;
  memset(x->digest,0,32);
  memset(y->digest,0,32);
  if(moved){
    x->meta.stamp.ctime_seconds=y->meta.stamp.ctime_seconds=0;
    x->meta.stamp.ctime_nanoseconds=y->meta.stamp.ctime_nanoseconds=0;
  }
  PFResult r=memcmp(x,y,sizeof(*x))?PF_CHANGED:PF_OK;
  pf_snapshot_close(x);
  pf_snapshot_close(y);
  return r;
}
PFResult pf_snapshot_current(PFRoot *r,PFRecipe recipe,const PFSnapshot *s) {
  if(!s||s->recipe!=recipe)return PF_INVALID;
  PFSnapshot *current=NULL;
  PFResult result=pf_snapshot_fixed(r,recipe,&s->bindings,&current);
  if(result==PF_OK)result=pf_snapshot_compare(s,current,0);
  pf_snapshot_close(current);
  return result;
}
