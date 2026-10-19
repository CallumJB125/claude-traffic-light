#define _DARWIN_C_SOURCE
#include "bootstrap.h"
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#if defined(__APPLE__)
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <poll.h>
/* Fixed Node-owned endpoints only. FIFO library transport remains unchanged.
 * Launcher proves handle provenance; native does not claim FD alias detection. */
static PFResult channel(int fd,pid_t parent){
 struct stat s;struct sockaddr_un a,b;memset(&a,0,sizeof(a));memset(&b,0,sizeof(b));socklen_t an=sizeof(a),bn=sizeof(b),n=sizeof(int);int type=0;pid_t peer=0;uid_t uid=0;gid_t gid=0;
 if(parent<=1||getppid()!=parent||fstat(fd,&s)||!S_ISSOCK(s.st_mode)||getsockopt(fd,SOL_SOCKET,SO_TYPE,&type,&n)||n!=sizeof(int)||type!=SOCK_STREAM||getsockname(fd,(struct sockaddr*)&a,&an)||getpeername(fd,(struct sockaddr*)&b,&bn)||an>sizeof(a)||bn>sizeof(b)||an<2||bn<2||a.sun_family!=AF_UNIX||b.sun_family!=AF_UNIX)return PF_UNSAFE;
 for(unsigned i=0;i<sizeof(a.sun_path);i++)if(a.sun_path[i]||b.sun_path[i])return PF_UNSAFE;
 n=sizeof(peer);if(getsockopt(fd,SOL_LOCAL,LOCAL_PEERPID,&peer,&n)||n!=sizeof(peer)||peer!=parent||getpeereid(fd,&uid,&gid)||uid!=geteuid())return PF_UNSAFE;
 int flags=fcntl(fd,F_GETFL);if(flags<0||(flags&O_ACCMODE)!=O_RDWR)return PF_UNSAFE;
 if(fcntl(fd,F_SETFL,flags|O_NONBLOCK))return PF_UNSUPPORTED;flags=fcntl(fd,F_GETFL);if(flags<0||!(flags&O_NONBLOCK))return PF_UNSUPPORTED;
 int yes=1;n=sizeof(yes);if(setsockopt(fd,SOL_SOCKET,SO_NOSIGPIPE,&yes,sizeof(yes)))return PF_UNSUPPORTED;yes=0;if(getsockopt(fd,SOL_SOCKET,SO_NOSIGPIPE,&yes,&n)||n!=sizeof(yes)||yes!=1)return PF_UNSUPPORTED;
 return PF_OK;
}
static PFResult transfer(int fd,unsigned char *b,uint32_t size,int writing,uint64_t cutoff,pid_t parent){
 uint32_t at=0;while(at<size){if(getppid()!=parent)return PF_UNSAFE;uint64_t now=pf_packet_now();if(!now||now>=cutoff)return PF_DEADLINE;
  ssize_t n=writing?write(fd,b+at,size-at):read(fd,b+at,size-at);if(n>0){at+=(uint32_t)n;continue;}if(!n)return PF_IO;if(errno==EINTR)continue;if(errno!=EAGAIN&&errno!=EWOULDBLOCK)return PF_IO;
  struct pollfd p={fd,writing?POLLOUT:POLLIN,0};uint64_t ms=(cutoff-now)/UINT64_C(1000000);int wait=(int)(ms>50?50:ms?ms:1);int ready=poll(&p,1,wait);if(ready<0&&errno!=EINTR)return PF_IO;if(ready>0&&(p.revents&(POLLERR|POLLNVAL)))return PF_IO;
 }return getppid()==parent&&pf_packet_now()<cutoff?PF_OK:PF_DEADLINE;
}
static uint32_t u32(const unsigned char *b){return ((uint32_t)b[0]<<24)|((uint32_t)b[1]<<16)|((uint32_t)b[2]<<8)|b[3];}
int main(int argc,char **argv){
 (void)argv;if(argc!=1)return PF_INVALID;pid_t parent=getppid();uint64_t start=pf_packet_now(),cutoff=start+UINT64_C(8000000000);PFResult r=channel(0,parent);if(r==PF_OK)r=channel(1,parent);if(r==PF_OK)r=channel(3,parent);
 unsigned char prefix[4]={0},ack[48]={0};unsigned char *raw=NULL,*in=NULL,*out=NULL;uint32_t raw_size=0;PFHelperBootstrap bootstrap;memset(&bootstrap,0,sizeof(bootstrap));PFRoot *profile=NULL,*app=NULL;PFProtocol *protocol=NULL;
 if(r==PF_OK)r=transfer(3,prefix,4,0,cutoff,parent);uint32_t n=u32(prefix);if(r==PF_OK&&(!n||n>PF_BOOTSTRAP_BYTES))r=PF_TOO_LARGE;
 if(r==PF_OK){raw_size=n;raw=calloc(raw_size,1);if(!raw)r=PF_IO;}if(r==PF_OK)r=transfer(3,raw,n,0,cutoff,parent);if(r==PF_OK)r=pf_helper_bootstrap_decode((PFByteView){raw,n},start,&bootstrap);
 cutoff=bootstrap.private_channel.authority.cutoff;if(r==PF_OK&&getppid()!=parent)r=PF_UNSAFE;
 if(r==PF_OK)r=pf_root_open(bootstrap.profile,&bootstrap.profile_expected,&profile);if(r==PF_OK)r=pf_root_open(bootstrap.app_parent,&bootstrap.app_expected,&app);
 if(r==PF_OK&&getppid()!=parent)r=PF_UNSAFE;if(r==PF_OK)r=pf_private_protocol_open(profile,app,&bootstrap.private_channel,&protocol);
 if(r==PF_OK)r=pf_helper_bootstrap_ack(&bootstrap,ack);if(r==PF_OK)r=transfer(1,ack,48,1,cutoff,parent);
 const uint32_t cap=PF_FRAME_PAYLOAD+PF_FRAME_OVERHEAD;if(r==PF_OK){in=calloc(cap,1);out=calloc(cap,1);if(!in||!out)r=PF_IO;}
 while(r==PF_OK){r=transfer(0,in,40,0,cutoff,parent);if(r!=PF_OK)break;n=u32(in+36);if(n>PF_FRAME_PAYLOAD){r=PF_TOO_LARGE;break;}r=transfer(0,in+40,n+32,0,cutoff,parent);if(r!=PF_OK)break;if(getppid()!=parent){r=PF_UNSAFE;break;}
  uint32_t written=0;r=pf_protocol_process(protocol,(PFByteView){in,n+PF_FRAME_OVERHEAD},out,cap,&written);if(r!=PF_OK)break;r=transfer(1,out,written,1,cutoff,parent);pf_packet_wipe(in,cap);pf_packet_wipe(out,cap);if(!pf_private_protocol_cutoff(protocol))break;
 }
 if(raw){pf_packet_wipe(raw,raw_size);free(raw);}if(in){pf_packet_wipe(in,cap);free(in);}if(out){pf_packet_wipe(out,cap);free(out);}pf_packet_wipe(&bootstrap,sizeof(bootstrap));pf_packet_wipe(ack,sizeof(ack));pf_protocol_close(protocol);pf_root_close(profile);pf_root_close(app);return (int)r;
}
#else
int main(void){return PF_UNSUPPORTED;}
#endif
