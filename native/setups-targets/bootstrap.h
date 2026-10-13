#ifndef PF_SETUPS_BOOTSTRAP_H
#define PF_SETUPS_BOOTSTRAP_H
/* Private helper construction only. Never an exported renderer capability. */
#include "protocol-private.h"
#define PF_BOOTSTRAP_BYTES 16384u
typedef struct {
 PFPrivateBootstrap private_channel;
 char profile[4097], app_parent[4097];
 PFStamp profile_expected, app_expected;
} PFHelperBootstrap;
PFResult pf_helper_bootstrap_decode(PFByteView, uint64_t, PFHelperBootstrap *);
PFResult pf_helper_bootstrap_ack(const PFHelperBootstrap *, unsigned char[48]);
#endif
