package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
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
	folders map[string]string
	opened  []string
	agent   *agentBroker
}

func (d *Desktop) ToggleFullscreen(ctx context.Context) {
	if window := mygo.CallerWindow(ctx); window != nil {
		window.ToggleFullScreen()
	}
}

// StartupError allows native smoke tests to report failures before IPC polling starts.
func (d *Desktop) StartupError(message string) {
	if os.Getenv("OPENLR_DIAGNOSTICS") == "1" {
		fmt.Fprintln(os.Stderr, message)
	}
}

// CaptureWorkspace snapshots only the OpenLR webview that issued the call.
func (d *Desktop) CaptureWorkspace(ctx context.Context) (string, error) {
	window := mygo.CallerWindow(ctx)
	if window == nil {
		return "", errors.New("no active workspace window")
	}
	png, err := window.CapturePage()
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(png), nil
}

type exportFile struct {
	file   *os.File
	path   string
	folder string
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
	if d.exports == nil {
		d.exports = make(map[string]*exportFile)
	}
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
func (d *Desktop) FinishExport(id string) (result error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	transfer, ok := d.exports[id]
	if !ok {
		return errors.New("unknown export transfer")
	}
	tempPath := transfer.file.Name()
	defer func() {
		if cleanup := d.cancelExportLocked(id); cleanup != nil {
			if result == nil {
				// Publication has committed. Keep the completed-file acknowledgment;
				// retained cleanup is retried/reported when its folder or app closes.
				fmt.Fprintln(os.Stderr, "OpenLR saved export cleanup:", cleanup)
			} else {
				result = errors.Join(result, cleanup)
			}
		}
	}()
	if err := transfer.file.Sync(); err != nil {
		return err
	}
	if err := transfer.file.Close(); err != nil {
		return err
	}
	if transfer.folder != "" {
		return publishNewExport(tempPath, transfer.path)
	}
	return os.Rename(tempPath, transfer.path)
}

// publishNewExport never replaces a file created after filename selection.
// Hard links publish complete bytes atomically. Filesystems without hard links
// use an exclusive destination and bounded-memory copy, removing it on failure.
func publishNewExport(source, destination string) error {
	if err := os.Link(source, destination); err == nil {
		return nil
	} else if errors.Is(err, os.ErrExist) {
		return err
	}
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	completed := false
	defer func() {
		output.Close()
		if !completed {
			os.Remove(destination)
		}
	}()
	if _, err = io.Copy(output, input); err != nil {
		return err
	}
	if err = output.Sync(); err != nil {
		return err
	}
	if err = output.Close(); err != nil {
		return err
	}
	completed = true
	return nil
}

type exportFolder struct {
	ID   string `json:"id"`
	Path string `json:"path"`
}

type folderExport struct {
	ID       string `json:"id"`
	Path     string `json:"path"`
	Filename string `json:"filename"`
}

// BeginExportFolder authorizes only the chosen directory for one export run.
func (d *Desktop) BeginExportFolder(ctx context.Context, directory string) (*exportFolder, error) {
	if directory == "" {
		paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{Parent: mygo.CallerWindow(ctx), Directory: true})
		if err != nil {
			return nil, err
		}
		if len(paths) == 0 {
			return nil, nil
		}
		directory = paths[0]
	}
	root, err := filepath.Abs(directory)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(root)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, errors.New("export destination must be a directory")
	}
	var token [24]byte
	if _, err = rand.Read(token[:]); err != nil {
		return nil, err
	}
	id := hex.EncodeToString(token[:])
	d.mu.Lock()
	if d.folders == nil {
		d.folders = make(map[string]string)
	}
	d.folders[id] = root
	d.mu.Unlock()
	return &exportFolder{ID: id, Path: root}, nil
}

// BeginFolderExport resolves case-insensitive collisions without replacing files.
func (d *Desktop) BeginFolderExport(folder, filename string) (*folderExport, error) {
	if filename == "" || filename == "." || filename == ".." || strings.ContainsAny(filename, "/\\\x00") {
		return nil, errors.New("export filename must be a basename")
	}
	d.mu.Lock()
	root, ok := d.folders[folder]
	d.mu.Unlock()
	if !ok {
		return nil, errors.New("unknown export folder")
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	used := make(map[string]bool)
	for _, entry := range entries {
		used[strings.ToLower(entry.Name())] = true
	}
	ext := filepath.Ext(filename)
	stem := strings.TrimSuffix(filename, ext)
	chosen := filename
	for number := 2; used[strings.ToLower(chosen)]; number++ {
		chosen = fmt.Sprintf("%s-%d%s", stem, number, ext)
	}
	destination := filepath.Join(root, chosen)
	id, err := d.beginExport(destination)
	if err != nil {
		return nil, err
	}
	d.mu.Lock()
	if _, ok := d.folders[folder]; !ok {
		d.mu.Unlock()
		return nil, errors.Join(errors.New("export folder was closed"), d.CancelExport(id))
	}
	d.exports[id].folder = folder
	d.mu.Unlock()
	return &folderExport{ID: id, Path: destination, Filename: chosen}, nil
}

func (d *Desktop) EndExportFolder(folder string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	delete(d.folders, folder)
	var result error
	for id, transfer := range d.exports {
		if transfer.folder == folder {
			result = errors.Join(result, d.cancelExportLocked(id))
		}
	}
	return result
}

// CancelExport discards a partial export and preserves an existing destination.
func (d *Desktop) CancelExport(id string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.cancelExportLocked(id)
}

// Failed removal stays tracked so folder/shutdown cleanup can report and retry it.
func (d *Desktop) cancelExportLocked(id string) error {
	if transfer, ok := d.exports[id]; ok {
		var result error
		if err := transfer.file.Close(); err != nil && !errors.Is(err, os.ErrClosed) {
			result = fmt.Errorf("close export temporary file: %w", err)
		}
		if err := os.Remove(transfer.file.Name()); err != nil && !errors.Is(err, os.ErrNotExist) {
			result = errors.Join(result, fmt.Errorf("remove export temporary file: %w", err))
		} else {
			delete(d.exports, id)
		}
		return result
	}
	return nil
}

func (d *Desktop) cancelAll() {
	d.mu.Lock()
	defer d.mu.Unlock()
	clear(d.folders)
	for id := range d.exports {
		if err := d.cancelExportLocked(id); err != nil {
			fmt.Fprintln(os.Stderr, "OpenLR export cleanup:", err)
		}
	}
}
