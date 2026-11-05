// HTTP hardening shared by every route: security headers, a same-origin
// check on state-changing API calls, write rate limits and error responses
// that never leak stack traces.
import crypto from "node:crypto";

// PayPal's JS SDK loads from *.paypal.com, renders its buttons in PayPal
// iframes and pulls assets from *.paypalobjects.com. Its own inline scripts
// (prerender and popup frames) are allowed through a per-response nonce,
// which the page hands to the SDK as data-csp-nonce (PayPal's documented
// CSP mechanism). Nothing else may run scripts. CSP=off disables it.
const PAYPAL = "https://*.paypal.com https://*.paypalobjects.com";
const csp = (nonce) => [
  "default-src 'self'",
  `script-src 'self' 'nonce-${nonce}' https://cdn.jsdelivr.net ${PAYPAL}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  `img-src 'self' data: blob: ${PAYPAL}`,
  `connect-src 'self' ${PAYPAL}`,
  `frame-src ${PAYPAL}`,
  `form-action 'self' ${PAYPAL}`,
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join("; ");

// Mounted middleware sees req.path without the mount prefix.
const fullPath = (req) => req.baseUrl + req.path;

export function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.locals.cspNonce = crypto.randomBytes(16).toString("base64");
  if (process.env.CSP !== "off") res.setHeader("Content-Security-Policy", csp(res.locals.cspNonce));
  if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
  next();
}

// Browsers send Origin on cross-site POSTs; refuse any that isn't us. (The
// API also needs a custom X-Session-Id header, which a cross-site form or
// simple request can't send without a CORS preflight we never allow.)
export function sameOrigin(req, res, next) {
  if (req.method === "GET" || req.method === "HEAD" || fullPath(req) === "/api/webhooks/paypal") return next();
  const origin = req.get("origin");
  if (!origin) return next();
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    host = null;
  }
  if (host && host === req.get("host")) return next();
  res.status(403).json({ error: "Cross-origin request refused." });
}

// Sliding-window limit per IP for API writes (chat has its own hourly limit).
export function writeLimiter({ perMinute = Number(process.env.WRITE_LIMIT_PER_MIN || 120) } = {}) {
  const hits = new Map();
  setInterval(() => {
    const cutoff = Date.now() - 60_000;
    for (const [ip, times] of hits) if (!times.some((t) => t > cutoff)) hits.delete(ip);
  }, 60_000).unref();
  return (req, res, next) => {
    const path = fullPath(req);
    if (req.method === "GET" || req.method === "HEAD" || path === "/api/chat" || path === "/api/webhooks/paypal") return next();
    const now = Date.now();
    const times = (hits.get(req.ip) || []).filter((t) => t > now - 60_000);
    if (times.length >= perMinute) {
      res.setHeader("Retry-After", "30");
      return res.status(429).json({ error: "Too many requests. Please slow down." });
    }
    times.push(now);
    hits.set(req.ip, times);
    next();
  };
}

export function notFound(req, res) {
  res.status(404).json({ error: "Not found" });
}

// Express error handler: client errors get a short message, server errors a
// generic one; details only go to the server log.
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const status = Number(err.status || err.statusCode) || 500;
  if (status >= 500) console.error(err);
  if (res.headersSent) return res.end();
  const message = status === 413 ? "Request body too large." : status === 400 ? "Malformed request body." : status < 500 ? "Invalid request." : "Something went wrong on our side.";
  res.status(status).json({ error: message });
}
