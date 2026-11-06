package main

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"
)

func TestStartupRendererMilestonesAreOptInAndAllowlisted(t *testing.T) {
	var output bytes.Buffer
	d := &Desktop{}
	d.StartupMilestone("renderer-script")
	d.startup = newStartupTrace(&output)
	d.StartupMilestone("renderer-script\nprivate path")
	d.StartupMilestone("opaque unknown message")
	d.StartupMilestone("renderer-script")
	d.StartupMilestone("renderer-script")
	d.StartupMilestone("workspace-ready-failed")
	got := strings.Split(strings.TrimSpace(output.String()), "\n")
	expected := []string{"renderer-script", "workspace-ready-failed"}
	if len(got) != len(expected) {
		t.Fatalf("unexpected startup diagnostic output: %q", got)
	}
	for i, stage := range expected {
		pattern := regexp.MustCompile("^OpenLR startup milestone " + stage + " elapsed_ms=[0-9]+$")
		if !pattern.MatchString(got[i]) {
			t.Fatalf("startup log must contain only a fixed stage and elapsed time: %q", got[i])
		}
	}
}

func TestStartupUIProbeBoundsWaitAndPostsOnce(t *testing.T) {
	trace := newStartupTrace(&bytes.Buffer{})
	posted := make(chan func(), 1)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	request, disconnect := context.WithCancel(ctx)
	defer disconnect()
	result := make(chan bool, 1)
	go func() {
		result <- trace.probeUI(request, func(fn func()) { posted <- fn })
	}()
	var dispatch func()
	select {
	case dispatch = <-posted:
	case <-ctx.Done():
		t.Fatal("probe did not post a UI callback")
	}
	disconnect()
	select {
	case responded := <-result:
		if responded {
			t.Fatal("an unpumped UI replied after request cancellation")
		}
	case <-ctx.Done():
		t.Fatal("probe did not stop waiting after request cancellation")
	}
	dispatch()
	for range 2 {
		if !trace.probeUI(ctx, func(func()) { t.Error("probe posted a second UI callback") }) {
			t.Fatal("dispatched callback was not observed")
		}
	}
}

func TestStartupUIProbeRequiresAuthenticationAndDiagnostics(t *testing.T) {
	trace := newStartupTrace(&bytes.Buffer{})
	b := &agentBroker{token: "test-secret"}
	request := func(method, token string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "/diagnostics/startup-ui", nil)
		r.Header.Set("Authorization", "Bearer "+token)
		response := httptest.NewRecorder()
		b.serveHTTP(response, r)
		return response
	}
	if got := request(http.MethodGet, b.token); got.Code != http.StatusNotFound {
		t.Fatalf("disabled diagnostic endpoint returned %d", got.Code)
	}
	b.startup = trace
	if got := request(http.MethodGet, "wrong"); got.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated diagnostic returned %d", got.Code)
	}
	if got := request(http.MethodPost, b.token); got.Code != http.StatusNotFound {
		t.Fatalf("unexpected method returned %d", got.Code)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if !trace.probeUI(ctx, func(fn func()) { fn() }) {
		t.Fatal("controlled UI callback did not respond")
	}
	if got := request(http.MethodGet, b.token); got.Code != http.StatusOK || got.Body.String() != "{\"responded\":true}\n" {
		t.Fatalf("unexpected diagnostic response %d: %q", got.Code, got.Body.String())
	}
}

func TestStartupUIProbeReportsWhenDispatchIsStillPending(t *testing.T) {
	trace := newStartupTrace(&bytes.Buffer{})
	posted := make(chan func(), 1)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	trace.probeUI(ctx, func(fn func()) { posted <- fn })

	outer, stop := context.WithTimeout(context.Background(), 3*time.Second)
	defer stop()
	var dispatch func()
	select {
	case dispatch = <-posted:
	case <-outer.Done():
		t.Fatal("controlled UI callback was not posted")
	}
	defer dispatch()
	request := httptest.NewRequest(http.MethodGet, "/diagnostics/startup-ui", nil).WithContext(outer)
	response := httptest.NewRecorder()
	trace.serveUIProbe(response, request)
	if outer.Err() != nil || response.Body.String() != "{\"responded\":false}\n" {
		t.Fatalf("bounded diagnostic did not report pending UI dispatch: %q, %v", response.Body.String(), outer.Err())
	}
}
