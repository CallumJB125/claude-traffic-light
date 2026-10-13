/* Compose the accepted SDK bytes as one native translation unit. Its static
 * owner/ACL/component/identity policy remains exact, and is never exported as
 * a path endpoint. Do not additionally link directory.c into this unit. */
#include "directory.c"
#include "owned-foundation-private.h"
#include <bcrypt.h>
#include <stdlib.h>

NTSYSAPI NTSTATUS NTAPI NtSetInformationFile(HANDLE, PIO_STATUS_BLOCK, PVOID,
    ULONG, FILE_INFORMATION_CLASS);
typedef struct {
    BOOLEAN replace;
    HANDLE root;
    ULONG bytes;
    WCHAR name[1];
} PFONativeRename;

static BOOL pfo_current(PFOAuthority *a) {
    return a && GetTickCount64()<a->cutoff &&
        pf_directory_inspect(&a->root,&a->identity,NULL)==PF_OK && GetTickCount64()<a->cutoff;
}
static BOOL pfo_duplicate_root(const PFDirectory *from, PFDirectory *to) {
    DWORD i;
    ZeroMemory(to,sizeof(*to));
    if(!from || !from->count || from->count>PF_DIRECTORY_DEPTH) return FALSE;
    for(i=0;i<from->count;i++) {
        if(!DuplicateHandle(GetCurrentProcess(),from->handles[i],GetCurrentProcess(),
            &to->handles[i],0,FALSE,DUPLICATE_SAME_ACCESS)) { pf_directory_close(to); return FALSE; }
        to->count++;
    }
    return TRUE;
}
PFOResult pfo_private_open(const PFDirectory *root,const PFDirectoryIdentity *identity,
    ULONGLONG cutoff,PFOAuthority **out) {
    PFOAuthority *a; ULONGLONG now=GetTickCount64();
    if(out) *out=NULL;
    if(!out || !identity || cutoff<=now || cutoff-now>5000 ||
        pf_directory_inspect(root,identity,NULL)!=PF_OK) return PFO_UNAVAILABLE;
    a=(PFOAuthority *)calloc(1,sizeof(*a));
    if(!a) return PFO_IO;
    a->identity=*identity; a->cutoff=cutoff;
    if(!pfo_duplicate_root(root,&a->root) || !pfo_current(a)) {
        pf_directory_close(&a->root); free(a); return PFO_UNAVAILABLE;
    }
    *out=a; return PFO_OK;
}
PFOResult pfo_close(PFOAuthority *a) {
    if(!a) return PFO_INVALID;
    if(a->controls) return PFO_PENDING;
    pf_directory_close(&a->root); SecureZeroMemory(a,sizeof(*a)); free(a); return PFO_OK;
}
/* Owner is TokenUser, never TokenOwner/default creator owner. Fixed private
 * principals and a protected DACL are set at exclusive creation only. */
static BOOL pfo_security(PFToken *token,SECURITY_DESCRIPTOR *sd,PACL *out) {
    DWORD size;
    *out=NULL;
    if(!token_open(token)) return FALSE;
    size=(DWORD)(sizeof(ACL)+3*offsetof(ACCESS_ALLOWED_ACE,SidStart))+
        GetLengthSid(token->user->User.Sid)+GetLengthSid(token->system)+GetLengthSid(token->administrators);
    *out=(PACL)HeapAlloc(GetProcessHeap(),HEAP_ZERO_MEMORY,size);
    return *out && InitializeAcl(*out,size,ACL_REVISION) &&
        AddAccessAllowedAceEx(*out,ACL_REVISION,0,FILE_ALL_ACCESS,token->user->User.Sid) &&
        AddAccessAllowedAceEx(*out,ACL_REVISION,0,FILE_ALL_ACCESS,token->system) &&
        AddAccessAllowedAceEx(*out,ACL_REVISION,0,FILE_ALL_ACCESS,token->administrators) &&
        InitializeSecurityDescriptor(sd,SECURITY_DESCRIPTOR_REVISION) &&
        SetSecurityDescriptorOwner(sd,token->user->User.Sid,FALSE) &&
        SetSecurityDescriptorDacl(sd,TRUE,*out,FALSE) &&
        SetSecurityDescriptorControl(sd,SE_DACL_PROTECTED,SE_DACL_PROTECTED);
}
static BOOL pfo_nonce(WCHAR *out,DWORD capacity,const WCHAR *prefix,const WCHAR *suffix) {
    BYTE random[16]; DWORD i; size_t before=wcslen(prefix),after=wcslen(suffix);
    static const WCHAR hex[]=L"0123456789abcdef";
    if(before+32+after+1>capacity || BCryptGenRandom(NULL,random,sizeof(random),BCRYPT_USE_SYSTEM_PREFERRED_RNG)<0) return FALSE;
    memcpy(out,prefix,before*sizeof(WCHAR));
    for(i=0;i<16;i++) { out[before+2*i]=hex[random[i]>>4]; out[before+2*i+1]=hex[random[i]&15]; }
    memcpy(out+before+32,suffix,(after+1)*sizeof(WCHAR)); SecureZeroMemory(random,sizeof(random)); return TRUE;
}
PFOPublication pfo_publish(PFOAuthority *a,PFFileRole role,const BYTE *bytes,DWORD length) {
    const WCHAR *name=role==PF_FILE_GRANT?L"connector.grant":role==PF_FILE_TASKS_TOKEN?L"tasks.token":NULL;
    DWORD cap=role==PF_FILE_GRANT?PF_GRANT_BYTES:PF_TOKEN_BYTES,at=0,written=0,observedLength=0;
    BYTE captured[PF_GRANT_BYTES],observed[PF_GRANT_BYTES]; WCHAR staging[PF_COMPONENT_LIMIT+1];
    PFOPublication receipt={PFO_INVALID,PFO_NONE}; PFToken token; PACL acl=NULL;
    SECURITY_DESCRIPTOR sd; UNICODE_STRING unicode; OBJECT_ATTRIBUTES attributes; IO_STATUS_BLOCK io;
    HANDLE file=INVALID_HANDLE_VALUE; NTSTATUS status; PFFileStamp stamp,checked,progress;
    PSECURITY_DESCRIPTOR before=NULL,after=NULL; PFONativeRename *rename=NULL; DWORD renameSize;
    ZeroMemory(&token,sizeof(token)); ZeroMemory(captured,sizeof(captured)); ZeroMemory(observed,sizeof(observed));
    if(!name || !bytes || length>cap) goto done;
    memcpy(captured,bytes,length);
    if(!pfo_current(a)) { receipt.result=PFO_UNAVAILABLE; goto done; }
    if(!pfo_nonce(staging,PF_COMPONENT_LIMIT+1,L"pfo-stage-",L".tmp") || !pfo_security(&token,&sd,&acl)) { receipt.result=PFO_IO; goto done; }
    ZeroMemory(&unicode,sizeof(unicode)); unicode.Buffer=staging; unicode.Length=(USHORT)(wcslen(staging)*sizeof(WCHAR)); unicode.MaximumLength=unicode.Length;
    ZeroMemory(&attributes,sizeof(attributes)); attributes.Length=sizeof(attributes); attributes.RootDirectory=current_handle(&a->root);
    attributes.ObjectName=&unicode; attributes.Attributes=OBJ_CASE_INSENSITIVE; attributes.SecurityDescriptor=&sd;
    ZeroMemory(&io,sizeof(io));
    if(!pfo_current(a)) { receipt.result=PFO_UNAVAILABLE; goto done; }
    status=NtCreateFile(&file,PF_FILE_READ|FILE_WRITE_DATA|DELETE,&attributes,&io,NULL,FILE_ATTRIBUTE_NORMAL,
        0,FILE_CREATE,FILE_NON_DIRECTORY_FILE|FILE_SYNCHRONOUS_IO_NONALERT|FILE_OPEN_REPARSE_POINT,NULL,0);
    if(status<0) { file=INVALID_HANDLE_VALUE; receipt.result=status==PF_NAME_COLLISION?PFO_EXISTS:PFO_IO; goto done; }
    receipt.effect=PFO_STAGED;
    if(io.Information!=FILE_CREATED || file_details(file,&stamp)!=PF_FILE_OK ||
        inspect_private_security(file,FILE_ALL_ACCESS,&before)!=PF_OK || !pfo_current(a)) { receipt.result=PFO_UNAVAILABLE; goto done; }
    while(at<length) {
        if(!pfo_current(a) || file_details(file,&progress)!=PF_FILE_OK ||
            !same_identity(&stamp.identity,&progress.identity) || progress.bytes!=at ||
            inspect_private_security(file,FILE_ALL_ACCESS,&after)!=PF_OK || !same_security(before,after)) { receipt.result=PFO_UNAVAILABLE; goto done; }
        LocalFree(after); after=NULL;
        if(!pfo_current(a) || !WriteFile(file,captured+at,length-at,&written,NULL) || !written || written>length-at) { receipt.result=PFO_IO; goto done; }
        at+=written;
    }
    if(!FlushFileBuffers(file) || !pfo_current(a) || file_details(file,&stamp)!=PF_FILE_OK || stamp.bytes!=length ||
        inspect_private_security(file,FILE_ALL_ACCESS,&after)!=PF_OK || !same_security(before,after)) { receipt.result=PFO_UNAVAILABLE; goto done; }
    LocalFree(after); after=NULL;
    renameSize=(DWORD)(offsetof(PFONativeRename,name)+wcslen(name)*sizeof(WCHAR));
    rename=(PFONativeRename *)calloc(1,renameSize);
    if(!rename) { receipt.result=PFO_IO; goto done; }
    /* The exclusive staged handle already belongs to this pinned directory.
     * A fixed same-directory basename rename requires no target root open. */
    rename->root=NULL; rename->bytes=(ULONG)(wcslen(name)*sizeof(WCHAR));
    memcpy(rename->name,name,rename->bytes); /* replace remains FALSE. */
    if(!pfo_current(a)) { receipt.result=PFO_UNAVAILABLE; goto done; }
    ZeroMemory(&io,sizeof(io));
    status=NtSetInformationFile(file,&io,rename,renameSize,(FILE_INFORMATION_CLASS)10);
    if(status<0) { receipt.result=status==PF_NAME_COLLISION?PFO_EXISTS:PFO_IO; goto done; }
    receipt.effect=PFO_UNCERTAIN;
    if(!pfo_current(a) || file_details(file,&stamp)!=PF_FILE_OK || stamp.bytes!=length ||
        inspect_private_security(file,FILE_ALL_ACCESS,&after)!=PF_OK || !same_security(before,after)) { receipt.result=PFO_UNAVAILABLE; goto done; }
    CloseHandle(file); file=INVALID_HANDLE_VALUE;
    if(pf_file_read(&a->root,name,role,NULL,observed,cap,&observedLength,&checked)!=PF_FILE_OK ||
        !same_identity(&stamp.identity,&checked.identity) || stamp.creationTime!=checked.creationTime ||
        observedLength!=length || memcmp(captured,observed,length) ||
        file_named_binding(current_handle(&a->root),(WCHAR *)name,(USHORT)wcslen(name),&checked,before)!=PF_FILE_OK || !pfo_current(a)) { receipt.result=PFO_UNAVAILABLE; goto done; }
    receipt.result=PFO_OK; receipt.effect=PFO_PUBLISHED;
done:
    if(file!=INVALID_HANDLE_VALUE) CloseHandle(file);
    if(before) LocalFree(before); if(after) LocalFree(after);
    if(acl) HeapFree(GetProcessHeap(),0,acl); token_close(&token); free(rename);
    SecureZeroMemory(captured,sizeof(captured)); SecureZeroMemory(observed,sizeof(observed));
    /* No automatic deletion, overwrite, ACL repair or adoption. Staging was
     * created private; later security loss is a refusal, never an assertion
     * that the entry remains private. Caller must retain its observed effect. */
    return receipt;
}

static BOOL pfo_process(HANDLE process,DWORD *pid,FILETIME *creation,DWORD *session,LUID *logon) {
    FILETIME exit,kernel,user; HANDLE processToken=NULL;
    TOKEN_STATISTICS stats; PFToken current; TOKEN_USER *owner=NULL; DWORD size=0; BOOL ok=FALSE;
    ZeroMemory(&current,sizeof(current));
    if(WaitForSingleObject(process,0)!=WAIT_TIMEOUT || !GetProcessTimes(process,creation,&exit,&kernel,&user) ||
        !(*pid=GetProcessId(process)) || !OpenProcessToken(process,TOKEN_QUERY,&processToken) || !token_open(&current)) goto done;
    if(GetTokenInformation(processToken,TokenUser,NULL,0,&size) || GetLastError()!=ERROR_INSUFFICIENT_BUFFER || size>65536) goto done;
    owner=(TOKEN_USER *)HeapAlloc(GetProcessHeap(),HEAP_ZERO_MEMORY,size);
    if(!owner || !GetTokenInformation(processToken,TokenUser,owner,size,&size) ||
        !IsValidSid(owner->User.Sid) || !EqualSid(owner->User.Sid,current.user->User.Sid) ||
        !GetTokenInformation(processToken,TokenSessionId,session,sizeof(*session),&size) ||
        !GetTokenInformation(processToken,TokenStatistics,&stats,sizeof(stats),&size)) goto done;
    *logon=stats.AuthenticationId;
    if(!GetTokenInformation(current.processToken,TokenStatistics,&stats,sizeof(stats),&size) ||
        logon->LowPart!=stats.AuthenticationId.LowPart || logon->HighPart!=stats.AuthenticationId.HighPart) goto done;
    ok=TRUE;
done:
    if(owner) HeapFree(GetProcessHeap(),0,owner); if(processToken) CloseHandle(processToken); token_close(&current); return ok;
}
static BOOL pfo_same_time(const FILETIME *a,const FILETIME *b) {
    return a->dwLowDateTime==b->dwLowDateTime && a->dwHighDateTime==b->dwHighDateTime;
}
static BOOL pfo_peer(PFOControl *c) {
    DWORD actual=0,session=0,pid=0; FILETIME creation; LUID logon;
    PSECURITY_DESCRIPTOR security=NULL; BOOL ok=FALSE;
    if(!pfo_current(c->authority) || !GetNamedPipeClientProcessId(c->pipe,&actual) || actual!=c->pid ||
        !GetNamedPipeClientSessionId(c->pipe,&session) || session!=c->session ||
        !pfo_process(c->process,&pid,&creation,&session,&logon) || pid!=c->pid || session!=c->session ||
        !pfo_same_time(&creation,&c->creation) || logon.LowPart!=c->logon.LowPart || logon.HighPart!=c->logon.HighPart) goto done;
    if(inspect_private_security(c->pipe,FILE_ALL_ACCESS,&security)!=PF_OK || !same_security(security,c->security) ||
        !GetNamedPipeClientProcessId(c->pipe,&actual) || actual!=c->pid || !pfo_current(c->authority)) goto done;
    ok=TRUE;
done:
    if(security) LocalFree(security); return ok;
}
PFOResult pfo_control_begin(PFOAuthority *a,HANDLE expectedProcess,PFOControl **out) {
    PFOControl *c=NULL; PFToken token; SECURITY_DESCRIPTOR sd; PACL acl=NULL; SECURITY_ATTRIBUTES sa;
    PFOResult result=PFO_UNAVAILABLE; BOOL connected; DWORD error;
    ZeroMemory(&token,sizeof(token)); if(out) *out=NULL;
    if(!out || !pfo_current(a) || !expectedProcess || expectedProcess==INVALID_HANDLE_VALUE || a->controls) return PFO_UNAVAILABLE;
    c=(PFOControl *)calloc(1,sizeof(*c)); if(!c) return PFO_IO;
    c->pipe=INVALID_HANDLE_VALUE; c->authority=a;
    if(!DuplicateHandle(GetCurrentProcess(),expectedProcess,GetCurrentProcess(),&c->process,0,FALSE,DUPLICATE_SAME_ACCESS) ||
        !pfo_process(c->process,&c->pid,&c->creation,&c->session,&c->logon) ||
        !pfo_nonce(c->name,PFO_PIPE_NAME,L"\\\\.\\pipe\\Plexiform-control-v1-",L"") || !pfo_security(&token,&sd,&acl)) goto done;
    ZeroMemory(&sa,sizeof(sa)); sa.nLength=sizeof(sa); sa.lpSecurityDescriptor=&sd; sa.bInheritHandle=FALSE;
    if(!pfo_current(a)) goto done;
    /* Duplex already grants DACL read access. READ_CONTROL is not a valid
     * CreateNamedPipeW open-mode flag; the explicit private SD still applies. */
    c->pipe=CreateNamedPipeW(c->name,PIPE_ACCESS_DUPLEX|FILE_FLAG_OVERLAPPED|FILE_FLAG_FIRST_PIPE_INSTANCE,
        PIPE_TYPE_BYTE|PIPE_READMODE_BYTE|PIPE_WAIT|PIPE_REJECT_REMOTE_CLIENTS,1,4096,4096,0,&sa);
    if(c->pipe==INVALID_HANDLE_VALUE || inspect_private_security(c->pipe,FILE_ALL_ACCESS,&c->security)!=PF_OK || !pfo_current(a)) goto done;
    c->event=CreateEventW(NULL,TRUE,FALSE,NULL); if(!c->event) goto done;
    ZeroMemory(&c->connect,sizeof(c->connect)); c->connect.hEvent=c->event;
    connected=ConnectNamedPipe(c->pipe,&c->connect);
    error=connected?ERROR_SUCCESS:GetLastError();
    if(connected || error==ERROR_PIPE_CONNECTED) c->connected=TRUE;
    else if(error==ERROR_IO_PENDING) c->pending=TRUE;
    else goto done;
    a->controls=1; result=pfo_current(a)?PFO_OK:PFO_UNAVAILABLE;
    if(result!=PFO_OK) c->refused=TRUE;
    *out=c; c=NULL;
done:
    if(c) {
        if(c->pipe!=INVALID_HANDLE_VALUE) CloseHandle(c->pipe);
        if(c->event) CloseHandle(c->event); if(c->process) CloseHandle(c->process);
        if(c->security) LocalFree(c->security); SecureZeroMemory(c,sizeof(*c)); free(c);
    }
    if(acl) HeapFree(GetProcessHeap(),0,acl); token_close(&token); return result;
}
PFOResult pfo_control_name(PFOControl *c,WCHAR *output,DWORD capacity) {
    if(output && capacity==PFO_PIPE_NAME) SecureZeroMemory(output,capacity*sizeof(WCHAR));
    if(!c || !output || capacity!=PFO_PIPE_NAME || c->closing || c->refused || !pfo_current(c->authority)) return PFO_UNAVAILABLE;
    memcpy(output,c->name,sizeof(c->name)); return PFO_OK;
}
PFOResult pfo_control_poll(PFOControl *c) {
    DWORD bytes=0,error;
    if(!c || c->closing || c->refused) return PFO_UNAVAILABLE;
    if(!pfo_current(c->authority)) { c->refused=TRUE; return PFO_UNAVAILABLE; }
    if(c->pending) {
        if(!GetOverlappedResult(c->pipe,&c->connect,&bytes,FALSE)) {
            error=GetLastError(); if(error==ERROR_IO_INCOMPLETE) return PFO_PENDING;
            /* Only the documented completed-cancellation result retires
             * pending storage. A query failure is not a completion receipt. */
            if(error==ERROR_OPERATION_ABORTED) c->pending=FALSE;
            c->refused=TRUE; return PFO_IO;
        }
        c->pending=FALSE; c->connected=TRUE;
    }
    if(!c->connected || !pfo_peer(c)) { c->refused=TRUE; return PFO_PEER; }
    return PFO_OK;
}
PFOResult pfo_control_close(PFOControl *c) {
    DWORD bytes=0;
    if(!c) return PFO_INVALID;
    c->closing=TRUE;
    if(c->pending) {
        /* Never free/reuse OVERLAPPED storage while the kernel owns it. An
         * external helper deadline must terminate/reap a stuck operation. */
        CancelIoEx(c->pipe,&c->connect);
        if(!GetOverlappedResult(c->pipe,&c->connect,&bytes,FALSE) && GetLastError()!=ERROR_OPERATION_ABORTED) return PFO_PENDING;
        c->pending=FALSE;
    }
    CloseHandle(c->pipe); CloseHandle(c->event); CloseHandle(c->process); LocalFree(c->security);
    c->authority->controls=0; SecureZeroMemory(c,sizeof(*c)); free(c); return PFO_OK;
}
