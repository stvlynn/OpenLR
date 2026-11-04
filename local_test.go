package main

import (
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestLocalFolderPreservesOriginalAndReopensSidecar(t *testing.T) {
	dir := t.TempDir()
	registry := filepath.Join(t.TempDir(), "folders.json")
	l := &Local{file: registry, roots: make(map[string]LocalRoot)}
	original := []byte("original photo bytes unchanged")
	path := filepath.Join(dir, "photo #1.jpg")
	if err := os.WriteFile(path, original, 0o600); err != nil {
		t.Fatal(err)
	}
	os.Mkdir(filepath.Join(dir, "subfolder"), 0o700)
	os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("private nonphoto"), 0o600)
	root, err := l.authorize(dir)
	if err != nil {
		t.Fatal(err)
	}
	listing, err := l.OpenFolder(root.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(listing.Photos) != 1 || len(listing.Directories) != 1 {
		t.Fatalf("unexpected listing: %+v", listing)
	}
	recipe := `{"edit":{"Exposure":1,"turn":1},"rating":4,"flag":"pick","versions":[{"name":"Warm","edit":{"Temperature":20}}]}`
	if err := l.SaveRecipe(root.ID, "photo #1.jpg", recipe); err != nil {
		t.Fatal(err)
	}
	// Replacing a previous sidecar is supported, without ever replacing the photo.
	if err := l.SaveRecipe(root.ID, "photo #1.jpg", recipe); err != nil {
		t.Fatal(err)
	}
	reopened := &Local{file: registry, roots: make(map[string]LocalRoot)}
	listing, err = reopened.OpenFolder(root.ID, ".")
	if err != nil {
		t.Fatal(err)
	}
	var actual, want any
	json.Unmarshal(listing.Photos[0].Recipe, &actual)
	json.Unmarshal([]byte(recipe), &want)
	actualJSON, _ := json.Marshal(actual)
	wantJSON, _ := json.Marshal(want)
	if string(actualJSON) != string(wantJSON) {
		t.Fatalf("recipe lost: %s", actualJSON)
	}
	after, _ := os.ReadFile(path)
	if sha256.Sum256(after) != sha256.Sum256(original) {
		t.Fatal("original photo changed")
	}
	request := httptest.NewRequest(http.MethodGet, "http://localphoto.localhost/"+root.ID+"/photo%20%231.jpg", nil)
	response := httptest.NewRecorder()
	reopened.servePhoto(response, request)
	if response.Code != 200 || response.Body.String() != string(original) {
		t.Fatalf("photo response: %d %s", response.Code, response.Body.String())
	}
}

func TestLocalFolderRejectsUnauthorizedTraversalAndSymlink(t *testing.T) {
	dir := t.TempDir()
	outside := t.TempDir()
	l := &Local{file: filepath.Join(t.TempDir(), "folders.json"), roots: make(map[string]LocalRoot)}
	os.WriteFile(filepath.Join(dir, "photo.jpg"), []byte("photo"), 0o600)
	os.WriteFile(filepath.Join(outside, "secret.jpg"), []byte("secret"), 0o600)
	root, err := l.authorize(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := l.OpenFolder("unknown", ""); err == nil {
		t.Fatal("unknown root accepted")
	}
	for _, path := range []string{"../", "../secret.jpg", "/etc", "C:/Photos", "sub/../../outside"} {
		if _, err := l.OpenFolder(root.ID, path); err == nil {
			t.Fatalf("traversal accepted: %s", path)
		}
		if err := l.SaveRecipe(root.ID, path, `{}`); err == nil {
			t.Fatalf("sidecar traversal accepted: %s", path)
		}
	}
	if err := os.Symlink(filepath.Join(outside, "secret.jpg"), filepath.Join(dir, "linked.jpg")); err == nil {
		request := httptest.NewRequest(http.MethodGet, "http://localphoto.localhost/"+root.ID+"/linked.jpg", nil)
		response := httptest.NewRecorder()
		l.servePhoto(response, request)
		if response.Code == 200 {
			t.Fatal("escaped symlink was served")
		}
	}
	request := httptest.NewRequest(http.MethodPost, "http://localphoto.localhost/"+root.ID+"/photo.jpg", nil)
	response := httptest.NewRecorder()
	l.servePhoto(response, request)
	if response.Code != http.StatusMethodNotAllowed {
		t.Fatal("photo protocol allowed mutation")
	}
}
