package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type Sharing struct {
	mu       sync.Mutex
	file     string
	endpoint string
	token    string
	loaded   bool
}

func newSharing() *Sharing {
	file := os.Getenv("OPENLR_SHARE_FILE")
	if file == "" {
		config, _ := os.UserConfigDir()
		file = filepath.Join(config, "OpenLR", "sharing.json")
	}
	return &Sharing{file: file}
}
func (s *Sharing) load() error {
	if s.loaded {
		return nil
	}
	data, err := os.ReadFile(s.file)
	if err == nil {
		var config struct {
			Endpoint string `json:"endpoint"`
			Token    string `json:"token"`
		}
		if err = json.Unmarshal(data, &config); err != nil {
			return err
		}
		s.endpoint = config.Endpoint
		s.token = config.Token
	} else if !os.IsNotExist(err) {
		return err
	}
	if endpoint := os.Getenv("OPENLR_SHARE_URL"); endpoint != "" {
		s.endpoint = endpoint
	}
	if token := os.Getenv("OPENLR_SHARE_TOKEN"); token != "" {
		s.token = token
	}
	s.loaded = true
	return nil
}
func (s *Sharing) State() (map[string]any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.load(); err != nil {
		return nil, err
	}
	return map[string]any{"endpoint": s.endpoint, "configured": s.endpoint != "" && s.token != ""}, nil
}
func (s *Sharing) Configure(endpoint, token string) error {
	u, err := url.Parse(endpoint)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("enter the review server's HTTP(S) URL")
	}
	if token == "" {
		return errors.New("admin token is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.endpoint = strings.TrimRight(endpoint, "/")
	s.token = token
	s.loaded = true
	data, _ := json.Marshal(map[string]string{"endpoint": s.endpoint, "token": token})
	if err = os.MkdirAll(filepath.Dir(s.file), 0o700); err != nil {
		return err
	}
	return os.WriteFile(s.file, data, 0o600)
}
func (s *Sharing) request(ctx context.Context, method, path, contentType string, body []byte) (string, error) {
	s.mu.Lock()
	if err := s.load(); err != nil {
		s.mu.Unlock()
		return "", err
	}
	endpoint, token := s.endpoint, s.token
	s.mu.Unlock()
	if endpoint == "" || token == "" {
		return "", errors.New("configure an OpenLR review server first")
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint+path, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", contentType)
	client := http.Client{Timeout: 90 * time.Second}
	response, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		return "", err
	}
	if response.StatusCode >= 300 {
		return "", fmt.Errorf("review server HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(data)))
	}
	return string(data), nil
}
func (s *Sharing) Prepare(ctx context.Context, id, title string, comments, likes bool) (string, error) {
	data, _ := json.Marshal(map[string]any{"title": title, "allowComments": comments, "allowLikes": likes})
	return s.request(ctx, http.MethodPost, "/api/albums/"+url.PathEscape(id), "application/json", data)
}
func (s *Sharing) Upload(ctx context.Context, album, photo, encoded string) error {
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return err
	}
	_, err = s.request(ctx, http.MethodPut, "/api/albums/"+url.PathEscape(album)+"/photos/"+url.PathEscape(photo), "image/jpeg", data)
	return err
}
func (s *Sharing) Publish(ctx context.Context, id, photos string) (string, error) {
	if !json.Valid([]byte(photos)) {
		return "", errors.New("invalid photo list")
	}
	return s.request(ctx, http.MethodPost, "/api/albums/"+url.PathEscape(id)+"/publish", "application/json", []byte(`{"photos":`+photos+`}`))
}
func (s *Sharing) Reviews(ctx context.Context, id string) (string, error) {
	return s.request(ctx, http.MethodGet, "/api/albums/"+url.PathEscape(id), "application/json", nil)
}
func (s *Sharing) Revoke(ctx context.Context, id string) error {
	_, err := s.request(ctx, http.MethodPost, "/api/albums/"+url.PathEscape(id)+"/revoke", "application/json", []byte(`{}`))
	return err
}
