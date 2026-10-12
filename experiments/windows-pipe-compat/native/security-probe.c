/* Shares the exact descriptor implementation with the experimental addon. */
#include "pipe-compat.c"
int main(int argc,char **argv) {
  if (argc < 2) return 64;
  if (!strcmp(argv[1],"token")) {
    HANDLE token;
    if (!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token)) return 65;
    PTOKEN_GROUPS groups=token_info(token,TokenRestrictedSids);
    PTOKEN_MANDATORY_LABEL label=token_info(token,TokenIntegrityLevel);
    if (!groups || !label) return 66;
    DWORD level=*GetSidSubAuthority(label->Label.Sid,*GetSidSubAuthorityCount(label->Label.Sid)-1);
    printf("{\"restricted\":%s,\"integrity\":%lu,\"sids\":[",IsTokenRestricted(token)?"true":"false",level);
    for(DWORD i=0;i<groups->GroupCount;i++) {
      LPSTR sid=NULL;
      if (!ConvertSidToStringSidA(groups->Groups[i].Sid,&sid)) return 67;
      printf("%s\"%s\"",i?",":"",sid);LocalFree(sid);
    }
    printf("]}\n");free(groups);free(label);CloseHandle(token);return 0;
  }
  if (argc==4 && !strcmp(argv[1],"open")) {
    DWORD access=!strcmp(argv[3],"write")?GENERIC_WRITE:GENERIC_READ;
    HANDLE pipe=CreateFileA(argv[2],access,0,NULL,OPEN_EXISTING,0,NULL);
    DWORD error=pipe==INVALID_HANDLE_VALUE?GetLastError():0;
    if(pipe!=INVALID_HANDLE_VALUE) CloseHandle(pipe);
    printf("{\"error\":%lu}\n",error);return 0;
  }
  if (argc==3 && !strcmp(argv[1],"serve")) {
    if(!make_descriptor()) return 68;
    SECURITY_ATTRIBUTES sa={sizeof(sa),pipe_sd,FALSE};
    HANDLE pipe=CreateNamedPipeA(argv[2],PIPE_ACCESS_DUPLEX|FILE_FLAG_FIRST_PIPE_INSTANCE,PIPE_TYPE_BYTE|PIPE_WAIT|PIPE_REJECT_REMOTE_CLIENTS,1,4096,4096,0,&sa);
    if(pipe==INVALID_HANDLE_VALUE) { fprintf(stderr,"CreateNamedPipe failed %lu\n",GetLastError()); return 69; }
    puts("ready");fflush(stdout);getchar();CloseHandle(pipe);LocalFree(pipe_sd);return 0;
  }
  return 64;
}
