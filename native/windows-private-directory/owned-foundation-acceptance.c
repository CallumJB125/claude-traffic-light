#define WIN32_LEAN_AND_MEAN
#include "owned-foundation-private.h"
#include <aclapi.h>
#include <bcrypt.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>
#include <stddef.h>
#include <winternl.h>

NTSYSAPI NTSTATUS NTAPI NtSetInformationFile(HANDLE,PIO_STATUS_BLOCK,PVOID,ULONG,FILE_INFORMATION_CLASS);
static BOOL WINAPI fx_flush(HANDLE);
static NTSTATUS NTAPI fx_rename(HANDLE,PIO_STATUS_BLOCK,PVOID,ULONG,FILE_INFORMATION_CLASS);
static HANDLE WINAPI fx_pipe(LPCWSTR,DWORD,DWORD,DWORD,DWORD,DWORD,DWORD,LPSECURITY_ATTRIBUTES);
static DWORD WINAPI fx_security(HANDLE,SE_OBJECT_TYPE,SECURITY_INFORMATION,PSID *,PSID *,PACL *,PACL *,PSECURITY_DESCRIPTOR *);

/* Production is also compiled separately by CI. Only this driver interposes
 * WriteFile; normal calls still reach the real kernel. */
static BOOL WINAPI fx_write(HANDLE,LPCVOID,DWORD,LPDWORD,LPOVERLAPPED);
#define WriteFile fx_write
#define FlushFileBuffers fx_flush
#define NtSetInformationFile fx_rename
#define CreateNamedPipeW fx_pipe
#define GetSecurityInfo fx_security
/* SDK declarations were loaded above. Only the production module's repeated
 * NT declaration must bind our local interposer in this driver translation. */
#pragma push_macro("NTSYSAPI")
#undef NTSYSAPI
#define NTSYSAPI
#include "owned-foundation.c"
#pragma pop_macro("NTSYSAPI")
#undef WriteFile
#undef FlushFileBuffers
#undef NtSetInformationFile
#undef CreateNamedPipeW
#undef GetSecurityInfo
static BOOL diagnosticActive=FALSE;
static DWORD diagnosticPhase=0,diagnosticError=0,flushCalls=0,renameCalls=0,pipeCalls=0;
static NTSTATUS renameStatus=0;
static void diagnostic_failure(DWORD phase,DWORD error) {
    if(diagnosticActive && !diagnosticPhase) { diagnosticPhase=phase; diagnosticError=error; }
}
static BOOL WINAPI fx_flush(HANDLE file) {
    BOOL ok=FlushFileBuffers(file);
    if(diagnosticActive) flushCalls++;
    if(!ok) diagnostic_failure(10,GetLastError());
    return ok;
}
static NTSTATUS NTAPI fx_rename(HANDLE file,PIO_STATUS_BLOCK io,PVOID info,ULONG size,FILE_INFORMATION_CLASS kind) {
    NTSTATUS status=NtSetInformationFile(file,io,info,size,kind);
    if(diagnosticActive) { renameCalls++; renameStatus=status; }
    if(status<0) diagnostic_failure(20,(DWORD)status);
    return status;
}
static HANDLE WINAPI fx_pipe(LPCWSTR name,DWORD openMode,DWORD mode,DWORD instances,DWORD output,DWORD input,DWORD timeout,LPSECURITY_ATTRIBUTES security) {
    HANDLE pipe=CreateNamedPipeW(name,openMode,mode,instances,output,input,timeout,security);
    if(diagnosticActive) pipeCalls++;
    if(pipe==INVALID_HANDLE_VALUE) diagnostic_failure(30,GetLastError());
    return pipe;
}
static DWORD WINAPI fx_security(HANDLE handle,SE_OBJECT_TYPE type,SECURITY_INFORMATION info,PSID *owner,PSID *group,PACL *acl,PACL *sacl,PSECURITY_DESCRIPTOR *security) {
    DWORD result=GetSecurityInfo(handle,type,info,owner,group,acl,sacl,security);
    if(result!=ERROR_SUCCESS) diagnostic_failure(40,result);
    return result;
}
static void diagnostic_reset(void) {
    diagnosticPhase=0; diagnosticError=0; flushCalls=0; renameCalls=0; pipeCalls=0; renameStatus=0; diagnosticActive=TRUE;
}
static void diagnostic_report(DWORD operation,DWORD result,DWORD effect,DWORD savedError) {
    diagnosticActive=FALSE;
    printf("# foundation operation=%lu result=%lu effect=%lu phase=%lu status=%lu ntstatus=%08lx flushes=%lu renames=%lu pipes=%lu\n",
        (unsigned long)operation,(unsigned long)result,(unsigned long)effect,(unsigned long)diagnosticPhase,
        (unsigned long)diagnosticError,(unsigned long)renameStatus,(unsigned long)flushCalls,(unsigned long)renameCalls,(unsigned long)pipeCalls);
    SetLastError(savedError);
}
static PFOPublication fx_publish(PFOAuthority *a,PFFileRole role,const BYTE *bytes,DWORD length) {
    PFOPublication receipt; DWORD error;
    diagnostic_reset(); receipt=pfo_publish(a,role,bytes,length); error=GetLastError();
    diagnostic_report(1,(DWORD)receipt.result,(DWORD)receipt.effect,error); return receipt;
}
static PFOResult fx_control_begin(PFOAuthority *a,HANDLE process,PFOControl **out) {
    PFOResult result; DWORD error;
    diagnostic_reset(); result=pfo_control_begin(a,process,out); error=GetLastError();
    diagnostic_report(2,(DWORD)result,0,error); return result;
}
#define pfo_publish fx_publish
#define pfo_control_begin fx_control_begin
static DWORD faultMode=0;
static BOOL faultObserved=FALSE;
static HANDLE faultRoot=INVALID_HANDLE_VALUE;
static PACL faultPublic=NULL;
static BYTE *faultInput=NULL;
static DWORD faultInputLength=0;
static BOOL WINAPI fx_write(HANDLE file,LPCVOID bytes,DWORD length,LPDWORD written,LPOVERLAPPED overlap) {
    DWORD mode=faultMode; BOOL ok;
    faultMode=0;
    if(mode==1) { *written=0; faultObserved=TRUE; return TRUE; }
    if(mode==2) { *written=0; faultObserved=TRUE; SetLastError(ERROR_WRITE_FAULT); return FALSE; }
    ok=WriteFile(file,bytes,length,written,overlap);
    if(ok && mode==3) faultObserved=SetSecurityInfo(faultRoot,SE_FILE_OBJECT,DACL_SECURITY_INFORMATION|PROTECTED_DACL_SECURITY_INFORMATION,NULL,NULL,faultPublic,NULL)==ERROR_SUCCESS;
    if(ok && mode==4) { memset(faultInput,88,faultInputLength); faultObserved=TRUE; }
    return ok;
}
static unsigned tests=0,failed=0;
static void check(BOOL ok,const char *label) {
    tests++; printf("%s %u - %s\n",ok?"ok":"not ok",tests,label); if(!ok) failed++;
}
static BOOL private_owner(const WCHAR *path) {
    HANDLE token=NULL; TOKEN_USER *user=NULL; DWORD size=0,i; BOOL ok=FALSE,haveUser=FALSE,haveSystem=FALSE,haveAdmins=FALSE;
    PSECURITY_DESCRIPTOR sd=NULL; PSID owner=NULL; PACL acl=NULL;
    SECURITY_DESCRIPTOR_CONTROL control; DWORD revision;
    if(!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token) ||
        GetTokenInformation(token,TokenUser,NULL,0,&size) || GetLastError()!=ERROR_INSUFFICIENT_BUFFER || size>65536) goto done;
    user=(TOKEN_USER *)HeapAlloc(GetProcessHeap(),HEAP_ZERO_MEMORY,size);
    if(!user || !GetTokenInformation(token,TokenUser,user,size,&size) ||
        GetNamedSecurityInfoW((WCHAR *)path,SE_FILE_OBJECT,OWNER_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION,
            &owner,NULL,&acl,NULL,&sd)!=ERROR_SUCCESS || !owner || !EqualSid(owner,user->User.Sid) || !acl ||
        acl->AceCount!=3 || !GetSecurityDescriptorControl(sd,&control,&revision) || !(control&SE_DACL_PROTECTED)) goto done;
    for(i=0;i<acl->AceCount;i++) {
        ACCESS_ALLOWED_ACE *ace=NULL;
        if(!GetAce(acl,i,(LPVOID *)&ace) || !ace || ace->Header.AceType!=ACCESS_ALLOWED_ACE_TYPE || ace->Header.AceFlags || ace->Mask!=FILE_ALL_ACCESS) goto done;
        if(EqualSid(&ace->SidStart,user->User.Sid)) { if(haveUser) goto done; haveUser=TRUE; }
        else if(IsWellKnownSid(&ace->SidStart,WinLocalSystemSid)) { if(haveSystem) goto done; haveSystem=TRUE; }
        else if(IsWellKnownSid(&ace->SidStart,WinBuiltinAdministratorsSid)) { if(haveAdmins) goto done; haveAdmins=TRUE; }
        else goto done;
    }
    ok=haveUser && haveSystem && haveAdmins;
done:
    if(user) HeapFree(GetProcessHeap(),0,user); if(token) CloseHandle(token); if(sd) LocalFree(sd); return ok;
}
static BOOL fresh_root(WCHAR *path,DWORD capacity) {
    WCHAR temp[MAX_PATH]; BYTE nonce[16]; DWORD i; WCHAR name[33];
    HANDLE token=NULL; TOKEN_USER *user=NULL; DWORD size=0,sidSize=SECURITY_MAX_SID_SIZE;
    BYTE system[SECURITY_MAX_SID_SIZE],admins[SECURITY_MAX_SID_SIZE]; PACL acl=NULL;
    SECURITY_DESCRIPTOR sd; SECURITY_ATTRIBUTES sa; BOOL ok=FALSE;
    static const WCHAR hex[]=L"0123456789abcdef";
    if(!GetTempPathW(MAX_PATH,temp) || BCryptGenRandom(NULL,nonce,sizeof(nonce),BCRYPT_USE_SYSTEM_PREFERRED_RNG)<0 ||
        !OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token) ||
        GetTokenInformation(token,TokenUser,NULL,0,&size) || GetLastError()!=ERROR_INSUFFICIENT_BUFFER || size>65536) goto done;
    user=(TOKEN_USER *)HeapAlloc(GetProcessHeap(),HEAP_ZERO_MEMORY,size);
    if(!user || !GetTokenInformation(token,TokenUser,user,size,&size) || !CreateWellKnownSid(WinLocalSystemSid,NULL,system,&sidSize)) goto done;
    sidSize=SECURITY_MAX_SID_SIZE; if(!CreateWellKnownSid(WinBuiltinAdministratorsSid,NULL,admins,&sidSize)) goto done;
    size=(DWORD)(sizeof(ACL)+3*offsetof(ACCESS_ALLOWED_ACE,SidStart))+GetLengthSid(user->User.Sid)+GetLengthSid(system)+GetLengthSid(admins);
    acl=(PACL)HeapAlloc(GetProcessHeap(),HEAP_ZERO_MEMORY,size);
    if(!acl || !InitializeAcl(acl,size,ACL_REVISION) || !AddAccessAllowedAceEx(acl,ACL_REVISION,0,FILE_ALL_ACCESS,user->User.Sid) ||
        !AddAccessAllowedAceEx(acl,ACL_REVISION,0,FILE_ALL_ACCESS,system) || !AddAccessAllowedAceEx(acl,ACL_REVISION,0,FILE_ALL_ACCESS,admins) ||
        !InitializeSecurityDescriptor(&sd,SECURITY_DESCRIPTOR_REVISION) || !SetSecurityDescriptorOwner(&sd,user->User.Sid,FALSE) ||
        !SetSecurityDescriptorDacl(&sd,TRUE,acl,FALSE) || !SetSecurityDescriptorControl(&sd,SE_DACL_PROTECTED,SE_DACL_PROTECTED)) goto done;
    for(i=0;i<16;i++) { name[2*i]=hex[nonce[i]>>4]; name[2*i+1]=hex[nonce[i]&15]; } name[32]=0;
    if(swprintf_s(path,capacity,L"%spfo-foundation-%s",temp,name)<0) goto done;
    ZeroMemory(&sa,sizeof(sa)); sa.nLength=sizeof(sa); sa.lpSecurityDescriptor=&sd;
    ok=CreateDirectoryW(path,&sa) && private_owner(path);
done:
    if(user) HeapFree(GetProcessHeap(),0,user); if(token) CloseHandle(token); if(acl) HeapFree(GetProcessHeap(),0,acl); SecureZeroMemory(nonce,sizeof(nonce)); return ok;
}
static BOOL close_control(PFOControl *control) {
    DWORD i; PFOResult result;
    for(i=0;i<1000;i++) { result=pfo_control_close(control); if(result!=PFO_PENDING) return result==PFO_OK; Sleep(1); }
    return FALSE;
}
static PFOResult connect_result(PFOControl *control) {
    DWORD i; PFOResult result;
    for(i=0;i<1000;i++) { result=pfo_control_poll(control); if(result!=PFO_PENDING) return result; Sleep(1); }
    return PFO_PENDING;
}
static BOOL clean_root(const WCHAR *path,const PFDirectoryIdentity *identity) {
    PFDirectory probe; WIN32_FIND_DATAW data; WCHAR pattern[MAX_PATH],child[MAX_PATH]; HANDLE search;
    BOOL ok=TRUE;
    if(pf_directory_open_root(path,identity,&probe)!=PF_OK || pf_directory_inspect(&probe,identity,NULL)!=PF_OK) return FALSE;
    if(swprintf_s(pattern,MAX_PATH,L"%s\\*",path)<0) { pf_directory_close(&probe); return FALSE; }
    search=FindFirstFileW(pattern,&data);
    if(search!=INVALID_HANDLE_VALUE) {
        do {
            if(!wcscmp(data.cFileName,L".") || !wcscmp(data.cFileName,L"..")) continue;
            if(data.dwFileAttributes&(FILE_ATTRIBUTE_DIRECTORY|FILE_ATTRIBUTE_REPARSE_POINT) ||
                swprintf_s(child,MAX_PATH,L"%s\\%s",path,data.cFileName)<0 || !private_owner(child) || !DeleteFileW(child)) { ok=FALSE; break; }
        } while(FindNextFileW(search,&data));
        if(ok && GetLastError()!=ERROR_NO_MORE_FILES) ok=FALSE;
        FindClose(search);
    } else if(GetLastError()!=ERROR_FILE_NOT_FOUND) ok=FALSE;
    pf_directory_close(&probe); return ok && RemoveDirectoryW(path);
}
static void publication_faults(void) {
    DWORD mode;
    for(mode=1;mode<=4;mode++) {
        WCHAR rootPath[MAX_PATH],fixedPath[MAX_PATH]; PFDirectory root; PFDirectoryIdentity identity={0};
        PFOAuthority *authority=NULL; PFOPublication receipt; BYTE input[333],output[PF_GRANT_BYTES],everyone[SECURITY_MAX_SID_SIZE];
        DWORD size=SECURITY_MAX_SID_SIZE,length=0; PFFileStamp stamp; PSECURITY_DESCRIPTOR original=NULL; PACL originalAcl=NULL;
        BOOL captured=FALSE; DWORD setupFailures=failed;
        memset(input,37,sizeof(input)); ZeroMemory(&root,sizeof(root)); faultObserved=FALSE;
        check(fresh_root(rootPath,MAX_PATH),"fault fixture root is fresh explicit owner and private");
        if(failed!=setupFailures) continue;
        captured=pf_directory_open_root(rootPath,NULL,&root)==PF_OK && pf_directory_inspect(&root,NULL,&identity)==PF_OK;
        check(captured,"fault fixture captures accepted private native identity"); if(!captured) goto finish;
        check(pfo_private_open(&root,&identity,GetTickCount64()+5000,&authority)==PFO_OK && authority,"fault fixture owns fixed-deadline authority"); if(!authority) goto finish;
        if(mode==3) {
            faultRoot=CreateFileW(rootPath,READ_CONTROL|WRITE_DAC,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,NULL,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,NULL);
            check(faultRoot!=INVALID_HANDLE_VALUE && GetSecurityInfo(faultRoot,SE_FILE_OBJECT,DACL_SECURITY_INFORMATION,NULL,NULL,&originalAcl,NULL,&original)==ERROR_SUCCESS,"late ACL fixture retains its own original control handle and descriptor");
            if(!original || !CreateWellKnownSid(WinWorldSid,NULL,everyone,&size)) goto finish;
            size=(DWORD)(sizeof(ACL)+offsetof(ACCESS_ALLOWED_ACE,SidStart))+GetLengthSid(everyone);
            faultPublic=(PACL)HeapAlloc(GetProcessHeap(),HEAP_ZERO_MEMORY,size);
            check(faultPublic && InitializeAcl(faultPublic,size,ACL_REVISION) && AddAccessAllowedAceEx(faultPublic,ACL_REVISION,0,FILE_ALL_ACCESS,everyone),"late ACL fixture builds actual public grant only for its fresh root");
            if(!faultPublic) goto finish;
        }
        faultInput=input; faultInputLength=sizeof(input); faultMode=mode;
        receipt=pfo_publish(authority,PF_FILE_GRANT,input,sizeof(input)); faultMode=0;
        if(mode==4) {
            check(faultObserved && input[0]==88 && receipt.result==PFO_OK && receipt.effect==PFO_PUBLISHED,"caller mutation after actual write cannot change captured publication");
            check(pf_file_read(&root,L"connector.grant",PF_FILE_GRANT,NULL,output,PF_GRANT_BYTES,&length,&stamp)==PF_FILE_OK && length==sizeof(input) && output[0]==37 && output[length-1]==37,"accepted kernel reader confirms immutable captured input bytes");
        } else {
            check(faultObserved && receipt.result!=PFO_OK && receipt.effect==PFO_STAGED,mode==1?"injected zero progress refuses with private staging receipt":mode==2?"injected write error refuses with private staging receipt":"actual late parent public ACL refuses before fixed publication");
            check(swprintf_s(fixedPath,MAX_PATH,L"%s\\connector.grant",rootPath)>0 && GetFileAttributesW(fixedPath)==INVALID_FILE_ATTRIBUTES && GetLastError()==ERROR_FILE_NOT_FOUND,"refused staging never exposes the fixed grant endpoint");
        }
        if(mode==3) {
            check(pf_directory_inspect(&root,&identity,NULL)==PF_NOT_PRIVATE,"independent SDK observes actual parent ACL privacy loss");
            check(SetSecurityInfo(faultRoot,SE_FILE_OBJECT,DACL_SECURITY_INFORMATION|PROTECTED_DACL_SECURITY_INFORMATION,NULL,NULL,originalAcl,NULL)==ERROR_SUCCESS &&
                pf_directory_inspect(&root,&identity,NULL)==PF_OK,"only preowned fresh fixture ACL is restored after unchanged refusal assertions");
        }
finish:
        faultMode=0; faultInput=NULL; faultInputLength=0;
        if(authority) check(pfo_close(authority)==PFO_OK,"fault authority retires without an active control");
        if(faultRoot!=INVALID_HANDLE_VALUE) { CloseHandle(faultRoot); faultRoot=INVALID_HANDLE_VALUE; }
        if(original) LocalFree(original);
        if(faultPublic) { HeapFree(GetProcessHeap(),0,faultPublic); faultPublic=NULL; }
        pf_directory_close(&root);
        if(captured) check(clean_root(rootPath,&identity),"fresh fault fixture cleanup verifies original root identity and private objects");
        SecureZeroMemory(input,sizeof(input)); SecureZeroMemory(output,sizeof(output));
    }
}
int wmain(int argc,WCHAR **argv) {
    WCHAR rootPath[MAX_PATH],filePath[MAX_PATH],pipeName[PFO_PIPE_NAME],self[MAX_PATH],command[MAX_PATH+32];
    WCHAR emptyEnvironment[2]={0,0}; PFDirectory root; PFDirectoryIdentity identity={0},wrong={0};
    PFOAuthority *a=NULL; PFOControl *control=NULL; PFOPublication receipt;
    BYTE grant[PF_GRANT_BYTES],readback[PF_GRANT_BYTES]; DWORD readLength=0; PFFileStamp stamp;
    HANDLE client=INVALID_HANDLE_VALUE,duplicate=INVALID_HANDLE_VALUE; STARTUPINFOW startup; PROCESS_INFORMATION child;
    DWORD used=0; BYTE marker=42; BOOL childStarted=FALSE,rootCaptured=FALSE; PFOResult result;
    if(argc==2 && !wcscmp(argv[1],L"--fixture-wait")) { Sleep(3000); return 0; }
    if(argc!=1) return 2;
    puts("TAP version 13"); ZeroMemory(&root,sizeof(root)); ZeroMemory(&child,sizeof(child));
    memset(grant,37,sizeof(grant));
    check(fresh_root(rootPath,MAX_PATH),"fresh fixture root has explicit current owner and protected private ACL");
    if(failed) goto done;
    rootCaptured=pf_directory_open_root(rootPath,NULL,&root)==PF_OK && pf_directory_inspect(&root,NULL,&identity)==PF_OK;
    check(rootCaptured,"accepted SDK captures actual fresh root");
    if(failed) goto done;
    wrong=identity; wrong.file[0]^=1;
    check(pfo_private_open(&root,&wrong,GetTickCount64()+5000,&a)==PFO_UNAVAILABLE && !a,"stale native root identity refuses authority");
    check(pfo_private_open(&root,&identity,GetTickCount64(),&a)==PFO_UNAVAILABLE && !a,"expired authority refuses before work");
    check(pfo_private_open(&root,&identity,GetTickCount64()+60000,&a)==PFO_UNAVAILABLE && !a,"authority cannot extend maximum absolute budget");
    check(pfo_private_open(&root,&identity,GetTickCount64()+5000,&a)==PFO_OK && a,"native opaque authority retains accepted root lease");
    if(!a) goto done;
    receipt=pfo_publish(a,(PFFileRole)3,grant,1); check(receipt.result==PFO_INVALID && receipt.effect==PFO_NONE,"unknown publication role has no effect");
    receipt=pfo_publish(a,PF_FILE_TASKS_TOKEN,grant,PF_TOKEN_BYTES+1); check(receipt.result==PFO_INVALID && receipt.effect==PFO_NONE,"token cap refuses before staging");
    receipt=pfo_publish(a,PF_FILE_GRANT,grant,PF_GRANT_BYTES); check(receipt.result==PFO_OK && receipt.effect==PFO_PUBLISHED,"exclusive inclusive-cap grant is actually published");
    check(pf_file_read(&root,L"connector.grant",PF_FILE_GRANT,NULL,readback,PF_GRANT_BYTES,&readLength,&stamp)==PF_FILE_OK &&
        readLength==PF_GRANT_BYTES && !memcmp(readback,grant,readLength),"accepted reader confirms exact published grant bytes");
    check(swprintf_s(filePath,MAX_PATH,L"%s\\connector.grant",rootPath)>0 && private_owner(filePath),"independent kernel query confirms published owner and protected exact ACL");
    receipt=pfo_publish(a,PF_FILE_GRANT,&marker,1); check(receipt.result==PFO_EXISTS && receipt.effect==PFO_STAGED,"existing grant is never overwritten or adopted");
    check(pf_file_read(&root,L"connector.grant",PF_FILE_GRANT,&stamp,readback,PF_GRANT_BYTES,&readLength,&stamp)==PF_FILE_OK &&
        readLength==PF_GRANT_BYTES && !memcmp(readback,grant,readLength),"collision preserves original exact grant stamp and bytes");
    receipt=pfo_publish(a,PF_FILE_TASKS_TOKEN,grant,0); check(receipt.result==PFO_OK && receipt.effect==PFO_PUBLISHED,"zero-length fixed role is valid and private");
    check(pfo_control_begin(a,GetCurrentProcess(),&control)==PFO_OK && control,"actual private control pipe begins with held process authority");
    if(!control) goto done;
    check(pfo_close(a)==PFO_PENDING,"pending control keeps root authority from being freed");
    check(pfo_control_name(control,pipeName,PFO_PIPE_NAME)==PFO_OK,"native caller receives generated closed pipe name");
    duplicate=CreateNamedPipeW(pipeName,PIPE_ACCESS_DUPLEX|FILE_FLAG_FIRST_PIPE_INSTANCE,PIPE_TYPE_BYTE|PIPE_REJECT_REMOTE_CLIENTS,1,4096,4096,0,NULL);
    check(duplicate==INVALID_HANDLE_VALUE,"first-instance pipe cannot be squatted or extended"); if(duplicate!=INVALID_HANDLE_VALUE) CloseHandle(duplicate);
    client=CreateFileW(pipeName,FILE_READ_DATA|FILE_WRITE_DATA,0,NULL,OPEN_EXISTING,SECURITY_SQOS_PRESENT|SECURITY_IDENTIFICATION,NULL);
    check(client!=INVALID_HANDLE_VALUE,"actual same-owned-process client connects using explicit minimal data rights");
    check(connect_result(control)==PFO_OK,"kernel peer PID start owner logon session and exact pipe security agree");
    check(client!=INVALID_HANDLE_VALUE && WriteFile(client,&marker,1,&used,NULL) && used==1,"actual client transfers synthetic byte on private pipe");
    if(client!=INVALID_HANDLE_VALUE) { CloseHandle(client); client=INVALID_HANDLE_VALUE; }
    check(close_control(control),"completed control closes only after observed operation completion"); control=NULL;
    check(pfo_control_begin(a,GetCurrentProcess(),&control)==PFO_OK && control,"fresh control can begin after complete prior close");
    if(control) { check(close_control(control),"unconnected pending control cancellation is observed before resources free"); control=NULL; }
    check(GetModuleFileNameW(NULL,self,MAX_PATH)>0 && swprintf_s(command,MAX_PATH+32,L"\"%s\" --fixture-wait",self)>0,"fixed owned fixture executable identity is available");
    ZeroMemory(&startup,sizeof(startup)); startup.cb=sizeof(startup);
    childStarted=CreateProcessW(self,command,NULL,NULL,FALSE,CREATE_NO_WINDOW|CREATE_UNICODE_ENVIRONMENT,emptyEnvironment,NULL,&startup,&child);
    check(childStarted,"fresh owned fixture process provides genuine different peer authority");
    if(childStarted) {
        check(pfo_control_begin(a,child.hProcess,&control)==PFO_OK && control,"control captures held owned child process identity");
        if(control) {
            check(pfo_control_name(control,pipeName,PFO_PIPE_NAME)==PFO_OK,"different-peer pipe name stays native-only");
            client=CreateFileW(pipeName,FILE_READ_DATA|FILE_WRITE_DATA,0,NULL,OPEN_EXISTING,SECURITY_SQOS_PRESENT|SECURITY_IDENTIFICATION,NULL);
            check(client!=INVALID_HANDLE_VALUE,"wrong actual process can reach user-private ACL boundary");
            result=connect_result(control); check(result==PFO_PEER,"actual wrong PID refuses despite same user and logon");
            if(client!=INVALID_HANDLE_VALUE) { CloseHandle(client); client=INVALID_HANDLE_VALUE; }
            check(close_control(control),"refused peer channel resources close completely"); control=NULL;
        }
    }
    check(pfo_close(a)==PFO_OK,"fully closed controls permit authority retirement"); a=NULL;
    check(pfo_private_open(&root,&identity,GetTickCount64()+100,&a)==PFO_OK && a,"short live cutoff can be captured");
    Sleep(125); receipt=pfo_publish(a,PF_FILE_TASKS_TOKEN,&marker,1);
    check(receipt.result==PFO_UNAVAILABLE && receipt.effect==PFO_NONE,"elapsed absolute cutoff cannot renew or stage more work");
done:
    if(client!=INVALID_HANDLE_VALUE) CloseHandle(client);
    if(control) check(close_control(control),"final owned control closes");
    if(a) check(pfo_close(a)==PFO_OK,"final authority closes");
    if(childStarted) { TerminateProcess(child.hProcess,0); check(WaitForSingleObject(child.hProcess,1000)==WAIT_OBJECT_0,"owned fixture child is reaped"); CloseHandle(child.hThread); CloseHandle(child.hProcess); }
    pf_directory_close(&root);
    if(rootCaptured) check(clean_root(rootPath,&identity),"only fresh identity-verified private fixture files and root are cleaned");
    publication_faults();
    printf("1..%u\n",tests); return failed?1:0;
}
