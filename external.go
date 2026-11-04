package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
)

type External struct {
	mu       sync.Mutex
	desktop  *Desktop
	file     string
	loaded   bool
	editor   string
	sessions []*externalSession
}
type externalSession struct {
	ID           string          `json:"id"`
	SourceID     string          `json:"sourceId"`
	Name         string          `json:"name"`
	Path         string          `json:"path"`
	Hash         string          `json:"hash"`
	Launched     bool            `json:"launched"`
	Pending      *ExternalChange `json:"pending,omitempty"`
	ObservedSize int64           `json:"-"`
	ObservedTime int64           `json:"-"`
	StableSince  time.Time       `json:"-"`
}
type ExternalChange struct {
	ID       string `json:"id"`
	SourceID string `json:"sourceId"`
	Name     string `json:"name"`
	Hash     string `json:"hash"`
	Error    string `json:"error,omitempty"`
}
type ExternalTransfer struct {
	ID       string `json:"id"`
	Transfer string `json:"transfer"`
}

func newExternal(desktop *Desktop) *External {
	file := os.Getenv("OPENLR_EXTERNAL_FILE")
	if file == "" {
		config, _ := os.UserConfigDir()
		file = filepath.Join(config, "OpenLR", "external.json")
	}
	return &External{desktop: desktop, file: file}
}
func (e *External) load() error {
	if e.loaded {
		return nil
	}
	data, err := os.ReadFile(e.file)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err == nil {
		var config struct {
			Editor   string             `json:"editor"`
			Sessions []*externalSession `json:"sessions"`
		}
		if err = json.Unmarshal(data, &config); err != nil {
			return err
		}
		e.editor = config.Editor
		e.sessions = config.Sessions
	}
	if editor := os.Getenv("OPENLR_EXTERNAL_EDITOR"); editor != "" {
		e.editor = editor
	}
	e.loaded = true
	return nil
}
func (e *External) persist() error {
	data, err := json.MarshalIndent(struct {
		Editor   string             `json:"editor"`
		Sessions []*externalSession `json:"sessions"`
	}{e.editor, e.sessions}, "", "  ")
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(e.file), 0o700); err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(e.file), ".external-*")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())
	if _, err = temp.Write(data); err != nil {
		temp.Close()
		return err
	}
	if err = temp.Close(); err != nil {
		return err
	}
	return os.Rename(temp.Name(), e.file)
}
func (e *External) Editor() (string, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if err := e.load(); err != nil {
		return "", err
	}
	return e.editor, nil
}
func (e *External) ChooseEditor(ctx context.Context) (string, error) {
	paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{Parent: mygo.CallerWindow(ctx), Directory: runtime.GOOS == "darwin"})
	if err != nil || len(paths) == 0 {
		return "", err
	}
	path := paths[0]
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if info.IsDir() && (runtime.GOOS != "darwin" || !strings.HasSuffix(strings.ToLower(path), ".app")) {
		return "", errors.New("choose an editor executable or macOS app")
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if err = e.load(); err != nil {
		return "", err
	}
	e.editor = path
	return path, e.persist()
}
func (e *External) Photoshop() (string, error) {
	var patterns []string
	if runtime.GOOS == "windows" {
		for _, key := range []string{"ProgramFiles", "ProgramFiles(x86)"} {
			if base := os.Getenv(key); base != "" {
				patterns = append(patterns, filepath.Join(base, "Adobe", "Adobe Photoshop*", "Photoshop.exe"))
			}
		}
	}
	if runtime.GOOS == "darwin" {
		patterns = []string{"/Applications/Adobe Photoshop*/Adobe Photoshop*.app"}
	}
	for _, pattern := range patterns {
		matches, _ := filepath.Glob(pattern)
		if len(matches) > 0 {
			e.mu.Lock()
			defer e.mu.Unlock()
			if err := e.load(); err != nil {
				return "", err
			}
			e.editor = matches[len(matches)-1]
			return e.editor, e.persist()
		}
	}
	return "", errors.New("Photoshop was not found; choose an installed editor")
}
func (e *External) Begin(sourceID, name string) (*ExternalTransfer, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if err := e.load(); err != nil {
		return nil, err
	}
	if e.editor == "" {
		return nil, errors.New("choose an external editor first")
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return nil, err
	}
	id := hex.EncodeToString(random[:])
	dir := filepath.Join(filepath.Dir(e.file), "external-edits", id)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	name = strings.TrimSuffix(name, filepath.Ext(name)) + "-external.tif"
	path := filepath.Join(dir, name)
	transfer, err := e.desktop.beginExport(path)
	if err != nil {
		return nil, err
	}
	e.sessions = append(e.sessions, &externalSession{ID: id, SourceID: sourceID, Name: name, Path: path})
	if err = e.persist(); err != nil {
		e.desktop.CancelExport(transfer)
		return nil, err
	}
	return &ExternalTransfer{ID: id, Transfer: transfer}, nil
}
func hashExternal(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err = io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
func (e *External) session(id string) (*externalSession, error) {
	for _, session := range e.sessions {
		if session.ID == id {
			return session, nil
		}
	}
	return nil, errors.New("unknown external edit session")
}
func (e *External) Launch(id string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if err := e.load(); err != nil {
		return err
	}
	session, err := e.session(id)
	if err != nil {
		return err
	}
	if session.Launched {
		return errors.New("editor was already launched for this copy")
	}
	session.Hash, err = hashExternal(session.Path)
	if err != nil {
		return err
	}
	var command *exec.Cmd
	if runtime.GOOS == "darwin" && strings.HasSuffix(strings.ToLower(e.editor), ".app") {
		command = exec.Command("open", "-a", e.editor, session.Path)
	} else {
		command = exec.Command(e.editor, session.Path)
	}
	if err = command.Start(); err != nil {
		return fmt.Errorf("start external editor: %w", err)
	}
	go command.Wait()
	session.Launched = true
	return e.persist()
}

// Changes waits for a stable save, then exposes an immutable hashed snapshot.
// It does not assume that the launched process owns the editor's lifetime.
func (e *External) Changes() ([]ExternalChange, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if err := e.load(); err != nil {
		return nil, err
	}
	result := []ExternalChange{}
	for _, session := range e.sessions {
		if !session.Launched {
			continue
		}
		if session.Pending != nil {
			result = append(result, *session.Pending)
			continue
		}
		info, err := os.Stat(session.Path)
		if err != nil {
			result = append(result, ExternalChange{ID: session.ID, Name: session.Name, Error: err.Error()})
			continue
		}
		if info.Size() != session.ObservedSize || info.ModTime().UnixNano() != session.ObservedTime {
			session.ObservedSize = info.Size()
			session.ObservedTime = info.ModTime().UnixNano()
			session.StableSince = time.Now()
			continue
		}
		if session.StableSince.IsZero() || time.Since(session.StableSince) < 750*time.Millisecond {
			continue
		}
		hash, err := hashExternal(session.Path)
		if err != nil {
			return nil, err
		}
		if hash == session.Hash {
			session.StableSince = time.Time{}
			continue
		}
		snapshot := session.Path + ".saved-" + hash
		input, err := os.Open(session.Path)
		if err != nil {
			return nil, err
		}
		output, err := os.Create(snapshot)
		if err != nil {
			input.Close()
			return nil, err
		}
		copiedHash := sha256.New()
		_, copyErr := io.Copy(io.MultiWriter(output, copiedHash), input)
		input.Close()
		closeErr := output.Close()
		if copyErr != nil {
			return nil, copyErr
		}
		if closeErr != nil {
			return nil, closeErr
		}
		after, err := os.Stat(session.Path)
		if err != nil {
			return nil, err
		}
		if after.Size() != info.Size() || after.ModTime() != info.ModTime() || hex.EncodeToString(copiedHash.Sum(nil)) != hash {
			os.Remove(snapshot)
			session.StableSince = time.Now()
			continue
		}
		session.Pending = &ExternalChange{ID: session.ID, SourceID: session.SourceID, Name: session.Name, Hash: hash}
		result = append(result, *session.Pending)
		if err = e.persist(); err != nil {
			return nil, err
		}
	}
	return result, nil
}
func (e *External) Acknowledge(id, hash string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if err := e.load(); err != nil {
		return err
	}
	session, err := e.session(id)
	if err != nil {
		return err
	}
	if session.Pending == nil || session.Pending.Hash != hash {
		return errors.New("saved copy revision changed")
	}
	session.Hash = hash
	session.Pending = nil
	session.StableSince = time.Time{}
	if err = e.persist(); err != nil {
		return err
	}
	return os.Remove(session.Path + ".saved-" + hash)
}
func (e *External) servePhoto(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "read only", 405)
		return
	}
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) != 2 {
		http.NotFound(w, r)
		return
	}
	e.mu.Lock()
	if err := e.load(); err != nil {
		e.mu.Unlock()
		http.Error(w, "unavailable", 500)
		return
	}
	session, err := e.session(parts[0])
	if err != nil || session.Pending == nil || session.Pending.Hash != parts[1] {
		e.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	path := session.Path + ".saved-" + session.Pending.Hash
	e.mu.Unlock()
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "image/tiff")
	http.ServeFile(w, r, path)
}
