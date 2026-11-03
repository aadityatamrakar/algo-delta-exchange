package uploader

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"
)

type rec struct {
	method, path, rawQuery string
	header                 http.Header
	body                   string
}

func fake(status int, resp string) (*httptest.Server, *rec) {
	r := &rec{}
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, q *http.Request) {
		b, _ := io.ReadAll(q.Body)
		*r = rec{q.Method, q.URL.Path, q.URL.RawQuery, q.Header.Clone(), string(b)}
		w.WriteHeader(status)
		w.Write([]byte(resp))
	}))
	return s, r
}

func TestPutFileWhole(t *testing.T) {
	s, r := fake(200, `{"stored":true,"parser":"odin-trd","parseError":null}`)
	defer s.Close()
	c := &Client{Server: s.URL, Token: "tok", Version: "1.0.0"}
	res, err := c.PutFile(context.Background(), "Nse Derivatives/Trades/1019TRD.TXT", time.UnixMilli(1760000000123), "abc", []byte("hello"), -1)
	if err != nil {
		t.Fatal(err)
	}
	if r.method != "PUT" || r.path != "/v1/traders/files" {
		t.Fatalf("%s %s", r.method, r.path)
	}
	if r.rawQuery != "mtime=1760000000123&path=Nse+Derivatives%2FTrades%2F1019TRD.TXT&sha256=abc" {
		t.Fatal(r.rawQuery)
	}
	if r.body != "hello" || r.header.Get("Authorization") != "Bearer tok" ||
		r.header.Get("Content-Type") != "application/octet-stream" ||
		r.header.Get("User-Agent") != "traders-watcher/1.0.0" || r.header.Get("Origin") != "" {
		t.Fatalf("%q %v", r.body, r.header)
	}
	if !res.Stored || res.Parser == nil || *res.Parser != "odin-trd" || res.ParseError != nil {
		t.Fatalf("%+v", res)
	}
}

func TestPutFileOffset(t *testing.T) {
	s, r := fake(200, `{"stored":true,"parser":null,"parseError":null}`)
	defer s.Close()
	c := &Client{Server: s.URL + "/", Token: "tok", Version: "1"}
	if _, err := c.PutFile(context.Background(), "a/b.txt", time.UnixMilli(5), "ff", []byte("tail"), 4096); err != nil {
		t.Fatal(err)
	}
	if r.rawQuery != "mtime=5&offset=4096&path=a%2Fb.txt&sha256=ff" || r.body != "tail" || r.path != "/v1/traders/files" {
		t.Fatalf("%s %q %s", r.rawQuery, r.body, r.path)
	}
}

func TestStatuses(t *testing.T) {
	for _, tc := range []struct {
		status int
		check  func(error) bool
	}{
		{409, func(e error) bool { return errors.Is(e, ErrOffset) }},
		{401, func(e error) bool { return errors.Is(e, ErrRejected) }},
		{403, func(e error) bool { return errors.Is(e, ErrRejected) }},
		{500, func(e error) bool {
			var he *HTTPError
			return errors.As(e, &he) && he.Status == 500 && he.Body == "boom"
		}},
	} {
		s, _ := fake(tc.status, "boom")
		c := &Client{Server: s.URL, Token: "t", Version: "1"}
		_, err := c.PutFile(context.Background(), "a", time.Now(), "x", nil, -1)
		if err == nil || !tc.check(err) {
			t.Errorf("%d: %v", tc.status, err)
		}
		s.Close()
	}
	s, _ := fake(200, "")
	url := s.URL
	s.Close()
	c := &Client{Server: url, Token: "t", Version: "1"}
	_, err := c.PutFile(context.Background(), "a", time.Now(), "x", nil, -1)
	var he *HTTPError
	if err == nil || errors.Is(err, ErrOffset) || errors.Is(err, ErrRejected) || errors.As(err, &he) {
		t.Fatalf("closed server: %v", err)
	}
	// heartbeat shares the status mapping
	s2, _ := fake(401, "")
	defer s2.Close()
	if err := (&Client{Server: s2.URL, Token: "t"}).SendHeartbeat(context.Background(), Heartbeat{}); !errors.Is(err, ErrRejected) {
		t.Fatal(err)
	}
}

func TestHeartbeatBody(t *testing.T) {
	s, r := fake(200, `{}`)
	defer s.Close()
	c := &Client{Server: s.URL, Token: "tok", Version: "1.0.0"}
	if err := c.SendHeartbeat(context.Background(), Heartbeat{Version: "1.0.0", Folder: `C:\ODIN\OnLineBackup`, FileCount: 3}); err != nil {
		t.Fatal(err)
	}
	want := `{"version":"1.0.0","folder":"C:\\ODIN\\OnLineBackup","lastUploadAt":null,"fileCount":3}`
	if r.method != "POST" || r.path != "/v1/traders/heartbeat" || r.body != want ||
		r.header.Get("Content-Type") != "application/json" || r.header.Get("Origin") != "" ||
		r.header.Get("Authorization") != "Bearer tok" {
		t.Fatalf("%s %s %q %v", r.method, r.path, r.body, r.header)
	}
}

func TestQueueLatestWins(t *testing.T) {
	var q Queue
	q.Put("a")
	q.Put("b")
	q.Put("a")
	if q.Len() != 2 {
		t.Fatal(q.Len())
	}
	if got := q.Take(); !reflect.DeepEqual(got, []string{"a", "b"}) || q.Len() != 0 {
		t.Fatal(got)
	}
	if got := q.Take(); len(got) != 0 {
		t.Fatal(got)
	}
}
