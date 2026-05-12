// Auth callback bootstrap, extracted from callback.html (audit
// follow-up, May 2026). Lives as a separate file so the page CSP
// can drop `script-src 'unsafe-inline'` and rely on `script-src
// 'self'` only. Meaningful XSS hardening across the platform.
//
// Behaviour by intent:
//   type=recovery   : password-reset flow. NEVER persist as a
//                     session; the user has not entered a new
//                     password yet. Stash the recovery token in
//                     sessionStorage (origin + tab scoped) and
//                     redirect to /#/reset. The /reset screen reads
//                     and clears the storage on submit.
//   no type / magic : sign-in flow. Persist session, post to opener,
//                     redirect to v3 app.
//
// Hardening:
//   - history.replaceState clears the URL fragment so the token is
//     not in browser history.
//   - sessionStorage is preferred over localStorage for recovery
//     tokens (tab-scoped + auto-cleared on tab close).
//   - Reverse-link from sessionStorage with a single-use guard.
//   - target origin is pinned to our own origin on postMessage.
//   - The HTML carries <meta name="referrer" content="no-referrer">
//     so the token cannot leak via the Referer header.
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
  function clearUrlFragment() {
    // Remove the fragment + search from the address bar without a
    // page reload. The token stays in memory inside this script
    // for the millisecond before the redirect, then evicted by
    // the navigation away from this page.
    try {
      var clean = window.location.pathname;
      window.history.replaceState(null, "", clean);
    } catch (_) {}
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
  function showOk(label) {
    document.getElementById("title").textContent = label || "Signed in";
    document.getElementById("title").className = "ok";
    document.getElementById("message").textContent = "Returning to Anvil...";
    var back = document.getElementById("back");
    back.style.display = "inline-block";
    back.textContent = "Open Anvil";
  }
  function goReset() {
    var pinned = false;
    try { pinned = localStorage.getItem("obara:v3_pinned") === "1"; } catch (_) {}
    var target = (pinned ? "/v3.html" : "/") + "#/reset";
    window.location.replace(target);
  }
  function goHome() {
    var pinned = false;
    try { pinned = localStorage.getItem("obara:v3_pinned") === "1"; } catch (_) {}
    var target = pinned ? "/v3.html" : "/";
    if (window.opener && !window.opener.closed) {
      try { window.close(); return; } catch (_) {}
    }
    window.location.replace(target);
  }

  var params = parseHashParams();
  // Always clear the URL fragment first so the token does not stay
  // in the address bar / browser history.
  clearUrlFragment();

  if (params.error) {
    showError(params.error_description || params.error, params);
    return;
  }
  if (!params.access_token) {
    showError("Missing access token in URL", params);
    return;
  }

  // Branch on intent. Recovery tokens must never be persisted as a
  // session because the user has not authenticated themselves yet;
  // the recovery token is a single-use credential to set a new
  // password.
  if (params.type === "recovery") {
    try {
      sessionStorage.setItem("anvil:recovery", JSON.stringify({
        access_token: params.access_token,
        refresh_token: params.refresh_token || null,
        expires_at: params.expires_at ? Number(params.expires_at) : null,
        captured_at: Date.now(),
      }));
    } catch (e) {
      showError("Browser blocked sessionStorage; cannot continue. Please enable storage for this site.", String(e));
      return;
    }
    document.getElementById("title").textContent = "Confirming password reset";
    document.getElementById("title").className = "ok";
    document.getElementById("message").textContent = "Redirecting to the new-password form...";
    var backBtn = document.getElementById("back");
    backBtn.style.display = "inline-block";
    backBtn.textContent = "Continue to reset password";
    backBtn.addEventListener("click", goReset);
    setTimeout(goReset, 800);
    return;
  }

  // Sign-in / magic-link flow: persist the session and go home.
  persistSession(params);
  showOk("Signed in");
  document.getElementById("back").addEventListener("click", goHome);
  setTimeout(goHome, 1200);
})();
