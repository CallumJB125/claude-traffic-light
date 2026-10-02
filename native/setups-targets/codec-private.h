#ifndef PF_SETUPS_CODEC_PRIVATE_H
#define PF_SETUPS_CODEC_PRIVATE_H
#include "snapshot.h"
#include <string.h>
typedef struct { unsigned char *out; const unsigned char *in; uint32_t size, at; int failed; } PFCodec;
static inline void pf_codec_bytes(PFCodec *c, void *value, uint32_t n) {
 if(c->failed || c->at>c->size || n>c->size-c->at){c->failed=1;return;}
 if(c->out)memcpy(c->out+c->at,value,n);else memcpy(value,c->in+c->at,n);c->at+=n;
}
static inline void pf_codec_u32(PFCodec *c,uint32_t *value){unsigned char b[4];if(c->out){for(unsigned i=0;i<4;i++)b[i]=(unsigned char)(*value>>(24u-i*8u));}pf_codec_bytes(c,b,4);if(!c->out&&!c->failed){*value=0;for(unsigned i=0;i<4;i++)*value=(*value<<8)|b[i];}}
static inline void pf_codec_u64(PFCodec *c,uint64_t *value){unsigned char b[8];if(c->out){for(unsigned i=0;i<8;i++)b[i]=(unsigned char)(*value>>(56u-i*8u));}pf_codec_bytes(c,b,8);if(!c->out&&!c->failed){*value=0;for(unsigned i=0;i<8;i++)*value=(*value<<8)|b[i];}}
static inline void pf_codec_i64(PFCodec *c,int64_t *value){uint64_t n=0;if(c->out)memcpy(&n,value,8);pf_codec_u64(c,&n);if(!c->out&&!c->failed)memcpy(value,&n,8);}
static inline void pf_codec_stamp(PFCodec *c,PFStamp *s){pf_codec_u64(c,&s->device);pf_codec_u64(c,&s->inode);pf_codec_u64(c,&s->size);pf_codec_u64(c,&s->uid);pf_codec_u64(c,&s->mode);pf_codec_u64(c,&s->links);pf_codec_i64(c,&s->mtime_seconds);pf_codec_i64(c,&s->mtime_nanoseconds);pf_codec_i64(c,&s->ctime_seconds);pf_codec_i64(c,&s->ctime_nanoseconds);if(s->uid>UINT32_MAX||s->mode>0177777u||s->mtime_nanoseconds<0||s->mtime_nanoseconds>999999999||s->ctime_nanoseconds<0||s->ctime_nanoseconds>999999999)c->failed=1;}
#endif
