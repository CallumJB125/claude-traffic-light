#ifndef PF_SETUPS_RECOVERY_PRIVATE_H
#define PF_SETUPS_RECOVERY_PRIVATE_H
#include "recovery.h"
#include "journal-gate-private.h"
typedef struct {
 PFUuid transaction; uint32_t target_index, recipe, schema;
 uint64_t generation, cutoff; unsigned char session_nonce[16], confirmation_nonce[16], profile_hash[32], plan_hash[32], record_hash[32], before_hash[32];
} PFRecoveryFields;
struct PFRecoveryGrant { PFChannelBinding channel; PFRecoveryFields fields; PFNativeWriterState anchor; PFSnapshot *before; unsigned used; };
typedef struct {
 PFUuid transaction; uint32_t target_index;
 uint64_t generation, cutoff;
 unsigned char session_nonce[16], confirmation_nonce[16], inspection_hash[32], record_hash[32];
} PFRestoreFields;
struct PFRestoreGrant { PFChannelBinding channel; PFRestoreFields fields; unsigned used; };
struct PFRecovery { PFChannelBinding channel; PFPreparationFields prepared; PFWriteTxn *writer; PFIntent *intent; unsigned attempted;
 unsigned char inspection_hash[32], confirmation_nonce[16], record_hash[32]; };
PFResult pf_private_restore_grant(const PFChannelBinding *, const PFRestoreFields *, PFRestoreGrant **);
PFResult pf_private_recovery_grant(const PFChannelBinding *, const PFRecoveryFields *, const PFObservedReceipt *, const PFSnapshot *, PFRecoveryGrant **);
#endif
