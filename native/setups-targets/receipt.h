#ifndef PF_SETUPS_RECEIPT_H
#define PF_SETUPS_RECEIPT_H
#include "snapshot.h"
#define PF_RECEIPT_BYTES (704u * 1024u)
typedef struct PFObservedReceipt PFObservedReceipt;
PFResult pf_receipt_encode(const PFObservedReceipt *, unsigned char *, uint32_t, uint32_t *);
PFResult pf_receipt_decode(PFByteView, PFObservedReceipt **); /* Data only. */
void pf_receipt_close(PFObservedReceipt *);
#endif
