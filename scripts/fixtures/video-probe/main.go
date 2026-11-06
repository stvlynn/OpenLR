package main

import (
	"embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"mime"
	"os"

	"github.com/egoist/mygo"
)

//go:embed probe.html probe.js
var probeAssets embed.FS

type probeFrontend struct {
	workspace fs.FS
}

func (f probeFrontend) Open(name string) (fs.File, error) {
	switch name {
	case "probe.html", "probe.js":
		return probeAssets.Open(name)
	default:
		return f.workspace.Open(name)
	}
}

type VideoProbe struct {
	fixture string
	report  string
}

func (p *VideoProbe) Fixture() string { return p.fixture }

func (p *VideoProbe) Finish(report string) error {
	if !json.Valid([]byte(report)) {
		return errors.New("video origin probe returned invalid JSON")
	}
	if err := os.WriteFile(p.report, []byte(report), 0o600); err != nil {
		return errors.New("cannot save video origin probe report")
	}
	mygo.App.Quit()
	return nil
}

func main() {
	if len(os.Args) != 4 {
		log.Fatal("Pass the frontend directory, generated video, and private report destination")
	}
	bytes, err := os.ReadFile(os.Args[2])
	if err != nil {
		log.Fatal("Cannot read generated video fixture")
	}
	for extension, contentType := range map[string]string{".mjs": "text/javascript", ".js": "text/javascript"} {
		if err := mime.AddExtensionType(extension, contentType); err != nil {
			log.Fatal(err)
		}
	}
	mygo.SetFrontend(probeFrontend{workspace: os.DirFS(os.Args[1])})
	mygo.Bind(&VideoProbe{fixture: base64.StdEncoding.EncodeToString(bytes), report: os.Args[3]})
	mygo.App.WhenReady(func() {
		mygo.NewWindow(mygo.WindowOptions{
			Title:  "OpenLR Video Origin Probe",
			URL:    "/probe.html",
			Width:  640,
			Height: 480,
			Page:   mygo.PageOptions{Session: mygo.NewEphemeralSession()},
		})
	})
	mygo.App.OnWindowAllClosed(mygo.App.Quit)
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}
