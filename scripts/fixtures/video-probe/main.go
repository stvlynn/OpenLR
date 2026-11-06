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
	"path/filepath"
	"sync/atomic"

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
	fixture  probeFixture
	report   string
	finished atomic.Bool
}

type probeFixture struct {
	Candidate string `json:"candidate"`
	Encoded   string `json:"encoded"`
}

func probeStage(stage string) { log.Print("Video origin probe: ", stage) }

func (p *VideoProbe) Stage(stage string) error {
	switch stage {
	case "renderer-start", p.fixture.Candidate + "-start", p.fixture.Candidate + "-end":
		probeStage(stage)
		return nil
	default:
		return errors.New("invalid video origin probe stage")
	}
}

func (p *VideoProbe) Fixture() probeFixture {
	probeStage("fixture-supplied")
	return p.fixture
}

func (p *VideoProbe) Finish(report string) error {
	if !json.Valid([]byte(report)) {
		return errors.New("video origin probe returned invalid JSON")
	}
	if err := os.WriteFile(p.report, []byte(report), 0o600); err != nil {
		return errors.New("cannot save video origin probe report")
	}
	p.finished.Store(true)
	probeStage("report-written")
	mygo.App.Quit()
	return nil
}

func main() {
	log.SetFlags(0)
	probeStage("host-start")
	if len(os.Args) != 5 {
		log.Fatal("Pass the frontend directory, generated video, private report destination, and candidate")
	}
	candidate := os.Args[4]
	switch candidate {
	case "direct", "poster", "anonymous", "decoded",
		"clock-detached", "clock-attached", "clock-frame-stream", "clock-restore":
	default:
		log.Fatal("Invalid video origin probe candidate")
	}
	bytes, err := os.ReadFile(os.Args[2])
	if err != nil {
		log.Fatal("Cannot read generated video fixture")
	}
	for extension, contentType := range map[string]string{".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm"} {
		if err := mime.AddExtensionType(extension, contentType); err != nil {
			log.Fatal(err)
		}
	}
	mygo.SetFrontend(probeFrontend{workspace: os.DirFS(os.Args[1])})
	probe := &VideoProbe{
		fixture: probeFixture{Candidate: candidate, Encoded: base64.StdEncoding.EncodeToString(bytes)},
		report:  os.Args[3],
	}
	profile := filepath.Dir(probe.report)
	mygo.App.SetPath(mygo.PathUserData, profile)
	mygo.App.SetPath(mygo.PathCache, profile)
	mygo.Bind(probe)
	mygo.App.OnWindowCreated(func(window *mygo.Window) {
		probeStage("window-created")
		page := window.Page()
		page.OnDOMReady(func() { probeStage("dom-ready") })
		page.OnDidFinishLoad(func() { probeStage("page-loaded") })
		page.OnDidFailLoad(func(_ *mygo.LoadError) { probeStage("page-load-failed") })
		page.OnRenderProcessGone(func(_ string) { probeStage("renderer-exited") })
	})
	mygo.App.WhenReady(func() {
		probeStage("app-ready")
		mygo.NewWindow(mygo.WindowOptions{
			Title:  "OpenLR Video Origin Probe",
			URL:    "/probe.html",
			Width:  640,
			Height: 480,
			Page:   mygo.PageOptions{Session: mygo.NewEphemeralSession()},
		})
	})
	mygo.App.OnWindowAllClosed(mygo.App.Quit)
	probeStage("app-run")
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
	if !probe.finished.Load() {
		log.Fatal("Video origin probe host exited before writing the report")
	}
	probeStage("host-finished")
}
