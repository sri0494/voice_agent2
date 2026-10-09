// twilioSignature.js — validates the X-Twilio-Signature header per Twilio's
// documented algorithm: HMAC-SHA1 of (full request URL + sorted, concatenated
// POST param key-value pairs), keyed with the Twilio Auth Token, base64-encoded.
// https://www.twilio.com/docs/usage/security#validating-requests
import crypto from "crypto";

export function validateTwilioSignature(req, authToken) {
  const signature = req.headers["x-twilio-signature"];
  if (!signature || !authToken) return false;

  const publicBaseUrl = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  const fullUrl = `${publicBaseUrl}${req.originalUrl}`;

  const sortedParams = Object.keys(req.body || {})
    .sort()
    .reduce((acc, key) => acc + key + req.body[key], "");

  const expected = crypto
    .createHmac("sha1", authToken)
    .update(fullUrl + sortedParams)
    .digest("base64");

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false; // length mismatch etc. — treat as invalid rather than throwing
  }
}
