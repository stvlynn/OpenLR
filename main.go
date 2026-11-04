package main

import (
	"embed"
	"io/fs"
	"log"
	"mime"
	"os"
	"runtime"

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
	mygo.App.OnQuit(desktop.cancelAll)
	var window *mygo.Window
	openWindow := func() {
		var page mygo.PageOptions
		if os.Getenv("OPENLR_EPHEMERAL") == "1" {
			page.Session = mygo.NewEphemeralSession()
		}
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
		window.OnClosed(func() { window = nil })
	}
	mygo.App.WhenReady(func() {
		if !mygo.App.RequestSingleInstanceLock() {
			mygo.App.Quit()
			return
		}
		agent, err := startAgent()
		if err != nil {
			log.Fatal("start local agent: ", err)
		}
		desktop.agent = agent
		installMenu()
		mygo.App.OnQuit(agent.close)
		openWindow()
	})
	mygo.App.OnSecondInstance(func(_ []string, _ string) {
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
