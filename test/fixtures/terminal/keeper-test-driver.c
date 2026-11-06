#include <sys/socket.h>
#include <sys/un.h>
#include <sys/select.h>
#include <unistd.h>
#include <stdio.h>
#include <string.h>
#include <errno.h>
#include "keeper.h"
int main(int argc,char **argv) {
 if (argc!=2 || strncmp(argv[1],"/private/tmp/pf-keeper-test-",strlen("/private/tmp/pf-keeper-test-"))!=0) return 64;
 int fd=socket(AF_UNIX,SOCK_STREAM,0); struct sockaddr_un sa={.sun_family=AF_UNIX}; strlcpy(sa.sun_path,argv[1],sizeof(sa.sun_path));
 if(connect(fd,(struct sockaddr*)&sa,sizeof(sa))!=0) { perror("connect");return 1; }
 char ident[256];int build=0; int auth=pf_peer(fd,1,"",ident,256,&build); if(!auth||strcmp(ident,"dev.plexiform.keeper")) {fprintf(stderr,"peer failed auth=%d id=%s build=%d\n",auth,ident,build); return 77;}
 for(;;) { fd_set set;FD_ZERO(&set);FD_SET(0,&set);FD_SET(fd,&set); if(select(fd+1,&set,NULL,NULL,NULL)<0)return 1;
  char b[65536];int sources[]={0,fd},targets[]={fd,1};
  for(int i=0;i<2;i++)if(FD_ISSET(sources[i],&set)){ssize_t n=read(sources[i],b,sizeof(b));if(n<=0)return 0;ssize_t at=0;while(at<n){ssize_t k=write(targets[i],b+at,n-at);if(k<=0)return 1;at+=k;}}
 }
}
