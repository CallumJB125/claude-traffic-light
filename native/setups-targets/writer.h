#ifndef PF_SETUPS_WRITER_H
#define PF_SETUPS_WRITER_H
#include "reader.h"
#define PF_WRITER_HOLD_ID_BYTES 64u
#define PF_WRITER_HASH_BYTES 32u
#define PF_WRITER_MAX_HOLDS 32u
typedef enum {
  PF_WRITE_PREPARED = 1, PF_WRITE_APPLY_INTENT, PF_WRITE_APPLIED,
  PF_WRITE_NOOP, PF_WRITE_UNDO_INTENT, PF_WRITE_UNDONE,
  PF_WRITE_CONFLICT, PF_WRITE_UNKNOWN
} PFWritePhase;
typedef struct {
  PFWritePhase phase;
  PFResult result;
  unsigned sequence, namespace_effect, existed;
  PFStamp target, displaced;
  unsigned char target_hash[PF_WRITER_HASH_BYTES], displaced_hash[PF_WRITER_HASH_BYTES];
  char hold_id[PF_WRITER_HOLD_ID_BYTES];
} PFWriteReceipt;
typedef struct PFWriteTxn PFWriteTxn;
/* Trusted serialized native-module calls only. before/after are exact bytes
 * from an already validated format/permission plan; this primitive neither
 * merges nor sanitizes their content. Main authority and authenticated encrypted
 * full-set snapshots are prerequisites to any future app binding.
 * NULL expected means an absent leaf, not an absent parent. Existing before
 * bytes/stamp must match the current leaf. Only the first three recipes work.
 * No path, hold adoption, shell, transport or Node journal mutator is exposed. */
PFResult pf_writer_prepare(PFRoot *root, PFRecipe recipe, const PFStamp *expected,
                          const unsigned char *before, size_t before_size,
                          const unsigned char *after, size_t after_size,
                          PFWriteTxn **out);
/* Apply/Undo attempts consume their own single attempt. Any uncertain effect
 * poisons further mutation. A SWAP is observed replacement, never hash/inode
 * CAS: raced foreign objects may move, and every displaced object is retained. */
PFResult pf_writer_apply(PFWriteTxn *txn, PFWriteReceipt *out);
PFResult pf_writer_undo(PFWriteTxn *txn, PFWriteReceipt *out);
PFResult pf_writer_check(PFWriteTxn *txn, PFWriteReceipt *out);
/* Closing releases descriptors/memory only. Never removes/prunes any disk
 * object, including snapshots, stages, intent, displaced/old-open-fd variants. */
void pf_writer_close(PFWriteTxn *txn);
#endif
