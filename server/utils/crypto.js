// crypto.js — AES-256-GCM encryption for business integration credentials
// (API keys, tokens, passwords for connectors like CRM/ERP/Payment APIs).
//
// This is separate from the core infra providers (AI/STT/TTS/Telephony),
// which stay env-var-configured. Business integrations are user-managed
// through the UI, so their secrets must be encrypted at rest in Postgres —
// never stored or returned in plaintext.
//
// Requires ENCRYPTION_KEY in env: a 32-byte key, base64 or hex encoded.
// Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // recommended for GCM

function getKey() {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "ENCRYPTION_KEY is not set. Generate one with: " +
      "node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\" " +
      "and set it as an environment variable."
    );
  }
  const key = raw.length === 44 && raw.endsWith("=") ? Buffer.from(raw, "base64") : Buffer.from(raw, "hex");
  if (key.length !== 32) {
    throw new Error("ENCRYPTION_KEY must decode to exactly 32 bytes (AES-256).");
  }
  return key;
}

/**
 * @param {Object} plainObject - credentials object, e.g. { apiKey, username, password, token }
 * @returns {string} base64-encoded "iv:authTag:ciphertext" blob, safe to store in a TEXT column
 */
export function encryptCredentials(plainObject) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(plainObject || {}), "utf-8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

/**
 * @param {string} encryptedBlob - output of encryptCredentials()
 * @returns {Object} the original credentials object
 */
export function decryptCredentials(encryptedBlob) {
  if (!encryptedBlob) return {};
  const key = getKey();
  const data = Buffer.from(encryptedBlob, "base64");
  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(IV_LENGTH, IV_LENGTH + 16);
  const ciphertext = data.subarray(IV_LENGTH + 16);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString("utf-8"));
}

// Metadata-only view for the frontend: WHICH fields are set, never any part of their value (no last-4 either).
export function redactCredentials(plainObject) {
  const redacted = {};
  for (const [k, v] of Object.entries(plainObject || {})) redacted[k] = typeof v === "string" && v.length > 0 ? "********" : null;
  return redacted;
}
