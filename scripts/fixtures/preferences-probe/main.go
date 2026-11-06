package main

import (
	"embed"
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
var assets embed.FS

type frontend struct{ workspace fs.FS }

func (f frontend) Open(name string) (fs.File, error) {
	if name == "probe.html" || name == "probe.js" {
		return assets.Open(name)
	}
	return f.workspace.Open(name)
}

type fixture struct {
	Candidate string `json:"candidate"`
	Phase     string `json:"phase"`
	Value     bool   `json:"value"`
}

type PreferencesProbe struct {
	fixture  fixture
	report   string
	finished atomic.Bool
}

func (p *PreferencesProbe) Fixture() fixture { return p.fixture }

func (p *PreferencesProbe) Finish(report string) error {
	if !json.Valid([]byte(report)) {
		return errors.New("invalid preference probe report")
	}
	if err := os.WriteFile(p.report, []byte(report), 0o600); err != nil {
		return errors.New("cannot save preference probe report")
	}
	p.finished.Store(true)
	log.Print("Preference probe: acknowledged report; requesting normal quit")
	mygo.App.Quit()
	return nil
}

func main() {
	log.SetFlags(0)
	if len(os.Args) != 6 {
		log.Fatal("Pass frontend, report, candidate, phase and value")
	}
	candidate, phase, value := os.Args[3], os.Args[4], os.Args[5]
	if (candidate != "local-storage" && candidate != "indexeddb-strict") ||
		(phase != "write" && phase != "read") || (value != "true" && value != "false") {
		log.Fatal("Invalid preference probe fixture")
	}
	if err := mime.AddExtensionType(".js", "text/javascript"); err != nil {
		log.Fatal(err)
	}
	profile := filepath.Dir(os.Args[2])
	mygo.App.SetName("OpenLR Preference Probe")
	mygo.App.SetPath(mygo.PathUserData, profile)
	mygo.App.SetPath(mygo.PathCache, profile)
	mygo.SetFrontend(frontend{workspace: os.DirFS(os.Args[1])})
	probe := &PreferencesProbe{fixture: fixture{candidate, phase, value == "true"}, report: os.Args[2]}
	mygo.Bind(probe)
	mygo.App.WhenReady(func() {
		mygo.NewWindow(mygo.WindowOptions{Title: "OpenLR Preference Probe", URL: "/probe.html", Width: 400, Height: 240})
	})
	mygo.App.OnWindowAllClosed(mygo.App.Quit)
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
	if !probe.finished.Load() {
		log.Fatal("Preference probe exited without a report")
	}
}
