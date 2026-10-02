#ifndef PF_SETUPS_STORE_H
#define PF_SETUPS_STORE_H
#include "snapshot.h"
#define PF_STORE_BLOB_BYTES (704u * 1024u)
#define PF_STORE_TRANSACTION_BYTES (64u * 1024u * 1024u)
#define PF_STORE_TOTAL_BYTES (128u * 1024u * 1024u)
#define PF_STORE_MAX_TRANSACTIONS 16u
#define PF_STORE_MAX_CHILDREN 512u
#define PF_STORE_MAX_EVENTS 64u
#define PF_STORE_MAX_TARGETS 128u
typedef struct PFStoreRoot PFStoreRoot;
typedef struct PFStoreTxn PFStoreTxn;
typedef enum { PF_STORE_MANIFEST, PF_STORE_BEFORE, PF_STORE_BASE, PF_STORE_AFTER, PF_STORE_METADATA, PF_STORE_EVENT } PFStoreRole;
typedef struct { uint32_t role, target, sequence; uint64_t bytes; } PFStoreEntry;
typedef struct {
 uint32_t namespaces, children; uint64_t total_bytes, transaction_bytes;
 PFStoreEntry entries[PF_STORE_MAX_CHILDREN];
} PFStoreInventory;
PFResult pf_store_open_fixed(PFRoot *, PFStoreRoot **);
PFResult pf_store_list(PFStoreRoot *, PFUuid *, uint32_t, uint32_t *);
/* Metadata observation only; optional txn must belong to this current root.
 * No atomic reservation, physical-block, authentication or retention claim. */
PFResult pf_store_inventory(PFStoreRoot *, PFStoreTxn *, PFStoreInventory *);
PFResult pf_store_create_txn(PFStoreRoot *, PFUuid, PFStoreTxn **);
PFResult pf_store_open_txn(PFStoreRoot *, PFUuid, PFStoreTxn **);
PFResult pf_store_read(PFStoreTxn *, PFStoreRole, uint32_t, uint32_t, unsigned char *, uint32_t, uint32_t *);
PFResult pf_store_write_exclusive(PFStoreTxn *, PFStoreRole, uint32_t, uint32_t, PFByteView);
PFResult pf_store_sync(PFStoreTxn *);
void pf_store_txn_close(PFStoreTxn *);
void pf_store_close(PFStoreRoot *);
#endif
