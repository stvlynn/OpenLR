package main

import (
	"context"
	"encoding/base64"
	"net/http/httptest"
	"testing"

	"golang.org/x/net/webdav"
)

func TestDAVRoundTrip(t *testing.T) {
	h := &webdav.Handler{FileSystem: webdav.NewMemFS(), LockSystem: webdav.NewMemLS()}
	server := httptest.NewServer(h)
	defer server.Close()
	client := new(Remote)
	if err := client.Connect(server.URL, "", ""); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	const key = "openlr-manifest.json"
	original := base64.StdEncoding.EncodeToString([]byte("manifest"))
	result, err := client.Get(ctx, key)
	if err != nil || result.Status != 404 {
		t.Fatalf("empty: %+v %v", result, err)
	}
	result, err = client.Put(ctx, key, "*", original)
	if err != nil || result.Status != 201 {
		t.Fatalf("create: %+v %v", result, err)
	}
	result, err = client.Get(ctx, key)
	if err != nil || result.Data != original || result.ETag == "" {
		t.Fatalf("read: %+v %v", result, err)
	}
	if _, err = client.Get(ctx, "../private"); err == nil {
		t.Fatal("invalid resource accepted")
	}
	if err = client.Connect("http://example.org/", "x", "x"); err == nil {
		t.Fatal("insecure remote accepted")
	}
	client.Disconnect()
	if _, err = client.Get(ctx, key); err == nil {
		t.Fatal("disconnected client read resource")
	}
}
