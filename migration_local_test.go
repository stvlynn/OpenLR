package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMigrationReferencesStayInsideExplicitRoot(t *testing.T) {
	base := t.TempDir()
	t.Setenv("OPENLR_LOCAL_FILE", filepath.Join(base, "folders.json"))
	originals := filepath.Join(base, "exported")
	if err := os.MkdirAll(filepath.Join(originals, "Album"), 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"Album/photo.png", "Album/photo.xmp"} {
		if err := os.WriteFile(filepath.Join(originals, name), []byte("synthetic fixture"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Join(originals, "Private.photoslibrary"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(originals, "Private.photoslibrary", "never.png"), []byte("not a resource export"), 0600); err != nil {
		t.Fatal(err)
	}
	local := newLocal()
	root, err := local.authorize(originals)
	if err != nil {
		t.Fatal(err)
	}
	info, err := local.ReferenceInfo(root.ID, "Album/photo.png")
	if err != nil || info.Size != 17 {
		t.Fatalf("stat exact resource: %+v, %v", info, err)
	}
	for _, path := range []string{"../outside.png", "/absolute.png", "C:/private.png", "Album/missing.png"} {
		if _, err := local.ReferenceInfo(root.ID, path); err == nil {
			t.Fatalf("accepted unauthorized/missing path %s", path)
		}
	}
	if _, err := local.ReferenceInfo("unknown", "Album/photo.png"); err == nil {
		t.Fatal("accepted unapproved root")
	}
	entries, err := local.ExportedResources(root.ID)
	if err != nil || len(entries) != 2 {
		t.Fatalf("explicit exported resources: %+v, %v", entries, err)
	}
	bundle, err := local.authorize(filepath.Join(originals, "Private.photoslibrary"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := local.ExportedResources(bundle.ID); err == nil {
		t.Fatal("read private Photos bundle")
	}
	if !photosBundlePath(filepath.Join(originals, "Private.photoslibrary", "originals")) {
		t.Fatal("accepted an internal Photos bundle directory")
	}
}
