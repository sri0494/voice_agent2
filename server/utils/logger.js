// Minimal structured logger. Never logs secrets, passwords, JWTs, API keys, auth headers or full phone numbers.
const SENSITIVE = ["password", "password_hash", "token", "authorization", "jwt", "secret", "api_key", "apikey", "x-api-key",
  "cookie", "credential", "encrypted", "signature", "accesskey", "private"];
const PHONE_KEYS = ["phone", "mobile", "from", "to", "caller", "called", "msisdn"];

function maskPhone(v) { return typeof v === "string" && v.length > 4 ? `${"*".repeat(v.length - 4)}${v.slice(-4)}` : v; }

export function redact(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 6) return obj;
  const clone = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    const key = k.toLowerCase();
    if (SENSITIVE.some((s) => key.includes(s))) clone[k] = "[REDACTED]";
    else if (PHONE_KEYS.includes(key) && typeof v === "string") clone[k] = maskPhone(v);
    else if (typeof v === "object") clone[k] = redact(v, depth + 1);
    else clone[k] = v;
  }
  return clone;
}

const out = (level, method) => (msg, meta = {}) => console[method](JSON.stringify({ level, msg, ...redact(meta), ts: new Date().toISOString() }));
export const logger = {
  info: out("info", "log"),
  warn: out("warn", "warn"),
  error: out("error", "error"),
};
