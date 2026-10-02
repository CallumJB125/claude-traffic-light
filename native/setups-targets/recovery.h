#ifndef PF_SETUPS_RECOVERY_H
#define PF_SETUPS_RECOVERY_H
#include "journal-gate.h"
typedef struct PFRecoveryGrant PFRecoveryGrant;
typedef struct PFRecovery PFRecovery;
typedef struct PFRestoreGrant PFRestoreGrant;
PFResult pf_recovery_inspect(PFRoot *, PFRecoveryGrant *, PFRecovery **, PFObservedReceipt **);
/* A separately authenticated fresh restoration confirmation precedes staging. */
PFResult pf_recovery_intent(PFRecovery *, PFRestoreGrant *, PFIntent **);
PFResult pf_recovery_observe(PFRecovery *, PFObservedReceipt **);
void pf_restore_grant_close(PFRestoreGrant *);
PFResult pf_recovery_restore(PFRecovery *, PFPermit *, PFObservedReceipt **);
void pf_recovery_close(PFRecovery *);
void pf_recovery_grant_close(PFRecoveryGrant *);
#endif
