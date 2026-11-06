package main

import (
	"bytes"
	"regexp"
	"strings"
	"testing"
)

func TestStartupRendererMilestonesAreOptInAndAllowlisted(t *testing.T) {
	var output bytes.Buffer
	d := &Desktop{}
	d.StartupMilestone("renderer-script")
	d.startup = newStartupTrace(&output)
	d.StartupMilestone("renderer-script\nprivate path")
	d.StartupMilestone("opaque unknown message")
	d.StartupMilestone("renderer-script")
	d.StartupMilestone("renderer-script")
	d.StartupMilestone("workspace-ready-failed")
	got := strings.Split(strings.TrimSpace(output.String()), "\n")
	expected := []string{"renderer-script", "workspace-ready-failed"}
	if len(got) != len(expected) {
		t.Fatalf("unexpected startup diagnostic output: %q", got)
	}
	for i, stage := range expected {
		pattern := regexp.MustCompile("^OpenLR startup milestone " + stage + " elapsed_ms=[0-9]+$")
		if !pattern.MatchString(got[i]) {
			t.Fatalf("startup log must contain only a fixed stage and elapsed time: %q", got[i])
		}
	}
}
