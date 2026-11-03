// Package syncer watches the ODIN OnLineBackup folder (and its VirtualStore
// twin) and uploads changed files to the traders ingest API.
//
// ODIN appends to the day's trade file during the session, so the normal
// upload is an offset append of the new complete lines.
package syncer

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"log"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/algomaker/watcher/internal/uploader"
)

type Clock interface{ Now() time.Time }

type realClock struct{}

func (realClock) Now() time.Time { return time.Now() }

type Uploader interface {
	PutFile(ctx context.Context, rel string, mtime time.Time, sha string, body []byte, offset int64) (uploader.PutResult, error)
	SendHeartbeat(ctx context.Context, hb uploader.Heartbeat) error
}

type Options struct {
	Roots     []string
	Include   []string
	Folder    string
	Version   string
	Quiet     time.Duration // 2s
	Rescan    time.Duration // 5m
	Heartbeat time.Duration // 60s
	Retry     time.Duration // 30s
	MaxSize   int64         // 20 << 20
	Clock     Clock
	Up        Uploader
	Log       *log.Logger
}

// statKey is the size and mtime of a file at one moment.
type statKey struct {
	size  int64
	mtime time.Time
}

// pending is a noticed file waiting for quiet.
type pending struct {
	last time.Time // time of the last event
	st   statKey   // stat as of the last event
}

// uploaded is what the server holds for a rel path.
type uploaded struct {
	size int64  // bytes of content sent (complete lines only)
	sha  string // sha256 of those bytes
	st   statKey
}

type Syncer struct {
	o  Options
	mu sync.Mutex

	pend     map[string]*pending // rel
	done     map[string]uploaded // rel
	seen     map[string]statKey  // abs, for the poll
	bad      map[string]string   // rel -> sha the server refused with a 4xx
	queue    uploader.Queue
	nextTry  time.Time
	rejLog   time.Time
	lastUp   *time.Time
	fileCnt  int
	lastScan time.Time
	lastHB   time.Time
	walkErr  string // last logged walk error
}

func New(o Options) *Syncer {
	if o.Clock == nil {
		o.Clock = realClock{}
	}
	if o.Log == nil {
		o.Log = log.New(io.Discard, "", 0)
	}
	now := o.Clock.Now()
	return &Syncer{
		o: o, pend: map[string]*pending{}, done: map[string]uploaded{},
		seen: map[string]statKey{}, bad: map[string]string{},
		lastScan: now, lastHB: now,
	}
}

// included reports whether rel (forward slashes) matches an include pattern.
func (s *Syncer) included(rel string) bool {
	lrel := strings.ToLower(rel)
	base := path.Base(lrel)
	for _, p := range s.o.Include {
		lp := strings.ToLower(p)
		target := base
		if strings.Contains(lp, "/") {
			target = lrel
		}
		if ok, _ := path.Match(lp, target); ok {
			return true
		}
	}
	return false
}

// relOf returns the path of abs below one of the roots, with forward slashes.
func (s *Syncer) relOf(abs string) (string, bool) {
	for _, r := range s.o.Roots {
		rel, err := filepath.Rel(r, abs)
		if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			continue
		}
		return filepath.ToSlash(rel), true
	}
	return "", false
}

// newest stats rel under every root and returns the newest copy.
func (s *Syncer) newest(rel string) (abs string, st statKey, ok bool) {
	for _, r := range s.o.Roots {
		p := filepath.Join(r, filepath.FromSlash(rel))
		fi, err := os.Stat(p)
		if err != nil || !fi.Mode().IsRegular() {
			continue
		}
		if !ok || fi.ModTime().After(st.mtime) {
			abs, st, ok = p, statKey{fi.Size(), fi.ModTime()}, true
		}
	}
	return
}

// Notice records a change event for abs.
func (s *Syncer) Notice(abs string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.notice(abs, false)
}

// notice records an event. Every notice starts the quiet period afresh. A
// scan's notice (fromScan) never replaces an entry already pending: that entry
// carries a more recent event than the scan's stat.
func (s *Syncer) notice(abs string, fromScan bool) {
	rel, ok := s.relOf(abs)
	if !ok || !s.included(rel) {
		return
	}
	_, st, ok := s.newest(rel)
	if !ok {
		return
	}
	if _, exists := s.pend[rel]; exists && fromScan {
		return
	}
	s.pend[rel] = &pending{last: s.o.Clock.Now(), st: st}
}

// walk calls fn for every regular included file under every root. It returns
// an error when the watched folder (the first root) cannot be walked, and logs
// it once per distinct message; a missing VirtualStore twin is fine.
func (s *Syncer) walk(fn func(abs, rel string, fi fs.FileInfo)) error {
	var rootErr error
	for i, r := range s.o.Roots {
		_ = filepath.WalkDir(r, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				if i == 0 && p == r && rootErr == nil {
					rootErr = err
				}
				return nil
			}
			if d.IsDir() {
				return nil
			}
			rel, ok := s.relOf(p)
			if !ok || !s.included(rel) {
				return nil
			}
			// os.Stat, not d.Info(): on Windows DirEntry.Info() returns the
			// directory-listing record, which NTFS updates lazily while ODIN
			// holds the file open for writing. A real stat sees live appends.
			fi, err := os.Stat(p)
			if err != nil || !fi.Mode().IsRegular() {
				return nil
			}
			fn(p, rel, fi)
			return nil
		})
	}
	if rootErr == nil {
		s.walkErr = ""
		return nil
	}
	if msg := rootErr.Error(); msg != s.walkErr {
		s.walkErr = msg
		s.o.Log.Printf("cannot read watched folder: %v", rootErr)
	}
	return rootErr
}

// Scan walks every root, counts the included files and notices each whose size
// or mtime differs from its last upload.
func (s *Syncer) Scan() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.scan()
}

func (s *Syncer) scan() error {
	rels := map[string]bool{}
	err := s.walk(func(abs, rel string, fi fs.FileInfo) {
		rels[rel] = true
		st := statKey{fi.Size(), fi.ModTime()}
		s.seen[abs] = st
		if fi.Size() == 0 {
			return
		}
		if d, ok := s.done[rel]; ok && d.st == st {
			return
		}
		s.notice(abs, true)
	})
	s.fileCnt = len(rels)
	s.lastScan = s.o.Clock.Now()
	return err
}

// Tick does whatever is due: rescan, queued retries, quiet files, heartbeat.
func (s *Syncer) Tick(ctx context.Context) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.o.Clock.Now()

	if now.Sub(s.lastScan) >= s.o.Rescan {
		s.scan()
	}

	if s.queue.Len() > 0 && !now.Before(s.nextTry) {
		for _, rel := range s.queue.Take() {
			s.upload(ctx, rel)
		}
	}

	for rel, p := range s.pend {
		if ctx.Err() != nil {
			return
		}
		if now.Sub(p.last) < s.o.Quiet {
			continue
		}
		_, st, ok := s.newest(rel)
		if !ok {
			delete(s.pend, rel)
			continue
		}
		if st != p.st { // still changing: that counts as an event
			p.st, p.last = st, now
			continue
		}
		delete(s.pend, rel)
		if s.queue.Len() > 0 && now.Before(s.nextTry) {
			s.queue.Put(rel) // the server is failing; wait for the retry slot
			continue
		}
		s.upload(ctx, rel)
	}

	if now.Sub(s.lastHB) >= s.o.Heartbeat {
		s.lastHB = now
		hb := uploader.Heartbeat{Version: s.o.Version, Folder: s.o.Folder, FileCount: s.fileCnt}
		if s.lastUp != nil {
			ms := s.lastUp.UnixMilli()
			hb.LastUploadAt = &ms
		}
		if err := s.o.Up.SendHeartbeat(ctx, hb); err != nil {
			s.o.Log.Printf("heartbeat failed: %v", err)
		}
	}
}

func hashHex(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// upload sends the current content of rel. The file on disk is always the
// latest version, so a failed upload just queues the path.
func (s *Syncer) upload(ctx context.Context, rel string) {
	abs, st, ok := s.newest(rel)
	if !ok || st.size == 0 {
		return
	}
	if st.size > s.o.MaxSize {
		s.o.Log.Printf("skip %s: %d bytes is over the %d byte limit", rel, st.size, s.o.MaxSize)
		return
	}
	f, err := openShared(abs)
	if err != nil {
		s.o.Log.Printf("open %s: %v", rel, err)
		s.fail(rel)
		return
	}
	data, err := io.ReadAll(io.LimitReader(f, s.o.MaxSize+1))
	f.Close()
	if err != nil {
		s.o.Log.Printf("read %s: %v", rel, err)
		s.fail(rel)
		return
	}
	if int64(len(data)) > s.o.MaxSize {
		s.o.Log.Printf("skip %s: over the %d byte limit", rel, s.o.MaxSize)
		return
	}
	// Complete lines only: hold back an unterminated last line.
	i := bytes.LastIndexByte(data, '\n')
	if i < 0 {
		return
	}
	content := data[:i+1]
	sha := hashHex(content)
	last, had := s.done[rel]
	if had && last.sha == sha {
		last.st = st
		s.done[rel] = last
		return
	}
	if s.bad[rel] == sha {
		return
	}

	var err2 error
	sent := false
	if had && int64(len(content)) > last.size && hashHex(content[:last.size]) == last.sha {
		_, err2 = s.o.Up.PutFile(ctx, rel, st.mtime, sha, content[last.size:], last.size)
		sent = err2 == nil
		if errors.Is(err2, uploader.ErrOffset) {
			s.o.Log.Printf("%s: server refused offset %d, resending whole", rel, last.size)
			err2 = nil
		}
	}
	if !sent && err2 == nil {
		_, err2 = s.o.Up.PutFile(ctx, rel, st.mtime, sha, content, -1)
	}
	if err2 == nil {
		s.done[rel] = uploaded{size: int64(len(content)), sha: sha, st: st}
		now := s.o.Clock.Now()
		s.lastUp = &now
		delete(s.bad, rel)
		s.o.Log.Printf("uploaded %s (%d bytes)", rel, len(content))
		return
	}

	var he *uploader.HTTPError
	switch {
	case errors.Is(err2, uploader.ErrRejected):
		if now := s.o.Clock.Now(); s.rejLog.IsZero() || now.Sub(s.rejLog) >= time.Hour {
			s.rejLog = now
			s.o.Log.Printf("upload %s: server rejected the token", rel)
		}
		s.fail(rel)
	case errors.As(err2, &he) && he.Status < 500:
		s.o.Log.Printf("upload %s refused with %d: %s", rel, he.Status, he.Body)
		s.bad[rel] = sha
	default:
		s.o.Log.Printf("upload %s failed, will retry: %v", rel, err2)
		s.fail(rel)
	}
}

func (s *Syncer) fail(rel string) {
	s.queue.Put(rel)
	s.nextTry = s.o.Clock.Now().Add(s.o.Retry)
}

// Run scans, then polls every second and ticks every 500 ms until ctx ends.
func (s *Syncer) Run(ctx context.Context) error {
	_ = s.Scan() // a walk error is logged; keep running in case the folder appears
	tick := time.NewTicker(500 * time.Millisecond)
	poll := time.NewTicker(time.Second)
	defer tick.Stop()
	defer poll.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-poll.C:
			s.poll()
		case <-tick.C:
			s.Tick(ctx)
		}
	}
}
