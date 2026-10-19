#define _DARWIN_C_SOURCE
#include "bootstrap.h"
#include "store.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/stat.h>
#if defined(__APPLE__)
static unsigned checks;
#define CHECK(x) do { checks++; if(!(x)){fprintf(stderr,"synthetic check %u failed\n",checks);return 1;} } while(0)
static void u32(unsigned char *p,uint32_t n){for(unsigned i=0;i<4;i++)p[i]=(unsigned char)(n>>(24-i*8));}
int main(void){
 char pattern[]="/tmp/pf-binding-native-XXXXXX",canonical[4097];CHECK(mkdtemp(pattern)!=NULL);CHECK(realpath(pattern,canonical)!=NULL);CHECK(chmod(canonical,0700)==0);
 PFRoot *root=NULL;CHECK(pf_root_open(canonical,NULL,&root)==PF_OK);PFStoreRoot *store=NULL;CHECK(pf_store_open_fixed(root,&store)==PF_OK);
 PFUuid id={{0}};id.bytes[6]=0x40;id.bytes[8]=0x80;id.bytes[15]=1;PFStoreTxn *txn=NULL;CHECK(pf_store_create_txn(store,id,&txn)==PF_OK);
 PFStoreInventory inventory;memset(&inventory,0xff,sizeof(inventory));CHECK(pf_store_inventory(store,txn,&inventory)==PF_OK);CHECK(inventory.namespaces==1&&inventory.children==0&&inventory.total_bytes==0);
 unsigned char blob[48]={0};memcpy(blob,"PFSEAL02",8);u32(blob+8,2);memcpy(blob+24,id.bytes,16);u32(blob+40,4);memcpy(blob+44,"TEST",4);
 CHECK(pf_store_write_exclusive(txn,PF_STORE_MANIFEST,0,0,(PFByteView){blob,sizeof(blob)})==PF_OK);CHECK(pf_store_sync(txn)==PF_OK);CHECK(pf_store_inventory(store,txn,&inventory)==PF_OK);CHECK(inventory.children==1&&inventory.transaction_bytes==48&&inventory.total_bytes==48&&inventory.entries[0].role==0&&inventory.entries[0].bytes==48);
 CHECK(pf_store_write_exclusive(txn,PF_STORE_MANIFEST,0,0,(PFByteView){blob,sizeof(blob)})!=PF_OK);
 char file[8192];int n=snprintf(file,sizeof(file),"%s/setups-transactions/00000000-0000-4000-8000-000000000001/manifest.sealed",canonical);CHECK(n>0&&(unsigned)n<sizeof(file));CHECK(chmod(file,0644)==0);memset(&inventory,0xff,sizeof(inventory));CHECK(pf_store_inventory(store,txn,&inventory)!=PF_OK);unsigned char *bytes=(unsigned char*)&inventory;for(size_t i=0;i<sizeof(inventory);i++)CHECK(bytes[i]==0);CHECK(chmod(file,0600)==0);
 n=snprintf(file,sizeof(file),"%s/setups-transactions/00000000-0000-4000-8000-000000000001/foreign",canonical);CHECK(n>0&&(unsigned)n<sizeof(file));int fd=open(file,O_CREAT|O_EXCL|O_WRONLY,0600);CHECK(fd>=0);CHECK(close(fd)==0);memset(&inventory,0xff,sizeof(inventory));CHECK(pf_store_inventory(store,txn,&inventory)!=PF_OK);bytes=(unsigned char*)&inventory;for(size_t i=0;i<sizeof(inventory);i++)CHECK(bytes[i]==0);
 PFHelperBootstrap bootstrap;unsigned char invalid[4]={0};CHECK(pf_helper_bootstrap_decode((PFByteView){invalid,sizeof(invalid)},pf_packet_now(),&bootstrap)!=PF_OK);bytes=(unsigned char*)&bootstrap;for(size_t i=0;i<sizeof(bootstrap);i++)CHECK(bytes[i]==0);
 pf_store_txn_close(txn);pf_store_close(store);pf_root_close(root);printf("native inventory guards passed; synthetic root retained at %s\n",canonical);return 0;
}
#else
int main(void){return PF_UNSUPPORTED;}
#endif
