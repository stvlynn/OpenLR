// Package review implements OpenLR's independently deployable album review
// service. It has no dependency on the desktop application or photo editor.
package review

import (
	"crypto/rand"
	"crypto/subtle"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

//go:embed viewer.html
var viewer embed.FS

type Photo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}
type Comment struct {
	ID      string `json:"id"`
	PhotoID string `json:"photoId"`
	Name    string `json:"name"`
	Text    string `json:"text"`
	Created string `json:"created"`
}
type Album struct {
	ID            string                       `json:"id"`
	Title         string                       `json:"title"`
	Token         string                       `json:"token,omitempty"`
	Revoked       bool                         `json:"revoked"`
	Photos        []Photo                      `json:"photos"`
	Comments      []Comment                    `json:"comments"`
	Likes         map[string]map[string]string `json:"likes"`
	AllowComments bool                         `json:"allowComments"`
	AllowLikes    bool                         `json:"allowLikes"`
}
type Server struct {
	mu         sync.Mutex
	Directory  string
	AdminToken string
	albums     map[string]*Album
	committed  []byte
}

func Token() string {
	var token [24]byte
	if _, err := rand.Read(token[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(token[:])
}
func New(directory, token string) (*Server, error) {
	if token == "" {
		return nil, errors.New("an admin token is required")
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, err
	}
	s := &Server{Directory: directory, AdminToken: token, albums: make(map[string]*Album), committed: []byte(`{}`)}
	data, err := os.ReadFile(filepath.Join(directory, "albums.json"))
	if err == nil {
		if err = json.Unmarshal(data, &s.albums); err != nil {
			return nil, err
		}
		s.committed = append([]byte(nil), data...)
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	return s, nil
}

var safeID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,100}$`)

func (s *Server) persist() (failure error) {
	defer func() {
		if failure != nil {
			var restored map[string]*Album
			if json.Unmarshal(s.committed, &restored) == nil {
				s.albums = restored
			}
		}
	}()
	data, err := json.MarshalIndent(s.albums, "", "  ")
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(s.Directory, ".albums-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err = file.Write(data); err != nil {
		file.Close()
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	if err = os.Rename(file.Name(), filepath.Join(s.Directory, "albums.json")); err != nil {
		return err
	}
	s.committed = append([]byte(nil), data...)
	return nil
}
func jsonReply(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(value)
}
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
	w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, OPTIONS")
	if r.Method == http.MethodOptions {
		w.WriteHeader(204)
		return
	}
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) == 2 && parts[0] == "albums" && safeID.MatchString(parts[1]) && r.Method == http.MethodGet {
		data, _ := viewer.ReadFile("viewer.html")
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(data)
		return
	}
	admin := len(parts) >= 3 && parts[0] == "api" && parts[1] == "albums"
	if admin {
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+s.AdminToken)) != 1 {
			jsonReply(w, 401, map[string]string{"error": "unauthorized"})
			return
		}
		parts = parts[2:]
	} else if len(parts) >= 2 && parts[0] == "review" {
		parts = parts[1:]
	} else {
		http.NotFound(w, r)
		return
	}
	if len(parts) < 1 || !safeID.MatchString(parts[0]) {
		http.NotFound(w, r)
		return
	}
	id := parts[0]
	s.mu.Lock()
	defer s.mu.Unlock()
	album := s.albums[id]
	if admin && len(parts) == 1 && r.Method == http.MethodPost {
		var input struct {
			Title         string `json:"title"`
			AllowComments *bool  `json:"allowComments"`
			AllowLikes    *bool  `json:"allowLikes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil || strings.TrimSpace(input.Title) == "" {
			jsonReply(w, 400, map[string]string{"error": "album title required"})
			return
		}
		if album == nil {
			album = &Album{ID: id, Token: Token(), Photos: []Photo{}, Comments: []Comment{}, Likes: make(map[string]map[string]string), AllowComments: true, AllowLikes: true}
			s.albums[id] = album
		}
		album.Title = input.Title
		if album.Revoked {
			album.Token = Token()
		}
		album.Revoked = false
		if input.AllowComments != nil {
			album.AllowComments = *input.AllowComments
		}
		if input.AllowLikes != nil {
			album.AllowLikes = *input.AllowLikes
		}
		if err := s.persist(); err != nil {
			jsonReply(w, 500, map[string]string{"error": err.Error()})
			return
		}
		jsonReply(w, 200, album)
		return
	}
	if album == nil {
		http.NotFound(w, r)
		return
	}
	if !admin && (album.Revoked || subtle.ConstantTimeCompare([]byte(r.URL.Query().Get("key")), []byte(album.Token)) != 1) {
		jsonReply(w, 403, map[string]string{"error": "album link is unavailable"})
		return
	}
	if len(parts) == 1 && r.Method == http.MethodGet {
		copy := *album
		if !admin {
			copy.Token = ""
		}
		jsonReply(w, 200, copy)
		return
	}
	if admin && len(parts) == 2 && parts[1] == "revoke" && r.Method == http.MethodPost {
		album.Revoked = true
		if err := s.persist(); err != nil {
			jsonReply(w, 500, map[string]string{"error": err.Error()})
			return
		}
		jsonReply(w, 200, map[string]bool{"revoked": true})
		return
	}
	if admin && len(parts) == 2 && parts[1] == "publish" && r.Method == http.MethodPost {
		var input struct {
			Photos []Photo `json:"photos"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			jsonReply(w, 400, map[string]string{"error": "invalid photo list"})
			return
		}
		for _, photo := range input.Photos {
			if !safeID.MatchString(photo.ID) {
				jsonReply(w, 400, map[string]string{"error": "invalid photo ID"})
				return
			}
			if _, err := os.Stat(filepath.Join(s.Directory, id, photo.ID+".jpg")); err != nil {
				jsonReply(w, 400, map[string]string{"error": "missing uploaded photo"})
				return
			}
		}
		album.Photos = input.Photos
		if err := s.persist(); err != nil {
			jsonReply(w, 500, map[string]string{"error": err.Error()})
			return
		}
		jsonReply(w, 200, album)
		return
	}
	if len(parts) == 3 && parts[1] == "photos" && safeID.MatchString(parts[2]) {
		path := filepath.Join(s.Directory, id, parts[2]+".jpg")
		if admin && r.Method == http.MethodPut {
			if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
				jsonReply(w, 500, map[string]string{"error": err.Error()})
				return
			}
			file, err := os.CreateTemp(filepath.Dir(path), ".photo-*")
			if err != nil {
				jsonReply(w, 500, map[string]string{"error": err.Error()})
				return
			}
			defer os.Remove(file.Name())
			_, err = io.Copy(file, r.Body)
			closeErr := file.Close()
			if err == nil {
				err = closeErr
			}
			if err == nil {
				err = os.Rename(file.Name(), path)
			}
			if err != nil {
				jsonReply(w, 500, map[string]string{"error": err.Error()})
				return
			}
			jsonReply(w, 200, map[string]bool{"uploaded": true})
			return
		}
		found := false
		for _, photo := range album.Photos {
			if photo.ID == parts[2] {
				found = true
				break
			}
		}
		if !found {
			http.NotFound(w, r)
			return
		}
		if r.Method == http.MethodGet || r.Method == http.MethodHead {
			w.Header().Set("Content-Type", "image/jpeg")
			http.ServeFile(w, r, path)
			return
		}
	}
	if !admin && len(parts) == 2 && r.Method == http.MethodPost {
		var input struct {
			PhotoID    string `json:"photoId"`
			ReviewerID string `json:"reviewerId"`
			Name       string `json:"name"`
			Text       string `json:"text"`
			Liked      bool   `json:"liked"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 16385)).Decode(&input); err != nil || len(input.Name) > 100 || strings.TrimSpace(input.Name) == "" {
			jsonReply(w, 400, map[string]string{"error": "reviewer name required"})
			return
		}
		found := false
		for _, photo := range album.Photos {
			if photo.ID == input.PhotoID {
				found = true
				break
			}
		}
		if !found {
			jsonReply(w, 404, map[string]string{"error": "photo unavailable"})
			return
		}
		switch parts[1] {
		case "comments":
			if !album.AllowComments {
				jsonReply(w, 403, map[string]string{"error": "comments disabled"})
				return
			}
			if strings.TrimSpace(input.Text) == "" || len(input.Text) > 4000 {
				jsonReply(w, 400, map[string]string{"error": "comment must contain 1–4000 characters"})
				return
			}
			album.Comments = append(album.Comments, Comment{ID: Token(), PhotoID: input.PhotoID, Name: input.Name, Text: input.Text, Created: time.Now().UTC().Format(time.RFC3339)})
		case "likes":
			if !album.AllowLikes {
				jsonReply(w, 403, map[string]string{"error": "likes disabled"})
				return
			}
			if !safeID.MatchString(input.ReviewerID) {
				jsonReply(w, 400, map[string]string{"error": "reviewer identity required"})
				return
			}
			if album.Likes[input.PhotoID] == nil {
				album.Likes[input.PhotoID] = make(map[string]string)
			}
			if input.Liked {
				album.Likes[input.PhotoID][input.ReviewerID] = input.Name
			} else {
				delete(album.Likes[input.PhotoID], input.ReviewerID)
			}
		default:
			http.NotFound(w, r)
			return
		}
		if err := s.persist(); err != nil {
			jsonReply(w, 500, map[string]string{"error": err.Error()})
			return
		}
		jsonReply(w, 200, map[string]bool{"saved": true})
		return
	}
	http.NotFound(w, r)
}
