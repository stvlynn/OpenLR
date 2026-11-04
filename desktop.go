package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/egoist/mygo"
)

// Desktop isolates the native save dialog and filesystem from the photo UI.
type Desktop struct {
	mu      sync.Mutex
	exports map[string]*exportFile
	agent   *agentBroker
}

type exportFile struct {
	file *os.File
	path string
}

// BeginExport returns an opaque transfer ID, or an empty string on cancel.
func (d *Desktop) BeginExport(ctx context.Context, filename string) (string, error) {
	filename = filepath.Base(strings.ReplaceAll(filename, "\\", "/"))
	if filename == "." || filename == "" {
		filename = "OpenLR-export.jpg"
	}
	path, err := mygo.Dialog.Save(mygo.SaveDialogOptions{
		Parent: mygo.CallerWindow(ctx), DefaultPath: filename,
	})
	if err != nil || path == "" {
		return "", err
	}
	return d.beginExport(path)
}

func (d *Desktop) beginExport(path string) (string, error) {
	var token [24]byte
	if _, err := rand.Read(token[:]); err != nil {
		return "", err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".openlr-export-*")
	if err != nil {
		return "", fmt.Errorf("create export: %w", err)
	}
	id := hex.EncodeToString(token[:])
	d.mu.Lock()
	d.exports[id] = &exportFile{file: file, path: path}
	d.mu.Unlock()
	return id, nil
}

// WriteExport receives one bounded-memory chunk, without limiting total size.
func (d *Desktop) WriteExport(id, encoded string) error {
	if len(encoded) > base64.StdEncoding.EncodedLen(1<<20) {
		return errors.New("export chunk exceeds 1 MiB")
	}
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return fmt.Errorf("decode export chunk: %w", err)
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	transfer, ok := d.exports[id]
	if !ok {
		return errors.New("unknown export transfer")
	}
	_, err = transfer.file.Write(data)
	return err
}

// FinishExport replaces the chosen destination only after all chunks arrive.
func (d *Desktop) FinishExport(id string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	transfer, ok := d.exports[id]
	if !ok {
		return errors.New("unknown export transfer")
	}
	delete(d.exports, id)
	tempPath := transfer.file.Name()
	defer os.Remove(tempPath)
	if err := transfer.file.Sync(); err != nil {
		transfer.file.Close()
		return err
	}
	if err := transfer.file.Close(); err != nil {
		return err
	}
	return os.Rename(tempPath, transfer.path)
}

// CancelExport discards a partial export and preserves an existing destination.
func (d *Desktop) CancelExport(id string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if transfer, ok := d.exports[id]; ok {
		transfer.file.Close()
		os.Remove(transfer.file.Name())
		delete(d.exports, id)
	}
}

func (d *Desktop) cancelAll() {
	d.mu.Lock()
	defer d.mu.Unlock()
	for id, transfer := range d.exports {
		transfer.file.Close()
		os.Remove(transfer.file.Name())
		delete(d.exports, id)
	}
}
