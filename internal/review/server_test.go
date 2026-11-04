package review

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestReviewAuthorizationPersistenceAndRevocation(t *testing.T) {
	dir := t.TempDir()
	server, err := New(dir, "admin-test-token")
	if err != nil {
		t.Fatal(err)
	}
	request := func(handler http.Handler, method, path, body string, admin bool) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		if admin {
			r.Header.Set("Authorization", "Bearer admin-test-token")
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	if w := request(server, "POST", "/api/albums/album1", `{"title":"Fixture album"}`, false); w.Code != 401 {
		t.Fatal("unauthorized publishing accepted")
	}
	w := request(server, "POST", "/api/albums/album1", `{"title":"Fixture album"}`, true)
	var album Album
	if err = json.Unmarshal(w.Body.Bytes(), &album); err != nil || album.Token == "" {
		t.Fatal("missing album capability")
	}
	request(server, "PUT", "/api/albums/album1/photos/photo1", "fixture preview bytes", true)
	if w = request(server, "POST", "/api/albums/album1/publish", `{"photos":[{"id":"photo1","name":"Fixture.jpg"}]}`, true); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if w = request(server, "GET", "/review/album1", "", false); w.Code != 403 {
		t.Fatal("missing capability accepted")
	}
	if w = request(server, "GET", "/review/album1/photos/photo1", "", false); w.Code != 403 {
		t.Fatal("image bypassed album access")
	}
	query := "?key=" + album.Token
	w = request(server, "GET", "/review/album1"+query, "", false)
	if w.Code != 200 || strings.Contains(w.Body.String(), album.Token) {
		t.Fatal("public view failed or leaked its stored token")
	}
	w = request(server, "POST", "/review/album1/comments"+query, `{"photoId":"photo1","name":"Reviewer","text":"Keep this image"}`, false)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	w = request(server, "POST", "/review/album1/likes"+query, `{"photoId":"photo1","reviewerId":"reviewer1","name":"Reviewer","liked":true}`, false)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	reopened, err := New(dir, "admin-test-token")
	if err != nil {
		t.Fatal(err)
	}
	w = request(reopened, "GET", "/api/albums/album1", "", true)
	if err = json.Unmarshal(w.Body.Bytes(), &album); err != nil || len(album.Comments) != 1 || len(album.Likes["photo1"]) != 1 {
		t.Fatal("review persistence failed")
	}
	request(reopened, "POST", "/api/albums/album1/revoke", `{}`, true)
	if w = request(reopened, "GET", "/review/album1"+query, "", false); w.Code != 403 {
		t.Fatal("revoked link remained usable")
	}
}
