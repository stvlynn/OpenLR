package main

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/egoist/mygo"
)

//go:embed probe.html probe.js child.html
var assets embed.FS

var progress = mygo.NewEvent[string]("scheme-probe:progress")

type SchemeProbe struct {
	mu            sync.Mutex
	checks        map[string]bool
	errors        []string
	report        string
	window        *mygo.Window
	started       atomic.Bool
	finished      atomic.Bool
	secondReady   chan struct{}
	loadFailed    chan struct{}
	prevented     chan struct{}
	pageCanceled  chan struct{}
	reservedLeaks atomic.Int32
	failedURL     string
}

func (p *SchemeProbe) check(name string, ok bool, detail string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.checks[name] = ok
	if !ok {
		p.errors = append(p.errors, name+": "+detail)
	}
	log.Printf("scheme-probe check %s=%t", name, ok)
}

func (p *SchemeProbe) Echo(value string) string { return value }

func (p *SchemeProbe) Stream(values *mygo.Channel[string]) error {
	// More than the existing 1 MiB channel window: ACKs must be admitted
	// while this method is blocked on backpressure.
	for i := range 24 {
		if err := values.Send(fmt.Sprintf("%d:", i) + strings.Repeat("λ", 65536)); err != nil {
			return err
		}
	}
	return nil
}

func (p *SchemeProbe) Event(ctx context.Context) error {
	return progress.Emit(mygo.CallerWindow(ctx), "event:漢字🌍\u0000")
}

func (p *SchemeProbe) WaitForNavigation(ctx context.Context) error {
	<-ctx.Done()
	select {
	case p.pageCanceled <- struct{}{}:
	default:
	}
	return ctx.Err()
}

func (p *SchemeProbe) RendererChecks(checks map[string]bool) {
	for name, ok := range checks {
		p.check("renderer/"+name, ok, "renderer assertion failed")
	}
}

func (p *SchemeProbe) RendererError(message string) {
	p.check("renderer/error", false, message)
	p.finish()
}

func (p *SchemeProbe) Ready(ctx context.Context, phase string) {
	if phase == "second" {
		select {
		case p.secondReady <- struct{}{}:
		default:
		}
		return
	}
	if !p.started.CompareAndSwap(false, true) {
		return
	}
	p.window = mygo.CallerWindow(ctx)
	go p.run()
}

func (p *SchemeProbe) eval(name, code, expected string) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	value, err := p.window.Page().EvalContext(ctx, code)
	encoded, encodeErr := json.Marshal(value)
	p.check(name, err == nil && encodeErr == nil && string(encoded) == expected,
		fmt.Sprintf("result=%s error=%v", encoded, err))
}

func (p *SchemeProbe) evalError(name, code, contains string) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	_, err := p.window.Page().EvalContext(ctx, code)
	p.check(name, err != nil && strings.Contains(err.Error(), contains), fmt.Sprintf("error=%v", err))
}

func await(signal <-chan struct{}) bool {
	select {
	case <-signal:
		return true
	case <-time.After(8 * time.Second):
		return false
	}
}

func (p *SchemeProbe) run() {
	defer p.finish()
	page := p.window.Page()
	p.eval("eval/expression", "6 * 7", "42")
	p.eval("eval/statements", "const value = 41; return value + 1", "42")
	p.eval("eval/unicode", `"漢字🌍\\\"\n\u0000"`, `"漢字🌍\\\"\n\u0000"`)
	p.eval("eval/promise", `Promise.resolve("resolved")`, `"resolved"`)
	p.evalError("eval/rejected-promise", `Promise.reject(new Error("promise marker"))`, "promise marker")
	p.evalError("eval/native-syntax-error", `const =`, "SyntaxError")
	p.evalError("eval/runtime-error", `(() => { throw new Error("runtime marker") })()`, "runtime marker")
	p.evalError("eval/runtime-syntax-single-execution", `(window.__single = (window.__single || 0) + 1, (() => { throw new SyntaxError("runtime syntax marker") })())`, "runtime syntax marker")
	p.eval("eval/runtime-syntax-counter", `window.__single`, "1")
	p.eval("eval/statements-single-execution", `window.__statementSingle = (window.__statementSingle || 0) + 1; return window.__statementSingle`, "1")
	p.eval("eval/duplicate-reply", `window.__duplicateNextEval = true; return "duplicate"`, `"duplicate"`)
	p.eval("eval/duplicate-rejected", `window.__duplicateStatus`, "409")
	p.evalError("eval/transport-syntax-no-fallback", `(() => { window.__transportSingle = (window.__transportSingle || 0) + 1; const original = window.fetch; window.fetch = () => { window.fetch = original; throw new SyntaxError("injected transport marker") }; return 7 })()`, "OpenLR scheme transport")
	p.eval("eval/transport-single-counter", `window.__transportSingle`, "1")
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	_, err := page.EvalContext(ctx, `new Promise(resolve => setTimeout(() => resolve("late"), 200))`)
	cancel()
	p.check("eval/context-cancellation", errors.Is(err, context.DeadlineExceeded), fmt.Sprintf("error=%v", err))
	p.eval("eval/late-reply-does-not-complete-next", `new Promise(resolve => setTimeout(() => resolve("next"), 300))`, `"next"`)
	p.eval("navigation/same-document", `location.hash = "same-document"; return mygo.call("SchemeProbe.Echo", "hash alive")`, `"hash alive"`)
	p.eval("navigation/prevented-live-page", `location.href = "/blocked"; await new Promise(resolve => setTimeout(resolve, 100)); return mygo.call("SchemeProbe.Echo", "prevented alive")`, `"prevented alive"`)
	p.check("navigation/prevented-observed", await(p.prevented), "policy callback did not prevent navigation")
	// A local TCP peer accepts then closes without sending an HTTP response.
	// This forces an actual provisional failure, rather than a 404 document.
	_ = page.LoadURL(p.failedURL)
	p.check("navigation/provisional-failure-observed", await(p.loadFailed), "no native provisional load error")
	p.eval("navigation/failed-provisional-live-page", `mygo.call("SchemeProbe.Echo", "failure alive")`, `"failure alive"`)
	p.eval("navigation/save-old-envelope", `sessionStorage.setItem("oldEnvelope", window.__capturedEnvelope); return !!window.__capturedEnvelope`, "true")
	p.eval("navigation/start-page-bound-call", `void mygo.call("SchemeProbe.WaitForNavigation").catch(() => {}); await new Promise(resolve => setTimeout(resolve, 100)); return true`, "true")
	pending := make(chan error, 1)
	go func() {
		_, err := page.Eval(`new Promise(() => {})`)
		pending <- err
	}()
	// Serialize a second successful native Eval before navigating, so the
	// preceding unresolved request has definitely been submitted.
	p.eval("navigation/eval-before-commit", `"before commit"`, `"before commit"`)
	_ = page.LoadURL("/probe.html?phase=second")
	p.check("navigation/new-page-ready", await(p.secondReady), "new document failed to establish its bridge")
	p.check("navigation/page-context-canceled", await(p.pageCanceled), "old bound method did not receive cancellation")
	select {
	case err := <-pending:
		p.check("navigation/pending-eval-canceled", err != nil, "old Eval completed successfully")
	case <-time.After(8 * time.Second):
		p.check("navigation/pending-eval-canceled", false, "old Eval remained pending")
	}
	p.eval("navigation/old-envelope-rejected", `const envelope = sessionStorage.getItem("oldEnvelope"); if (!envelope) throw new Error("Missing old replay envelope"); return fetch("mygo://localhost/__openlr_bridge", {method:"POST", body:envelope}).then(response => response.status)`, "403")
	p.eval("navigation/new-page-normal-call", `mygo.call("SchemeProbe.Echo", "new page alive")`, `"new page alive"`)
	p.check("transport/reserved-endpoint-owned", p.reservedLeaks.Load() == 0, "application protocol handler received reserved endpoint")
}

func (p *SchemeProbe) finish() {
	if !p.finished.CompareAndSwap(false, true) {
		return
	}
	p.mu.Lock()
	report := map[string]any{
		"candidate": "OpenLR local frontend scheme bridge; diagnostic only", "checks": p.checks,
		"errors": p.errors, "passed": len(p.errors) == 0,
		"limits": []string{"No native WKFrameInfo attribution on scheme tasks", "CSP-restricted and remote pages unsupported", "Back/forward-cache restoration not validated", "Unsupported-result completion protocol requires target WebKit validation"},
	}
	data, err := json.MarshalIndent(report, "", "  ")
	p.mu.Unlock()
	if err == nil {
		err = os.WriteFile(p.report, append(data, '\n'), 0o600)
	}
	if err != nil {
		log.Printf("scheme-probe report failure: %v", err)
	}
	log.Print("scheme-probe report-written")
	mygo.App.Quit()
}

func main() {
	log.SetFlags(log.Ltime | log.Lmicroseconds)
	if len(os.Args) != 2 {
		log.Fatal("Pass the private report directory")
	}
	dir := os.Args[1]
	if err := os.MkdirAll(dir, 0o700); err != nil {
		log.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatal(err)
	}
	defer listener.Close()
	go func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			_ = connection.Close()
		}
	}()
	p := &SchemeProbe{checks: map[string]bool{}, report: filepath.Join(dir, "report.json"), secondReady: make(chan struct{}, 1), loadFailed: make(chan struct{}, 1), prevented: make(chan struct{}, 1), pageCanceled: make(chan struct{}, 1), failedURL: "http://" + listener.Addr().String() + "/provisional-failure"}
	mygo.SetFrontend(assets)
	_ = mime.AddExtensionType(".js", "text/javascript")
	// The reservation must precede even an application override of mygo://.
	_ = mygo.Protocol.Handle("mygo", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/__openlr_bridge" {
			p.reservedLeaks.Add(1)
		}
		http.FileServer(http.FS(assets)).ServeHTTP(w, r)
	}))
	mygo.Bind(p)
	mygo.App.SetName("OpenLR Scheme Bridge Probe")
	mygo.App.SetPath(mygo.PathUserData, filepath.Join(dir, "profile"))
	mygo.App.SetPath(mygo.PathCache, filepath.Join(dir, "cache"))
	mygo.App.OnWindowCreated(func(window *mygo.Window) {
		window.Page().OnWillNavigate(func(event *mygo.NavigateEvent) {
			if strings.HasSuffix(event.URL, "/blocked") {
				event.PreventDefault()
				select {
				case p.prevented <- struct{}{}:
				default:
				}
			}
		})
		window.Page().OnDidFailLoad(func(event *mygo.LoadError) {
			log.Printf("scheme-probe native load failure code=%d", event.Code)
			select {
			case p.loadFailed <- struct{}{}:
			default:
			}
		})
	})
	mygo.App.WhenReady(func() {
		mygo.NewWindow(mygo.WindowOptions{Title: "OpenLR Scheme Bridge Probe", URL: "/probe.html", Width: 640, Height: 480, Page: mygo.PageOptions{Session: mygo.NewEphemeralSession()}})
	})
	mygo.App.OnWindowAllClosed(mygo.App.Quit)
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
	if !p.finished.Load() {
		log.Fatal("scheme-probe exited without a report")
	}
	log.Print("scheme-probe host-finished")
}
