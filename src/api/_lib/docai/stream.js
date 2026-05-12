// Streaming response surfacing (Wave 4.2 / #17).
//
// runExtractionPipeline already emits processing_events for every
// stage (L1 text layer, L2 OCR, profiler, chunker, dispatch,
// validators, ...). Today the client polls the events table over
// HTTP to render "page 4 of 12 done" progress bars. The poll
// cycle adds latency and burns DB connections.
//
// Server-Sent Events (SSE) over the extraction route turns the
// poll into a push. The client subscribes once; the server
// flushes one event per pipeline stage; on completion the server
// emits a final 'done' event and closes the stream.
//
// Two helpers:
//
//   1. createSseStream(res) wraps an Express-like response in an
//      SSE writer. The writer exposes:
//        write({type, data})  -> flushes one event
//        close()              -> ends the stream
//      Headers (Content-Type: text/event-stream, no-cache,
//      keep-alive) are set on first write.
//
//   2. wrapEventSinkForSse(stream, fallback) returns a function
//      with the same signature as run.js's eventSink so the
//      pipeline doesn't need to know whether the consumer is
//      SSE-backed or DB-backed. Calls fallback first so events
//      still persist to processing_events; then forwards to the
//      SSE writer.

// Format one SSE event with the standard "event: ...\ndata: ...\n\n"
// framing. Both fields are utf-8 plain; data is JSON-stringified.
const formatEvent = (type, data) => {
  const safe = (s) => String(s).replace(/[\r\n]+/g, " ");
  const lines = [];
  if (type) lines.push("event: " + safe(type));
  lines.push("data: " + JSON.stringify(data ?? null));
  return lines.join("\n") + "\n\n";
};

// SSE keep-alive: emit a comment every 15s so intermediaries
// don't time out the connection during a long extraction.
const KEEPALIVE_MS = 15_000;

export const createSseStream = (res) => {
  if (!res || typeof res.write !== "function") {
    throw new Error("createSseStream requires an Express-like response");
  }
  let opened = false;
  let closed = false;
  let keepaliveTimer = null;
  const openOnce = () => {
    if (opened) return;
    opened = true;
    if (typeof res.setHeader === "function") {
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
    }
    keepaliveTimer = setInterval(() => {
      if (closed) return;
      try { res.write(": keep-alive\n\n"); } catch (_e) { /* ignore */ }
    }, KEEPALIVE_MS);
    if (keepaliveTimer.unref) keepaliveTimer.unref();
  };
  return {
    write({ type, data }) {
      if (closed) return;
      openOnce();
      try { res.write(formatEvent(type, data)); } catch (_e) { closed = true; }
    },
    error(detail) {
      if (closed) return;
      openOnce();
      try { res.write(formatEvent("error", detail)); } catch (_e) { closed = true; }
    },
    close(payload) {
      if (closed) return;
      closed = true;
      try {
        if (payload !== undefined) res.write(formatEvent("done", payload));
        if (typeof res.end === "function") res.end();
      } catch (_e) { /* ignore */ }
      if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
    },
    isClosed() { return closed; },
  };
};

// Build an eventSink the pipeline can hand to chunkedExtract / TOC
// profiler. fallback (existing recordRunEvent wrapper) still fires
// so events persist to processing_events even when the SSE consumer
// disconnects mid-stream. The SSE write is fire-and-forget.
export const wrapEventSinkForSse = (sseStream, fallback) => (event) => {
  if (fallback) {
    try { Promise.resolve(fallback(event)).catch(() => { /* ignore */ }); } catch (_e) { /* ignore */ }
  }
  if (!sseStream || sseStream.isClosed()) return;
  // Normalise: chunkedExtract uses { stage, ... } shape; profiler
  // uses { ok, ... }. SSE event type = stage (or 'event' as
  // fallback). Strip large fields the client doesn't need
  // (full pages, raw_meta) to keep the wire small.
  const type = event?.stage || event?.eventType || "event";
  const data = { ...event };
  delete data.raw_meta;
  delete data.page_breakdown;
  delete data.raw_pages;
  sseStream.write({ type, data });
};

export const __test = { formatEvent };
