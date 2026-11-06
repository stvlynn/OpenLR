package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/egoist/mygo"
)

// Startup diagnostics retain only the first occurrence of each stage. They
// log host-relative time and fixed names, independent of request or page data.
type startupTrace struct {
	started  time.Time
	output   io.Writer
	mu       sync.Mutex
	seen     map[string]bool
	uiProbe  sync.Once
	uiPumped chan struct{}
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
	json.NewEncoder(w).Encode(map[string]bool{"responded": t.probeUI(ctx, mygo.RunOnMain)})
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
