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
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

type Camera struct {
	mu        sync.Mutex
	devices   map[string]cameraDevice
	captures  map[string]string
	sequence  int
	directory string
}
type CameraDevice struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Backend    string `json:"backend"`
	CanCapture bool   `json:"canCapture"`
	Simulated  bool   `json:"simulated"`
}
type cameraDevice struct {
	CameraDevice
	nativeID string
	port     string
}
type CameraBackend struct {
	Name      string `json:"name"`
	Available bool   `json:"available"`
	Message   string `json:"message,omitempty"`
}
type CameraDiscovery struct {
	Devices  []CameraDevice  `json:"devices"`
	Backends []CameraBackend `json:"backends"`
}
type CameraFile struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Size int64  `json:"size"`
}
type CameraCapture struct {
	Device CameraDevice `json:"device"`
	Files  []CameraFile `json:"files"`
}

func newCamera() *Camera {
	directory := os.Getenv("OPENLR_CAMERA_DIRECTORY")
	if directory == "" {
		config, _ := os.UserConfigDir()
		directory = filepath.Join(config, "OpenLR", "camera-captures")
	}
	return &Camera{devices: make(map[string]cameraDevice), captures: make(map[string]string), directory: directory}
}
func cameraID(backend, value string) string {
	hash := sha256.Sum256([]byte(value))
	return backend + ":" + hex.EncodeToString(hash[:12])
}

const wiaDiscoverScript = `$ErrorActionPreference='Stop';[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding; $manager=New-Object -ComObject WIA.DeviceManager; $result=@(); foreach($info in $manager.DeviceInfos){if($info.Type -ne 2){continue};$name='WIA camera';foreach($p in $info.Properties){if($p.Name -eq 'Name'){$name=[string]$p.Value}};$device=$info.Connect();$capture=$false;foreach($cmd in $device.Commands){if($cmd.CommandID -eq '{AF933CAC-ACAD-11D2-A093-00C04F72DC3C}'){$capture=$true}};$result+=@{id=[string]$info.DeviceID;name=$name;capture=$capture}};ConvertTo-Json -InputObject @($result) -Compress`
const wiaCaptureScript = `$ErrorActionPreference='Stop';$manager=New-Object -ComObject WIA.DeviceManager;$device=$null;foreach($info in $manager.DeviceInfos){if($info.DeviceID -eq $env:OPENLR_WIA_DEVICE){$device=$info.Connect();break}};if($null -eq $device){throw 'The camera disconnected'};$item=$device.ExecuteCommand('{AF933CAC-ACAD-11D2-A093-00C04F72DC3C}');if($null -eq $item){throw 'The camera did not return a captured image'};$image=$item.Transfer();$extension=[string]$image.FileExtension;if($extension -notmatch '^[A-Za-z0-9]+$'){throw 'Invalid camera image extension'};$image.SaveFile((Join-Path $env:OPENLR_WIA_OUTPUT ('capture.'+$extension)))`

func powershellCamera(ctx context.Context, script string, environment ...string) ([]byte, error) {
	command := exec.CommandContext(ctx, "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-Command", script)
	command.Env = append(os.Environ(), environment...)
	data, err := command.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("WIA: %w: %s", err, strings.TrimSpace(string(data)))
	}
	return data, nil
}
func (c *Camera) Devices(ctx context.Context) (*CameraDiscovery, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.devices = make(map[string]cameraDevice)
	result := &CameraDiscovery{Devices: []CameraDevice{}, Backends: []CameraBackend{}}
	if runtime.GOOS == "windows" {
		probe, cancel := context.WithTimeout(ctx, 15*time.Second)
		data, err := powershellCamera(probe, wiaDiscoverScript)
		cancel()
		backend := CameraBackend{Name: "WIA", Available: err == nil}
		if err != nil {
			backend.Message = err.Error()
		} else {
			var devices []struct {
				ID      string `json:"id"`
				Name    string `json:"name"`
				Capture bool   `json:"capture"`
			}
			if err = json.Unmarshal(data, &devices); err != nil {
				backend.Message = "Cannot decode WIA discovery"
				backend.Available = false
			} else {
				for _, device := range devices {
					info := CameraDevice{ID: cameraID("wia", device.ID), Name: device.Name, Backend: "wia", CanCapture: device.Capture}
					c.devices[info.ID] = cameraDevice{CameraDevice: info, nativeID: device.ID}
					result.Devices = append(result.Devices, info)
				}
			}
		}
		result.Backends = append(result.Backends, backend)
	}
	if binary, err := exec.LookPath("gphoto2"); err == nil {
		probe, cancel := context.WithTimeout(ctx, 15*time.Second)
		command := exec.CommandContext(probe, binary, "--auto-detect")
		data, err := command.CombinedOutput()
		cancel()
		backend := CameraBackend{Name: "gphoto2", Available: err == nil}
		if err != nil {
			backend.Message = string(data)
		} else {
			for _, device := range parseGphotoDevices(string(data)) {
				c.devices[device.ID] = device
				result.Devices = append(result.Devices, device.CameraDevice)
			}
		}
		result.Backends = append(result.Backends, backend)
	} else {
		result.Backends = append(result.Backends, CameraBackend{Name: "gphoto2", Available: false, Message: "gphoto2 is not installed"})
	}
	if simulator := os.Getenv("OPENLR_CAMERA_SIMULATOR"); simulator != "" {
		if info, err := os.Stat(simulator); err == nil && info.IsDir() {
			device := CameraDevice{ID: "simulator", Name: "[SIMULATOR] Generated fixture camera", Backend: "simulator", CanCapture: true, Simulated: true}
			c.devices[device.ID] = cameraDevice{CameraDevice: device, nativeID: simulator}
			result.Devices = append(result.Devices, device)
			result.Backends = append(result.Backends, CameraBackend{Name: "simulator", Available: true, Message: "Test fixture simulator; not a physical camera"})
		}
	}
	return result, nil
}
func parseGphotoDevices(output string) []cameraDevice {
	pattern := regexp.MustCompile(`^(.+?)\s{2,}(usb:[0-9,]+|ptpip:[^\s]+)\s*$`)
	result := []cameraDevice{}
	for _, line := range strings.Split(output, "\n") {
		parts := pattern.FindStringSubmatch(strings.TrimSpace(line))
		if len(parts) != 3 {
			continue
		}
		info := CameraDevice{ID: cameraID("gphoto2", parts[1]+parts[2]), Name: parts[1], Backend: "gphoto2", CanCapture: true}
		result = append(result, cameraDevice{CameraDevice: info, nativeID: parts[1], port: parts[2]})
	}
	return result
}
func (c *Camera) Capture(ctx context.Context, id string) (*CameraCapture, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	device, ok := c.devices[id]
	if !ok {
		return nil, errors.New("refresh camera discovery and select a connected camera")
	}
	if !device.CanCapture {
		return nil, errors.New("this camera driver does not support remote capture")
	}
	var token [16]byte
	if _, err := rand.Read(token[:]); err != nil {
		return nil, err
	}
	captureID := hex.EncodeToString(token[:])
	directory := filepath.Join(c.directory, captureID)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, err
	}
	operation, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	switch device.Backend {
	case "wia":
		if _, err := powershellCamera(operation, wiaCaptureScript, "OPENLR_WIA_DEVICE="+device.nativeID, "OPENLR_WIA_OUTPUT="+directory); err != nil {
			return nil, err
		}
	case "gphoto2":
		command := exec.CommandContext(operation, "gphoto2", "--camera", device.nativeID, "--port", device.port, "--capture-image-and-download", "--keep", "--filename", filepath.Join(directory, "capture-%n.%C"))
		if output, err := command.CombinedOutput(); err != nil {
			return nil, fmt.Errorf("camera capture: %w: %s", err, strings.TrimSpace(string(output)))
		}
	case "simulator":
		entries, err := os.ReadDir(device.nativeID)
		if err != nil {
			return nil, err
		}
		files := []string{}
		for _, entry := range entries {
			if entry.Type().IsRegular() && localPhotoExtensions[strings.ToLower(filepath.Ext(entry.Name()))] {
				files = append(files, entry.Name())
			}
		}
		sort.Strings(files)
		if len(files) == 0 {
			return nil, errors.New("camera simulator has no image fixtures")
		}
		name := files[c.sequence%len(files)]
		c.sequence++
		input, err := os.Open(filepath.Join(device.nativeID, name))
		if err != nil {
			return nil, err
		}
		output, err := os.Create(filepath.Join(directory, "simulated-"+name))
		if err != nil {
			input.Close()
			return nil, err
		}
		_, err = io.Copy(output, input)
		input.Close()
		closeErr := output.Close()
		if err != nil {
			return nil, err
		}
		if closeErr != nil {
			return nil, closeErr
		}
	default:
		return nil, errors.New("unsupported camera backend")
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, err
	}
	result := &CameraCapture{Device: device.CameraDevice, Files: []CameraFile{}}
	for _, entry := range entries {
		if !entry.Type().IsRegular() {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return nil, err
		}
		if info.Size() == 0 {
			continue
		}
		fileID := captureID + "-" + hex.EncodeToString([]byte(entry.Name()))
		c.captures[fileID] = filepath.Join(directory, entry.Name())
		result.Files = append(result.Files, CameraFile{ID: fileID, Name: entry.Name(), Size: info.Size()})
	}
	if len(result.Files) == 0 {
		return nil, errors.New("the camera produced no downloadable image")
	}
	return result, nil
}
func (c *Camera) servePhoto(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "read only", 405)
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/")
	c.mu.Lock()
	path, ok := c.captures[id]
	c.mu.Unlock()
	if !ok {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	http.ServeFile(w, r, path)
}
