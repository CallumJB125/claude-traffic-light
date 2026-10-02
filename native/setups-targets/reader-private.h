#ifndef PF_SETUPS_READER_PRIVATE_H
#define PF_SETUPS_READER_PRIVATE_H
#include "reader.h"
#include <sys/stat.h>
typedef struct {
  uint64_t device, inode, uid, mode, gid, flags; unsigned char acl_hash[32];
} PFNativeBinding;
/* Native implementation bridge only; no transport/exported path selector.
 * Opening a fixed parent owns a duplicate of the complete retained root. */
typedef struct PFNativeParent PFNativeParent;
PFResult pf_native_parent_open(PFRoot *root, PFRecipe recipe, PFNativeParent **out);
PFResult pf_native_parent_current(PFNativeParent *parent);
int pf_native_profile_fd(PFNativeParent *parent);
int pf_native_parent_fd(PFNativeParent *parent);
const char *pf_native_leaf(PFNativeParent *parent);
void pf_native_parent_close(PFNativeParent *parent);
PFResult pf_native_acl_safe(int fd);
PFResult pf_native_root_duplicate(PFRoot *, PFRoot **);
PFResult pf_native_root_current(PFRoot *);
int pf_native_root_fd(PFRoot *);
PFResult pf_native_binding_fd(int, PFNativeBinding *);
PFResult pf_native_root_bindings(PFRoot *, PFNativeBinding *, size_t, size_t *, unsigned char[32]);
PFResult pf_native_parent_bindings(PFNativeParent *, PFNativeBinding *, size_t, size_t *, unsigned char[32]);
#endif
