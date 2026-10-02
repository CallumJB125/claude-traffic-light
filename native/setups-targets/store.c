#define _DARWIN_C_SOURCE
#include "store.h"
#include "snapshot-private.h"
#include "codec-private.h"
#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#if defined(__APPLE__)
#include <dirent.h>
#include <stdio.h>
#include <sys/stat.h>
struct PFStoreRoot {
  PFRoot *parent;
  int fd;
  PFNativeBinding binding;
  unsigned refs, closed, live;
}
;
struct PFStoreTxn {
  PFStoreRoot *root;
  int fd;
  PFNativeBinding binding;
  PFUuid id;
  char name[37];
}
;
static const char root_name[]="setups-transactions";
static int uuid_valid(PFUuid id){
  return (id.bytes[6]>>4)==4&&(id.bytes[8]&0xc0)==0x80;
}
static void uuid_name(PFUuid id,char out[37]){
  static const char hex[]="0123456789abcdef";
  unsigned at=0;
  for(unsigned i=0;i<16;i++){
    if(i==4||i==6||i==8||i==10)out[at++]='-';
    out[at++]=hex[id.bytes[i]>>4];
    out[at++]=hex[id.bytes[i]&15];
  }
  out[at]=0;
}
static int uuid_parse(const char *name,PFUuid *id){
  if(strlen(name)!=36)return 0;
  memset(id,0,sizeof(*id));
  unsigned at=0;
  for(unsigned i=0;i<16;i++){
    if(i==4||i==6||i==8||i==10){
      if(name[at++]!='-')return 0;
    }
    unsigned value=0;
    for(unsigned j=0;j<2;j++){
      char c=name[at++];
      if(c>='0'&&c<='9')value=value*16+(unsigned)(c-'0');
      else if(c>='a'&&c<='f')value=value*16+(unsigned)(c-'a'+10);
      else return 0;
    }
    id->bytes[i]=(unsigned char)value;
  }
  return uuid_valid(*id);
}
static PFResult private_binding(int parent,const char *name,int fd,PFNativeBinding *out,const PFNativeBinding *expected){
  struct stat held,named;
  if(fstat(fd,&held)!=0||fstatat(parent,name,&named,AT_SYMLINK_NOFOLLOW)!=0)return PF_CHANGED;
  PFStamp a=pf_packet_stamp(&held),b=pf_packet_stamp(&named);
  if(!S_ISDIR(held.st_mode)||held.st_uid!=getuid()||(held.st_mode&07777)!=0700||held.st_flags||memcmp(&a,&b,sizeof(a)))return PF_UNSAFE;
  PFResult r=pf_packet_empty_acl(fd);
  if(r!=PF_OK)return r;
  r=pf_native_binding_fd(fd,out);
  if(r!=PF_OK)return r;
  if(expected&&memcmp(expected,out,sizeof(*out)))return PF_CHANGED;
  if(fstat(fd,&held)!=0||fstatat(parent,name,&named,AT_SYMLINK_NOFOLLOW)!=0)return PF_CHANGED;
  PFStamp c=pf_packet_stamp(&held),d=pf_packet_stamp(&named);
  return memcmp(&a,&c,sizeof(a))||memcmp(&c,&d,sizeof(c))?PF_CHANGED:PF_OK;
}
static PFResult root_current(PFStoreRoot *s){
  if(!s||s->closed)return PF_INVALID;
  PFResult r=pf_native_root_current(s->parent);
  PFNativeBinding now;
  if(r==PF_OK)r=private_binding(pf_native_root_fd(s->parent),root_name,s->fd,&now,&s->binding);
  return r;
}
static PFResult txn_current(PFStoreTxn *t){
  if(!t)return PF_INVALID;
  PFResult r=root_current(t->root);
  PFNativeBinding now;
  if(r==PF_OK)r=private_binding(t->root->fd,t->name,t->fd,&now,&t->binding);
  return r;
}
static PFResult filename(PFStoreRole role,uint32_t target,uint32_t seq,char out[48]){
  if(role==PF_STORE_MANIFEST){
    if(target||seq)return PF_INVALID;
    strcpy(out,"manifest.sealed");
    return PF_OK;
  }
  if(role==PF_STORE_EVENT){
    if(target||seq>=PF_STORE_MAX_EVENTS)return PF_INVALID;
    (void)snprintf(out,48,"event%06u.sealed",seq);
    return PF_OK;
  }
  static const char *const roles[]={
    "manifest","before","base","after","metadata"
  }
  ;
  if(role<PF_STORE_BEFORE||role>PF_STORE_METADATA||target>=PF_STORE_MAX_TARGETS||seq)return PF_INVALID;
  (void)snprintf(out,48,"target%03u-%s.sealed",target,roles[role]);
  return PF_OK;
}
/* Closed plaintext header describes the sealed body; only the trusted worker
 * can authenticate/decrypt that body. Native never infers AEAD from this tag. */
static PFResult sealed_header(PFByteView bytes, PFUuid id, PFStoreRole role, uint32_t index, uint32_t seq) {
  if(!bytes.data||bytes.size<48||bytes.size>PF_STORE_BLOB_BYTES)return PF_INVALID;
  PFCodec c={
    NULL,bytes.data,bytes.size,0,0
  }
  ;
  unsigned char magic[8],uuid[16];
  uint32_t schema=0,r=0,t=0,q=0,n=0;
  pf_codec_bytes(&c,magic,8);
  pf_codec_u32(&c,&schema);
  pf_codec_u32(&c,&r);
  pf_codec_u32(&c,&t);
  pf_codec_u32(&c,&q);
  pf_codec_bytes(&c,uuid,16);
  pf_codec_u32(&c,&n);
  return c.failed||memcmp(magic,"PFSEAL02",8)||schema!=2||r!=(uint32_t)role||t!=index||q!=seq||memcmp(uuid,id.bytes,16)||!n||n!=bytes.size-c.at?PF_INVALID:PF_OK;
}
static int known_child(const char *name){
  if(strcmp(name,"manifest.sealed")==0)return 1;
  char candidate[48];
  for(unsigned i=0;i<PF_STORE_MAX_EVENTS;i++){
    (void)filename(PF_STORE_EVENT,0,i,candidate);
    if(strcmp(candidate,name)==0)return 1;
  }
  for(unsigned i=0;i<PF_STORE_MAX_TARGETS;i++)for(unsigned r=PF_STORE_BEFORE;r<=PF_STORE_METADATA;r++){
    (void)filename((PFStoreRole)r,i,0,candidate);
    if(strcmp(candidate,name)==0)return 1;
  }
  return 0;
}
static PFResult private_file(int parent,const char *name,int fd,PFStamp *out){
  struct stat a,b,c;
  if(fstat(fd,&a)!=0||fstatat(parent,name,&b,AT_SYMLINK_NOFOLLOW)!=0)return PF_CHANGED;
  PFStamp x=pf_packet_stamp(&a),y=pf_packet_stamp(&b);
  if(!S_ISREG(a.st_mode)||a.st_uid!=getuid()||a.st_nlink!=1||(a.st_mode&07777)!=0600||a.st_flags)return PF_UNSAFE;
  if(a.st_size<0||(uint64_t)a.st_size>PF_STORE_BLOB_BYTES)return PF_TOO_LARGE;
  if(memcmp(&x,&y,sizeof(x)))return PF_CHANGED;
  PFResult r=pf_packet_empty_acl(fd);
  if(r!=PF_OK)return r;
  if(fstat(fd,&c)!=0)return PF_IO;
  PFStamp z=pf_packet_stamp(&c);
  if(memcmp(&x,&z,sizeof(x)))return PF_CHANGED;
  *out=z;
  return PF_OK;
}
static PFResult scan_children(int fd,uint64_t *bytes,unsigned *children){
  *bytes=0;
  *children=0;
  int copy=openat(fd,".",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
  if(copy<0)return PF_IO;
  DIR *dir=fdopendir(copy);
  if(!dir){
    close(copy);
    return PF_IO;
  }
  PFResult r=PF_OK;
  struct dirent *entry;
  uint64_t start=pf_packet_now();
  errno=0;
  while((entry=readdir(dir))!=NULL){
    if(!strcmp(entry->d_name,".")||!strcmp(entry->d_name,".."))continue;
    if(!start||pf_packet_now()-start>=UINT64_C(1000000000)){
      r=PF_DEADLINE;
      break;
    }
    if(++*children>PF_STORE_MAX_CHILDREN){
      r=PF_TOO_LARGE;
      break;
    }
    if(!known_child(entry->d_name)){
      r=PF_UNSAFE;
      break;
    }
    int file=openat(fd,entry->d_name,O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC);
    if(file<0){
      r=pf_packet_error();
      break;
    }
    PFStamp stamp;
    r=private_file(fd,entry->d_name,file,&stamp);
    close(file);
    if(r!=PF_OK)break;
    if(stamp.size>PF_STORE_TRANSACTION_BYTES-*bytes){
      r=PF_TOO_LARGE;
      break;
    }
    *bytes+=stamp.size;
    errno=0;
  }
  if(r==PF_OK&&errno)r=PF_IO;
  closedir(dir);
  return r;
}
static PFResult scan_root(PFStoreRoot *s,PFUuid *ids,uint32_t cap,uint32_t *count,uint64_t *total){
  *count=0;
  *total=0;
  PFResult r=root_current(s);
  if(r!=PF_OK)return r;
  int copy=openat(s->fd,".",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
  if(copy<0)return PF_IO;
  DIR *dir=fdopendir(copy);
  if(!dir){
    close(copy);
    return PF_IO;
  }
  struct dirent *entry;
  uint32_t n=0;
  uint64_t start=pf_packet_now();
  errno=0;
  while((entry=readdir(dir))!=NULL){
    if(!strcmp(entry->d_name,".")||!strcmp(entry->d_name,".."))continue;
    if(!start||pf_packet_now()-start>=UINT64_C(1000000000)){
      r=PF_DEADLINE;
      break;
    }
    PFUuid id;
    if(n>=PF_STORE_MAX_TRANSACTIONS||!uuid_parse(entry->d_name,&id)){
      r=PF_UNSAFE;
      break;
    }
    int child=openat(s->fd,entry->d_name,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
    if(child<0){
      r=pf_packet_error();
      break;
    }
    PFNativeBinding binding;
    r=private_binding(s->fd,entry->d_name,child,&binding,NULL);
    uint64_t bytes=0;
    unsigned children=0;
    if(r==PF_OK)r=scan_children(child,&bytes,&children);
    PFNativeBinding after;
    if(r==PF_OK)r=private_binding(s->fd,entry->d_name,child,&after,&binding);
    close(child);
    if(r!=PF_OK)break;
    if(bytes>PF_STORE_TOTAL_BYTES-*total){
      r=PF_TOO_LARGE;
      break;
    }
    *total+=bytes;
    if(ids){
      if(n>=cap){
        r=PF_TOO_LARGE;
        break;
      }
      ids[n]=id;
    }
    n++;
    errno=0;
  }
  if(r==PF_OK&&errno)r=PF_IO;
  closedir(dir);
  if(r==PF_OK)r=root_current(s);
  if(r!=PF_OK){
    if(ids)memset(ids,0,(size_t)cap*sizeof(*ids));
    return r;
  }
  *count=n;
  return PF_OK;
}
static PFResult sync_fd(int fd,int file){
  if(fsync(fd)!=0)return PF_IO;
  if(file&&fcntl(fd,F_FULLFSYNC)!=0)return PF_IO;
  return PF_OK;
}
PFResult pf_store_open_fixed(PFRoot *parent,PFStoreRoot **out){
  if(!out)return PF_INVALID;
  *out=NULL;
  PFStoreRoot *s=calloc(1,sizeof(*s));
  if(!s)return PF_IO;
  s->fd=-1;
  s->refs=1;
  PFResult r=pf_native_root_duplicate(parent,&s->parent);
  if(r==PF_OK){
    int fd=pf_native_root_fd(s->parent);
    struct stat named;
    if(fstatat(fd,root_name,&named,AT_SYMLINK_NOFOLLOW)!=0){
      if(errno!=ENOENT)r=pf_packet_error();
      else if(mkdirat(fd,root_name,0700)!=0)r=pf_packet_error();
    }
    if(r==PF_OK){
      s->fd=openat(fd,root_name,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
      if(s->fd<0)r=pf_packet_error();
    }
    if(r==PF_OK)r=private_binding(fd,root_name,s->fd,&s->binding,NULL);
    if(r==PF_OK){
      struct stat p;
      if(fstat(fd,&p)!=0)r=PF_IO;
      else if(s->binding.device!=(uint64_t)p.st_dev)r=PF_UNSAFE;
    }
    if(r==PF_OK)r=sync_fd(s->fd,0);
    if(r==PF_OK)r=sync_fd(fd,0);
  }
  if(r!=PF_OK){
    pf_store_close(s);
    return r;
  }
  *out=s;
  return PF_OK;
}
PFResult pf_store_list(PFStoreRoot *s,PFUuid *ids,uint32_t cap,uint32_t *count){
  if(count)*count=0;
  if(!ids||!count||cap>PF_STORE_MAX_TRANSACTIONS)return PF_INVALID;
  memset(ids,0,(size_t)cap*sizeof(*ids));
  uint64_t bytes;
  return scan_root(s,ids,cap,count,&bytes);
}
static int child_entry(const char *name,PFStoreEntry *out){
 char candidate[48];memset(out,0,sizeof(*out));
 for(unsigned role=0;role<=PF_STORE_EVENT;role++){
  unsigned indices=(role>=PF_STORE_BEFORE&&role<=PF_STORE_METADATA)?PF_STORE_MAX_TARGETS:1u;
  unsigned sequences=role==PF_STORE_EVENT?PF_STORE_MAX_EVENTS:1u;
  for(unsigned index=0;index<indices;index++)for(unsigned seq=0;seq<sequences;seq++){
   if(filename((PFStoreRole)role,index,seq,candidate)!=PF_OK)return 0;
   if(!strcmp(candidate,name)){out->role=role;out->target=index;out->sequence=seq;return 1;}
  }
 }return 0;
}
PFResult pf_store_inventory(PFStoreRoot *s,PFStoreTxn *t,PFStoreInventory *out){
 if(!out)return PF_INVALID;memset(out,0,sizeof(*out));
 if(!s||(t&&t->root!=s))return PF_INVALID;
 PFResult r=scan_root(s,NULL,0,&out->namespaces,&out->total_bytes);
 if(r==PF_OK&&t)r=txn_current(t);
 DIR *dir=NULL;int copy=-1;uint64_t start=pf_packet_now();
 if(r==PF_OK&&t){copy=openat(t->fd,".",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);if(copy<0)r=PF_IO;else{dir=fdopendir(copy);if(!dir){close(copy);r=PF_IO;}}}
 if(dir){struct dirent *entry;errno=0;
  while((entry=readdir(dir))!=NULL){
   if(!strcmp(entry->d_name,".")||!strcmp(entry->d_name,".."))continue;
   if(!start||pf_packet_now()-start>=UINT64_C(1000000000)){r=PF_DEADLINE;break;}
   if(out->children>=PF_STORE_MAX_CHILDREN){r=PF_TOO_LARGE;break;}
   PFStoreEntry tuple;if(!child_entry(entry->d_name,&tuple)){r=PF_UNSAFE;break;}
   for(uint32_t i=0;i<out->children;i++)if(out->entries[i].role==tuple.role&&out->entries[i].target==tuple.target&&out->entries[i].sequence==tuple.sequence){r=PF_CHANGED;break;}
   if(r!=PF_OK)break;
   int fd=openat(t->fd,entry->d_name,O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC);if(fd<0){r=pf_packet_error();break;}
   PFStamp stamp;r=private_file(t->fd,entry->d_name,fd,&stamp);close(fd);if(r!=PF_OK)break;
   if(stamp.size>PF_STORE_TRANSACTION_BYTES-out->transaction_bytes){r=PF_TOO_LARGE;break;}
   tuple.bytes=stamp.size;out->transaction_bytes+=stamp.size;out->entries[out->children++]=tuple;errno=0;
  }
  if(r==PF_OK&&errno)r=PF_IO;closedir(dir);
 }
 if(r==PF_OK&&t){uint64_t bytes=0;unsigned children=0;r=scan_children(t->fd,&bytes,&children);if(r==PF_OK&&(bytes!=out->transaction_bytes||children!=out->children))r=PF_CHANGED;if(r==PF_OK)r=txn_current(t);}
 if(r==PF_OK){uint32_t count=0;uint64_t total=0;r=scan_root(s,NULL,0,&count,&total);if(r==PF_OK&&(count!=out->namespaces||total!=out->total_bytes))r=PF_CHANGED;}
 if(r!=PF_OK)memset(out,0,sizeof(*out));return r;
}
static PFResult open_txn(PFStoreRoot *s,PFUuid id,int create,PFStoreTxn **out){
  if(!out)return PF_INVALID;
  *out=NULL;
  if(!uuid_valid(id))return PF_INVALID;
  uint32_t count;
  uint64_t bytes;
  PFResult r=scan_root(s,NULL,0,&count,&bytes);
  if(r!=PF_OK)return r;
  if(create&&count>=PF_STORE_MAX_TRANSACTIONS)return PF_TOO_LARGE;
  if(s->live>=PF_STORE_MAX_TRANSACTIONS)return PF_TOO_LARGE;
  PFStoreTxn *t=calloc(1,sizeof(*t));
  if(!t)return PF_IO;
  t->fd=-1;
  t->root=s;
  t->id=id;
  uuid_name(id,t->name);
  if(create&&mkdirat(s->fd,t->name,0700)!=0)r=pf_packet_error();
  if(r==PF_OK){
    t->fd=openat(s->fd,t->name,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
    if(t->fd<0)r=pf_packet_error();
  }
  if(r==PF_OK)r=private_binding(s->fd,t->name,t->fd,&t->binding,NULL);
  if(r==PF_OK&&t->binding.device!=s->binding.device)r=PF_UNSAFE;
  uint64_t own=0;
  unsigned children=0;
  if(r==PF_OK)r=scan_children(t->fd,&own,&children);
  if(r==PF_OK&&create&&children)r=PF_CHANGED;
  if(r==PF_OK)r=sync_fd(t->fd,0);
  if(r==PF_OK)r=sync_fd(s->fd,0);
  if(r==PF_OK)r=root_current(s);
  if(r!=PF_OK){
    if(t->fd>=0)close(t->fd);
    pf_packet_wipe(t,sizeof(*t));
    free(t);
    return r;
  }
  s->refs++;
  s->live++;
  *out=t;
  return PF_OK;
}
PFResult pf_store_create_txn(PFStoreRoot *s,PFUuid id,PFStoreTxn **out){
  return open_txn(s,id,1,out);
}
PFResult pf_store_open_txn(PFStoreRoot *s,PFUuid id,PFStoreTxn **out){
  return open_txn(s,id,0,out);
}
PFResult pf_store_read(PFStoreTxn *t,PFStoreRole role,uint32_t index,uint32_t seq,unsigned char *out,uint32_t cap,uint32_t *written){
  if(written)*written=0;
  if(!out||!written||cap>PF_STORE_BLOB_BYTES)return PF_INVALID;
  char name[48];
  PFResult r=filename(role,index,seq,name);
  if(r==PF_OK)r=txn_current(t);
  if(r!=PF_OK)return r;
  int fd=openat(t->fd,name,O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC);
  if(fd<0)return pf_packet_error();
  PFStamp before={
    0
  }
  ,after={0};
  r=private_file(t->fd,name,fd,&before);
  if(r==PF_OK&&before.size>cap)r=PF_TOO_LARGE;
  uint32_t at=0;
  uint64_t start=pf_packet_now();
  while(r==PF_OK&&at<before.size){
    if(!start||pf_packet_now()-start>=UINT64_C(1000000000)){
      r=PF_DEADLINE;
      break;
    }
    uint32_t want=(uint32_t)before.size-at;
    if(want>4096)want=4096;
    ssize_t n=pread(fd,out+at,want,at);
    if(n<0&&errno==EINTR)continue;
    if(n<=0){
      r=n==0?PF_CHANGED:PF_IO;
      break;
    }
    at+=(uint32_t)n;
  }
  if(r==PF_OK){
    unsigned char byte;
    ssize_t n=pread(fd,&byte,1,at);
    if(n!=0)r=n>0?PF_CHANGED:PF_IO;
  }
  if(r==PF_OK)r=private_file(t->fd,name,fd,&after);
  if(r==PF_OK&&memcmp(&before,&after,sizeof(before)))r=PF_CHANGED;
  close(fd);
  if(r==PF_OK)r=txn_current(t);
  if(r==PF_OK)r=sealed_header((PFByteView){
    out,at
  }
  ,t->id,role,index,seq);
  if(r==PF_OK)*written=at;
  else pf_packet_wipe(out,at);
  return r;
}
PFResult pf_store_write_exclusive(PFStoreTxn *t,PFStoreRole role,uint32_t index,uint32_t seq,PFByteView bytes){
  if(!t||!bytes.data||!bytes.size||bytes.size>PF_STORE_BLOB_BYTES)return PF_INVALID;
  char name[48];
  PFResult r=filename(role,index,seq,name);
  if(r==PF_OK)r=sealed_header(bytes,t->id,role,index,seq);
  if(r==PF_OK)r=txn_current(t);
  if(r!=PF_OK)return r;
  uint32_t count;
  uint64_t total,own=0;
  unsigned children=0;
  r=scan_root(t->root,NULL,0,&count,&total);
  if(r==PF_OK)r=scan_children(t->fd,&own,&children);
  if(r!=PF_OK)return r;
  if(children>=PF_STORE_MAX_CHILDREN||bytes.size>PF_STORE_TRANSACTION_BYTES-own||bytes.size>PF_STORE_TOTAL_BYTES-total)return PF_TOO_LARGE;
  int fd=openat(t->fd,name,O_RDWR|O_CREAT|O_EXCL|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC,0600);
  if(fd<0)return pf_packet_error();
  PFStamp start_stamp;
  r=private_file(t->fd,name,fd,&start_stamp);
  uint32_t at=0;
  uint64_t start=pf_packet_now();
  while(r==PF_OK&&at<bytes.size){
    if(!start||pf_packet_now()-start>=UINT64_C(1000000000)){
      r=PF_DEADLINE;
      break;
    }
    uint32_t want=bytes.size-at;
    if(want>4096)want=4096;
    ssize_t n=write(fd,bytes.data+at,want);
    if(n<0&&errno==EINTR)continue;
    if(n<=0){
      r=PF_IO;
      break;
    }
    at+=(uint32_t)n;
  }
  if(r==PF_OK)r=sync_fd(fd,1);
  PFStamp after;
  if(r==PF_OK)r=private_file(t->fd,name,fd,&after);
  if(r==PF_OK&&(after.device!=start_stamp.device||after.inode!=start_stamp.inode||after.size!=bytes.size))r=PF_CHANGED;
  unsigned char *verify=r==PF_OK?calloc(bytes.size,1):NULL;
  if(r==PF_OK&&!verify)r=PF_IO;
  uint32_t got=0;
  while(r==PF_OK&&got<bytes.size){
    if(!start||pf_packet_now()-start>=UINT64_C(1000000000)){
      r=PF_DEADLINE;
      break;
    }
    uint32_t want=bytes.size-got;
    if(want>4096)want=4096;
    ssize_t n=pread(fd,verify+got,want,got);
    if(n<0&&errno==EINTR)continue;
    if(n<=0){
      r=PF_IO;
      break;
    }
    got+=(uint32_t)n;
  }
  if(r==PF_OK&&memcmp(verify,bytes.data,bytes.size))r=PF_CHANGED;
  PFStamp final;
  if(r==PF_OK)r=private_file(t->fd,name,fd,&final);
  if(r==PF_OK&&memcmp(&after,&final,sizeof(after)))r=PF_CHANGED;
  if(verify){
    pf_packet_wipe(verify,bytes.size);
    free(verify);
  }
  close(fd);
  if(r==PF_OK)r=sync_fd(t->fd,0);
  if(r==PF_OK)r=txn_current(t);
  return r;
}
PFResult pf_store_sync(PFStoreTxn *t){
  PFResult r=txn_current(t);
  if(r==PF_OK)r=sync_fd(t->fd,0);
  if(r==PF_OK)r=sync_fd(t->root->fd,0);
  if(r==PF_OK)r=txn_current(t);
  return r;
}
static void root_release(PFStoreRoot *s){
  if(!s)return;
  if(--s->refs)return;
  if(s->fd>=0)close(s->fd);
  pf_root_close(s->parent);
  pf_packet_wipe(s,sizeof(*s));
  free(s);
}
void pf_store_txn_close(PFStoreTxn *t){
  if(!t)return;
  PFStoreRoot *s=t->root;
  if(t->fd>=0)close(t->fd);
  pf_packet_wipe(t,sizeof(*t));
  free(t);
  s->live--;
  root_release(s);
}
void pf_store_close(PFStoreRoot *s){
  if(!s||s->closed)return;
  s->closed=1;
  root_release(s);
}
#else
struct PFStoreRoot {
  int unavailable;
}
;
struct PFStoreTxn {
  int unavailable;
}
;
PFResult pf_store_open_fixed(PFRoot *r,PFStoreRoot **o){
  (void)r;
  if(o)*o=NULL;
  return PF_UNSUPPORTED;
}
PFResult pf_store_list(PFStoreRoot *r,PFUuid *i,uint32_t c,uint32_t *n){
  (void)r;
  (void)i;
  (void)c;
  if(n)*n=0;
  return PF_UNSUPPORTED;
}
PFResult pf_store_inventory(PFStoreRoot *r,PFStoreTxn *t,PFStoreInventory *out){(void)r;(void)t;if(out)memset(out,0,sizeof(*out));return PF_UNSUPPORTED;}
PFResult pf_store_create_txn(PFStoreRoot *r,PFUuid i,PFStoreTxn **o){
  (void)r;
  (void)i;
  if(o)*o=NULL;
  return PF_UNSUPPORTED;
}
PFResult pf_store_open_txn(PFStoreRoot *r,PFUuid i,PFStoreTxn **o){
  (void)r;
  (void)i;
  if(o)*o=NULL;
  return PF_UNSUPPORTED;
}
PFResult pf_store_read(PFStoreTxn *t,PFStoreRole r,uint32_t i,uint32_t s,unsigned char *o,uint32_t c,uint32_t *n){
  (void)t;
  (void)r;
  (void)i;
  (void)s;
  (void)o;
  (void)c;
  if(n)*n=0;
  return PF_UNSUPPORTED;
}
PFResult pf_store_write_exclusive(PFStoreTxn *t,PFStoreRole r,uint32_t i,uint32_t s,PFByteView b){
  (void)t;
  (void)r;
  (void)i;
  (void)s;
  (void)b;
  return PF_UNSUPPORTED;
}
PFResult pf_store_sync(PFStoreTxn *t){
  (void)t;
  return PF_UNSUPPORTED;
}
void pf_store_txn_close(PFStoreTxn *t){
  (void)t;
}
void pf_store_close(PFStoreRoot *r){
  (void)r;
}
#endif
