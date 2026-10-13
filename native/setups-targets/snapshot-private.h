#ifndef PF_SETUPS_SNAPSHOT_PRIVATE_H
#define PF_SETUPS_SNAPSHOT_PRIVATE_H
#include "snapshot.h"
#include "reader-private.h"
typedef struct { uint64_t present, size; unsigned char hash[32]; } PFAttributeMeta;
typedef struct { unsigned char bytes[PF_SNAPSHOT_ATTR_BYTES]; size_t size; unsigned present; } PFAttribute;
typedef struct {
 PFStamp stamp; uint64_t gid, flags;
 unsigned char acl_hash[32], hash[32]; PFAttributeMeta attrs[2];
} PFWriteMeta;
struct PFBindingSet { uint32_t count; PFNativeBinding entries[PF_SNAPSHOT_BINDINGS]; unsigned char profile_hash[32]; };
struct PFSnapshot {
 PFRecipe recipe; uint32_t exists, acl_tag, acl_size;
 PFWriteMeta meta; PFBindingSet bindings;
 unsigned char acl[PF_SNAPSHOT_ACL_BYTES], bytes[PF_READER_MAX_BYTES];
 PFAttribute attrs[2]; unsigned char digest[32];
};
/* Trusted internal descriptor use only. No names from wire/renderer are accepted. */
PFResult pf_snapshot_native(PFNativeParent *, int, const char *, PFRecipe, PFSnapshot **);
PFResult pf_snapshot_bindings(PFNativeParent *, PFBindingSet *);
PFResult pf_snapshot_fd(int, PFSnapshot *);
PFResult pf_snapshot_metadata_fd(int, PFSnapshot *);
PFResult pf_snapshot_apply_metadata(int, const PFSnapshot *, int original_time);
PFResult pf_snapshot_compare(const PFSnapshot *, const PFSnapshot *, int moved);
PFResult pf_snapshot_acl_validate(PFByteView, uint32_t tag);
void pf_packet_wipe(void *, size_t);
void pf_packet_hash(const void *, size_t, unsigned char[32]);
uint64_t pf_packet_now(void);
PFStamp pf_packet_stamp(const struct stat *);
PFResult pf_packet_empty_acl(int);
PFResult pf_packet_error(void);
#endif
