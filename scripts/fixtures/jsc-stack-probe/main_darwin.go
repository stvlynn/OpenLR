//go:build darwin && arm64

package main

import (
	"fmt"
	"os"
	"runtime"
	"sync/atomic"
	"time"
	"unsafe"

	"github.com/ebitengine/purego"
)

// readStackPointer observes this callback's Go stack, not JSC's suspended sample.
func readStackPointer() uintptr

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: jsc-stack-probe native.dylib native-c|go-busy|go-to-c")
		os.Exit(2)
	}
	modes := map[string]int32{"native-c": 0, "go-busy": 1, "go-to-c": 2}
	mode, ok := modes[os.Args[2]]
	if !ok {
		fmt.Fprintln(os.Stderr, "unknown stack probe mode")
		os.Exit(2)
	}
	// Keep the mutator pthread identical across modes; this does not keep a Go
	// callback on the native pthread stack and is not a proposed integration fix.
	runtime.LockOSThread()
	handle, err := purego.Dlopen(os.Args[1], purego.RTLD_NOW|purego.RTLD_LOCAL)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	var start func(int32, uintptr) int32
	var nativeWait func(uintptr) uintptr
	purego.RegisterLibFunc(&start, handle, "openlr_jsc_stack_probe")
	purego.RegisterLibFunc(&nativeWait, handle, "openlr_jsc_native_wait")
	var callbacks atomic.Uint32
	callback := purego.NewCallback(func(shared uintptr) uintptr {
		if shared == 0 || shared&7 != 0 || callbacks.Add(1) != 1 {
			return 91
		}
		sp := readStackPointer()
		fmt.Printf("OpenLR JSC stack probe {\"event\":\"callback-entry\",\"pid\":%d,\"mode\":%q,\"sp\":\"0x%x\",\"scope\":\"Go callback observation; not JSC sampled SP\"}\n", os.Getpid(), os.Args[2], sp)
		if mode == 2 {
			return nativeWait(shared)
		}
		if mode != 1 {
			return 92
		}
		// Slots are aligned uint64_t atomics allocated/owned by the C wrapper.
		// No Go pointer is passed into or retained by C. The C call owns their
		// lifetime until this callback returns and its collector joins.
		ready := (*uint64)(unsafe.Pointer(shared))
		done := (*uint64)(unsafe.Pointer(shared + 8))
		failed := (*uint64)(unsafe.Pointer(shared + 16))
		deadline := time.Now().Add(8 * time.Second)
		fmt.Printf("OpenLR JSC stack probe {\"event\":\"waiting-stack\",\"pid\":%d,\"mode\":%q,\"sp\":\"0x%x\",\"scope\":\"Go callback observation before ready; not JSC sampled SP\"}\n", os.Getpid(), os.Args[2], sp)
		atomic.StoreUint64(ready, 1)
		for count := uint64(0); atomic.LoadUint64(done) == 0; count++ {
			// No channel, sleep, Gosched or outbound FFI in the active wait.
			if count&65535 == 0 && time.Now().After(deadline) {
				atomic.StoreUint64(failed, 1)
				return 93
			}
		}
		return 0
	})
	status := start(mode, callback)
	expected := uint32(1)
	if mode == 0 {
		expected = 0
	}
	if status != 0 || callbacks.Load() != expected {
		fmt.Fprintf(os.Stderr, "OpenLR JSC stack error returned status=%d callbacks=%d expected=%d\n", status, callbacks.Load(), expected)
		os.Exit(3)
	}
}
