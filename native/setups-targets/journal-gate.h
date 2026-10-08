#ifndef PF_SETUPS_JOURNAL_GATE_H
#define PF_SETUPS_JOURNAL_GATE_H
#include "receipt.h"
typedef struct PFPrepareGrant PFPrepareGrant;
typedef struct PFPermit PFPermit;
typedef struct PFIntent PFIntent;
typedef struct PFWriteSession PFWriteSession;
PFResult pf_session_prepare(PFRoot *, PFRecipe, PFPrepareGrant *, const PFSnapshot *, PFByteView, PFWriteSession **, PFObservedReceipt **);
PFResult pf_session_intent(PFWriteSession *, PFIntent **);
PFResult pf_intent_encode(const PFIntent *, unsigned char *, uint32_t, uint32_t *);
PFResult pf_session_apply(PFWriteSession *, PFPermit *, PFObservedReceipt **);
PFResult pf_session_check(PFWriteSession *, PFObservedReceipt **);
void pf_session_close(PFWriteSession *);
void pf_intent_close(PFIntent *);
void pf_prepare_grant_close(PFPrepareGrant *);
void pf_permit_close(PFPermit *);
#endif
