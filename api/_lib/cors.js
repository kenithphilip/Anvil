const ALLOWED = (process.env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim()).filter(Boolean);

export const applyCors = (req, res) => {
  const origin = req.headers.origin || "";
  const allow = ALLOWED.includes("*") || ALLOWED.includes(origin) ? (origin || "*") : "";
  if (allow) res.setHeader("Access-Control-Allow-Origin", allow);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-obara-tenant");
  res.setHeader("Access-Control-Max-Age", "86400");
};

export const handlePreflight = (req, res) => {
  if (req.method !== "OPTIONS") return false;
  applyCors(req, res);
  res.status(204).end();
  return true;
};

export const sendError = (res, err) => {
  const status = err && err.status ? err.status : 500;
  const message = err && err.message ? err.message : "Internal error";
  res.status(status).json({ error: { message, status } });
};

export const json = (res, status, body) => {
  res.setHeader("Content-Type", "application/json");
  res.status(status).send(JSON.stringify(body));
};

export const readBody = async (req) => {
  if (req.body && typeof req.body === "object") return req.body;
  return await new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (err) { reject(new Error("Invalid JSON body")); }
    });
    req.on("error", reject);
  });
};
