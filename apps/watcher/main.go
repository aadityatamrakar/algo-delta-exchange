// Command watcher syncs a trader's ODIN OnLineBackup folder to the server.
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"time"

	"github.com/algomaker/watcher/internal/config"
	"github.com/algomaker/watcher/internal/syncer"
	"github.com/algomaker/watcher/internal/uploader"
)

var version = "dev" // -ldflags "-X main.version=…"

const logLimit = 5 << 20

func main() {
	if err := run(os.Args[1:]); err != nil {
		// Built as a GUI program there is no console; leave a trace next to the exe.
		if exe, e := os.Executable(); e == nil {
			if f, e := os.OpenFile(filepath.Join(filepath.Dir(exe), "watcher.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644); e == nil {
				fmt.Fprintf(f, "%s fatal: %v\n", time.Now().Format(time.RFC3339), err)
				f.Close()
			}
		}
		fmt.Fprintln(os.Stderr, "watcher:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	fs := flag.NewFlagSet("watcher", flag.ContinueOnError)
	cfgPath := fs.String("config", "", "path to watcher.json (default: next to the executable)")
	showVersion := fs.Bool("version", false, "print the version and exit")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *showVersion {
		fmt.Println(version)
		return nil
	}
	p := *cfgPath
	if p == "" {
		exe, err := os.Executable()
		if err != nil {
			return err
		}
		p = config.DefaultPath(exe)
	}
	cfg, err := config.Load(p)
	if err != nil {
		return fmt.Errorf("config %s: %w", p, err)
	}

	lw := &rotatingFile{path: filepath.Join(filepath.Dir(p), "watcher.log"), limit: logLimit}
	defer lw.Close()
	lg := log.New(lw, "", log.LstdFlags)

	roots := []string{cfg.Folder}
	if twin, ok := config.VirtualStoreTwin(cfg.Folder, os.Getenv); ok {
		roots = append(roots, twin)
	}
	lg.Printf("watcher %s starting: folder=%s roots=%v server=%s", version, cfg.Folder, roots, cfg.Server)

	s := syncer.New(syncer.Options{
		Roots: roots, Include: cfg.Include, Folder: cfg.Folder, Version: version,
		Quiet: 2 * time.Second, Rescan: 5 * time.Minute, Heartbeat: 60 * time.Second, Retry: 30 * time.Second,
		MaxSize: 20 << 20,
		Up:      &uploader.Client{Server: cfg.Server, Token: cfg.Token, Version: version},
		Log:     lg,
	})
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	return s.Run(ctx)
}

// rotatingFile appends to path and moves it to path+".1" once it passes limit.
type rotatingFile struct {
	mu    sync.Mutex
	path  string
	limit int64
	f     *os.File
	size  int64
}

func (r *rotatingFile) open() error {
	f, err := os.OpenFile(r.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	fi, err := f.Stat()
	if err != nil {
		f.Close()
		return err
	}
	r.f, r.size = f, fi.Size()
	return nil
}

func (r *rotatingFile) Write(b []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.f == nil {
		if err := r.open(); err != nil {
			return len(b), nil // never let logging stop the sync
		}
	}
	if r.size+int64(len(b)) > r.limit {
		r.f.Close()
		r.f = nil
		_ = os.Remove(r.path + ".1")
		_ = os.Rename(r.path, r.path+".1")
		if err := r.open(); err != nil {
			return len(b), nil
		}
	}
	n, err := r.f.Write(b)
	r.size += int64(n)
	return n, err
}

func (r *rotatingFile) Close() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.f != nil {
		return r.f.Close()
	}
	return nil
}

var _ io.Writer = (*rotatingFile)(nil)
