#ifndef PF_SETUPS_SNAPSHOT_H
#define PF_SETUPS_SNAPSHOT_H
#include "reader.h"
#define PF_SNAPSHOT_BYTES (320u * 1024u)
#define PF_SNAPSHOT_ACL_BYTES 32768u
#define PF_SNAPSHOT_ATTR_BYTES 8192u
#define PF_SNAPSHOT_BINDINGS 64u
typedef struct PFSnapshot PFSnapshot;
typedef struct PFBindingSet PFBindingSet;
typedef struct { const unsigned char *data; uint32_t size; } PFByteView;
typedef struct { unsigned char bytes[16]; } PFUuid;
typedef struct { unsigned char bytes[32]; } PFHash;
PFResult pf_snapshot_fixed(PFRoot *, PFRecipe, const PFBindingSet *, PFSnapshot **);
PFResult pf_snapshot_encode(const PFSnapshot *, unsigned char *, uint32_t, uint32_t *);
PFResult pf_snapshot_decode(PFByteView, PFSnapshot **); /* Immutable data; never authority. */
PFResult pf_snapshot_current(PFRoot *, PFRecipe, const PFSnapshot *);
void pf_snapshot_close(PFSnapshot *);
#endif
