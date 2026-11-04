package main

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/egoist/mygo"
)

func photosBundlePath(path string) bool {
	for _, part := range strings.FieldsFunc(filepath.ToSlash(path), func(r rune) bool { return r == '/' || r == '\\' }) {
		if strings.EqualFold(filepath.Ext(part), ".photoslibrary") {
			return true
		}
	}
	return false
}

// ChooseReferenceRoot authorizes only the explicitly selected originals/export
// folder. Catalog paths are metadata and never grant filesystem access.
func (l *Local) ChooseReferenceRoot(ctx context.Context) (*LocalRoot, error) {
	paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{Parent: mygo.CallerWindow(ctx), Title: "Choose originals or exported resources folder", Directory: true})
	if err != nil || len(paths) == 0 {
		return nil, err
	}
	if photosBundlePath(paths[0]) {
		return nil, errors.New("Export unmodified originals from Photos first; do not choose a Photos Library bundle")
	}
	root, err := l.authorize(paths[0])
	if err != nil {
		return nil, err
	}
	return &root, nil
}

// ReferenceInfo checks one catalog-listed file through os.Root. It does not
// follow catalog absolute paths or enumerate an originals folder.
func (l *Local) ReferenceInfo(id, relative string) (*LocalEntry, error) {
	_, dir, err := l.root(id)
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	rel, err := localRelative(relative)
	if err != nil {
		return nil, err
	}
	ext := strings.ToLower(filepath.Ext(rel))
	if !localPhotoExtensions[ext] && ext != ".xmp" {
		return nil, errors.New("unsupported referenced resource type")
	}
	info, err := dir.Stat(rel)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("referenced resource is not a regular file")
	}
	return &LocalEntry{Name: info.Name(), Relative: filepath.ToSlash(rel), Size: info.Size(), Modified: info.ModTime().UnixMilli()}, nil
}

// ExportedResources lists only a user-authorized export folder. Apple Photos
// private databases/bundles and symlink directories are never traversed.
func (l *Local) ExportedResources(id string) ([]LocalEntry, error) {
	root, dir, err := l.root(id)
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	if photosBundlePath(root.Path) {
		return nil, errors.New("choose exported resources, not a Photos Library bundle")
	}
	result := []LocalEntry{}
	err = fs.WalkDir(dir.FS(), ".", func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() && (strings.HasPrefix(entry.Name(), ".") || strings.EqualFold(filepath.Ext(entry.Name()), ".photoslibrary")) && path != "." {
			return fs.SkipDir
		}
		if entry.Type()&os.ModeSymlink != 0 || entry.IsDir() {
			return nil
		}
		ext := strings.ToLower(filepath.Ext(path))
		if !localPhotoExtensions[ext] && ext != ".xmp" {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		result = append(result, LocalEntry{Name: entry.Name(), Relative: path, Size: info.Size(), Modified: info.ModTime().UnixMilli()})
		return nil
	})
	return result, err
}
