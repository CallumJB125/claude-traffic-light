#ifndef PF_SETUPS_PROTOCOL_PRIVATE_H
#define PF_SETUPS_PROTOCOL_PRIVATE_H
#include "protocol.h"
#include "recovery-private.h"
#include "store.h"
typedef struct { PFChannelBinding authority; unsigned char key[32]; } PFPrivateBootstrap;
/* Trusted owned bootstrap only; current production launcher does not exist. */
PFResult pf_private_protocol_open(PFRoot *, PFRoot *, const PFPrivateBootstrap *, PFProtocol **);
void pf_private_preparation_codec(PFCodec *, PFPreparationFields *);
void pf_private_permit_codec(PFCodec *, PFPermitFields *);
void pf_private_recovery_codec(PFCodec *, PFRecoveryFields *);
void pf_private_restore_codec(PFCodec *, PFRestoreFields *);
/* Owned anonymous nonblocking pipes only, supplied by a trusted future launcher. */
PFResult pf_private_protocol_serve(PFProtocol *, int, int);
uint64_t pf_private_protocol_cutoff(const PFProtocol *);
void pf_private_protocol_stop(PFProtocol *);
#ifdef PF_PACKET_FIXTURE
PFResult pf_fixture_frame(const PFPrivateBootstrap *, uint16_t, uint32_t, const unsigned char[16], PFByteView, unsigned char *, uint32_t, uint32_t *);
#endif
#endif
