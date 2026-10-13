#ifndef PF_SETUPS_JOURNAL_GATE_PRIVATE_H
#define PF_SETUPS_JOURNAL_GATE_PRIVATE_H
#include "journal-gate.h"
#include "receipt-private.h"
typedef struct {
 uint64_t generation, cutoff; uint32_t mode;
 unsigned char session_nonce[16], authority_hash[32];
} PFChannelBinding;
typedef struct {
 PFUuid transaction; uint32_t target_index, recipe;
 uint64_t generation, cutoff;
 unsigned char session_nonce[16], nonce[16], plan_hash[32], before_hash[32], after_hash[32], binding_hash[32], prepared_record_hash[32];
} PFPreparationFields;
typedef struct {
 PFUuid transaction; uint32_t target_index, recipe, action, sequence;
 uint64_t generation, cutoff;
 unsigned char session_nonce[16], nonce[16], plan_hash[32], before_hash[32], stage_hash[32], binding_hash[32], intent_hash[32], native_record_hash[32], record_hash[32], previous_hash[32];
} PFPermitFields;
struct PFPrepareGrant { PFChannelBinding channel; PFPreparationFields fields; unsigned used; };
struct PFPermit { PFChannelBinding channel; PFPermitFields fields; unsigned used; };
struct PFIntent { PFPermitFields fields; PFNativeWriterState native; unsigned char digest[32]; };
struct PFWriteSession { PFWriteTxn *writer; PFSnapshot *before; PFRoot *root; PFPreparationFields prepared; PFChannelBinding channel; PFIntent *intent; unsigned attempted; unsigned char record_hash[32]; };
/* Private authenticated dispatcher only; no decoder/public factory exists. */
PFResult pf_private_prepare_grant(const PFChannelBinding *, const PFPreparationFields *, PFPrepareGrant **);
PFResult pf_private_permit(const PFChannelBinding *, const PFPermitFields *, PFPermit **);
PFResult pf_private_intent(PFWriteTxn *, const PFChannelBinding *, const PFPreparationFields *, unsigned, PFIntent **);
PFResult pf_private_permit_consume(PFPermit *, const PFChannelBinding *, const PFIntent *);
PFResult pf_private_binding_hash(const PFBindingSet *, unsigned char[32]);
PFResult pf_private_intent_codec(PFCodec *, PFIntent *);
#endif
