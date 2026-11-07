// SPDX-License-Identifier: AGPL-3.0-only
package main

import (
	"embed"
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"

	"github.com/egoist/mygo"
)

//go:embed probe.html probe.js
var assets embed.FS

type EncoderProbe struct {
	candidate string
	directory string
	finished  atomic.Bool
}

func (p *EncoderProbe) Case() string { return p.candidate }
func (p *EncoderProbe) Finish(report string) error {
	var result struct {
		Candidate string `json:"candidate"`
	}
	if json.Unmarshal([]byte(report), &result) != nil || result.Candidate != p.candidate {
		return errors.New("encoder report does not match this owned case")
	}
	if p.finished.Swap(true) {
		return errors.New("encoder report was already supplied")
	}
	if err := os.WriteFile(filepath.Join(p.directory, "report.json"), []byte(report), 0600); err != nil {
		p.finished.Store(false)
		return err
	}
	log.Printf("Encoder probe %s: report written", p.candidate)
	mygo.App.Quit()
	return nil
}

func main() {
	log.SetFlags(0)
	if len(os.Args) != 4 {
		log.Fatal("Pass retained result directory, candidate and private profile directory")
	}
	candidate := os.Args[2]
	switch candidate {
	case "quality-default", "quality-software", "realtime-software", "realtime-default", "quality-software-flush3":
	default:
		log.Fatal("Unknown encoder case")
	}
	probe := &EncoderProbe{candidate: candidate, directory: os.Args[1]}
	receipt, _ := json.Marshal(map[string]any{"pid": os.Getpid(), "candidate": candidate, "started": time.Now().UTC()})
	if err := os.WriteFile(filepath.Join(probe.directory, "host.json"), receipt, 0600); err != nil {
		log.Fatal(err)
	}
	mygo.SetFrontend(assets)
	mygo.App.SetPath(mygo.PathUserData, os.Args[3])
	mygo.App.SetPath(mygo.PathCache, os.Args[3])
	mygo.Bind(probe)
	mygo.App.WhenReady(func() {
		mygo.NewWindow(mygo.WindowOptions{
			Title: "OpenLR Encoder Probe", URL: "/probe.html", Width: 360, Height: 240,
			Page: mygo.PageOptions{Session: mygo.NewEphemeralSession()},
		})
	})
	mygo.App.OnWindowAllClosed(mygo.App.Quit)
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
	if !probe.finished.Load() {
		log.Fatal("Encoder host exited before completing its report")
	}
	log.Printf("Encoder probe %s: host finished", candidate)
}
