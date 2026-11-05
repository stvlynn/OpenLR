package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSessionReplacementKeepsExistingReadersComplete(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.json")
	old := []byte(`{"version":1,"token":"previous"}`)
	if err := publishAgentSession(path, old); err != nil {
		t.Fatal(err)
	}
	reader, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	next := []byte(`{"version":1,"token":"next"}`)
	publishErr := publishAgentSession(path, next)
	previous := make([]byte, len(old))
	if _, err := reader.Read(previous); err != nil || string(previous) != string(old) {
		t.Fatalf("existing reader lost its complete session: %q, %v", previous, err)
	}
	reader.Close()
	if publishErr != nil {
		current, err := os.ReadFile(path)
		if err != nil || string(current) != string(old) {
			t.Fatalf("failed replacement damaged the session: %q, %v", current, err)
		}
		if err := publishAgentSession(path, next); err != nil {
			t.Fatal(err)
		}
	}
	current, err := os.ReadFile(path)
	if err != nil || string(current) != string(next) {
		t.Fatalf("new reader did not get the published session: %q, %v", current, err)
	}
}

func TestAgentRequiresSecretAndReturnsLiveReply(t *testing.T) {
	b := &agentBroker{queue: make(chan *AgentCommand, 1), done: make(chan struct{}), pending: make(map[string]chan json.RawMessage), token: "test-secret"}
	d := &Desktop{agent: b}
	unauthorized := httptest.NewRecorder()
	b.serveHTTP(unauthorized, httptest.NewRequest(http.MethodGet, "/health", nil))
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated request got %d", unauthorized.Code)
	}
	completed := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		request := httptest.NewRequest(http.MethodPost, "/command", strings.NewReader(`{"command":"status","args":{"detail":true}}`))
		request.Header.Set("Authorization", "Bearer test-secret")
		recorder := httptest.NewRecorder()
		b.serveHTTP(recorder, request)
		completed <- recorder
	}()
	command := d.AgentPoll(context.Background())
	if command == nil || command.Command != "status" || string(command.Args) != `{"detail":true}` {
		t.Fatalf("unexpected command: %+v", command)
	}
	if err := d.AgentReply(command.ID, `{"ok":true,"selected":"photo-1"}`); err != nil {
		t.Fatal(err)
	}
	response := <-completed
	if response.Code != http.StatusOK || response.Body.String() != `{"ok":true,"selected":"photo-1"}` {
		t.Fatalf("unexpected response %d: %s", response.Code, response.Body.String())
	}
	if err := d.AgentReply(command.ID, `{}`); err == nil {
		t.Fatal("completed request still accepted a reply")
	}
}

func TestAgentReplyIsClaimedExactlyOnce(t *testing.T) {
	reply := make(chan json.RawMessage, 1)
	d := &Desktop{agent: &agentBroker{pending: map[string]chan json.RawMessage{"command": reply}}}
	if err := d.AgentReply("command", `{"ok":true}`); err != nil {
		t.Fatal(err)
	}
	<-reply // HTTP may consume the reply before it finishes writing the response.
	if err := d.AgentReply("command", `{"ok":true}`); err == nil {
		t.Fatal("a second reply claimed an already-consumed command")
	}
}

func TestExportControlsBypassHeldCommandAndQueuedEdit(t *testing.T) {
	b := &agentBroker{queue: make(chan *AgentCommand, 1), controls: make(chan *AgentCommand, 2), done: make(chan struct{}), pending: make(map[string]chan json.RawMessage), token: "test-secret"}
	d := &Desktop{agent: b}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	post := func(body string) <-chan *httptest.ResponseRecorder {
		completed := make(chan *httptest.ResponseRecorder, 1)
		go func() {
			request := httptest.NewRequest(http.MethodPost, "/command", strings.NewReader(body)).WithContext(ctx)
			request.Header.Set("Authorization", "Bearer test-secret")
			recorder := httptest.NewRecorder()
			b.serveHTTP(recorder, request)
			completed <- recorder
		}()
		return completed
	}
	exportReply := post(`{"command":"export-selection"}`)
	export := d.AgentPoll(ctx)
	if export == nil || export.Command != "export-selection" {
		t.Fatalf("export not delivered: %+v", export)
	}
	// The ordinary lane is full and its consumer is awaiting the export result.
	b.mu.Lock()
	b.pending["edit"] = make(chan json.RawMessage, 1)
	b.mu.Unlock()
	b.queue <- &AgentCommand{ID: "edit", Command: "edit", Args: json.RawMessage(`{"key":"Exposure","value":1}`)}
	// A disconnected control request must not be executed after a later poll.
	b.controls <- &AgentCommand{ID: "expired", Command: "export-cancel"}
	for _, command := range []string{"export-status", "export-cancel"} {
		response := post(`{"command":"` + command + `","args":{"id":"job-1"},"capture":true}`)
		control := d.AgentPollControl(ctx)
		if control == nil || control.Command != command || !control.Capture || string(control.Args) != `{"id":"job-1"}` {
			t.Fatalf("control not delivered while export held: %+v", control)
		}
		if err := d.AgentReply(control.ID, `{"ok":true,"result":{"status":"running"}}`); err != nil {
			t.Fatal(err)
		}
		if got := <-response; got.Code != http.StatusOK || !strings.Contains(got.Body.String(), `"status":"running"`) {
			t.Fatalf("wrong control reply: %d %s", got.Code, got.Body.String())
		}
		if len(b.queue) != 1 {
			t.Fatal("a control consumed the queued edit")
		}
		select {
		case <-exportReply:
			t.Fatal("control completed the unrelated export request")
		default:
		}
	}
	if err := d.AgentReply(export.ID, `{"ok":true,"result":{"cancelled":true}}`); err != nil {
		t.Fatal(err)
	}
	if got := <-exportReply; !strings.Contains(got.Body.String(), `"cancelled":true`) {
		t.Fatalf("wrong export reply: %s", got.Body.String())
	}
	if next := d.AgentPoll(ctx); next == nil || next.ID != "edit" {
		t.Fatalf("ordinary ordering lost: %+v", next)
	}
}
