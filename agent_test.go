package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

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
