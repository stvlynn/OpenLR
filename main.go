package main

import (
	"embed"
	"io/fs"
	"log"
	"mime"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/egoist/mygo"
)

//go:embed all:web
var frontend embed.FS

func main() {
	web, err := fs.Sub(frontend, "web")
	if err != nil {
		log.Fatal(err)
	}
	// Embedded modules have the same MIME types regardless of host file associations.
	for extension, contentType := range map[string]string{".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm"} {
		if err := mime.AddExtensionType(extension, contentType); err != nil {
			log.Fatal(err)
		}
	}
	mygo.SetFrontend(web)
	desktop := &Desktop{exports: make(map[string]*exportFile)}
	if os.Getenv("OPENLR_DIAGNOSTICS") == "1" {
		desktop.startup = newStartupTrace(os.Stderr)
		// MyGo fires this before loading WindowOptions.URL.
		mygo.App.OnWindowCreated(desktop.startup.observeWindow)
	}
	mygo.Bind(desktop)
	local := newLocal()
	mygo.Bind(local)
	mygo.Bind(&Remote{})
	mygo.Protocol.HandleFunc("localphoto", local.servePhoto)
	external := newExternal(desktop)
	mygo.Bind(external)
	mygo.Protocol.HandleFunc("externalphoto", external.servePhoto)
	camera := newCamera()
	mygo.Bind(camera)
	mygo.Protocol.HandleFunc("cameraphoto", camera.servePhoto)
	mygo.Bind(newSharing())
	mygo.App.OnQuit(desktop.cancelAll)
	audio := newNativeAudio()
	mygo.Bind(audio)
	mygo.App.OnWindowCreated(audio.observeWindow)
	mygo.App.OnQuit(audio.quit)
	var window *mygo.Window
	openWindow := func() {
		var page mygo.PageOptions
		if os.Getenv("OPENLR_EPHEMERAL") == "1" {
			page.Session = mygo.NewEphemeralSession()
		}
		if desktop.startup != nil {
			page.PreloadScript = "globalThis.openlrDiagnostics = true\n"
		}
		if runtime.GOOS == "darwin" {
			page.PreloadScript += "globalThis.openlrNativePlatform = 'darwin'\n"
		}
		desktop.startup.mark("window-requested")
		window = mygo.NewWindow(mygo.WindowOptions{
			Page:            page,
			Title:           "OpenLR",
			URL:             "/",
			Width:           1440,
			Height:          960,
			MinWidth:        1024,
			MinHeight:       680,
			StateKey:        "workspace",
			BackgroundColor: "#141414",
			AutoHideMenuBar: true,
		})
		desktop.startup.mark("window-request-returned")
		window.OnClosed(func() { window = nil })
	}
	mygo.App.WhenReady(func() {
		desktop.startup.mark("application-ready")
		if !mygo.App.RequestSingleInstanceLock() {
			mygo.App.Quit()
			return
		}
		agent, err := startAgent(desktop.startup)
		if err != nil {
			log.Fatal("start local agent: ", err)
		}
		desktop.agent = agent
		desktop.startup.mark("agent-published")
		installMenu()
		mygo.App.OnQuit(agent.close)
		openWindow()
	})
	mygo.App.OnOpenFile(func(path string) {
		if !localPhotoExtensions[strings.ToLower(filepath.Ext(path))] {
			return
		}
		desktop.mu.Lock()
		desktop.opened = append(desktop.opened, path)
		queued := len(desktop.opened)
		desktop.mu.Unlock()
		desktop.startup.fileOpen(0, "queued", queued)
		if window != nil {
			if err := menuAction.Emit(window, "open-files"); err != nil {
				desktop.startup.fileOpen(0, "emit-failed")
			} else {
				desktop.startup.fileOpen(0, "emit-accepted")
			}
			window.Restore()
			window.Focus()
		} else {
			desktop.startup.fileOpen(0, "no-window")
		}
	})
	mygo.App.OnSecondInstance(func(_ []string, _ string) {
		desktop.startup.fileOpen(0, "second-instance")
		if window != nil {
			window.Restore()
			window.Focus()
		}
	})
	mygo.App.OnWindowAllClosed(func() {
		if runtime.GOOS != "darwin" {
			mygo.App.Quit()
		}
	})
	mygo.App.OnActivate(func(hasVisibleWindows bool) {
		if !hasVisibleWindows && window == nil {
			openWindow()
		}
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}
