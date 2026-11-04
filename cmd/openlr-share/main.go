package main

import (
	"encoding/json"
	"flag"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"openlr/internal/review"
)

func main() {
	address := flag.String("addr", "127.0.0.1:8788", "listen address; defaults to loopback")
	directory := flag.String("data", "openlr-share-data", "persistent album/review directory")
	session := flag.String("session", "", "optional private local descriptor containing the admin token")
	flag.Parse()
	token := os.Getenv("OPENLR_SHARE_ADMIN_TOKEN")
	if token == "" {
		token = review.Token()
	}
	handler, err := review.New(*directory, token)
	if err != nil {
		log.Fatal(err)
	}
	listener, err := net.Listen("tcp", *address)
	if err != nil {
		log.Fatal(err)
	}
	if *session != "" {
		if err = os.MkdirAll(filepath.Dir(*session), 0o700); err != nil {
			log.Fatal(err)
		}
		data, _ := json.Marshal(map[string]string{"url": "http://" + listener.Addr().String(), "adminToken": token})
		if err = os.WriteFile(*session, data, 0o600); err != nil {
			log.Fatal(err)
		}
	}
	log.Printf("OpenLR album review listening on %s", listener.Addr())
	server := http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second}
	log.Fatal(server.Serve(listener))
}
