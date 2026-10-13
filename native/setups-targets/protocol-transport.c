#define _DARWIN_C_SOURCE
#include "protocol-private.h"
#include <stdlib.h>
#if defined(__APPLE__)
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <sys/stat.h>
#include <unistd.h>
static PFResult pipe_check(int fd,int write_side){
  struct stat s;
  int flags=fcntl(fd,F_GETFL);
  if(fd<0||flags<0||fstat(fd,&s)!=0)return PF_IO;
  int access=flags&O_ACCMODE;
  if(!S_ISFIFO(s.st_mode)||!(flags&O_NONBLOCK)||(write_side?access==O_RDONLY:access==O_WRONLY))return PF_UNSAFE;
  return PF_OK;
}
static PFResult wait_pipe(int fd,short events,uint64_t cutoff){
  for(;;){
    uint64_t now=pf_packet_now();
    if(!now||now>=cutoff)return PF_DEADLINE;
    uint64_t ms=(cutoff-now)/UINT64_C(1000000);
    if((cutoff-now)%UINT64_C(1000000))ms++;
    if(ms>INT_MAX)ms=INT_MAX;
    struct pollfd p={
      fd,events,0
    }
    ;
    int ready=poll(&p,1,(int)ms);
    if(ready<0){
      if(errno==EINTR)continue;
      return PF_IO;
    }
    if(!ready)continue;
    if(p.revents&POLLNVAL)return PF_IO;
    if(p.revents&(events|POLLHUP))return PF_OK;
    if(p.revents&POLLERR)return PF_IO;
  }
}
/* Header/body and blocked response share the same absolute session deadline.
 * Nonblocking flags must already be established by the private owning caller;
 * no path, inherited argv, arbitrary command or public bootstrap is accepted. */
static PFResult transfer(int fd,unsigned char *bytes,uint32_t size,uint64_t cutoff,int writing,int *clean_eof){
  uint32_t at=0;
  if(clean_eof)*clean_eof=0;
  while(at<size){
    if(pf_packet_now()>=cutoff)return PF_DEADLINE;
    ssize_t n=writing?write(fd,bytes+at,size-at):read(fd,bytes+at,size-at);
    if(n>0){
      at+=(uint32_t)n;
      continue;
    }
    if(!writing&&n==0){
      if(!at&&clean_eof)*clean_eof=1;
      return PF_IO;
    }
    if(n<0&&(errno==EAGAIN||errno==EWOULDBLOCK)){
      PFResult r=wait_pipe(fd,writing?POLLOUT:POLLIN,cutoff);
      if(r!=PF_OK)return r;
      continue;
    }
    if(n<0&&errno==EINTR)continue;
    return PF_IO;
  }
  return pf_packet_now()>=cutoff?PF_DEADLINE:PF_OK;
}
PFResult pf_private_protocol_serve(PFProtocol *p,int input,int output){
  if(!p||input==output)return PF_INVALID;
  PFResult r=pipe_check(input,0);
  if(r==PF_OK)r=pipe_check(output,1);
  if(r==PF_OK&&fcntl(output,F_SETNOSIGPIPE,1)!=0)r=PF_UNSUPPORTED;
  uint64_t cutoff=pf_private_protocol_cutoff(p);
  if(!cutoff)r=PF_INVALID;
  const uint32_t capacity=PF_FRAME_PAYLOAD+PF_FRAME_OVERHEAD;
  unsigned char *in=NULL,*out=NULL;
  if(r==PF_OK){
    in=calloc(capacity,1);
    out=calloc(capacity,1);
    if(!in||!out)r=PF_IO;
  }
  while(r==PF_OK){
    int eof=0;
    r=transfer(input,in,40,cutoff,0,&eof);
    if(r!=PF_OK){
      if(eof)r=PF_OK;
      break;
    }
    uint32_t n=0;
    for(unsigned i=36;i<40;i++)n=(n<<8)|in[i];
    if(n>PF_FRAME_PAYLOAD){
      r=PF_TOO_LARGE;
      break;
    }
    r=transfer(input,in+40,n+32,cutoff,0,NULL);
    if(r!=PF_OK)break;
    uint32_t written=0;
    r=pf_protocol_process(p,(PFByteView){
      in,n+PF_FRAME_OVERHEAD
    }
    ,out,capacity,&written);
    if(r!=PF_OK)break;
    r=transfer(output,out,written,cutoff,1,NULL);
    if(r==PF_OK&&!pf_private_protocol_cutoff(p))r=pf_packet_now()>=cutoff?PF_DEADLINE:PF_INVALID;
    pf_packet_wipe(in,capacity);
    pf_packet_wipe(out,capacity);
  }
  if(in){
    pf_packet_wipe(in,capacity);
    free(in);
  }
  if(out){
    pf_packet_wipe(out,capacity);
    free(out);
  }
  pf_private_protocol_stop(p);
  return r;
}
#else
PFResult pf_private_protocol_serve(PFProtocol *p,int i,int o){
  (void)p;
  (void)i;
  (void)o;
  return PF_UNSUPPORTED;
}
#endif
