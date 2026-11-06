package main

import (
	"fmt"
	"os"
	"time"
)

const maxFileOpenRecords = 128

// FileOpenMilestone accepts only the renderer's fixed stages and count shapes.
// An attempt identifies one renderer drain, which may consume multiple paths.
func (d *Desktop) FileOpenMilestone(attempt int, stage string, counts []int) {
	if d.startup == nil || attempt < 1 || attempt > maxFileOpenRecords {
		return
	}
	want := 0
	switch stage {
	case "startup-drain", "renderer-wake", "detail-finished", "renderer-failed":
	case "renderer-received":
		want = 1
	case "renderer-imported":
		want = 3
	default:
		return
	}
	if len(counts) != want {
		return
	}
	for _, count := range counts {
		if count < 0 {
			return
		}
	}
	d.startup.fileOpen(attempt, stage, counts...)
}

func (t *startupTrace) fileOpen(attempt int, stage string, counts ...int) {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.fileOpenRecords >= maxFileOpenRecords {
		return
	}
	t.fileOpenRecords++
	detail := ""
	switch len(counts) {
	case 1:
		detail = fmt.Sprintf(" count=%d", counts[0])
	case 3:
		detail = fmt.Sprintf(" added=%d existing=%d failed=%d", counts[0], counts[1], counts[2])
	}
	fmt.Fprintf(t.output, "OpenLR file-open milestone %s pid=%d elapsed_ms=%d attempt=%d%s\n",
		stage, os.Getpid(), time.Since(t.started).Milliseconds(), attempt, detail)
}
