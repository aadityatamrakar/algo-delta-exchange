// Package uploader talks to the traders ingest API.
package uploader

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	ErrOffset   = errors.New("server refused the offset") // 409
	ErrRejected = errors.New("server rejected the token") // 401, 403
)

// HTTPError is any other non-2xx response.
type HTTPError struct {
	Status int
	Body   string
}

func (e *HTTPError) Error() string { return fmt.Sprintf("server returned %d: %s", e.Status, e.Body) }

// Client is the API client. HTTP nil means a default client with a 60 s timeout.
type Client struct {
	Server, Token, Version string
	HTTP                   *http.Client
}

// PutResult is the server's reply to a file upload.
type PutResult struct {
	Stored     bool    `json:"stored"`
	Parser     *string `json:"parser"`
	ParseError *string `json:"parseError"`
}

// Heartbeat is the body of POST /v1/traders/heartbeat.
type Heartbeat struct {
	Version      string `json:"version"`
	Folder       string `json:"folder"`
	LastUploadAt *int64 `json:"lastUploadAt"`
	FileCount    int    `json:"fileCount"`
}

var defaultHTTP = &http.Client{Timeout: 60 * time.Second}

func (c *Client) do(ctx context.Context, method, endpoint, ctype string, body []byte) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(c.Server, "/")+endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Content-Type", ctype)
	req.Header.Set("User-Agent", "traders-watcher/"+c.Version)
	hc := c.HTTP
	if hc == nil {
		hc = defaultHTTP
	}
	resp, err := hc.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		return b, nil
	case resp.StatusCode == http.StatusConflict:
		return nil, ErrOffset
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		return nil, ErrRejected
	}
	return nil, &HTTPError{Status: resp.StatusCode, Body: string(b)}
}

// PutFile uploads body. sha is of the WHOLE content the server will hold
// afterwards. offset < 0 means the whole file; otherwise body is the tail
// starting at offset.
func (c *Client) PutFile(ctx context.Context, rel string, mtime time.Time, sha string, body []byte, offset int64) (PutResult, error) {
	q := url.Values{}
	q.Set("path", rel)
	q.Set("mtime", strconv.FormatInt(mtime.UnixMilli(), 10))
	q.Set("sha256", sha)
	if offset >= 0 {
		q.Set("offset", strconv.FormatInt(offset, 10))
	}
	b, err := c.do(ctx, http.MethodPut, "/v1/traders/files?"+q.Encode(), "application/octet-stream", body)
	if err != nil {
		return PutResult{}, err
	}
	var r PutResult
	if err := json.Unmarshal(b, &r); err != nil {
		return PutResult{}, fmt.Errorf("bad upload reply: %w", err)
	}
	return r, nil
}

// SendHeartbeat posts the watcher's liveness record.
func (c *Client) SendHeartbeat(ctx context.Context, hb Heartbeat) error {
	b, err := json.Marshal(hb)
	if err != nil {
		return err
	}
	_, err = c.do(ctx, http.MethodPost, "/v1/traders/heartbeat", "application/json", b)
	return err
}

// Queue is a latest-wins set of rel paths, kept in first-queued order.
// The zero value is ready to use.
type Queue struct {
	mu    sync.Mutex
	order []string
	set   map[string]struct{}
}

func (q *Queue) Put(rel string) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.set == nil {
		q.set = map[string]struct{}{}
	}
	if _, ok := q.set[rel]; ok {
		return
	}
	q.set[rel] = struct{}{}
	q.order = append(q.order, rel)
}

// Take returns everything queued, in first-queued order, and empties the queue.
func (q *Queue) Take() []string {
	q.mu.Lock()
	defer q.mu.Unlock()
	out := q.order
	q.order, q.set = nil, nil
	return out
}

func (q *Queue) Len() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.order)
}
