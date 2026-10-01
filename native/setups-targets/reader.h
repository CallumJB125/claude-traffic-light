#ifndef PF_SETUPS_READER_H
#define PF_SETUPS_READER_H
#include <stddef.h>
#include <stdint.h>
/* Trusted native-module calls only. No argv, renderer path or transport API. */
#define PF_READER_MAX_BYTES (256u * 1024u)
#define PF_READER_MAX_ANCESTORS 64u
#define PF_READER_INSPECT_OPERATION 0x20u
#define PF_READER_READ_OPERATION 0x21u

typedef enum {
  PF_OK = 0, PF_INVALID, PF_UNAVAILABLE, PF_UNSAFE, PF_CHANGED,
  PF_TOO_LARGE, PF_IO, PF_DEADLINE, PF_UNSUPPORTED
} PFResult;
typedef enum {
  PF_CODEX_INSTRUCTIONS = 1, PF_CLAUDE_SETTINGS, PF_GEMINI_SETTINGS,
  PF_CODEX_CONFIG, PF_GIT_CONFIG, PF_GIT_XDG_CONFIG,
  PF_GHOSTTY_CONFIG, PF_GHOSTTY_DARWIN_CONFIG
} PFRecipe;
typedef struct {
  uint64_t device, inode, size, uid, mode, links;
  int64_t mtime_seconds, mtime_nanoseconds, ctime_seconds, ctime_nanoseconds;
} PFStamp;
typedef struct PFRoot PFRoot;
/* canonical_profile must already be canonical, absolute and owned by this uid.
 * A supplied expected root identity binds a prior foreground capture. */
PFResult pf_root_open(const char *canonical_profile, const PFStamp *expected, PFRoot **out);
PFResult pf_root_identity(PFRoot *root, PFStamp *out);
void pf_root_close(PFRoot *root);
PFResult pf_inspect_fixed(PFRoot *root, PFRecipe recipe, PFStamp *out);
/* Read requires the stamp from a prior inspect/plan; stale contents or namespace
 * refuse. On failure size/stamp are zero and any bytes read are cleared. */
PFResult pf_read_fixed(PFRoot *root, PFRecipe recipe, const PFStamp *expected,
                      unsigned char *bytes, size_t capacity, size_t *size, PFStamp *out);
const char *pf_result_name(PFResult result);
#endif
