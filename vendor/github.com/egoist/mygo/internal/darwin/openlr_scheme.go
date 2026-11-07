//go:build darwin

// SPDX-License-Identifier: AGPL-3.0-only

package darwin

// OpenLR diagnostic candidate: public custom-scheme bridge for local pages.
// This is not a general replacement for MyGo's frame/CSP security contract.
import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"

	"github.com/ebitengine/purego/objc"
	"github.com/egoist/mygo/internal/platform"
)

const openLREndpoint = "mygo://localhost/__openlr_bridge"

type openLREvalReply struct {
	document         string
	value            string
	received         bool
	completed        bool
	callback         func(string, error)
	stopCancellation func() bool
}

func openLRCapability() string {
	var bytes [32]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(bytes[:])
}

// The public scheme task does not expose frameInfo. The private capability
// is injected only into the top-frame bridge. A navigation rotates it before
// document-start scripts run; the native fixture must validate that timing.
func (w *window) openLRBeginNavigation(nav id) {
	w.openLRNextDocument = openLRCapability()
	w.openLRNextNavigation = nav
	w.openLRRefreshScripts()
}

func (w *window) openLRCommitNavigation(nav id) {
	if w.openLRNextNavigation != nav {
		w.openLRReady = false
		w.openLRCancelEvals("OpenLR scheme navigation identity mismatch")
		return
	}
	if w.openLRNextDocument != "" {
		w.openLRDocument = w.openLRNextDocument
		w.openLRNextDocument = ""
		w.openLRNextNavigation = 0
	}
	w.openLRReady = true
	w.openLRSequence = 0
	w.pipActive = false
	w.openLRCancelEvals("OpenLR scheme Eval page navigated")
}

func (w *window) openLRCompleteEval(requestID string, reply *openLREvalReply, value string, err error) {
	if reply.completed {
		return
	}
	reply.completed = true
	if reply.stopCancellation != nil {
		reply.stopCancellation()
	}
	delete(w.openLREvals, requestID)
	reply.callback(value, err)
}

func (w *window) openLRCancelEvals(reason string) {
	for requestID, reply := range w.openLREvals {
		w.openLRCompleteEval(requestID, reply, "", errors.New(reason))
	}
}

func (w *window) openLRFailProvisionalNavigation(nav id) {
	if w.openLRNextNavigation != nav {
		return
	}
	// The previous document never stopped being current. Do not promote or
	// retain the aborted next document's capability.
	w.openLRNextDocument = ""
	w.openLRNextNavigation = 0
	w.openLRRefreshScripts()
}

func (w *window) openLRRefreshScripts() {
	withPool(func() {
		send(w.ucc, "removeAllUserScripts")
		w.addUserScripts(w.Zoom())
	})
}

// Called synchronously on the main thread, before application protocols.
// Existing native readRequest has already copied the request's original bytes.
func (w *window) openLRScheme(req *platform.SchemeRequest) bool {
	u, err := url.Parse(req.URL)
	if err != nil || u.Scheme != "mygo" || u.Host != "localhost" || u.Path != "/__openlr_bridge" {
		return false
	}
	status := http.StatusForbidden
	defer func() {
		req.Responder.Respond(status, map[string][]string{"Cache-Control": {"no-store"}})
		req.Responder.Finish()
	}()
	if req.Body != nil {
		defer req.Body.Close()
	}
	if req.Method != http.MethodPost || u.RawQuery != "" || u.Fragment != "" {
		status = http.StatusMethodNotAllowed
		return true
	}
	if req.Context.Err() != nil || !w.openLRReady || req.Body == nil {
		return true
	}
	current, err := url.Parse(w.URL())
	if err != nil || current.Scheme != "mygo" || current.Host != "localhost" {
		return true
	}
	var envelope struct {
		Document string `json:"document"`
		Sequence uint64 `json:"sequence"`
		Kind     string `json:"kind"`
		Message  string `json:"message"`
		ID       string `json:"id"`
		Value    string `json:"value"`
		Active   bool   `json:"active"`
	}
	// Trusted payloads have no artificial size ceiling. This retains the
	// existing native adapter's complete body copy and the core's untrusted cap.
	body, err := io.ReadAll(req.Body)
	if err != nil || json.Unmarshal(body, &envelope) != nil || envelope.Document != w.openLRDocument {
		return true
	}
	switch envelope.Kind {
	case "message":
		if envelope.Sequence != w.openLRSequence+1 {
			status = http.StatusConflict
			return true
		}
		w.openLRSequence = envelope.Sequence
		w.h.Message(envelope.Message) // the single existing secret-checking dispatcher
	case "pip":
		if envelope.Sequence != w.openLRSequence+1 {
			status = http.StatusConflict
			return true
		}
		w.openLRSequence = envelope.Sequence
		w.pipActive = envelope.Active
	case "eval":
		reply := w.openLREvals[envelope.ID]
		if reply == nil || reply.document != w.openLRDocument || reply.received {
			status = http.StatusConflict
			return true
		}
		reply.value, reply.received = envelope.Value, true
	default:
		status = http.StatusBadRequest
		return true
	}
	status = http.StatusNoContent
	return true
}

// This optional interface is used only by core's context-bearing Eval.
func (w *window) CallAsyncFunctionContext(ctx context.Context, body string, cb func(string, error)) {
	w.openLRCallAsyncFunction(ctx, body, cb)
}

func (w *window) openLRCallAsyncFunction(ctx context.Context, body string, cb func(string, error)) {
	if err := ctx.Err(); err != nil {
		cb("", err)
		return
	}
	if !respondsTo(w.web, "callAsyncJavaScript:arguments:inFrame:inContentWorld:completionHandler:") {
		cb("", errors.New("mygo: Eval requires macOS 11 or later"))
		return
	}
	if !w.openLRReady {
		cb("", errors.New("OpenLR scheme bridge has no committed local page"))
		return
	}
	current, err := url.Parse(w.URL())
	if err != nil || current.Scheme != "mygo" || current.Host != "localhost" {
		cb("", errors.New("OpenLR scheme bridge Eval requires the local frontend"))
		return
	}
	requestID := openLRCapability()
	reply := &openLREvalReply{document: w.openLRDocument, callback: cb}
	if w.openLREvals == nil {
		w.openLREvals = make(map[string]*openLREvalReply)
	}
	w.openLREvals[requestID] = reply
	reply.stopCancellation = context.AfterFunc(ctx, func() {
		w.b.post(func() { w.openLRCompleteEval(requestID, reply, "", ctx.Err()) })
	})
	// Native callAsyncJavaScript still compiles the supplied body. No eval or
	// Function constructor: SyntaxError remains eligible for core's one fallback.
	// The uncloneable function deliberately produces the public unsupported-
	// result status BEFORE UIProcess deserialization. Never accept it without
	// the matching authenticated scheme reply. This is an experimental protocol.
	wrapped := fmt.Sprintf(`const __openlrValue = await (async () => {
%s
})();
try {
const __openlrResponse = await fetch(%s, {method: "POST", body: JSON.stringify({
document: %s, kind: "eval", id: %s, value: __openlrValue
})});
if (!__openlrResponse.ok) throw Error("OpenLR scheme Eval reply rejected (" + __openlrResponse.status + ")");
} catch (__openlrError) {
throw new Error("OpenLR scheme transport: " + String(__openlrError && __openlrError.message || __openlrError));
}
return function openlrUnsupportedResult() {};`, body, strconv.Quote(openLREndpoint), strconv.Quote(reply.document), strconv.Quote(requestID))
	withPool(func() {
		blk := newBlock(func(_ objc.Block, result id, nativeErr id) {
			if reply.completed {
				return
			}
			if nativeErr != 0 {
				// WKErrorJavaScriptResultTypeIsUnsupported == 5 (public WKError).
				if goString(send(nativeErr, "domain")) == "WKErrorDomain" && sendInt(nativeErr, "code") == 5 && reply.received && reply.document == w.openLRDocument {
					w.openLRCompleteEval(requestID, reply, reply.value, nil)
					return
				}
				w.openLRCompleteEval(requestID, reply, "", nsError(nativeErr))
				return
			}
			w.openLRCompleteEval(requestID, reply, "", errors.New("OpenLR scheme Eval unexpectedly returned a supported native result"))
		})
		defer blk.Release()
		send(w.web, "callAsyncJavaScript:arguments:inFrame:inContentWorld:completionHandler:",
			uintptr(nsString(wrapped)), 0, 0, uintptr(send(class("WKContentWorld"), "pageWorld")), uintptr(blk))
	})
}
