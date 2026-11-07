#include <dlfcn.h>
#include <inttypes.h>
#include <mach/machine.h>
#include <mach-o/loader.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#if !defined(__APPLE__) || !defined(__aarch64__)
#error This fixture requires macOS ARM64
#endif

extern void openlr_brk0(void);
extern void openlr_brk1(void);

// Exported instruction labels make the trap address independent of compiler
// prologues. There is deliberately no fixture signal or exception handler.
__asm__(".text\n"
        ".p2align 2\n"
        ".globl _openlr_brk0\n"
        "_openlr_brk0:\n"
        "brk #0\n"
        "ret\n"
        ".globl _openlr_brk1\n"
        "_openlr_brk1:\n"
        "brk #1\n"
        "ret\n");

static void json_string(const char *value) {
    putchar('"');
    for (const unsigned char *p = (const unsigned char *)value; *p; p++) {
        if (*p == '"' || *p == '\\') printf("\\%c", *p);
        else if (*p < 0x20) printf("\\u%04x", *p);
        else putchar(*p);
    }
    putchar('"');
}

static int print_image(const char *role, const void *address) {
    Dl_info info;
    if (!address || !dladdr(address, &info) || !info.dli_fbase || !info.dli_fname) return -1;
    const struct mach_header_64 *header = info.dli_fbase;
    if (header->magic != MH_MAGIC_64) return -1;
    const struct load_command *command = (const void *)(header + 1);
    const struct uuid_command *uuid = NULL;
    const struct segment_command_64 *text = NULL;
    for (uint32_t i = 0; i < header->ncmds; i++) {
        if (command->cmd == LC_UUID) uuid = (const void *)command;
        if (command->cmd == LC_SEGMENT_64) {
            const struct segment_command_64 *segment = (const void *)command;
            if (!strcmp(segment->segname, "__TEXT")) text = segment;
        }
        command = (const void *)((const char *)command + command->cmdsize);
    }
    if (!uuid || !text) return -1;
    printf("OpenLR signal fixture {\"kind\":\"image\",\"role\":");
    json_string(role);
    printf(",\"path\":");
    json_string(info.dli_fname);
    printf(",\"symbol\":");
    json_string(info.dli_sname ? info.dli_sname : "");
    printf(",\"arch\":\"%s\",\"address\":\"0x%016" PRIxPTR "\",\"symbolAddress\":\"0x%016" PRIxPTR
           "\",\"base\":\"0x%016" PRIxPTR "\",\"textSize\":\"0x%016" PRIx64
           "\",\"textVMAddress\":\"0x%016" PRIx64 "\",\"uuid\":\"",
           (header->cpusubtype & ~CPU_SUBTYPE_MASK) == CPU_SUBTYPE_ARM64E ? "arm64e" : "arm64",
           (uintptr_t)address, (uintptr_t)info.dli_saddr, (uintptr_t)info.dli_fbase,
           text->vmsize, text->vmaddr);
    for (int i = 0; i < 16; i++) printf("%02x", uuid->uuid[i]);
    printf("\"}\n");
    return 0;
}

struct probe_args {
    uintptr_t (*callback)(uintptr_t);
    int mode;
};

static void *foreign_thread(void *opaque) {
    struct probe_args *args = opaque;
    uintptr_t result = args->callback(0x4f4c5253);
    if (result != 0x4f4c5254) _exit(90);
    void *pthread_kill_entry = dlsym(RTLD_DEFAULT, "__pthread_kill");
    if (print_image("fixture", (const void *)openlr_brk0) ||
        print_image("raise", (const void *)raise) ||
        print_image("pthread-kill", pthread_kill_entry)) _exit(91);
    uintptr_t stack_high = (uintptr_t)pthread_get_stackaddr_np(pthread_self());
    size_t stack_size = pthread_get_stacksize_np(pthread_self());
    printf("OpenLR signal fixture {\"kind\":\"ready\",\"mode\":%d,\"callbacks\":1,"
           "\"brk0\":\"0x%016" PRIxPTR "\",\"brk1\":\"0x%016" PRIxPTR
           "\",\"brk0Word\":\"0x%08" PRIx32 "\",\"brk1Word\":\"0x%08" PRIx32
           "\",\"stackLow\":\"0x%016" PRIxPTR "\",\"stackHigh\":\"0x%016" PRIxPTR
           "\",\"siUser\":%d,\"trapBreakpoint\":%d,\"trapTrace\":%d}\n",
           args->mode, (uintptr_t)openlr_brk0, (uintptr_t)openlr_brk1,
           *(const uint32_t *)(const void *)openlr_brk0, *(const uint32_t *)(const void *)openlr_brk1,
           stack_high - stack_size, stack_high, SI_USER, TRAP_BRKPT, TRAP_TRACE);
    fflush(stdout);
    if (args->mode == 0) openlr_brk0();
    else if (args->mode == 1) openlr_brk1();
    else if (args->mode == 2) raise(SIGTRAP);
    _exit(92);
}

__attribute__((visibility("default")))
int32_t openlr_signal_probe(uintptr_t callback, int32_t mode) {
    if (!callback || mode < 0 || mode > 2) return -1;
    struct probe_args args = {(uintptr_t (*)(uintptr_t))callback, mode};
    pthread_t thread;
    int error = pthread_create(&thread, NULL, foreign_thread, &args);
    if (error) return error;
    return pthread_join(thread, NULL);
}
