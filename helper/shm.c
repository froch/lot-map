// The helper's POSIX shared-memory calls. shm_open is variadic, which bun:ffi cannot call reliably on Apple arm64,
// so shm.ts compiles this file with TinyCC (bun:ffi `cc`) when the helper starts. Each call returns 0 or -errno.
#include <errno.h>
#include <fcntl.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

/** Creates `name` (it must not exist: -EEXIST while it is unread), mode 0600, sized to `len`, and copies `data` in. */
int shm_put(const char *name, const uint8_t *data, size_t len) {
  int fd = shm_open(name, O_CREAT | O_EXCL | O_RDWR, 0600);
  if (fd < 0) return -errno;
  int e = 0;
  if (ftruncate(fd, (off_t)len) != 0) {
    e = errno;
  } else if (len > 0) {
    void *p = mmap(NULL, len, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (p == MAP_FAILED) {
      e = errno;
    } else {
      memcpy(p, data, len);
      munmap(p, len);
    }
  }
  close(fd);
  if (e != 0) {
    shm_unlink(name);
    return -e;
  }
  return 0;
}

/** shm_unlink: 0, or -errno (-ENOENT once the terminal has read and unlinked it). */
int shm_drop(const char *name) {
  return shm_unlink(name) == 0 ? 0 : -errno;
}

/**
 * Copies the first `len` bytes of `name` into `out`, as a terminal reads a frame; it neither creates nor unlinks.
 * With `len` 0 it only checks that the name exists. -EINVAL when the object is smaller than `len`
 * (macOS reports a size rounded up to whole pages, so a frame's own length always fits).
 */
int shm_read(const char *name, uint8_t *out, size_t len) {
  int fd = shm_open(name, O_RDONLY);
  if (fd < 0) return -errno;
  int e = 0;
  struct stat st;
  if (fstat(fd, &st) != 0) {
    e = errno;
  } else if ((uint64_t)st.st_size < (uint64_t)len) {
    e = EINVAL;
  } else if (len > 0) {
    void *p = mmap(NULL, len, PROT_READ, MAP_SHARED, fd, 0);
    if (p == MAP_FAILED) {
      e = errno;
    } else {
      memcpy(out, p, len);
      munmap(p, len);
    }
  }
  close(fd);
  return -e;
}
