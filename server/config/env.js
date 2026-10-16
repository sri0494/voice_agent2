// Startup validation of the environment. In production, errors stop the server with an actionable message.
const SECRETISH = /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i;

export function validateEnv(env = process.env) {
  const errors = [], warnings = [];
  const prod = env.NODE_ENV === "production";
  const v = (k) => (env[k] || "").trim();
  const need = (cond, msg) => { if (!cond) errors.push(msg); };

  need(v("DATABASE_URL"), "DATABASE_URL is missing.");
  need(v("JWT_SECRET"), "JWT_SECRET is missing.");
  if (v("JWT_SECRET") && v("JWT_SECRET").length < 32) (prod ? errors : warnings).push("JWT_SECRET should be at least 32 random characters.");

  // Secrets must never be exposed to the browser bundle.
  for (const k of Object.keys(env)) if (k.startsWith("VITE_") && SECRETISH.test(k)) errors.push(`${k} looks like a secret but VITE_* variables are bundled into the public frontend. Rename it (no VITE_ prefix).`);

  const storage = (v("STORAGE_PROVIDER") || "local").toLowerCase();
  if (storage === "s3") {
    for (const k of ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]) need(v(k), `STORAGE_PROVIDER=s3 but ${k} is missing.`);
  } else if (storage === "local") {
    if (prod && v("ALLOW_LOCAL_STORAGE_IN_PRODUCTION") !== "true") errors.push("STORAGE_PROVIDER=local in production would lose recordings on every deploy (Render's disk is ephemeral). Set STORAGE_PROVIDER=s3 (Cloudflare R2 works) and the S3_* variables.");
  } else errors.push(`Unknown STORAGE_PROVIDER "${storage}" (use s3 or local).`);

  const ai = (v("AI_PROVIDER") || "mock").toLowerCase();
  if (ai !== "mock") need(v("AI_API_KEY"), `AI_PROVIDER=${ai} but AI_API_KEY is missing.`);
  const emb = (v("EMBEDDING_PROVIDER") || "mock").toLowerCase();
  if (emb !== "mock") need(v("EMBEDDING_API_KEY") || v("AI_API_KEY"), `EMBEDDING_PROVIDER=${emb} but EMBEDDING_API_KEY (or AI_API_KEY) is missing.`);
  for (const [name, key] of [["STT_PROVIDER", "STT_API_KEY"], ["TTS_PROVIDER", "TTS_API_KEY"]]) {
    const p = (v(name) || "mock").toLowerCase();
    if (p === "sarvam") need(v(key) || v("SARVAM_API_KEY"), `${name}=sarvam but ${key} (or SARVAM_API_KEY) is missing.`);
    else if (p !== "mock") errors.push(`Unknown ${name} "${p}" (implemented: mock, sarvam).`);
  }
  const tel = (v("TELEPHONY_PROVIDER") || "mock").toLowerCase();
  if (tel === "twilio") for (const k of ["TELEPHONY_API_KEY", "TELEPHONY_API_SECRET", "TELEPHONY_PHONE_NUMBER", "PUBLIC_BASE_URL"]) need(v(k), `TELEPHONY_PROVIDER=twilio but ${k} is missing.`);
  else if (tel === "mock" && prod && !v("TELEPHONY_WEBHOOK_SECRET")) warnings.push("TELEPHONY_PROVIDER=mock in production: webhooks are rejected unless TELEPHONY_WEBHOOK_SECRET is set.");
  else if (tel === "exotel") {
    for (const k of ["TELEPHONY_API_KEY", "TELEPHONY_API_SECRET", "EXOTEL_ACCOUNT_SID", "EXOTEL_FLOW_URL", "TELEPHONY_PHONE_NUMBER", "PUBLIC_BASE_URL", "TELEPHONY_WEBHOOK_SECRET"]) { if (!v(k)) warnings.push(`TELEPHONY_PROVIDER=exotel but ${k} is missing: the site still starts, but placing/receiving Exotel calls will fail until it is set.`); }
    if (v("TELEPHONY_WEBHOOK_SECRET") && v("TELEPHONY_WEBHOOK_SECRET").length < 24) (prod ? errors : warnings).push("TELEPHONY_WEBHOOK_SECRET should be at least 24 random characters (it is the only authentication of Exotel callbacks and the voice stream).");
    if (v("STT_PROVIDER").toLowerCase() !== "sarvam" || v("TTS_PROVIDER").toLowerCase() !== "sarvam") warnings.push("TELEPHONY_PROVIDER=exotel needs STT_PROVIDER=sarvam and TTS_PROVIDER=sarvam for real spoken conversations; with mock speech the caller hears nothing.");
    if (!v("RECORDING_URL_ALLOWLIST")) warnings.push("RECORDING_URL_ALLOWLIST is empty: set it to your Exotel recording host(s) so recordings can be copied into your private bucket.");
  }
  else if (!["mock", "twilio"].includes(tel)) errors.push(`Unknown TELEPHONY_PROVIDER "${tel}" (implemented: mock, twilio, exotel).`);
  for (const k of ["AUTH_IDLE_TIMEOUT_MIN", "AUTH_ABSOLUTE_TIMEOUT_HOURS", "AUTH_TAB_LIVENESS_SEC"]) if (v(k) && !(Number(v(k)) >= 0)) errors.push(`${k} must be a non-negative number.`);
  if (v("AUTH_IDLE_TIMEOUT_MIN") && Number(v("AUTH_IDLE_TIMEOUT_MIN")) === 0) errors.push("AUTH_IDLE_TIMEOUT_MIN=0 would disable the inactivity timeout; use a positive number of minutes.");
  if (Number(v("AUTH_IDLE_TIMEOUT_MIN") || 15) * 60 > Number(v("AUTH_ABSOLUTE_TIMEOUT_HOURS") || 8) * 3600) warnings.push("AUTH_IDLE_TIMEOUT_MIN is longer than AUTH_ABSOLUTE_TIMEOUT_HOURS: the absolute limit will always win.");
  if (v("AUTH_REQUIRE_SESSION") === "false" && prod) errors.push("AUTH_REQUIRE_SESSION=false accepts tokens without a server-side session; it is for tests/rollouts only and is refused in production.");
  if (!v("ENCRYPTION_KEY")) warnings.push("ENCRYPTION_KEY is not set: Business Integrations credentials cannot be stored.");
  if (prod && !v("CORS_ORIGIN")) warnings.push("CORS_ORIGIN is not set: any origin is allowed. Set it to your frontend URL.");
  return { errors, warnings };
}

export function assertEnvOrExit(logger) {
  const { errors, warnings } = validateEnv();
  warnings.forEach((w) => logger.warn("env_warning", { message: w }));
  if (errors.length) {
    errors.forEach((e) => logger.error("env_error", { message: e }));
    if (process.env.NODE_ENV === "production") { logger.error("startup_aborted", { reason: "invalid environment" }); process.exit(1); }
  }
  return { errors, warnings };
}
