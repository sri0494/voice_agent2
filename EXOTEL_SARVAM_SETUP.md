# Exotel + Sarvam + Gemini: voice survey setup

Flow: **Campaign dialer -> Exotel (outbound call) -> Exotel flow with a Voicebot applet -> wss://YOUR-APP/ws/exotel -> Sarvam STT (Telugu) -> consent / Gemini reply -> Sarvam TTS -> caller.**
Call records, transcripts and consent live in Neon; recordings are copied into your private Cloudflare R2 bucket.

## 1. Render environment variables
Copy the Exotel + Sarvam block from `.env.example`. Required: `TELEPHONY_PROVIDER=exotel`, `TELEPHONY_API_KEY`, `TELEPHONY_API_SECRET`, `EXOTEL_ACCOUNT_SID`, `EXOTEL_FLOW_URL`, `TELEPHONY_PHONE_NUMBER`, `PUBLIC_BASE_URL`, `TELEPHONY_WEBHOOK_SECRET`, `STT_PROVIDER=sarvam`, `TTS_PROVIDER=sarvam`, `STT_API_KEY`, `TTS_API_KEY`, `AI_PROVIDER=gemini`, `AI_API_KEY`, `RECORDING_URL_ALLOWLIST`. In production the server refuses to start if a required one is missing.

## 2. Exotel flow (App Bazaar)
Build ONE flow and use its start URL as `EXOTEL_FLOW_URL`:
1. **Voicebot / AgentStream applet** (bidirectional stream). URL: `wss://YOUR-APP.onrender.com/ws/exotel?token=<TELEPHONY_WEBHOOK_SECRET>` (or put the secret as the Basic-auth password in the wss URL). Sample rate 16000 recommended.
2. After it, a **Hangup applet** (the stream ends the applet when LeoMox closes it, e.g. survey finished or max duration).
3. Optional for transfers: a **Connect applet** between the Voicebot and Hangup applets. LeoMox cannot transfer a call from the server; it marks the call `Transferred`, says the hand-off line and closes the stream, and the flow continues to the Connect applet.
4. Recording: enable it in the flow (applet-level). Exotel then sends `RecordingUrl` in the status callback and LeoMox copies it to R2 (only if the caller did not decline consent).

Status callbacks are sent by LeoMox's own `Calls/connect` request to `/api/telephony/status?token=...`; nothing to configure for them in the dashboard.

## 3. Agent settings
- Language `Telugu` (also English, Hindi). Write the greeting and the consent message in the same language as the agent, because they are spoken by the Telugu voice.
- Recording consent `REQUIRED` makes the agent ask first. Anything other than a clear yes counts as declined and the recording is not stored.

## 4. What the server does and does not do
- Stream authentication: shared secret only (constant-time compare); no secret configured = every stream refused.
- Half-duplex: while the AI speaks, caller audio is ignored (no barge-in yet).
- Voice activity detection is an energy threshold (`VOICE_VAD_RMS`); tune it on real calls.
- Max call duration, idle re-prompts (twice, then goodbye), survey completion and transfer behave as in the Twilio flow.

## 5. Verified vs not verified
Verified by automated tests (`npm run test:security`): request shape of the Exotel call API, Sarvam request/response handling with mocked HTTP, status mapping and forward-only status, token authentication, stream protocol handling, consent, limits, environment validation.
**Not verified against the real services** (no credentials in the build environment): Exotel's actual stream messages and flow behaviour, Sarvam's live API (base URL, model names, Telugu voice name), call quality, VAD tuning, R2 upload from Exotel recording URLs. Run a few test calls to your own phone first.
