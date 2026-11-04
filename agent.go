package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type AgentCommand struct {
	ID      string          `json:"id"`
	Command string          `json:"command"`
	Args    json.RawMessage `json:"args"`
}

type agentBroker struct {
	queue   chan *AgentCommand
	done    chan struct{}
	mu      sync.Mutex
	pending map[string]chan json.RawMessage
	server  *http.Server
	file    string
	token   string
}

func startAgent() (*agentBroker, error) {
	var secret [32]byte
	if _, err := rand.Read(secret[:]); err != nil {
		return nil, err
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	b := &agentBroker{queue: make(chan *AgentCommand, 32), done: make(chan struct{}), pending: make(map[string]chan json.RawMessage), token: hex.EncodeToString(secret[:])}
	b.file = os.Getenv("OPENLR_AGENT_FILE")
	if b.file == "" {
		config, err := os.UserConfigDir()
		if err != nil {
			listener.Close()
			return nil, err
		}
		b.file = filepath.Join(config, "OpenLR", "agent.json")
	}
	if err := os.MkdirAll(filepath.Dir(b.file), 0o700); err != nil {
		listener.Close()
		return nil, err
	}
	info, _ := json.Marshal(map[string]any{"version": 1, "url": "http://" + listener.Addr().String(), "token": b.token, "pid": os.Getpid()})
	if err := os.WriteFile(b.file, info, 0o600); err != nil {
		listener.Close()
		return nil, err
	}
	b.server = &http.Server{Handler: http.HandlerFunc(b.serveHTTP), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second}
	go b.server.Serve(listener)
	return b, nil
}

func (b *agentBroker) serveHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	provided := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") || subtle.ConstantTimeCompare([]byte(provided), []byte(b.token)) != 1 {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}
	if r.URL.Path == "/health" && r.Method == http.MethodGet {
		json.NewEncoder(w).Encode(map[string]any{"ok": true, "version": 1})
		return
	}
	if r.URL.Path != "/command" || r.Method != http.MethodPost {
		http.Error(w, `{"error":"unknown endpoint"}`, http.StatusNotFound)
		return
	}
	var command AgentCommand
	if err := json.NewDecoder(r.Body).Decode(&command); err != nil || command.Command == "" {
		http.Error(w, `{"error":"expected a command and args object"}`, http.StatusBadRequest)
		return
	}
	var randomID [16]byte
	if _, err := rand.Read(randomID[:]); err != nil {
		http.Error(w, `{"error":"could not create command ID"}`, http.StatusInternalServerError)
		return
	}
	command.ID = hex.EncodeToString(randomID[:])
	if len(command.Args) == 0 {
		command.Args = json.RawMessage(`{}`)
	}
	reply := make(chan json.RawMessage, 1)
	b.mu.Lock()
	b.pending[command.ID] = reply
	b.mu.Unlock()
	defer func() { b.mu.Lock(); delete(b.pending, command.ID); b.mu.Unlock() }()
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	select {
	case b.queue <- &command:
	case <-ctx.Done():
		http.Error(w, `{"error":"command queue timed out"}`, http.StatusGatewayTimeout)
		return
	case <-b.done:
		http.Error(w, `{"error":"desktop closed"}`, http.StatusServiceUnavailable)
		return
	}
	select {
	case result := <-reply:
		w.Write(result)
	case <-ctx.Done():
		http.Error(w, `{"error":"desktop command timed out"}`, http.StatusGatewayTimeout)
	case <-b.done:
		http.Error(w, `{"error":"desktop closed"}`, http.StatusServiceUnavailable)
	}
}

// AgentPoll lets the embedded frontend execute CLI commands on its live state.
func (d *Desktop) AgentPoll(ctx context.Context) *AgentCommand {
	if d.agent == nil {
		return nil
	}
	timer := time.NewTimer(20 * time.Second)
	defer timer.Stop()
	for {
		select {
		case command := <-d.agent.queue:
			d.agent.mu.Lock()
			_, live := d.agent.pending[command.ID]
			d.agent.mu.Unlock()
			if live {
				return command
			}
		case <-timer.C:
			return nil
		case <-ctx.Done():
			return nil
		case <-d.agent.done:
			return nil
		}
	}
}

func (d *Desktop) AgentReply(id, result string) error {
	if d.agent == nil {
		return errors.New("agent server is unavailable")
	}
	if !json.Valid([]byte(result)) {
		return errors.New("agent reply must be valid JSON")
	}
	d.agent.mu.Lock()
	reply := d.agent.pending[id]
	d.agent.mu.Unlock()
	if reply == nil {
		return fmt.Errorf("command %s is no longer pending", id)
	}
	select {
	case reply <- json.RawMessage(result):
		return nil
	default:
		return errors.New("command already has a reply")
	}
}

func (b *agentBroker) close() {
	close(b.done)
	b.server.Close()
	data, err := os.ReadFile(b.file)
	if err == nil && strings.Contains(string(data), b.token) {
		os.Remove(b.file)
	}
}
