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
