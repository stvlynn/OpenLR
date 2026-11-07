// SPDX-License-Identifier: AGPL-3.0-only

// OpenLR diagnostic transport, limited to the local frontend without CSP.
function __openlrSchemeTransport() {
  if (window !== window.top || location.protocol !== "mygo:" || location.host !== "localhost") return null;
  const documentCapability = "__OPENLR_DOCUMENT_CAPABILITY__";
  const endpoint = "mygo://localhost/__openlr_bridge";
  const controller = new AbortController();
  let leaving = false;
  let admission = Promise.resolve();
  let sequence = 0;
  let failed;
  const send = (envelope) => {
    const request = admission.then(async () => {
      if (failed) throw failed;
      const response = await fetch(endpoint, {
        method: "POST",
        body: JSON.stringify({ document: documentCapability, sequence: ++sequence, ...envelope }),
        signal: controller.signal,
      });
      if (!response.ok) throw Error(`OpenLR scheme bridge rejected request (${response.status})`);
    });
    // Admission, not method completion, is serialized. A channel ACK must
    // not wait for the bound method which is waiting for that same ACK.
    // Failure may occur after native admission; never replay an uncertain
    // call or continue with an unknowable sequence. Fail this document visibly.
    admission = request.catch((error) => { failed ||= error; });
    return request;
  };
  addEventListener("pagehide", () => { leaving = true; controller.abort(); }, { once: true });
  addEventListener("pageshow", (event) => {
    if (event.persisted) {
      failed = Error("OpenLR diagnostic scheme bridge does not support BFCache restoration");
      setTimeout(() => { throw failed; });
    }
  });
  const post = (message) => {
    let call;
    try { call = JSON.parse(message.slice(__MYGO_CONFIG__.secret.length)); } catch {}
    send({ kind: "message", message }).catch((error) => {
      if (call?.t === "call") {
        window.__mygo?.receive({ t: "reply", k: call.k, id: call.id, ok: false, e: String(error.message || error) });
      } else if (!leaving) {
        setTimeout(() => { throw error; });
      }
    });
  };
  const pip = () => {
    send({ kind: "pip", active: !!document.pictureInPictureElement }).catch((error) => {
      if (!leaving) setTimeout(() => { throw error; });
    });
  };
  addEventListener("enterpictureinpicture", pip, true);
  addEventListener("leavepictureinpicture", pip, true);
  addEventListener("pageshow", pip);
  return { post };
}
