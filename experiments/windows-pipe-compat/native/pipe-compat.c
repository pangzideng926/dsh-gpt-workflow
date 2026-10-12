/* Independent compatibility experiment. Not installed into DSH or Node.
 * Only the current node.exe IAT is adapted; no other process is modified. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <sddl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef HANDLE (WINAPI *pipe_a_fn)(LPCSTR,DWORD,DWORD,DWORD,DWORD,DWORD,DWORD,LPSECURITY_ATTRIBUTES);
typedef HANDLE (WINAPI *pipe_w_fn)(LPCWSTR,DWORD,DWORD,DWORD,DWORD,DWORD,DWORD,LPSECURITY_ATTRIBUTES);
static pipe_a_fn original_a;
static pipe_w_fn original_w;
static PSECURITY_DESCRIPTOR pipe_sd;
static INIT_ONCE initialized = INIT_ONCE_STATIC_INIT;
static DWORD initialization_error;

static void *token_info(HANDLE token, TOKEN_INFORMATION_CLASS kind) {
  DWORD needed = 0;
  GetTokenInformation(token, kind, NULL, 0, &needed);
  if (!needed) return NULL;
  void *data = calloc(1, needed);
  if (!data) { SetLastError(ERROR_NOT_ENOUGH_MEMORY); return NULL; }
  if (!GetTokenInformation(token, kind, data, needed, &needed)) { free(data); return NULL; }
  return data;
}

/* The scope has to be present in this already-restricted token. An environment
 * variable by itself never confers authority. Do not add broad identities. */
static BOOL make_descriptor(void) {
  HANDLE token = NULL;
  PSID scope = NULL;
  PTOKEN_GROUPS restricted = NULL;
  PTOKEN_USER user = NULL;
  PTOKEN_MANDATORY_LABEL integrity = NULL;
  LPSTR user_text = NULL;
  BOOL ok = FALSE, found = FALSE;
  char scope_text[256], sddl[1024];
  DWORD size = GetEnvironmentVariableA("DSH_PIPE_SCOPE_SID", scope_text, sizeof(scope_text));
  if (!size || size >= sizeof(scope_text) || strncmp(scope_text,"S-1-4-",6)) goto done;
  if (!ConvertStringSidToSidA(scope_text, &scope)) goto done;
  /* Workspace and temp capabilities are not IPC identities. */
  if (*GetSidSubAuthorityCount(scope) != 5 || *GetSidSubAuthority(scope,4) != 2) goto done;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) goto done;
  if (!IsTokenRestricted(token)) goto done;
  restricted = token_info(token, TokenRestrictedSids);
  user = token_info(token, TokenUser);
  integrity = token_info(token, TokenIntegrityLevel);
  if (!restricted || !user || !integrity) goto done;
  DWORD level = *GetSidSubAuthority(integrity->Label.Sid, *GetSidSubAuthorityCount(integrity->Label.Sid)-1);
  if (level != SECURITY_MANDATORY_LOW_RID) goto done;
  for (DWORD i=0; i<restricted->GroupCount; i++)
    if (EqualSid(scope, restricted->Groups[i].Sid)) found = TRUE;
  if (!found || !ConvertSidToStringSidA(user->User.Sid, &user_text)) goto done;
  if (snprintf(sddl,sizeof(sddl),"D:P(A;;FA;;;%s)(A;;FA;;;%s)S:(ML;;NW;;;LW)", user_text,scope_text) < 0) goto done;
  ok = ConvertStringSecurityDescriptorToSecurityDescriptorA(sddl, SDDL_REVISION_1, &pipe_sd, NULL);
done:
  if (token) CloseHandle(token);
  if (scope) LocalFree(scope);
  if (user_text) LocalFree(user_text);
  free(restricted); free(user); free(integrity);
  if (!ok) SetLastError(ERROR_ACCESS_DENIED);
  return ok;
}

static BOOL own_uv_name(const char *name) {
  static const char prefix[] = "\\\\?\\pipe\\uv\\";
  if (!name || strncmp(name,prefix,sizeof(prefix)-1)) return FALSE;
  const char *p = name + sizeof(prefix)-1;
  if (*p<'0' || *p>'9') return FALSE;
  while (*p>='0' && *p<='9') p++;
  if (*p++ != '-') return FALSE;
  char *end;
  unsigned long pid = strtoul(p,&end,10);
  return p != end && !*end && pid == GetCurrentProcessId();
}

static HANDLE WINAPI compat_a(LPCSTR name,DWORD open,DWORD mode,DWORD max,DWORD out,DWORD in,DWORD timeout,LPSECURITY_ATTRIBUTES sa) {
  if ((open & FILE_FLAG_FIRST_PIPE_INSTANCE) && (!sa || !sa->lpSecurityDescriptor) && own_uv_name(name)) {
    SECURITY_ATTRIBUTES explicit_sa = {sizeof(SECURITY_ATTRIBUTES),pipe_sd,sa ? sa->bInheritHandle : FALSE};
    return original_a(name,open,mode | PIPE_REJECT_REMOTE_CLIENTS,max,out,in,timeout,&explicit_sa);
  }
  return original_a(name,open,mode,max,out,in,timeout,sa);
}
static HANDLE WINAPI compat_w(LPCWSTR name,DWORD open,DWORD mode,DWORD max,DWORD out,DWORD in,DWORD timeout,LPSECURITY_ATTRIBUTES sa) {
  char narrow[256];
  if (name && WideCharToMultiByte(CP_UTF8,0,name,-1,narrow,sizeof(narrow),NULL,NULL) &&
      (open & FILE_FLAG_FIRST_PIPE_INSTANCE) && (!sa || !sa->lpSecurityDescriptor) && own_uv_name(narrow)) {
    SECURITY_ATTRIBUTES explicit_sa = {sizeof(SECURITY_ATTRIBUTES),pipe_sd,sa ? sa->bInheritHandle : FALSE};
    return original_w(name,open,mode | PIPE_REJECT_REMOTE_CLIENTS,max,out,in,timeout,&explicit_sa);
  }
  return original_w(name,open,mode,max,out,in,timeout,sa);
}

static BOOL replace_import(ULONG_PTR *slot, ULONG_PTR replacement) {
  DWORD old, ignored;
  if (!VirtualProtect(slot,sizeof(*slot),PAGE_READWRITE,&old)) return FALSE;
  InterlockedExchangePointer((PVOID volatile *)slot,(PVOID)replacement);
  if (!VirtualProtect(slot,sizeof(*slot),old,&ignored)) return FALSE;
  return TRUE;
}

static BOOL CALLBACK install(PINIT_ONCE once,PVOID parameter,PVOID *context) {
  (void)once; (void)parameter; (void)context;
  if (!make_descriptor()) { initialization_error=GetLastError(); return TRUE; }
  BYTE *module = (BYTE *)GetModuleHandleW(NULL);
  IMAGE_DOS_HEADER *dos = (IMAGE_DOS_HEADER *)module;
  IMAGE_NT_HEADERS *nt = (IMAGE_NT_HEADERS *)(module+dos->e_lfanew);
  DWORD import_rva = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT].VirtualAddress;
  if (!import_rva) { initialization_error=ERROR_PROC_NOT_FOUND; return TRUE; }
  HMODULE self;
  if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,(LPCWSTR)&install,&self)) {
    initialization_error=GetLastError(); return TRUE;
  }
  int changed=0;
  for (IMAGE_IMPORT_DESCRIPTOR *desc=(IMAGE_IMPORT_DESCRIPTOR *)(module+import_rva);desc->Name;desc++) {
    if (!desc->OriginalFirstThunk) continue;
    IMAGE_THUNK_DATA *names=(IMAGE_THUNK_DATA *)(module+desc->OriginalFirstThunk);
    IMAGE_THUNK_DATA *addresses=(IMAGE_THUNK_DATA *)(module+desc->FirstThunk);
    for (; names->u1.AddressOfData; names++, addresses++) {
      if (IMAGE_SNAP_BY_ORDINAL(names->u1.Ordinal)) continue;
      const char *name=(const char *)((IMAGE_IMPORT_BY_NAME *)(module+names->u1.AddressOfData))->Name;
      ULONG_PTR replacement=0;
      if (!strcmp(name,"CreateNamedPipeA")) { original_a=(pipe_a_fn)addresses->u1.Function; replacement=(ULONG_PTR)&compat_a; }
      if (!strcmp(name,"CreateNamedPipeW")) { original_w=(pipe_w_fn)addresses->u1.Function; replacement=(ULONG_PTR)&compat_w; }
      if (replacement) {
        if (!replace_import(&addresses->u1.Function,replacement)) { initialization_error=GetLastError(); return TRUE; }
        changed++;
      }
    }
  }
  if (!changed) initialization_error=ERROR_PROC_NOT_FOUND;
  return TRUE;
}

/* Stable Node-API entry point, no dependency on a Node-version-specific ABI. */
__declspec(dllexport) int node_api_module_get_api_version_v1(void) { return 8; }
__declspec(dllexport) void *napi_register_module_v1(void *env,void *exports) {
  if (!InitOnceExecuteOnce(&initialized,install,NULL,NULL) || initialization_error) {
    typedef int (*throw_fn)(void *,const char *,const char *);
    throw_fn throw_error=(throw_fn)(void *)GetProcAddress(GetModuleHandleW(NULL),"napi_throw_error");
    char message[128];
    snprintf(message,sizeof(message),"Restricted pipe compatibility initialization failed (Win32 %lu)",initialization_error);
    if (throw_error) throw_error(env,"DSH_PIPE_COMPAT_DENIED",message);
    else ExitProcess(127);
    return NULL;
  }
  return exports;
}
