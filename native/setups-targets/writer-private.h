#ifndef PF_SETUPS_WRITER_PRIVATE_H
#define PF_SETUPS_WRITER_PRIVATE_H
#include "writer.h"
#include "snapshot-private.h"
#define PF_NATIVE_RECORDS 8u
typedef struct {
 PFRecipe recipe; PFWriteReceipt receipt;
 PFStamp profile, parent, hold; PFNativeBinding hold_binding;
 PFWriteMeta before, stage, accepted_after, restore_stage, snapshots[2], records[PF_NATIVE_RECORDS];
 uint32_t record_count; char hold_id[PF_WRITER_HOLD_ID_BYTES];
} PFNativeWriterState;
/* Trusted private dispatcher/session bridge only. Never a wire path selector. */
PFResult pf_native_writer_prepare_observed(PFRoot *, PFRecipe, const PFStamp *, PFByteView, PFByteView, uint64_t, PFWriteTxn **, PFNativeWriterState *);
PFResult pf_native_writer_state(PFWriteTxn *, PFNativeWriterState *);
PFResult pf_native_writer_intent(PFWriteTxn *, unsigned action, PFNativeWriterState *);
PFResult pf_native_writer_snapshot(PFWriteTxn *, unsigned role, PFSnapshot **);
PFResult pf_native_writer_stamp(PFWriteTxn *, unsigned role, PFStamp *);
PFResult pf_native_writer_current(PFWriteTxn *);
PFResult pf_native_writer_restrict_cutoff(PFWriteTxn *, uint64_t);
PFResult pf_native_writer_recover(PFRoot *, const PFNativeWriterState *, const PFSnapshot *, uint64_t, PFWriteTxn **);
#endif
