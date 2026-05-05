// Auth callback bootstrap, extracted from callback.html (audit
// follow-up, May 2026). Lives as a separate file so the page CSP
// can drop `script-src 'unsafe-inline'` and rely on `script-src
// 'self'` only — meaningful XSS hardening across the platform.
//
// The behaviour is unchanged from the previous inline version: read
// the magic-link tokens out of the URL hash, post the session to
// the opener (with target origin pinned to our own origin per audit
// C3), persist to localStorage during the transitional window, and
// hand off to the v3 app.
(function () {
  function parseHashParams() {
    var hash = window.location.hash.replace(/^#/, "");
    var search = window.location.search.replace(/^\?/, "");
    var combined = (hash + (hash && search ? "&" : "") + search).split("&").filter(Boolean);
    var params = {};
    combined.forEach(function (pair) {
      var idx = pair.indexOf("=");
      if (idx === -1) return;
      params[decodeURIComponent(pair.slice(0, idx))] = decodeURIComponent(pair.slice(idx + 1));
    });
    return params;
  }
  function persistSession(params) {
    var session = {
      access_token: params.access_token || "",
      refresh_token: params.refresh_token || "",
      expires_at: params.expires_at ? Number(params.expires_at) : null,
      type: params.type || null,
    };
    var ourOrigin = window.location.origin;
    if (window.opener && typeof window.opener.postMessage === "function") {
      try { window.opener.postMessage({ source: "obara-auth-callback", session: session }, ourOrigin); } catch (_) {}
    }
    try { localStorage.setItem("obara:backend_session", JSON.stringify(session)); } catch (_) {}
    return session;
  }
  function showError(message, detail) {
    document.getElementById("title").textContent = "Sign-in failed";
    document.getElementById("title").className = "err";
    document.getElementById("message").textContent = message;
    if (detail) {
      var el = document.getElementById("detail");
      el.textContent = typeof detail === "string" ? detail : JSON.stringify(detail, null, 2);
      el.style.display = "block";
    }
  }
  function showOk(detail) {
    document.getElementById("title").textContent = "Signed in";
    document.getElementById("title").className = "ok";
    document.getElementById("message").textContent = "Returning to Anvil...";
    if (detail) {
      var el = document.getElementById("detail");
      el.textContent = JSON.stringify(detail, null, 2);
      el.style.display = "block";
    }
    var back = document.getElementById("back");
    back.style.display = "inline-block";
    back.textContent = "Open Anvil";
    function goHome() {
      var pinned = false;
      try { pinned = localStorage.getItem("obara:v3_pinned") === "1"; } catch (_) {}
      var target = pinned ? "/v3.html" : "/";
      if (window.opener && !window.opener.closed) {
        try { window.close(); return; } catch (_) {}
      }
      window.location.replace(target);
    }
    back.addEventListener("click", goHome);
    setTimeout(goHome, 1500);
  }
  var params = parseHashParams();
  if (params.error) {
    showError(params.error_description || params.error, params);
    return;
  }
  if (!params.access_token) {
    showError("Missing access token in URL", params);
    return;
  }
  var session = persistSession(params);
  showOk({ user: params.user || params.email || "(unknown)", expires_at: session.expires_at });
})();
