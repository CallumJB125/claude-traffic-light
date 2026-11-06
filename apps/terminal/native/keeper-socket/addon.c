#include <node_api.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <string.h>
#include <fcntl.h>
#include <errno.h>
#include "keeper.h"
// Loaded only by Terminal's main process. The peer audit token comes from the
// connected fd, so neither a PID race nor a forked proxy can impersonate Keeper.
static napi_value connect_verified(napi_env env, napi_callback_info info) {
  size_t argc = 4; napi_value argv[4]; napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  char path[104] = {0}, team[64] = {0}; size_t n; bool dev = false; int32_t minimum = 1;
  if (argc != 4 || napi_get_value_string_utf8(env, argv[0], path, sizeof(path), &n) != napi_ok || n == 0 || n >= sizeof(path)-1 ||
      napi_get_value_bool(env, argv[1], &dev) != napi_ok || napi_get_value_string_utf8(env, argv[2], team, sizeof(team), &n) != napi_ok ||
      napi_get_value_int32(env, argv[3], &minimum) != napi_ok || minimum < 1) { napi_throw_error(env, "VALIDATION", "Invalid keeper connection."); return NULL; }
  struct sockaddr_un address = {.sun_family = AF_UNIX}; strlcpy(address.sun_path, path, sizeof(address.sun_path));
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0 || connect(fd, (struct sockaddr *)&address, sizeof(address)) != 0) { if (fd >= 0) close(fd); napi_throw_error(env, "KEEPER_DOWN", "Session Keeper is unavailable."); return NULL; }
  char ident[256] = {0}; int build = 0;
  if (!pf_peer(fd, dev ? 1 : 0, team, ident, sizeof(ident), &build) || strcmp(ident, "dev.plexiform.keeper") || build < minimum) {
    close(fd); napi_throw_error(env, "UNVERIFIED", "Session Keeper identity or signed build floor did not match."); return NULL;
  }
  fcntl(fd, F_SETFD, FD_CLOEXEC); fcntl(fd, F_SETFL, O_NONBLOCK);
  napi_value result; napi_create_int32(env, fd, &result); return result;
}
static napi_value init(napi_env env, napi_value exports) {
  napi_value fn; napi_create_function(env, "connectVerified", NAPI_AUTO_LENGTH, connect_verified, NULL, &fn);
  napi_set_named_property(env, exports, "connectVerified", fn); return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
