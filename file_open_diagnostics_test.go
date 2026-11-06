package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestFileOpenMilestonesAllowlistRepeatedRecordsAndCap(t *testing.T) {
	var output bytes.Buffer
	d := &Desktop{}
	d.FileOpenMilestone(1, "renderer-wake", nil)
	d.startup = newStartupTrace(&output)
	d.FileOpenMilestone(1, "renderer-wake\nprivate file", nil)
	d.FileOpenMilestone(1, "emit-accepted", nil)
	d.FileOpenMilestone(0, "renderer-wake", nil)
	d.FileOpenMilestone(1, "renderer-received", []int{-1})
	d.FileOpenMilestone(1, "renderer-imported", []int{1, 2})
	if output.Len() != 0 {
		t.Fatalf("unexpected invalid diagnostic records: %q", output.String())
	}
	for range maxFileOpenRecords + 1 {
		d.FileOpenMilestone(3, "renderer-imported", []int{0, 1, 0})
	}
	records := strings.Split(strings.TrimSpace(output.String()), "\n")
	if len(records) != maxFileOpenRecords {
		t.Fatalf("wrote %d repeated records", len(records))
	}
	pattern := regexp.MustCompile(fmt.Sprintf(`^OpenLR file-open milestone renderer-imported pid=%d elapsed_ms=[0-9]+ attempt=3 added=0 existing=1 failed=0$`, os.Getpid()))
	for _, record := range records {
		if !pattern.MatchString(record) {
			t.Fatalf("unexpected diagnostic record: %q", record)
		}
	}
}

type failedFileOpenTraceSink struct{ writes int }

func (s *failedFileOpenTraceSink) Write([]byte) (int, error) {
	s.writes++
	return 0, io.ErrClosedPipe
}

func TestOpenedFilesPreservesDrainsWithDisabledOrFailedDiagnostics(t *testing.T) {
	path := filepath.Join(t.TempDir(), "private-input.png")
	if err := os.WriteFile(path, []byte{1, 2, 3}, 0600); err != nil {
		t.Fatal(err)
	}
	sink := &failedFileOpenTraceSink{}
	for _, trace := range []*startupTrace{nil, newStartupTrace(sink)} {
		d := &Desktop{opened: []string{path}, startup: trace}
		files, err := d.OpenedFiles()
		if err != nil || len(files) != 1 || files[0].Name != "private-input.png" || files[0].Base64 != "AQID" || len(d.opened) != 0 {
			t.Fatalf("diagnostics changed file-open drain: %v, %v", files, err)
		}
		d.opened = []string{path + ".missing"}
		files, err = d.OpenedFiles()
		if files != nil || !errors.Is(err, os.ErrNotExist) || len(d.opened) != 0 {
			t.Fatalf("diagnostics changed file-open failure: %v, %v", files, err)
		}
	}
	if sink.writes != 4 {
		t.Fatalf("failed sink observed %d writes; expected one before and after each drain", sink.writes)
	}
}
