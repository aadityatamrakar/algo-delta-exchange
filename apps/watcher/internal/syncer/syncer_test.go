package syncer

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/algomaker/watcher/internal/uploader"
)

type fakeClock struct{ t time.Time }

func (c *fakeClock) Now() time.Time      { return c.t }
func (c *fakeClock) Add(d time.Duration) { c.t = c.t.Add(d) }
func (c *fakeClock) Set(t time.Time)     { c.t = t }

type put struct {
	Path, Sha string
	Offset    int64 // -1 when absent
	Body      string
	Mtime     int64
}

type srv struct {
	*httptest.Server
	mu     sync.Mutex
	puts   []put
	hbs    []uploader.Heartbeat
	status func(p put) int // nil → 200
}

func newSrv(t *testing.T) *srv {
	s := &srv{}
	s.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		s.mu.Lock()
		defer s.mu.Unlock()
		if r.URL.Path == "/v1/traders/heartbeat" {
			var hb uploader.Heartbeat
			_ = json.Unmarshal(b, &hb)
			s.hbs = append(s.hbs, hb)
			w.WriteHeader(200)
			return
		}
		q := r.URL.Query()
		p := put{Path: q.Get("path"), Sha: q.Get("sha256"), Offset: -1, Body: string(b)}
		if o := q.Get("offset"); o != "" {
			p.Offset, _ = strconv.ParseInt(o, 10, 64)
		}
		p.Mtime, _ = strconv.ParseInt(q.Get("mtime"), 10, 64)
		s.puts = append(s.puts, p)
		code := 200
		if s.status != nil {
			code = s.status(p)
		}
		w.WriteHeader(code)
		if code == 200 {
			_, _ = w.Write([]byte(`{"stored":true,"parser":null,"parseError":null}`))
		}
	}))
	t.Cleanup(s.Close)
	return s
}

func (s *srv) count() int                { s.mu.Lock(); defer s.mu.Unlock(); return len(s.puts) }
func (s *srv) last() put                 { s.mu.Lock(); defer s.mu.Unlock(); return s.puts[len(s.puts)-1] }
func (s *srv) setStatus(f func(put) int) { s.mu.Lock(); s.status = f; s.mu.Unlock() }

var include = []string{"*/Trades/*TRD.TXT", "*/Orders/*.txt", "*/Orders/*.TXT"}

type env struct {
	t   *testing.T
	dir string
	clk *fakeClock
	srv *srv
	s   *Syncer
	t0  time.Time
}

func newEnv(t *testing.T, roots ...string) *env {
	e := &env{t: t, dir: t.TempDir(), srv: newSrv(t)}
	e.t0 = time.Date(2026, 10, 19, 10, 0, 0, 0, time.UTC)
	e.clk = &fakeClock{t: e.t0}
	if len(roots) == 0 {
		roots = []string{e.dir}
	}
	cl := &uploader.Client{Server: e.srv.URL, Token: "tok", Version: "t"}
	e.s = New(Options{
		Roots: roots, Include: include, Folder: roots[0], Version: "1.2.3",
		Quiet: 2 * time.Second, Rescan: 5 * time.Minute, Heartbeat: 60 * time.Second, Retry: 30 * time.Second,
		MaxSize: 20 << 20, Clock: e.clk, Up: cl, Log: log.New(io.Discard, "", 0),
	})
	return e
}

func (e *env) write(root, rel, content string) string {
	e.t.Helper()
	p := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		e.t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		e.t.Fatal(err)
	}
	return p
}

func (e *env) appendTo(p, content string) {
	e.t.Helper()
	f, err := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		e.t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(content); err != nil {
		e.t.Fatal(err)
	}
}

func (e *env) tick(d time.Duration) { e.clk.Add(d); e.s.Tick(context.Background()) }

func sum(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }

const trade = "Nse Derivatives/Trades/1019TRD.TXT"

func TestNewFileUploadsOnceAfterQuiet(t *testing.T) {
	e := newEnv(t)
	body := "a,b,c\r\nd,e,f\r\n"
	p := e.write(e.dir, trade, body)
	e.s.Notice(p)
	e.tick(1900 * time.Millisecond)
	if e.srv.count() != 0 {
		t.Fatalf("early PUT")
	}
	e.tick(100 * time.Millisecond)
	if e.srv.count() != 1 {
		t.Fatalf("want 1 PUT, got %d", e.srv.count())
	}
	g := e.srv.last()
	if g.Path != trade || g.Body != body || g.Sha != sum(body) || g.Offset != -1 {
		t.Fatalf("bad put %+v", g)
	}
	e.tick(time.Second)
	if e.srv.count() != 1 {
		t.Fatalf("re-upload")
	}
}

func TestExcludedFileNeverUploads(t *testing.T) {
	e := newEnv(t)
	e.write(e.dir, "Nse Derivatives/Trades/DOCOMMiocp.log", "x\r\n")
	e.write(e.dir, "Spread/Logs/x_CrossCurr.csv", "x\r\n")
	if err := e.s.Scan(); err != nil {
		t.Fatal(err)
	}
	e.tick(3 * time.Second)
	if e.srv.count() != 0 {
		t.Fatalf("excluded uploaded")
	}
}

func TestZeroByteSkipped(t *testing.T) {
	e := newEnv(t)
	e.write(e.dir, "MCX Derivatives/Trades/0928TRD.TXT", "")
	_ = e.s.Scan()
	e.tick(3 * time.Second)
	if e.srv.count() != 0 {
		t.Fatalf("zero byte uploaded")
	}
}

func TestQuietResetsOnNewEvents(t *testing.T) {
	e := newEnv(t)
	p := e.write(e.dir, trade, "a\r\n")
	e.s.Notice(p)
	e.tick(1500 * time.Millisecond)
	e.s.Notice(p)
	e.tick(time.Second) // t0+2.5s
	if e.srv.count() != 0 {
		t.Fatalf("uploaded too early")
	}
	e.tick(1100 * time.Millisecond) // t0+3.6s
	if e.srv.count() != 1 {
		t.Fatalf("want 1, got %d", e.srv.count())
	}
}

func TestAppendSendsOnlyNewLines(t *testing.T) {
	e := newEnv(t)
	first := ""
	for len(first) < 300 {
		first += "0123456789,abcdefghij,klmnopqrst\r\n"
	}
	p := e.write(e.dir, trade, first)
	e.s.Notice(p)
	e.tick(2 * time.Second)
	add := "new,line,here\r\n"
	e.appendTo(p, add)
	e.s.Notice(p)
	e.tick(2 * time.Second)
	if e.srv.count() != 2 {
		t.Fatalf("want 2 PUTs, got %d", e.srv.count())
	}
	g := e.srv.last()
	if g.Offset != int64(len(first)) || g.Body != add || g.Sha != sum(first+add) {
		t.Fatalf("bad append %+v", g)
	}
}

func TestPartialLastLineHeldBack(t *testing.T) {
	e := newEnv(t)
	p := e.write(e.dir, trade, "one\r\n")
	e.s.Notice(p)
	e.tick(2 * time.Second)
	e.appendTo(p, "abc")
	e.s.Notice(p)
	e.tick(2 * time.Second)
	if e.srv.count() != 1 {
		t.Fatalf("partial line sent")
	}
	e.appendTo(p, "\r\n")
	e.s.Notice(p)
	e.tick(2 * time.Second)
	if e.srv.count() != 2 {
		t.Fatalf("want 2, got %d", e.srv.count())
	}
	g := e.srv.last()
	if g.Offset != 5 || g.Body != "abc\r\n" {
		t.Fatalf("bad %+v", g)
	}
}

func TestNoNewlineAtAllSendsNothing(t *testing.T) {
	e := newEnv(t)
	p := e.write(e.dir, trade, "abc")
	e.s.Notice(p)
	e.tick(2 * time.Second)
	if e.srv.count() != 0 {
		t.Fatalf("sent")
	}
}

func TestRewrittenFileSendsWhole(t *testing.T) {
	e := newEnv(t)
	rel := "Nse Derivatives/Orders/o.txt"
	p := e.write(e.dir, rel, "first\r\nsecond\r\n")
	e.s.Notice(p)
	e.tick(2 * time.Second)
	nb := "FIRST\r\nsecond\r\nthird\r\n"
	e.write(e.dir, rel, nb)
	e.s.Notice(p)
	e.tick(2 * time.Second)
	g := e.srv.last()
	if e.srv.count() != 2 || g.Offset != -1 || g.Body != nb {
		t.Fatalf("bad %+v n=%d", g, e.srv.count())
	}
}

func TestOffsetRefusedResendsWhole(t *testing.T) {
	e := newEnv(t)
	p := e.write(e.dir, trade, "one\r\n")
	e.s.Notice(p)
	e.tick(2 * time.Second)
	e.srv.setStatus(func(p put) int {
		if p.Offset >= 0 {
			return 409
		}
		return 200
	})
	e.appendTo(p, "two\r\n")
	e.s.Notice(p)
	e.tick(2 * time.Second)
	if e.srv.count() != 3 {
		t.Fatalf("want 3 PUTs, got %d", e.srv.count())
	}
	g := e.srv.last()
	if g.Offset != -1 || g.Body != "one\r\ntwo\r\n" {
		t.Fatalf("bad %+v", g)
	}
}

func TestOfflineLatestWins(t *testing.T) {
	e := newEnv(t)
	e.srv.setStatus(func(put) int { return 503 })
	p := e.write(e.dir, trade, "one\r\n")
	e.s.Notice(p)
	e.tick(2 * time.Second)
	if e.srv.count() != 1 {
		t.Fatalf("want 1 attempt, got %d", e.srv.count())
	}
	e.appendTo(p, "two\r\n")
	e.s.Notice(p)
	e.tick(2 * time.Second)
	e.appendTo(p, "three\r\n")
	e.s.Notice(p)
	e.tick(2 * time.Second)
	e.srv.setStatus(nil)
	e.tick(30 * time.Second)
	e.tick(500 * time.Millisecond)
	if e.srv.count() != 2 {
		t.Fatalf("want exactly 1 retry PUT (2 total), got %d", e.srv.count())
	}
	all := "one\r\ntwo\r\nthree\r\n"
	if g := e.srv.last(); g.Sha != sum(all) || g.Body != all {
		t.Fatalf("bad %+v", g)
	}
}

func TestRescanCatchesMissedChange(t *testing.T) {
	e := newEnv(t)
	p := e.write(e.dir, trade, "one\r\n")
	e.s.Notice(p)
	e.tick(2 * time.Second)
	e.appendTo(p, "two\r\n") // no Notice
	e.tick(4 * time.Minute)
	if e.srv.count() != 1 {
		t.Fatalf("early")
	}
	e.tick(time.Minute) // rescan notices it; quiet still applies
	if e.srv.count() != 1 {
		t.Fatalf("rescan skipped the quiet period")
	}
	e.tick(2 * time.Second)
	if e.srv.count() != 2 {
		t.Fatalf("rescan missed it, %d", e.srv.count())
	}
}

func TestPollPicksUpChangeWithoutNotice(t *testing.T) {
	e := newEnv(t)
	p := e.write(e.dir, trade, "one\r\n")
	if err := e.s.Scan(); err != nil {
		t.Fatal(err)
	}
	e.tick(2 * time.Second)
	if e.srv.count() != 1 {
		t.Fatalf("scan upload, got %d", e.srv.count())
	}
	e.appendTo(p, "two\r\n")
	e.clk.Add(time.Second)
	e.s.poll() // the 1 s poll
	e.tick(1900 * time.Millisecond)
	if e.srv.count() != 1 {
		t.Fatalf("too early")
	}
	e.tick(100 * time.Millisecond)
	if e.srv.count() != 2 {
		t.Fatalf("poll missed it, %d", e.srv.count())
	}
	if g := e.srv.last(); g.Offset != 5 || g.Body != "two\r\n" {
		t.Fatalf("bad %+v", g)
	}
	// an unchanged file is not re-noticed
	e.s.poll()
	e.tick(5 * time.Second)
	if e.srv.count() != 2 {
		t.Fatalf("unchanged file re-uploaded")
	}
}

func TestPollFindsNewSubfolder(t *testing.T) {
	e := newEnv(t)
	_ = e.s.Scan()
	e.write(e.dir, "MCX Derivatives/Trades/0928TRD.TXT", "x\r\n")
	e.s.poll()
	e.tick(2 * time.Second)
	if e.srv.count() != 1 {
		t.Fatalf("got %d", e.srv.count())
	}
}

func TestHeartbeat(t *testing.T) {
	e := newEnv(t)
	e.write(e.dir, trade, "one\r\n")
	e.write(e.dir, "Nse Derivatives/Orders/o.txt", "o\r\n")
	_ = e.s.Scan()
	e.tick(2 * time.Second)
	e.tick(58 * time.Second)
	e.srv.mu.Lock()
	defer e.srv.mu.Unlock()
	if len(e.srv.hbs) != 1 {
		t.Fatalf("want 1 heartbeat, got %d", len(e.srv.hbs))
	}
	h := e.srv.hbs[0]
	want := e.t0.Add(2 * time.Second).UnixMilli()
	if h.Version != "1.2.3" || h.Folder != e.dir || h.FileCount != 2 || h.LastUploadAt == nil || *h.LastUploadAt != want {
		t.Fatalf("bad heartbeat %+v", h)
	}
}

func TestTwinNewerWins(t *testing.T) {
	orig, twin := t.TempDir(), t.TempDir()
	e := newEnv(t, orig, twin)
	po := e.write(orig, trade, "old\r\n")
	pt := e.write(twin, trade, "twin\r\nbytes\r\n")
	old := time.Now().Add(-time.Hour)
	_ = os.Chtimes(po, old, old)
	e.s.Notice(pt)
	e.tick(2 * time.Second)
	if e.srv.count() != 1 {
		t.Fatalf("got %d", e.srv.count())
	}
	if g := e.srv.last(); g.Path != trade || g.Body != "twin\r\nbytes\r\n" {
		t.Fatalf("bad %+v", g)
	}
}

func TestRejectedTokenDoesNotSpin(t *testing.T) {
	e := newEnv(t)
	e.srv.setStatus(func(put) int { return 401 })
	p := e.write(e.dir, trade, "one\r\n")
	e.s.Notice(p)
	for i := 0; i < 600; i++ { // 5 minutes of 500 ms ticks
		e.tick(500 * time.Millisecond)
	}
	if n := e.srv.count(); n > 1+10 {
		t.Fatalf("spinning: %d PUTs", n)
	}
	if e.srv.count() < 2 {
		t.Fatalf("never retried")
	}
}

func TestOtherClientErrorNotRetried(t *testing.T) {
	e := newEnv(t)
	e.srv.setStatus(func(put) int { return 400 })
	p := e.write(e.dir, trade, "one\r\n")
	e.s.Notice(p)
	e.tick(2 * time.Second)
	e.tick(40 * time.Second)
	e.s.Notice(p)
	e.tick(2 * time.Second)
	if e.srv.count() != 1 {
		t.Fatalf("same bytes retried: %d", e.srv.count())
	}
}

func TestOversizeSkipped(t *testing.T) {
	e := newEnv(t)
	e.s.o.MaxSize = 10
	p := e.write(e.dir, trade, "0123456789\r\nabc\r\n")
	e.s.Notice(p)
	e.tick(2 * time.Second)
	if e.srv.count() != 0 {
		t.Fatalf("oversize uploaded")
	}
}

func TestRescanDoesNotReplacePendingEntry(t *testing.T) {
	e := newEnv(t)
	p := e.write(e.dir, trade, "one\r\n")
	_ = e.s.Scan()
	e.tick(2 * time.Second)
	e.appendTo(p, "two\r\n")
	e.clk.Add(4*time.Minute + 59*time.Second + 500*time.Millisecond)
	e.s.poll() // pending from the poll, last event now
	e.appendTo(p, "thr")
	e.clk.Add(500 * time.Millisecond)
	e.s.Tick(context.Background()) // rescan lands 0.5 s after the event
	if e.srv.count() != 1 {
		t.Fatalf("rescan made a recently changed file due: %d", e.srv.count())
	}
}

func TestMissingWatchedFolderIsLogged(t *testing.T) {
	var buf bytes.Buffer
	e := newEnv(t, filepath.Join(t.TempDir(), "nope"), t.TempDir())
	e.s.o.Log = log.New(&buf, "", 0)
	if err := e.s.Scan(); err == nil {
		t.Fatalf("Scan returned nil for a missing folder")
	}
	e.s.poll()
	e.s.poll()
	if n := strings.Count(buf.String(), "cannot read watched folder"); n != 1 {
		t.Fatalf("want one log line, got %d: %q", n, buf.String())
	}
}

func TestMissingTwinIsSilent(t *testing.T) {
	var buf bytes.Buffer
	e := newEnv(t, t.TempDir(), filepath.Join(t.TempDir(), "nope"))
	e.s.o.Log = log.New(&buf, "", 0)
	if err := e.s.Scan(); err != nil || buf.Len() != 0 {
		t.Fatalf("err=%v log=%q", err, buf.String())
	}
}
