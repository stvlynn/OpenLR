#define _DARWIN_C_SOURCE 1
#include <JavaScriptCore/JavaScript.h>
#include <dlfcn.h>
#include <mach-o/loader.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

// Generated diagnostic state only. No Go pointer is retained by native code.
typedef struct {
    _Alignas(8) _Atomic uint64_t ready;
    _Atomic uint64_t done;
    _Atomic uint64_t wait_failed;
} Shared;

_Static_assert(sizeof(_Atomic uint64_t) == sizeof(uint64_t), "Shared atomic width");
_Static_assert(_Alignof(Shared) >= 8, "Shared atomic alignment");
_Static_assert(offsetof(Shared, done) == 8 && offsetof(Shared, wait_failed) == 16, "Shared atomic offsets");

typedef uintptr_t (*Callback)(uintptr_t);
typedef struct { JSGlobalContextRef context; Shared *shared; } Collector;
static const char *mode_name;
static _Atomic uint64_t native_finalizers;
static _Atomic uint64_t finalization_in_exposure;

// JavaScriptCore may finalize on any thread. This callback only increments a
// lock-free native counter; it does not call Go or allocate/call any JSC API.
static void finalized(JSObjectRef object)
{
    (void)object;
    atomic_fetch_add_explicit(&native_finalizers, 1, memory_order_seq_cst);
}

__attribute__((noinline))
static void create_sentinels(JSGlobalContextRef context)
{
    JSClassDefinition definition = kJSClassDefinitionEmpty;
    definition.finalize = finalized;
    JSClassRef sentinel_class = JSClassCreate(&definition);
    for (unsigned index = 0; index < 8; index++)
        (void)JSObjectMake(context, sentinel_class, NULL);
    JSClassRelease(sentinel_class);
}

static uint64_t milliseconds(void)
{
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now)) _Exit(80);
    return (uint64_t)now.tv_sec * 1000 + (uint64_t)now.tv_nsec / 1000000;
}

static uintptr_t stack_pointer(void)
{
    uintptr_t value;
    __asm__ volatile("mov %0, sp" : "=r" (value));
    return value;
}

static void pause_briefly(void)
{
    struct timespec duration = { .tv_sec = 0, .tv_nsec = 1000000 };
    nanosleep(&duration, NULL);
}

static int loaded_jsc_uuid(char result[37])
{
    Dl_info info;
    if (!dladdr((const void *)&JSGlobalContextCreate, &info) || !info.dli_fbase) return 0;
    const struct mach_header_64 *header = info.dli_fbase;
    if (header->magic != MH_MAGIC_64 || header->ncmds > 4096 || header->sizeofcmds > 1024 * 1024) return 0;
    const unsigned char *position = (const unsigned char *)(header + 1);
    const unsigned char *end = position + header->sizeofcmds;
    unsigned matches = 0;
    for (uint32_t i = 0; i < header->ncmds; i++) {
        if ((size_t)(end - position) < sizeof(struct load_command)) return 0;
        const struct load_command *command = (const struct load_command *)position;
        if (command->cmdsize < sizeof(*command) || command->cmdsize > (size_t)(end - position)) return 0;
        if (command->cmd == LC_UUID) {
            if (command->cmdsize != sizeof(struct uuid_command) || ++matches != 1) return 0;
            const unsigned char *u = ((const struct uuid_command *)position)->uuid;
            snprintf(result, 37,
                "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
                u[0],u[1],u[2],u[3],u[4],u[5],u[6],u[7],u[8],u[9],u[10],u[11],u[12],u[13],u[14],u[15]);
        }
        position += command->cmdsize;
    }
    return matches == 1 && position == end;
}

static void record_waiting_stack(uintptr_t sp)
{
    pthread_t thread = pthread_self();
    uintptr_t origin = (uintptr_t)pthread_get_stackaddr_np(thread);
    size_t size = pthread_get_stacksize_np(thread);
    printf("OpenLR JSC stack probe {\"event\":\"waiting-stack\",\"pid\":%d,\"mode\":\"%s\",\"sp\":\"0x%llx\",\"pthreadLow\":\"0x%llx\",\"pthreadOrigin\":\"0x%llx\",\"pthreadSize\":%zu,\"scope\":\"fixture observation before ready; not JSC sampled SP\"}\n",
        getpid(), mode_name, (unsigned long long)sp, (unsigned long long)(origin-size), (unsigned long long)origin, size);
    fflush(stdout);
}

// A and C use precisely this body. C reaches it by an outbound purego call.
uintptr_t openlr_jsc_native_wait(uintptr_t argument)
{
    Shared *shared = (Shared *)argument;
    uint64_t deadline = milliseconds() + 8000;
    record_waiting_stack(stack_pointer());
    atomic_store_explicit(&shared->ready, 1, memory_order_seq_cst);
    while (!atomic_load_explicit(&shared->done, memory_order_seq_cst)) {
        if (milliseconds() >= deadline) {
            atomic_store_explicit(&shared->wait_failed, 1, memory_order_seq_cst);
            return 71;
        }
        pause_briefly();
    }
    return 0;
}

static void *collect(void *argument)
{
    Collector *collector = argument;
    uint64_t deadline = milliseconds() + 8000;
    while (!atomic_load_explicit(&collector->shared->ready, memory_order_seq_cst)) {
        if (milliseconds() >= deadline) {
            fprintf(stderr, "OpenLR JSC stack error collector-ready-timeout\n");
            fflush(stderr);
            _Exit(72);
        }
        pause_briefly();
    }
    printf("OpenLR JSC stack probe {\"event\":\"collection-started\",\"pid\":%d,\"mode\":\"%s\"}\n", getpid(), mode_name);
    fflush(stdout);
    // No other thread is using a JSC API here. The mutator's earlier API calls
    // returned before callback entry; it holds no JS lock while waiting.
    create_sentinels(collector->context);
    JSGarbageCollect(collector->context);
    printf("OpenLR JSC stack probe {\"event\":\"collection-returned\",\"pid\":%d,\"mode\":\"%s\",\"api\":\"JSGarbageCollect\",\"synchronous\":false}\n", getpid(), mode_name);
    fflush(stdout);
    // API return is not collection completion. A bounded allocation workload
    // gives the engine opportunities to collect; a native finalizer is the
    // independent observation, before this context can be released.
    JSStringRef pressure = JSStringCreateWithUTF8CString(
        "(function(){let a=[];for(let i=0;i<4096;i++)"
        "a.push({i:i,text:'openlr-owned-collection-probe'});return a.length;})()");
    uint64_t exposure_started = milliseconds();
    uint64_t iterations = 0;
    while (!atomic_load_explicit(&native_finalizers, memory_order_seq_cst) &&
           iterations < 256 && milliseconds() - exposure_started < 6000) {
        JSValueRef exception = NULL;
        JSValueRef value = JSEvaluateScript(collector->context, pressure, NULL, NULL, 1, &exception);
        if (!value || exception || JSValueToNumber(collector->context, value, NULL) != 4096) _Exit(89);
        iterations++;
        if (iterations % 8 == 0) JSGarbageCollect(collector->context);
    }
    JSStringRelease(pressure);
    uint64_t observed = atomic_load_explicit(&native_finalizers, memory_order_seq_cst);
    atomic_store_explicit(&finalization_in_exposure, observed > 0, memory_order_seq_cst);
    printf("OpenLR JSC stack probe {\"event\":\"exposure-ended\",\"pid\":%d,\"mode\":\"%s\",\"windowMs\":%llu,\"windowLimitMs\":6000,\"iterations\":%llu,\"iterationLimit\":256,\"gcFinalizationObserved\":%s,\"finalizersBeforeContextRelease\":%llu,\"scope\":\"native finalizer before context release; not a sampled mutator SP or full-phase trace\"}\n",
        getpid(), mode_name, (unsigned long long)(milliseconds()-exposure_started),
        (unsigned long long)iterations, observed ? "true" : "false", (unsigned long long)observed);
    fflush(stdout);
    atomic_store_explicit(&collector->shared->done, 1, memory_order_seq_cst);
    return NULL;
}

int32_t openlr_jsc_stack_probe(int32_t mode, uintptr_t callback_address)
{
    const char *names[] = { "native-c", "go-busy", "go-to-c" };
    if (mode < 0 || mode > 2 || (mode && !callback_address)) return 81;
    mode_name = names[mode];
    char uuid[37];
    if (!loaded_jsc_uuid(uuid)) return 82;
    printf("OpenLR JSC stack probe {\"event\":\"loaded-image\",\"pid\":%d,\"mode\":\"%s\",\"jscUUID\":\"%s\"}\n", getpid(), mode_name, uuid);
    fflush(stdout);
    pthread_t mutator = pthread_self();
    uintptr_t origin = (uintptr_t)pthread_get_stackaddr_np(mutator);
    size_t stack_size = pthread_get_stacksize_np(mutator);
    printf("OpenLR JSC stack probe {\"event\":\"mutator-native-stack\",\"pid\":%d,\"mode\":\"%s\",\"sp\":\"0x%llx\",\"pthreadLow\":\"0x%llx\",\"pthreadOrigin\":\"0x%llx\",\"pthreadSize\":%zu,\"scope\":\"native fixture observation; not JSC cached bounds or sampled SP\"}\n",
        getpid(), mode_name, (unsigned long long)stack_pointer(), (unsigned long long)(origin-stack_size), (unsigned long long)origin, stack_size);
    fflush(stdout);
    Shared *shared = calloc(1, sizeof(*shared));
    if (!shared) return 83;
    atomic_init(&shared->ready, 0);
    atomic_init(&shared->done, 0);
    atomic_init(&shared->wait_failed, 0);
    if (!atomic_is_lock_free(&shared->ready) || !atomic_is_lock_free(&shared->done) ||
        !atomic_is_lock_free(&native_finalizers)) { free(shared); return 88; }
    JSGlobalContextRef context = JSGlobalContextCreate(NULL);
    if (!context) { free(shared); return 84; }
    // Fixed, small generated allocation pressure. No original/user data.
    JSStringRef source = JSStringCreateWithUTF8CString(
        "(function(){globalThis.openlrProbe=[];for(let i=0;i<4096;i++)"
        "openlrProbe.push({i:i,text:'openlr-owned-stack-probe'});"
        "globalThis.openlrProbe=null;return 4096;})()");
    JSValueRef exception = NULL;
    JSValueRef result = JSEvaluateScript(context, source, NULL, NULL, 1, &exception);
    JSStringRelease(source);
    if (exception || !result || JSValueToNumber(context, result, NULL) != 4096) { JSGlobalContextRelease(context); free(shared); return 85; }
    printf("OpenLR JSC stack probe {\"event\":\"setup-returned\",\"pid\":%d,\"mode\":\"%s\",\"objects\":4096,\"scope\":\"JSC API returned before waiting; no mutator JS lock retained\"}\n", getpid(), mode_name);
    fflush(stdout);
    Collector collector = { .context = context, .shared = shared };
    pthread_t thread;
    int error = pthread_create(&thread, NULL, collect, &collector);
    if (error) { JSGlobalContextRelease(context); free(shared); return 86; }
    uintptr_t status = mode ? ((Callback)callback_address)((uintptr_t)shared) : openlr_jsc_native_wait((uintptr_t)shared);
    if (status || atomic_load_explicit(&shared->wait_failed, memory_order_seq_cst)) {
        fprintf(stderr, "OpenLR JSC stack error waiting-failed status=%llu\n", (unsigned long long)status);
        fflush(stderr);
        // The collector may still hold the VM; never release/free its objects.
        // Parent records this failed process exit independently.
        _Exit(73);
    }
    error = pthread_join(thread, NULL);
    if (error) _Exit(74);
    uint64_t ready = atomic_load_explicit(&shared->ready, memory_order_seq_cst);
    uint64_t done = atomic_load_explicit(&shared->done, memory_order_seq_cst);
    uint64_t finalizers_observed_in_exposure = atomic_load_explicit(&finalization_in_exposure, memory_order_seq_cst);
    JSGlobalContextRelease(context);
    free(shared);
    printf("OpenLR JSC stack probe {\"event\":\"completed\",\"pid\":%d,\"mode\":\"%s\",\"ready\":%llu,\"done\":%llu,\"collectorJoined\":true}\n", getpid(), mode_name, (unsigned long long)ready, (unsigned long long)done);
    fflush(stdout);
    if (!finalizers_observed_in_exposure) return 90;
    return ready == 1 && done == 1 ? 0 : 87;
}
