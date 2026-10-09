import rateLimit from "express-rate-limit";

// Limits are read per request from env so deployments (and tests) can tune them without code changes.
const num = (name, dflt) => () => Number(process.env[name]) || dflt;
const skip = () => process.env.RATE_LIMIT_DISABLED === "true";
const userKey = (prefix) => (req) => `${prefix}:${req.user?.id || req.ip}`;

function make({ windowMs, env, dflt, message, key, status = 429 }) {
  return rateLimit({
    windowMs,
    limit: num(env, dflt),
    standardHeaders: true,
    legacyHeaders: false,
    skip,
    validate: false,
    keyGenerator: key,
    handler: (req, res) => res.status(status).json({ success: false, message }),
  });
}
const MIN = 60 * 1000;

export const apiLimiter = make({ windowMs: 15 * MIN, env: "RL_API_MAX", dflt: 300, message: "Too many requests, please try again later.", key: (req) => `api:${req.ip}` });
export const authLimiter = make({ windowMs: 15 * MIN, env: "RL_LOGIN_IP_MAX", dflt: 20, message: "Too many login attempts, please try again later.", key: (req) => `login-ip:${req.ip}` });
// Brute force against ONE account from many IPs.
export const loginAccountLimiter = make({ windowMs: 15 * MIN, env: "RL_LOGIN_ACCOUNT_MAX", dflt: 8, message: "Too many login attempts for this account, please try again later.", key: (req) => `login-acct:${String(req.body?.email || "").toLowerCase().trim()}` });
export const passwordLimiter = make({ windowMs: 60 * MIN, env: "RL_PASSWORD_MAX", dflt: 10, message: "Too many password attempts, please try again later.", key: userKey("pw") });
export const callLimiter = make({ windowMs: 10 * MIN, env: "RL_CALL_MAX", dflt: 30, message: "Too many call requests. Slow down.", key: userKey("call") });
export const campaignLaunchLimiter = make({ windowMs: 10 * MIN, env: "RL_CAMPAIGN_LAUNCH_MAX", dflt: 10, message: "Too many campaign start/stop requests.", key: userKey("launch") });
export const integrationTestLimiter = make({ windowMs: 10 * MIN, env: "RL_INTEGRATION_TEST_MAX", dflt: 20, message: "Too many integration tests.", key: userKey("itest") });
export const uploadLimiter = make({ windowMs: 10 * MIN, env: "RL_UPLOAD_MAX", dflt: 30, message: "Too many uploads, please try again later.", key: userKey("upload") });
export const recordingUploadLimiter = make({ windowMs: 10 * MIN, env: "RL_RECORDING_UPLOAD_MAX", dflt: 30, message: "Too many recording uploads.", key: userKey("recup") });
export const importLimiter = make({ windowMs: 60 * MIN, env: "RL_IMPORT_MAX", dflt: 10, message: "Too many contact imports, please try again later.", key: userKey("import") });
// LLM / embedding calls cost money and time: cap them per user.
export const aiLimiter = make({ windowMs: 10 * MIN, env: "RL_AI_MAX", dflt: 40, message: "Too many AI requests, please slow down.", key: userKey("ai") });
export const contactFormLimiter = make({ windowMs: 60 * MIN, env: "RL_CONTACT_FORM_MAX", dflt: 5, message: "Too many submissions from this address, please try again later.", key: (req) => `form:${req.ip}` });
export const webhookLimiter = make({ windowMs: MIN, env: "RL_WEBHOOK_MAX", dflt: 600, message: "Too many webhook requests.", key: (req) => `hook:${req.ip}` });
