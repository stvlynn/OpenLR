package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

func TestFolderExportCollisionsAndCompletion(t *testing.T) {
	d := &Desktop{}
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "PHOTO.png"), []byte("existing"), 0o600); err != nil {
		t.Fatal(err)
	}
	folder, err := d.BeginExportFolder(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	defer d.EndExportFolder(folder.ID)
	for index, want := range []string{"photo-2.png", "photo-3.png", "旅行.png"} {
		name := "photo.png"
		if index == 2 {
			name = want
		}
		transfer, err := d.BeginFolderExport(folder.ID, name)
		if err != nil {
			t.Fatal(err)
		}
		if transfer.Filename != want || transfer.Path != filepath.Join(root, want) {
			t.Fatalf("unexpected result: %+v", transfer)
		}
		if _, err := os.Stat(transfer.Path); !os.IsNotExist(err) {
			t.Fatal("destination exposed before completion")
		}
		if err := d.WriteExport(transfer.ID, base64.StdEncoding.EncodeToString([]byte(want))); err != nil {
			t.Fatal(err)
		}
		if err := d.FinishExport(transfer.ID); err != nil {
			t.Fatal(err)
		}
		data, err := os.ReadFile(transfer.Path)
		if err != nil || string(data) != want {
			t.Fatalf("output: %q %v", data, err)
		}
	}
	existing, _ := os.ReadFile(filepath.Join(root, "PHOTO.png"))
	if string(existing) != "existing" {
		t.Fatal("existing destination overwritten")
	}
	entries, _ := os.ReadDir(root)
	if len(entries) != 4 {
		t.Fatal("temporary export files remained")
	}
}

func TestFolderExportRaceAndCancellationPreserveFiles(t *testing.T) {
	d := &Desktop{}
	root := t.TempDir()
	folder, err := d.BeginExportFolder(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"../escape.jpg", "a/b.jpg", "a\\b.jpg", ".", ""} {
		if _, err := d.BeginFolderExport(folder.ID, name); err == nil {
			t.Fatalf("accepted filename %q", name)
		}
	}
	transfer, err := d.BeginFolderExport(folder.ID, "race.png")
	if err != nil {
		t.Fatal(err)
	}
	if err := d.WriteExport(transfer.ID, "ZXhwb3J0"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(transfer.Path, []byte("concurrent writer"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := d.FinishExport(transfer.ID); err == nil {
		t.Fatal("replaced concurrent destination")
	}
	data, _ := os.ReadFile(transfer.Path)
	if string(data) != "concurrent writer" {
		t.Fatal("concurrent file changed")
	}
	partial, err := d.BeginFolderExport(folder.ID, "partial.png")
	if err != nil {
		t.Fatal(err)
	}
	if err := d.WriteExport(partial.ID, "cGFydGlhbA=="); err != nil {
		t.Fatal(err)
	}
	d.EndExportFolder(folder.ID)
	if err := d.FinishExport(partial.ID); err == nil {
		t.Fatal("closed transfer remained")
	}
	if _, err := d.BeginFolderExport(folder.ID, "later.png"); err == nil {
		t.Fatal("closed folder remained")
	}
	entries, _ := os.ReadDir(root)
	if len(entries) != 1 || entries[0].Name() != "race.png" {
		t.Fatal("cancellation left partial output")
	}
}

func TestExportStreamsBeyond64MiB(t *testing.T) {
	d := &Desktop{exports: make(map[string]*exportFile)}
	destination := filepath.Join(t.TempDir(), "photo.jpg")
	if err := os.WriteFile(destination, []byte("original destination"), 0o600); err != nil {
		t.Fatal(err)
	}
	id, err := d.beginExport(destination)
	if err != nil {
		t.Fatal(err)
	}
	defer d.cancelAll()
	chunk := make([]byte, 512<<10)
	for i := range chunk {
		chunk[i] = byte(i % 251)
	}
	encoded := base64.StdEncoding.EncodeToString(chunk)
	want := sha256.New()
	for i := 0; i < 130; i++ {
		if err := d.WriteExport(id, encoded); err != nil {
			t.Fatal(err)
		}
		want.Write(chunk)
	}
	before, _ := os.ReadFile(destination)
	if string(before) != "original destination" {
		t.Fatal("destination changed before transfer finished")
	}
	if err := d.FinishExport(id); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	if got := sha256.Sum256(data); string(got[:]) != string(want.Sum(nil)) {
		t.Fatal("streamed bytes changed")
	}
	if len(data) != 65<<20 {
		t.Fatalf("got %d bytes", len(data))
	}
}

func TestCanceledExportPreservesDestination(t *testing.T) {
	d := &Desktop{exports: make(map[string]*exportFile)}
	dir := t.TempDir()
	destination := filepath.Join(dir, "photo.jpg")
	os.WriteFile(destination, []byte("original"), 0o600)
	id, err := d.beginExport(destination)
	if err != nil {
		t.Fatal(err)
	}
	if err := d.WriteExport(id, "aW5jb21wbGV0ZQ=="); err != nil {
		t.Fatal(err)
	}
	d.CancelExport(id)
	data, _ := os.ReadFile(destination)
	if string(data) != "original" {
		t.Fatal("cancel changed destination")
	}
	files, _ := os.ReadDir(dir)
	if len(files) != 1 {
		t.Fatal("partial export was not removed")
	}
	if err := d.FinishExport(id); err == nil {
		t.Fatal("canceled transfer remained active")
	}
}
