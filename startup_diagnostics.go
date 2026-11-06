package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"runtime"
	"sync"
	"time"

	"github.com/egoist/mygo"
)

// Startup milestones retain only the first occurrence of each stage. The
// separate file-open stream retains repeated stages with a per-process cap.
type startupTrace struct {
	started         time.Time
	output          io.Writer
	mu              sync.Mutex
	seen            map[string]bool
	fileOpenRecords int
	uiProbe         sync.Once
	uiPumped        chan struct{}
}

func newStartupTrace(output io.Writer) *startupTrace {
	return &startupTrace{started: time.Now(), output: output, seen: make(map[string]bool), uiPumped: make(chan struct{})}
}

func (t *startupTrace) mark(stage string) {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.seen[stage] {
		return
	}
	t.seen[stage] = true
	fmt.Fprintf(t.output, "OpenLR startup milestone %s elapsed_ms=%d\n", stage, time.Since(t.started).Milliseconds())
}

func (t *startupTrace) observeWindow(window *mygo.Window) {
	t.mark("window-created")
	page := window.Page()
	page.OnDidNavigate(func(string) { t.mark("navigation-committed") })
	page.OnDOMReady(func() { t.mark("dom-ready") })
	page.OnDidFinishLoad(func() { t.mark("load-finished") })
	page.OnDidFailLoad(func(*mygo.LoadError) { t.mark("load-failed") })
	page.OnRenderProcessGone(func(string) { t.mark("renderer-gone") })
	t.mark("window-observers-attached")
}

func (t *startupTrace) serveUIProbe(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), time.Second)
	defer cancel()
	response := struct {
		Responded    bool     `json:"responded"`
		GoMainFrames []string `json:"goMainFrames,omitempty"`
	}{Responded: t.probeUI(ctx, mygo.RunOnMain)}
	if runtime.GOOS == "windows" && !response.Responded && r.Context().Err() == nil {
		response.GoMainFrames = mainGoroutineFrames()
	}
	json.NewEncoder(w).Encode(response)
}

// The Windows desktop runs MyGo's event loop on the main goroutine. Export
// only function names from its Go stack, keeping paths and values private.
func mainGoroutineFrames() []string {
	records := make([]runtime.StackRecord, runtime.NumGoroutine())
	n, ok := runtime.GoroutineProfile(records)
	if !ok {
		records = make([]runtime.StackRecord, n)
		n, ok = runtime.GoroutineProfile(records)
		if !ok {
			return nil
		}
	}
	for i := range records[:n] {
		frames := runtime.CallersFrames(records[i].Stack())
		var names []string
		for {
			frame, more := frames.Next()
			if frame.Function != "" {
				names = append(names, frame.Function)
			}
			if frame.Function == "main.main" {
				return names
			}
			if !more {
				break
			}
		}
	}
	return nil
}

func (t *startupTrace) probeUI(ctx context.Context, runOnMain func(func())) bool {
	// RunOnMain waits for dispatch and exposes no cancellation. A failed probe
	// may leave one waiting goroutine until the UI pumps or the host exits.
	t.uiProbe.Do(func() {
		go runOnMain(func() { close(t.uiPumped) })
	})
	select {
	case <-t.uiPumped:
		return true
	case <-ctx.Done():
		return false
	}
}

// StartupMilestone accepts only fixed diagnostic stage names from the renderer.
func (d *Desktop) StartupMilestone(stage string) {
	switch stage {
	case "renderer-script", "renderer-script-failed", "renderer-agent-ready",
		"catalog-read-started", "catalog-read-finished", "workspace-ready", "workspace-ready-failed",
		"ordinary-renderer-received", "ordinary-dispatch-finished",
		"control-renderer-received", "control-dispatch-finished":
		d.startup.mark(stage)
	}
}
