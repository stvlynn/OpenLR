package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestGphotoDiscoveryParsing(t *testing.T) {
	devices := parseGphotoDevices("Model                          Port\n----------------------------------------------------------\nCanon EOS Test                 usb:001,004\nNikon Test                     ptpip:192.0.2.1\n")
	if len(devices) != 2 || devices[0].Name != "Canon EOS Test" || devices[0].port != "usb:001,004" || devices[1].Backend != "gphoto2" {
		t.Fatalf("unexpected discovery: %+v", devices)
	}
}
func TestCameraSimulatorCaptureContract(t *testing.T) {
	fixtures := t.TempDir()
	source := filepath.Join(fixtures, "fixture.dng")
	original := []byte("generated fixture bytes")
	os.WriteFile(source, original, 0o600)
	c := &Camera{devices: map[string]cameraDevice{"simulator": {CameraDevice: CameraDevice{ID: "simulator", Name: "[SIMULATOR] fixture camera", Backend: "simulator", Simulated: true, CanCapture: true}, nativeID: fixtures}}, captures: make(map[string]string), directory: t.TempDir()}
	if _, err := c.Capture(context.Background(), "missing"); err == nil {
		t.Fatal("unknown camera accepted")
	}
	shot, err := c.Capture(context.Background(), "simulator")
	if err != nil {
		t.Fatal(err)
	}
	if !shot.Device.Simulated || len(shot.Files) != 1 {
		t.Fatalf("simulation contract lost: %+v", shot)
	}
	response := httptest.NewRecorder()
	c.servePhoto(response, httptest.NewRequest(http.MethodGet, "http://cameraphoto.localhost/"+shot.Files[0].ID, nil))
	if response.Code != 200 || response.Body.String() != string(original) {
		t.Fatal("capture bytes changed")
	}
	after, _ := os.ReadFile(source)
	if string(after) != string(original) {
		t.Fatal("camera source was changed")
	}
}
