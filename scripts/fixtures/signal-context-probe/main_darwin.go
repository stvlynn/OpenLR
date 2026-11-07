//go:build darwin && arm64

package main

import (
	"bufio"
	"fmt"
	"os"
	"sync/atomic"

	"github.com/ebitengine/purego"
)

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: signal-context-probe native.dylib brk0|brk1|raise")
		os.Exit(2)
	}
	modes := map[string]int32{"brk0": 0, "brk1": 1, "raise": 2}
	mode, ok := modes[os.Args[2]]
	if !ok {
		fmt.Fprintln(os.Stderr, "unknown signal calibration mode")
		os.Exit(2)
	}
	handle, err := purego.Dlopen(os.Args[1], purego.RTLD_NOW|purego.RTLD_LOCAL)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	var start func(uintptr, int32) int32
	purego.RegisterLibFunc(&start, handle, "openlr_signal_probe")
	var calls atomic.Uint32
	callback := purego.NewCallback(func(value uintptr) uintptr {
		if value != 0x4f4c5253 || calls.Add(1) != 1 {
			return 0
		}
		return value + 1
	})
	if os.Getenv("OPENLR_SIGNAL_PROBE_WAIT") == "1" {
		fmt.Printf("OpenLR signal fixture {\"kind\":\"controller-ready\",\"pid\":%d}\n", os.Getpid())
		if value, err := bufio.NewReader(os.Stdin).ReadByte(); err != nil || value != '\n' {
			fmt.Fprintln(os.Stderr, "signal calibration controller did not release the fixture")
			os.Exit(2)
		}
	}
	// A foreign pthread enters Go once and returns to C before the trap. This
	// exercises the runtime's extra-M signal path without a fixture handler.
	status := start(callback, mode)
	fmt.Fprintf(os.Stderr, "signal calibration unexpectedly returned: status=%d callbacks=%d\n", status, calls.Load())
	os.Exit(3)
}
