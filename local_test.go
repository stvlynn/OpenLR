package main

import (
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
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
	if listing.Photos[0].SidecarPresent {
		t.Fatal("photo without a sidecar reported as having one")
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
	if !listing.Photos[0].SidecarPresent {
		t.Fatal("saved sidecar presence was lost on restart")
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

func TestLocalSidecarProcessVersions(t *testing.T) {
	for _, test := range []struct {
		name    string
		recipe  string
		version int
	}{
		{"historical empty", `{}`, 1},
		{"legacy", `{"edit":{"Exposure":1}}`, 1},
		{"explicit legacy", `{"edit":{"processVersion":1}}`, 1},
		{"linear", `{"edit":{"processVersion":2,"Exposure":0.25},"rating":4,"keywords":"fixture"}`, 2},
		{"saved linear", `{"edit":{},"versions":[{"id":"linear","name":"Linear","edit":{"processVersion":2,"Exposure":1}},{"id":"old","name":"Old","edit":{}}]}`, 2},
	} {
		t.Run(test.name, func(t *testing.T) {
			dir := t.TempDir()
			original := []byte("original fixture")
			if err := os.WriteFile(filepath.Join(dir, "photo.jpg"), original, 0o600); err != nil {
				t.Fatal(err)
			}
			local := &Local{file: filepath.Join(t.TempDir(), "folders.json"), roots: make(map[string]LocalRoot)}
			root, err := local.authorize(dir)
			if err != nil {
				t.Fatal(err)
			}
			if err := local.SaveRecipe(root.ID, "photo.jpg", test.recipe); err != nil {
				t.Fatal(err)
			}
			data, err := os.ReadFile(filepath.Join(dir, "photo.jpg.openlr.json"))
			if err != nil {
				t.Fatal(err)
			}
			var sidecar localSidecar
			if err := json.Unmarshal(data, &sidecar); err != nil {
				t.Fatal(err)
			}
			if sidecar.Version != test.version {
				t.Fatalf("sidecar version %d, want %d", sidecar.Version, test.version)
			}
			listing, err := local.OpenFolder(root.ID, "")
			if err != nil {
				t.Fatal(err)
			}
			photo := listing.Photos[0]
			if !photo.SidecarPresent || photo.Error != "" {
				t.Fatalf("cannot reopen valid sidecar: %+v", photo)
			}
			var got, want any
			json.Unmarshal(photo.Recipe, &got)
			json.Unmarshal([]byte(test.recipe), &want)
			gotJSON, _ := json.Marshal(got)
			wantJSON, _ := json.Marshal(want)
			if string(gotJSON) != string(wantJSON) {
				t.Fatalf("recipe or metadata changed: %s", gotJSON)
			}
			after, err := os.ReadFile(filepath.Join(dir, "photo.jpg"))
			if err != nil || string(after) != string(original) {
				t.Fatal("original changed")
			}
		})
	}
}

func TestLocalSidecarRejectsUnsupportedProcessingWithoutOverwrite(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "photo.jpg"), []byte("original fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	local := &Local{file: filepath.Join(t.TempDir(), "folders.json"), roots: make(map[string]LocalRoot)}
	root, err := local.authorize(dir)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "photo.jpg.openlr.json")
	for _, data := range []string{
		`{"version":1,"recipe":{"edit":{"processVersion":2}}}`,
		`{"version":2,"recipe":{"edit":{"processVersion":3}}}`,
		`{"version":2,"recipe":{"edit":{"processVersion":"2"}}}`,
		`{"version":2,"recipe":{"edit":{"processVersion":null}}}`,
		`{"version":2,"recipe":{"versions":[{"edit":{"processVersion":99}}]}}`,
		`{"version":3,"recipe":{}}`,
		`{"version":1,"recipe":null}`,
		`broken`,
	} {
		if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
			t.Fatal(err)
		}
		listing, err := local.OpenFolder(root.ID, "")
		if err != nil {
			t.Fatal(err)
		}
		photo := listing.Photos[0]
		if !photo.SidecarPresent || photo.Error == "" {
			t.Fatalf("invalid sidecar accepted: %s", data)
		}
		if err := local.SaveRecipe(root.ID, "photo.jpg", `{}`); err == nil {
			t.Fatalf("invalid sidecar overwritten: %s", data)
		}
		after, err := os.ReadFile(path)
		if err != nil || string(after) != data {
			t.Fatal("rejected sidecar changed")
		}
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{`0`, `3`, `-1`, `1.5`, `"2"`, `null`, `true`, `{}`} {
		recipe := `{"edit":{"processVersion":` + value + `}}`
		if err := local.SaveRecipe(root.ID, "photo.jpg", recipe); err == nil || !strings.Contains(err.Error(), "process version") {
			t.Fatalf("unsupported process version accepted: %s, %v", recipe, err)
		}
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatal("rejected recipe created a sidecar")
		}
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
