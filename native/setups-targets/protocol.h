#ifndef PF_SETUPS_PROTOCOL_H
#define PF_SETUPS_PROTOCOL_H
#include "snapshot.h"
#define PF_FRAME_PAYLOAD (768u * 1024u)
#define PF_FRAME_OVERHEAD 72u
#define PF_FRAME_AGGREGATE (4u * 1024u * 1024u)
#define PF_PROTOCOL_MAX_FRAMES 64u
typedef struct PFProtocol PFProtocol;
PFResult pf_protocol_process(PFProtocol *, PFByteView, unsigned char *, uint32_t, uint32_t *);
/* No launcher, generic pipe/path, bootstrap-from-argv or public key setter. */
void pf_protocol_close(PFProtocol *);
#endif
