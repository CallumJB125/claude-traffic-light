#ifndef PF_KEEPER_H
#define PF_KEEPER_H
#include <sys/types.h>
int pf_spawn(const char *file, char *const argv[], char *const env[], const char *cwd, unsigned short cols, unsigned short rows, int *master, char *tty);
int pf_peer(int fd, int development, const char *team, char *identifier, int identifier_size, int *build);
int pf_verify_executable(const char *file, const char *requirement);
int pf_locked(void);
#endif
