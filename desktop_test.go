package main

import (
	"crypto/sha256"
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

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
