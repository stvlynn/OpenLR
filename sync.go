package main

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
)

// Remote stores credentials in memory for the active sync. Each request targets
// one OpenLR resource inside the endpoint the user explicitly supplied.
type Remote struct {
	mu                 sync.RWMutex
	base               *url.URL
	username, password string
}
type RemoteResult struct {
	Status int    `json:"status"`
	ETag   string `json:"etag"`
	Data   string `json:"data,omitempty"`
}

var resourceName = regexp.MustCompile(`^openlr-(manifest\.json|[A-Za-z0-9_-]+\.(original|hdr))$`)
var davClient = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

func (r *Remote) Connect(endpoint, username, password string) error {
	u, err := url.Parse(endpoint)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("enter a WebDAV folder URL")
	}
	loopback := u.Hostname() == "localhost" || net.ParseIP(u.Hostname()).IsLoopback()
	if u.Scheme != "https" && !(u.Scheme == "http" && loopback) {
		return errors.New("use HTTPS for a remote WebDAV folder")
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/"
	u.RawPath = ""
	r.mu.Lock()
	defer r.mu.Unlock()
	r.base = u
	r.username = username
	r.password = password
	return nil
}
func (r *Remote) Disconnect() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.base = nil
	r.username = ""
	r.password = ""
}
func (r *Remote) request(ctx context.Context, method, key, condition, encoded string) (RemoteResult, error) {
	if !resourceName.MatchString(key) {
		return RemoteResult{}, errors.New("invalid sync resource")
	}
	r.mu.RLock()
	if r.base == nil {
		r.mu.RUnlock()
		return RemoteResult{}, errors.New("connect to a WebDAV folder first")
	}
	target := r.base.JoinPath(key).String()
	username, password := r.username, r.password
	r.mu.RUnlock()
	var body io.Reader
	if method == http.MethodPut {
		body = base64.NewDecoder(base64.StdEncoding, strings.NewReader(encoded))
	}
	req, err := http.NewRequestWithContext(ctx, method, target, body)
	if err != nil {
		return RemoteResult{}, err
	}
	if username != "" || password != "" {
		req.SetBasicAuth(username, password)
	}
	if condition == "*" {
		req.Header.Set("If-None-Match", "*")
	} else if condition != "" {
		req.Header.Set("If-Match", condition)
	}
	if method == http.MethodPut {
		req.Header.Set("Content-Type", "application/octet-stream")
	}
	res, err := davClient.Do(req)
	if err != nil {
		return RemoteResult{}, err
	}
	defer res.Body.Close()
	out := RemoteResult{Status: res.StatusCode, ETag: res.Header.Get("ETag")}
	if res.StatusCode == http.StatusNotFound || res.StatusCode == http.StatusPreconditionFailed {
		return out, nil
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return out, fmt.Errorf("WebDAV %s %s: %s", method, key, res.Status)
	}
	if method == http.MethodGet {
		var text strings.Builder
		encoder := base64.NewEncoder(base64.StdEncoding, &text)
		if _, err = io.Copy(encoder, res.Body); err != nil {
			return out, err
		}
		if err = encoder.Close(); err != nil {
			return out, err
		}
		out.Data = text.String()
	}
	return out, nil
}
func (r *Remote) Get(ctx context.Context, key string) (RemoteResult, error) {
	return r.request(ctx, http.MethodGet, key, "", "")
}
func (r *Remote) Put(ctx context.Context, key, condition, encoded string) (RemoteResult, error) {
	return r.request(ctx, http.MethodPut, key, condition, encoded)
}
