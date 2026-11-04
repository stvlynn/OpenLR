package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestExternalStableSnapshotAndRestart(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "copy.tif")
	os.WriteFile(path, []byte("before"), 0o600)
	hash, _ := hashExternal(path)
	e := &External{file: filepath.Join(dir, "external.json"), loaded: true, sessions: []*externalSession{{ID: "session", SourceID: "photo-id", Name: "copy.tif", Path: path, Hash: hash, Launched: true}}}
	if err := e.persist(); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(path, []byte("saved edit"), 0o600)
	changes, err := e.Changes()
	if err != nil || len(changes) != 0 {
		t.Fatal("unstable file was returned")
	}
	e.sessions[0].StableSince = time.Now().Add(-time.Second)
	changes, err = e.Changes()
	if err != nil || len(changes) != 1 {
		t.Fatalf("saved changes: %+v %v", changes, err)
	}
	change := changes[0]
	// A second editor save cannot change the already exposed snapshot bytes.
	os.WriteFile(path, []byte("another save"), 0o600)
	restarted := &External{file: e.file}
	request := httptest.NewRequest(http.MethodGet, "http://externalphoto.localhost/session/"+change.Hash, nil)
	response := httptest.NewRecorder()
	restarted.servePhoto(response, request)
	if response.Code != 200 || response.Body.String() != "saved edit" {
		t.Fatalf("snapshot mutated: %d %s", response.Code, response.Body.String())
	}
	if err = restarted.Acknowledge("session", change.Hash); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(e.file)
	var persisted map[string]any
	if err = json.Unmarshal(data, &persisted); err != nil {
		t.Fatal(err)
	}
	if err = restarted.Acknowledge("session", change.Hash); err == nil {
		t.Fatal("same saved revision acknowledged twice")
	}
	if _, err = os.Stat(path + ".saved-" + change.Hash); !os.IsNotExist(err) {
		t.Fatal("acknowledged snapshot was not removed")
	}
}
