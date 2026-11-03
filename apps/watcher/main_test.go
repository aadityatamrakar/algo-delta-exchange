package main

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestRunRejectsBadConfig(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "nope.json")
	err := run([]string{"-config", missing})
	if err == nil || !strings.Contains(err.Error(), missing) {
		t.Fatalf("want an error naming %s, got %v", missing, err)
	}
}

func TestRunVersion(t *testing.T) {
	if err := run([]string{"-version"}); err != nil {
		t.Fatal(err)
	}
}
