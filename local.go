package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
)

// Local owns user-authorized folders, read-only originals and edit sidecars.
type Local struct {
	mu    sync.Mutex
	file  string
	roots map[string]LocalRoot
}

type LocalRoot struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Path string `json:"path"`
}

type LocalEntry struct {
	Name     string          `json:"name"`
	Relative string          `json:"relative"`
	Size     int64           `json:"size"`
	Modified int64           `json:"modified"`
	Recipe   json.RawMessage `json:"recipe"`
	Error    string          `json:"error,omitempty"`
}

type LocalFolder struct {
	Root        LocalRoot    `json:"root"`
	Relative    string       `json:"relative"`
	Directories []LocalEntry `json:"directories"`
	Photos      []LocalEntry `json:"photos"`
}

type localSidecar struct {
	Version int             `json:"version"`
	Recipe  json.RawMessage `json:"recipe"`
}

func newLocal() *Local {
	file := os.Getenv("OPENLR_LOCAL_FILE")
	if file == "" {
		config, _ := os.UserConfigDir()
		file = filepath.Join(config, "OpenLR", "folders.json")
	}
	return &Local{file: file, roots: make(map[string]LocalRoot)}
}

func (l *Local) load() error {
	data, err := os.ReadFile(l.file)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var roots []LocalRoot
	if err := json.Unmarshal(data, &roots); err != nil {
		return fmt.Errorf("read authorized folders: %w", err)
	}
	for _, root := range roots {
		l.roots[root.ID] = root
	}
	return nil
}

// Folders returns previously authorized roots; it never grants a new path.
func (l *Local) Folders() ([]LocalRoot, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.load(); err != nil {
		return nil, err
	}
	roots := make([]LocalRoot, 0, len(l.roots))
	for _, root := range l.roots {
		roots = append(roots, root)
	}
	sort.Slice(roots, func(i, j int) bool { return roots[i].Name < roots[j].Name })
	return roots, nil
}

// ChooseFolder grants access only to the folder selected in the system dialog.
func (l *Local) ChooseFolder(ctx context.Context) (*LocalFolder, error) {
	paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{Parent: mygo.CallerWindow(ctx), Directory: true})
	if err != nil || len(paths) == 0 {
		return nil, err
	}
	root, err := l.authorize(paths[0])
	if err != nil {
		return nil, err
	}
	return l.OpenFolder(root.ID, "")
}

func (l *Local) authorize(path string) (LocalRoot, error) {
	path, err := filepath.Abs(path)
	if err != nil {
		return LocalRoot{}, err
	}
	path, err = filepath.EvalSymlinks(path)
	if err != nil {
		return LocalRoot{}, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return LocalRoot{}, err
	}
	if !info.IsDir() {
		return LocalRoot{}, errors.New("choose a folder")
	}
	identity := path
	if runtime.GOOS == "windows" {
		identity = strings.ToLower(identity)
	}
	hash := sha256.Sum256([]byte(identity))
	root := LocalRoot{ID: hex.EncodeToString(hash[:16]), Name: filepath.Base(path), Path: path}
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.load(); err != nil {
		return LocalRoot{}, err
	}
	l.roots[root.ID] = root
	roots := make([]LocalRoot, 0, len(l.roots))
	for _, r := range l.roots {
		roots = append(roots, r)
	}
	data, _ := json.MarshalIndent(roots, "", "  ")
	if err := os.MkdirAll(filepath.Dir(l.file), 0o700); err != nil {
		return LocalRoot{}, err
	}
	temp, err := os.CreateTemp(filepath.Dir(l.file), ".openlr-folders-*")
	if err != nil {
		return LocalRoot{}, err
	}
	defer os.Remove(temp.Name())
	if _, err = temp.Write(data); err != nil {
		temp.Close()
		return LocalRoot{}, err
	}
	if err = temp.Close(); err != nil {
		return LocalRoot{}, err
	}
	if err = os.Rename(temp.Name(), l.file); err != nil {
		return LocalRoot{}, err
	}
	return root, nil
}

func (l *Local) root(id string) (LocalRoot, *os.Root, error) {
	l.mu.Lock()
	if err := l.load(); err != nil {
		l.mu.Unlock()
		return LocalRoot{}, nil, err
	}
	root, ok := l.roots[id]
	l.mu.Unlock()
	if !ok {
		return LocalRoot{}, nil, errors.New("folder is not authorized; choose it in Open folder first")
	}
	dir, err := os.OpenRoot(root.Path)
	return root, dir, err
}

var localPhotoExtensions = func() map[string]bool {
	result := make(map[string]bool)
	for _, ext := range strings.Fields("jpg jpeg png gif webp avif mp4 m4v mov mkv webm bmp tif tiff heic heif ico 3fr ari arw bay braw cap cine cr2 cr3 crw cs1 dc2 dcr dng drf eip erf fff gpr iiq k25 kdc mdc mef mos mrw nef nrw obm orf pef ptx pxn qtk raf raw rdc rw2 rwl rwz sr2 srf srw sti x3f") {
		result["."+ext] = true
	}
	return result
}()

func localRelative(path string) (string, error) {
	path = strings.ReplaceAll(path, "\\", "/")
	if path == "" {
		path = "."
	}
	if !fs.ValidPath(path) || filepath.IsAbs(path) || strings.Contains(path, ":") {
		return "", errors.New("path must stay inside the authorized folder")
	}
	return filepath.FromSlash(path), nil
}

func (l *Local) OpenFolder(id, relative string) (*LocalFolder, error) {
	root, dir, err := l.root(id)
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	rel, err := localRelative(relative)
	if err != nil {
		return nil, err
	}
	folder, err := dir.Open(rel)
	if err != nil {
		return nil, err
	}
	defer folder.Close()
	entries, err := folder.ReadDir(-1)
	if err != nil {
		return nil, err
	}
	result := &LocalFolder{Root: root, Relative: filepath.ToSlash(rel), Directories: []LocalEntry{}, Photos: []LocalEntry{}}
	for _, entry := range entries {
		if entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		path := filepath.Join(rel, entry.Name())
		if entry.IsDir() {
			result.Directories = append(result.Directories, LocalEntry{Name: entry.Name(), Relative: filepath.ToSlash(path)})
			continue
		}
		if !localPhotoExtensions[strings.ToLower(filepath.Ext(entry.Name()))] {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return nil, err
		}
		if !info.Mode().IsRegular() {
			continue
		}
		photo := LocalEntry{Name: entry.Name(), Relative: filepath.ToSlash(path), Size: info.Size(), Modified: info.ModTime().UnixMilli(), Recipe: json.RawMessage(`{}`)}
		data, readErr := dir.ReadFile(path + ".openlr.json")
		if readErr == nil {
			var sidecar localSidecar
			if err := json.Unmarshal(data, &sidecar); err != nil || sidecar.Version != 1 || len(sidecar.Recipe) == 0 {
				photo.Error = "Cannot read OpenLR edit sidecar"
			} else {
				photo.Recipe = sidecar.Recipe
			}
		} else if !errors.Is(readErr, fs.ErrNotExist) {
			photo.Error = "Cannot read OpenLR edit sidecar"
		}
		result.Photos = append(result.Photos, photo)
	}
	sort.Slice(result.Directories, func(i, j int) bool { return result.Directories[i].Name < result.Directories[j].Name })
	sort.Slice(result.Photos, func(i, j int) bool { return result.Photos[i].Name < result.Photos[j].Name })
	return result, nil
}

// SaveRecipe stores OpenLR JSON beside the image, never inside the original.
func (l *Local) SaveRecipe(id, relative, recipe string) error {
	_, dir, err := l.root(id)
	if err != nil {
		return err
	}
	defer dir.Close()
	rel, err := localRelative(relative)
	if err != nil {
		return err
	}
	info, err := dir.Stat(rel)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || !localPhotoExtensions[strings.ToLower(filepath.Ext(rel))] {
		return errors.New("edit target must be a photo")
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal([]byte(recipe), &object); err != nil || object == nil {
		return errors.New("edit recipe must be a JSON object")
	}
	data, err := json.MarshalIndent(localSidecar{Version: 1, Recipe: json.RawMessage(recipe)}, "", "  ")
	if err != nil {
		return err
	}
	temp := filepath.Join(filepath.Dir(rel), fmt.Sprintf(".openlr-%d.tmp", time.Now().UnixNano()))
	file, err := dir.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	defer dir.Remove(temp)
	if _, err = file.Write(data); err != nil {
		file.Close()
		return err
	}
	if err = file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	return dir.Rename(temp, rel+".openlr.json")
}

func (l *Local) servePhoto(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "read only", http.StatusMethodNotAllowed)
		return
	}
	parts := strings.SplitN(strings.TrimPrefix(r.URL.Path, "/"), "/", 2)
	if len(parts) != 2 {
		http.NotFound(w, r)
		return
	}
	_, dir, err := l.root(parts[0])
	if err != nil {
		http.Error(w, "unauthorized folder", http.StatusForbidden)
		return
	}
	defer dir.Close()
	rel, err := localRelative(parts[1])
	if err != nil || !localPhotoExtensions[strings.ToLower(filepath.Ext(rel))] {
		http.NotFound(w, r)
		return
	}
	file, err := dir.Open(rel)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeContent(w, r, info.Name(), info.ModTime(), file)
}
