#include "bootstrap.h"
#include <string.h>
#if defined(__APPLE__)
#include <CommonCrypto/CommonHMAC.h>
#endif
static int nonzero(const unsigned char *b,size_t n){unsigned x=0;for(size_t i=0;i<n;i++)x|=b[i];return x!=0;}
static int utf8(const unsigned char *b,uint32_t n){
 for(uint32_t i=0;i<n;){unsigned x=b[i++],need=0,min=0;
  if(!x)return 0;if(x<128)continue;
  if(x>=0xc2&&x<=0xdf){need=1;min=0x80;x&=0x1f;}
  else if(x>=0xe0&&x<=0xef){need=2;min=0x800;x&=0x0f;}
  else if(x>=0xf0&&x<=0xf4){need=3;min=0x10000;x&=7;}else return 0;
  if(need>n-i)return 0;while(need--){unsigned t=b[i++];if((t&0xc0)!=0x80)return 0;x=(x<<6)|(t&0x3f);}
  if(x<min||x>0x10ffff||(x>=0xd800&&x<=0xdfff))return 0;
 }return 1;
}
static void root(PFCodec *c,char out[4097],PFStamp *expected){uint32_t n=0;pf_codec_u32(c,&n);if(c->failed||!n||n>4096||n>c->size-c->at){c->failed=1;return;}if(c->in[c->at]!='/'||!utf8(c->in+c->at,n)){c->failed=1;return;}pf_codec_bytes(c,out,n);out[n]=0;pf_codec_stamp(c,expected);if(!expected->inode||(expected->mode&0170000u)!=0040000u)c->failed=1;}
PFResult pf_helper_bootstrap_decode(PFByteView in,uint64_t start,PFHelperBootstrap *out){
 if(!out)return PF_INVALID;memset(out,0,sizeof(*out));
 if(!in.data||in.size>PF_BOOTSTRAP_BYTES||!start)return PF_INVALID;
 PFCodec c={NULL,in.data,in.size,0,0};unsigned char magic[8];uint32_t version=0,budget=0;
 pf_codec_bytes(&c,magic,8);pf_codec_u32(&c,&version);pf_codec_u32(&c,&out->private_channel.authority.mode);pf_codec_u64(&c,&out->private_channel.authority.generation);pf_codec_u32(&c,&budget);
 pf_codec_bytes(&c,out->private_channel.key,32);pf_codec_bytes(&c,out->private_channel.authority.session_nonce,16);pf_codec_bytes(&c,out->private_channel.authority.authority_hash,32);
 root(&c,out->profile,&out->profile_expected);root(&c,out->app_parent,&out->app_expected);
 uint64_t now=pf_packet_now(),cutoff=start+(uint64_t)budget*UINT64_C(1000000);
 if(c.failed||c.at!=c.size||memcmp(magic,"PFBOOT03",8)||version!=3||!budget||budget>8000||cutoff<start||!now||now>=cutoff||!out->private_channel.authority.generation||(out->private_channel.authority.mode!=1&&out->private_channel.authority.mode!=2)||!nonzero(out->private_channel.key,32)||!nonzero(out->private_channel.authority.session_nonce,16)||!nonzero(out->private_channel.authority.authority_hash,32)){pf_packet_wipe(out,sizeof(*out));return PF_INVALID;}
 out->private_channel.authority.cutoff=cutoff;return PF_OK;
}
PFResult pf_helper_bootstrap_ack(const PFHelperBootstrap *b,unsigned char out[48]){
 if(!b||!out)return PF_INVALID;
#if defined(__APPLE__)
 memcpy(out,"PFACK003",8);for(unsigned i=0;i<8;i++)out[8+i]=(unsigned char)(b->private_channel.authority.cutoff>>(56u-i*8u));
 CCHmacContext c;static const char domain[]="PF-BOOT-ACK-V1";
 CCHmacInit(&c,kCCHmacAlgSHA256,b->private_channel.key,32);CCHmacUpdate(&c,domain,sizeof(domain));CCHmacUpdate(&c,b->private_channel.authority.session_nonce,16);CCHmacUpdate(&c,out,16);CCHmacFinal(&c,out+16);pf_packet_wipe(&c,sizeof(c));return PF_OK;
#else
 memset(out,0,48);return PF_UNSUPPORTED;
#endif
}
