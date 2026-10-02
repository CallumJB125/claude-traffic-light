#ifndef PF_SETUPS_RECEIPT_PRIVATE_H
#define PF_SETUPS_RECEIPT_PRIVATE_H
#include "receipt.h"
#include "writer-private.h"
#include "codec-private.h"
typedef struct { uint32_t tag; PFResult result; PFStamp identity; PFSnapshot *snapshot; } PFObservedObject;
struct PFObservedReceipt {
 uint32_t schema, action, target_index, sequence, effect, hold_status;
 PFResult result; PFUuid transaction; unsigned char plan_hash[32], intent_hash[32], record_hash[32];
 PFNativeWriterState native; PFObservedObject objects[2];
};
PFResult pf_receipt_capture(PFWriteTxn *, PFResult, unsigned action, PFObservedReceipt **);
PFResult pf_native_state_codec(PFCodec *, PFNativeWriterState *);
#endif
