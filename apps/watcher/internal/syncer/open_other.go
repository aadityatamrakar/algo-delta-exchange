//go:build !windows

package syncer

import "os"

func openShared(path string) (*os.File, error) { return os.Open(path) }
