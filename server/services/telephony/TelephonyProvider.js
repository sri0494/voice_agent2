// TelephonyProvider — abstract interface for real phone-call providers.
// IMPORTANT: LeoMox must never claim to have placed a real call unless a real
// provider is configured via TELEPHONY_PROVIDER + credentials. The mock
// provider below simulates state transitions only, and every response it
// returns is tagged `mock: true` so the UI/API can clearly label it.
export class TelephonyProvider {
  async makeCall(_opts) { throw new Error("makeCall() not implemented"); }
  async receiveCall(_opts) { throw new Error("receiveCall() not implemented"); }
  async hangup(_callSid) { throw new Error("hangup() not implemented"); }
  async transfer(_callSid, _toNumber) { throw new Error("transfer() not implemented"); }
  async getCallStatus(_callSid) { throw new Error("getCallStatus() not implemented"); }
  async getRecording(_callSid) { throw new Error("getRecording() not implemented"); }
  isMock() { return true; }
}

export class MockTelephonyProvider extends TelephonyProvider {
  async startRecording() { return { mock: true }; }
  constructor() {
    super();
    this._calls = new Map();
  }

  async makeCall({ to, from, campaignId, agentId }) {
    const sid = `mock_call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this._calls.set(sid, { sid, to, from, campaignId, agentId, status: "Ringing", startedAt: new Date() });
    return { providerCallId: sid, status: "Ringing", mock: true };
  }

  async receiveCall({ from, to }) {
    const sid = `mock_inbound_${Date.now()}`;
    this._calls.set(sid, { sid, to, from, status: "Connected", startedAt: new Date() });
    return { providerCallId: sid, status: "Connected", mock: true };
  }

  async hangup(callSid) {
    const call = this._calls.get(callSid);
    if (call) call.status = "Completed";
    return { status: "Completed", mock: true };
  }

  async transfer(callSid, toNumber) {
    const call = this._calls.get(callSid);
    if (call) call.status = "Transferred";
    return { status: "Transferred", transferredTo: toNumber, mock: true };
  }

  async getCallStatus(callSid) {
    const call = this._calls.get(callSid);
    return { status: call?.status || "Unknown", mock: true };
  }

  async getRecording(callSid) {
    return { url: null, mock: true, note: "No recording available in mock mode" };
  }

  isMock() { return true; }
}

// Real implementation — Twilio Programmable Voice.
// Uses Twilio's built-in <Gather input="speech"> for STT and <Say> for TTS,
// so a real phone conversation works end-to-end without needing a separate
// paid STT/TTS vendor. The per-turn conversation intelligence (relevance,
// steering, knowledge retrieval, response generation) still runs through
// conversationOrchestrator.js exactly as it does in the Testing Playground —
// see server/routes/telephonyVoice.js for the TwiML webhook handlers that
// wire this together.
//
// Requires: TELEPHONY_API_KEY (Account SID), TELEPHONY_API_SECRET (Auth
// Token), TELEPHONY_PHONE_NUMBER (your Twilio number), and PUBLIC_BASE_URL
// (this app's own public HTTPS URL, e.g. https://your-app.onrender.com) so
// Twilio has a real URL to call back into for TwiML instructions.
export class TwilioProvider extends TelephonyProvider {
  constructor({ accountSid, authToken, fromNumber, publicBaseUrl }) {
    super();
    if (!accountSid || !authToken) {
      throw new Error("TELEPHONY_API_KEY (Account SID) and TELEPHONY_API_SECRET (Auth Token) are required when TELEPHONY_PROVIDER=twilio");
    }
    if (!publicBaseUrl) {
      throw new Error("PUBLIC_BASE_URL is required when TELEPHONY_PROVIDER=twilio (Twilio needs a real HTTPS URL to call back into)");
    }
    this.accountSid = accountSid;
    this.authToken = authToken;
    this.fromNumber = fromNumber;
    this.publicBaseUrl = publicBaseUrl.replace(/\/$/, "");
    this.baseApiUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}`;
  }

  _authHeader() {
    return { Authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64")}` };
  }

  async _request(path, method, params) {
    const res = await fetch(`${this.baseApiUrl}${path}`, {
      method,
      headers: { ...this._authHeader(), "Content-Type": "application/x-www-form-urlencoded" },
      body: params ? new URLSearchParams(params).toString() : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(`Twilio API error ${res.status}: ${data.message || JSON.stringify(data)}`);
    }
    return data;
  }

  // callId is LeoMox's own internal calls.id (UUID) — passed through in the
  // webhook path so telephonyVoice.js knows which agent/session to load
  // without any extra lookup.
  // record=true only when the agent has recording enabled AND no consent prompt is required first.
  async makeCall({ to, from, callId, record = false }) {
    const data = await this._request("/Calls.json", "POST", {
      ...(record ? { Record: "true", RecordingStatusCallback: `${this.publicBaseUrl}/api/telephony/recording`, RecordingStatusCallbackEvent: "completed" } : {}),
      To: to,
      From: from || this.fromNumber,
      Url: `${this.publicBaseUrl}/api/telephony/voice/${callId}`,
      StatusCallback: `${this.publicBaseUrl}/api/telephony/status`,
      StatusCallbackEvent: "initiated ringing answered completed",
      StatusCallbackMethod: "POST",
    });
    return { providerCallId: data.sid, status: "Ringing", mock: false };
  }

  async receiveCall() {
    // Inbound calls are configured on the Twilio number itself (Voice
    // webhook URL set in the Twilio console to this.publicBaseUrl +
    // "/api/telephony/voice/inbound"), not initiated from here.
    throw new Error("receiveCall() is not called directly for Twilio — configure the number's inbound webhook in the Twilio console instead.");
  }

  async hangup(callSid) {
    const data = await this._request(`/Calls/${callSid}.json`, "POST", { Status: "completed" });
    return { status: data.status, mock: false };
  }

  async transfer(callSid, toNumber) {
    const safeNumber = String(toNumber).replace(/[^\d+]/g, "");
    if (!/^\+?[1-9]\d{7,14}$/.test(safeNumber)) throw new Error("Invalid transfer number");
    const twiml = `<Response><Dial>${safeNumber}</Dial></Response>`;
    await this._request(`/Calls/${callSid}.json`, "POST", { Twiml: twiml });
    return { status: "Transferred", transferredTo: toNumber, mock: false };
  }

  // Starts recording an in-progress call (after the caller grants consent). Not verified against a live Twilio account
  // in this repository: failures are logged by the caller and never break the call.
  async startRecording(callSid) {
    return this._request(`/Calls/${callSid}/Recordings.json`, "POST", {
      RecordingStatusCallback: `${this.publicBaseUrl}/api/telephony/recording`, RecordingStatusCallbackEvent: "completed",
    });
  }

  async getCallStatus(callSid) {
    const data = await this._request(`/Calls/${callSid}.json`, "GET");
    return { status: data.status, mock: false };
  }

  async getRecording(callSid) {
    const data = await this._request(`/Calls/${callSid}/Recordings.json`, "GET");
    const recording = data.recordings?.[0];
    return recording
      ? { url: `https://api.twilio.com${recording.uri.replace(".json", ".mp3")}`, mock: false }
      : { url: null, mock: false, note: "No recording found for this call" };
  }

  isMock() { return false; }
}

export function createTelephonyProvider() {
  const provider = (process.env.TELEPHONY_PROVIDER || "mock").toLowerCase();
  switch (provider) {
    case "mock":
      return new MockTelephonyProvider();
    case "twilio":
      return new TwilioProvider({
        accountSid: process.env.TELEPHONY_API_KEY,
        authToken: process.env.TELEPHONY_API_SECRET,
        fromNumber: process.env.TELEPHONY_PHONE_NUMBER,
        publicBaseUrl: process.env.PUBLIC_BASE_URL,
      });
    // case "exotel":     return new ExotelProvider({ apiKey: process.env.TELEPHONY_API_KEY, apiSecret: process.env.TELEPHONY_API_SECRET, from: process.env.TELEPHONY_PHONE_NUMBER });
    // case "knowlarity": return new KnowlarityProvider({ ... });
    // case "ozonetel":   return new OzonetelProvider({ ... });
    default:
      console.warn(`[telephony] Unknown TELEPHONY_PROVIDER="${provider}", falling back to mock. Real calls will NOT be made. Valid values: mock, twilio.`);
      return new MockTelephonyProvider();
  }
}
