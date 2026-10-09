# LeoMox Voice AI Platform — User Manual

This manual walks through the entire platform, in the order you'd actually
use it, with concrete examples. It reflects the app as of this build,
including the Conversation Intelligence engine and Survey engine.

---

## 0. Before you start

- **Mock mode is the default.** No real phone calls, no real AI provider
  calls happen until you configure real credentials in Render's environment
  variables (`AI_PROVIDER`, `STT_PROVIDER`, `TTS_PROVIDER`,
  `TELEPHONY_PROVIDER`, `EMBEDDING_PROVIDER`). Everything below works fully
  in mock mode — you're testing the *workflow*, not placing real calls.
- **Log in** at your Render URL with the admin account you seeded
  (`admin@leomox.ai` / whatever password you set via the bcrypt hash steps
  earlier), or any user an admin created for you.

---

## 1. Create a Knowledge Base

Your AI agent can only answer questions grounded in a Knowledge Base — it
will not invent information (see Agent Safety Rules, section 12).

**Sidebar → Knowledge Base → + Create Knowledge Base**

Example: a hospital feedback bot needs to know about hospital services.

```
Name: City Hospital Services
Description: Department info, visiting hours, and feedback survey context
```

Click into it, then add content one of three ways:

- **⬆ Upload Document** — PDF, DOCX, TXT, CSV, or Markdown
- **+ Add Text** — paste raw text (e.g. a policy document)
- **+ Add FAQ** — question/answer pairs, one at a time

**Example FAQ entry:**
```
Question: What are the hospital's visiting hours?
Answer: Visiting hours are 10 AM to 12 PM and 5 PM to 7 PM daily.
```

Each upload shows a status: `PENDING → PROCESSING → READY` (or `FAILED` with
an error message). Processing runs the pipeline: text extraction → cleaning
→ chunking → embedding → vector storage. Click **↻ Re-index** if you edit
a source document and need to regenerate its chunks.

**Test retrieval directly:** use the search box on the Knowledge Base detail
page — type a question, and you'll see the raw chunks the system would
retrieve, with a similarity score. This is useful for debugging *before* you
even build an agent around it.

---

## 2. Create an AI Agent

**Sidebar → AI Engine → + New Agent** → type a name → **OK**

You land on the agent's configuration page. Example: a hospital feedback
agent.

| Field | Example value |
|---|---|
| Agent Name | `City Hospital Feedback Agent` |
| Business Name | `City Hospital` |
| Agent Type | `Customer Support Agent` |
| Language | `Telugu` |
| Voice | `Female Telugu` |
| Gender | `Female` |
| Personality | `Warm and empathetic` |
| Greeting | `Namaskaram, thank you for visiting City Hospital. Can I ask a few quick questions about your visit?` |
| System Prompt | `You are a feedback assistant for City Hospital. Never diagnose or give medical advice. Only use the knowledge base for factual answers. Record feedback faithfully without altering it.` |
| Fallback Message | `I don't have that information in my available information. I can help you with the services covered by this agent.` |
| Temperature | `0.2` (low — this is a factual/compliance context) |
| Human Transfer Enabled | ✅ (medical contexts should always have an escalation path) |
| Knowledge Bases | select `City Hospital Services` |

Click **Save Agent**.

---

## 3. Configure Conversation Intelligence (Steering)

This is the part that makes LeoMox more than a plain chatbot — it keeps the
agent focused on its actual job instead of wandering off-topic.

On the agent page, click **Conversation Settings** (top right).

| Field | Example value | What it does |
|---|---|---|
| Primary Objective | `Collect patient satisfaction feedback about their hospital visit` | Used in redirect messages and objective-progress tracking |
| Allowed Topics | `doctor behaviour, staff response, waiting time, facilities` | Informational — documents intended scope |
| Restricted Topics | `medical diagnosis, prescriptions, billing disputes` | Informational — documents what to avoid |
| Required Information | `overall_satisfaction, doctor_rating, waiting_time_feedback` | Drives the **Objective Progress %** — the agent is "done" once these keys have been extracted |
| Off-topic Strategy | `Brief Answer + Redirect` | See below |
| Max Off-topic Turns | `2` | After this many off-topic turns, the agent stops engaging and firmly redirects |
| Confidence Threshold | `0.5` | Minimum knowledge-match similarity before the agent treats a question as answerable |
| Knowledge-Only Mode | ✅ ON | Agent will never answer outside its knowledge base — always safe default for regulated contexts (government, healthcare, finance) |

**The three off-topic strategies, concretely:**
- **Redirect** — immediately steers back: *"I'm here to help with our services. Could you tell me more about what you need?"*
- **Brief Answer + Redirect** — attempts a short answer first, then redirects. (Honest note: in mock mode this behaves like plain Redirect, since a real brief answer requires a real AI provider — see section 9.)
- **Strict Knowledge Mode** — never engages with off-topic questions at all: *"I don't have that information in my available information..."*

**Information to Extract from Speech** — add fields you want automatically
pulled from what the customer says.

Example for a retail sales agent:
```
Label: Budget       Type: Number   (key: budget)
Label: Product      Type: Text     (key: product)
```
Honest limitation: only **Number** fields are reliably extracted in mock
mode (e.g. "my budget is 30000" → `{"budget": 30000}`). Text fields need a
real AI provider to extract accurately — see section 9.

Click **Save Settings**.

---

## 4. Test the agent — Conversation Testing Playground

From the agent page, click **Test Playground**. This runs the *exact* same
pipeline a live call would use — relevance classification → knowledge
retrieval → response generation — with zero real telephony involved.

**Example test conversation** (hospital feedback agent):

```
You type: "The doctor was very polite."
→ Relevance: FEEDBACK | Sentiment: Positive | Confidence: 65%

You type: "What's the weather today?"
→ Relevance: OFF_TOPIC | Next Action: redirect
→ AI: "I'm here to help with our services. Could you tell me more
       about what you need?"

You type: "Sorry, I waited two hours before being seen."
→ Relevance: FEEDBACK | Sentiment: Negative | Confidence: 65%

You type: "My OTP is 4521, can you note that down?"
→ Relevance: UNSAFE | Next Action: transfer
→ AI: "For your security, I can't help with that over this line.
       Let me connect you with a team member."
```

Notice the **"· session active"** label next to "Conversation" once you've
sent a message — this confirms the conversation is tracked as one
continuous session (objective progress and off-topic count accumulate
correctly across turns). Click **New Conversation** to start a fresh test.

The right panel shows the full analysis for the last turn: Relevance,
Sentiment, Confidence, Next Action, Objective Progress %, Knowledge Sources
Used, and any Extracted Information as raw JSON.

---

## 5. Build a Survey (optional, for structured feedback/research agents)

**Sidebar → Surveys → + New Survey**

Example: link it to the hospital feedback agent.

```
Survey Name: Hospital Visit Feedback
Description: Post-visit satisfaction survey
Linked AI Agent: City Hospital Feedback Agent
```

Open the survey → **Question Builder** tab → **+ Add Question**:

```
Q1: How was your overall experience?          Type: Rating 1-5
Q2: How was the doctor interaction?            Type: Rating 1-5
Q3: How was the staff behaviour?               Type: Rating 1-5
Q4: Would you recommend our hospital?          Type: Yes/No
Q5: Any additional feedback?                   Type: Free Text
```

Responses get recorded (via `POST /api/surveys/:id/responses` — currently
called by your telephony/agent integration once wired to a real call flow;
there's no manual "fill out this survey" UI yet since surveys are meant to
be conducted *by* the AI agent during a call).

Switch to the **Results** tab to see aggregated data: total responses,
positive/negative/neutral sentiment split, and per-question average score.

---

## 6. Create a Campaign and add Contacts

**Sidebar → Campaigns → + New Campaign**

```
Campaign Name: Post-Discharge Feedback Calls
Type: Customer Support
Language: Telugu
AI Agent: City Hospital Feedback Agent
```

Click **Create Campaign**, then on the campaign detail page, **⬆ Upload
CSV** to add contacts:

```csv
name,phone,email,language
Ravi Kumar,9876543210,,Telugu
Lakshmi Devi,9123456789,,Telugu
```

Each row needs a valid Indian mobile number (10 digits starting 6–9, or
`+91`-prefixed) — invalid rows are skipped and reported in the upload
summary.

Click **▶ Call** next to a contact to place a call (in mock mode, this
creates a mock call record — no real phone rings unless `TELEPHONY_PROVIDER`
is configured).

---

## 7. Customers vs. Public Contacts — which to use

- **Public Contacts** (the `contacts` used above) — people you might call
  who aren't necessarily existing customers: campaign lists, survey
  participants, leads.
- **Customers** (Sidebar → Customers → + Add Customer) — people with an
  established relationship: existing patients, subscribers, clients. Has a
  richer profile (company, category, assigned agent, tags) and shows full
  call history on its detail page.
- **Convert a Contact to a Customer** once they become one: this is done
  via API (`POST /api/customers/convert-from-contact/:contactId`) — there's
  no button for it in the UI yet, so ask your admin/dev to trigger it, or
  I can add a UI button if you want it.

---

## 8. Phone Numbers & Business Integrations

**Phone Numbers** (Sidebar → Phone Numbers → + Add Number): register a
number and assign it to an agent. In mock mode this just plans the
routing — actual call delivery needs a real `TELEPHONY_PROVIDER`.

**Business Integrations** (Sidebar → Integrations → + Add Integration):
connect an external business API (CRM, ERP, payment system) so your agent
can look things up mid-conversation.

Example: connecting a retail order-status API.

```
Integration Name: Retail Order API
Category: E-commerce
Base URL: https://api.yourstore.com
Auth Type: API Key
API Key: •••••••• (encrypted before storage — never shown again in plaintext)
```

Then define a function:
```
Function Name: get_order_status
Description: Retrieve order status by order number
HTTP Method: GET
Path Template: /orders/{orderNumber}
```

Click **Test** next to the function, enter sample params like
`{"orderNumber":"ORD10254"}`, and it calls the real external API right
there so you can confirm it works before relying on it.

**Important honesty note:** defining a function here makes it *available*,
but a real AI provider with tool-calling support is what actually decides
*when* to call it mid-conversation. The mock AI provider doesn't do this —
see section 9.

---

## 9. What's mock vs. real, and how to go live

| Capability | Mock (default) | To go real |
|---|---|---|
| AI responses | Deterministic, labeled `[MOCK AI]`, echoes back retrieved KB text | Set `AI_PROVIDER` + `AI_API_KEY` in Render, implement the provider class |
| Relevance/sentiment classification | Keyword heuristics (see `relevanceEngine.js`) | Replace `classify()` with a real LLM call — same return shape, no other file changes |
| Speech-to-Text / Text-to-Speech | No-op placeholders | Set `STT_PROVIDER`/`TTS_PROVIDER` + keys |
| Phone calls | Simulated state only, tagged `mock: true` | Set `TELEPHONY_PROVIDER` (e.g. Exotel/Knowlarity) + credentials |
| Embeddings (Knowledge Base search) | Deterministic hash vector — not semantically meaningful | Set `EMBEDDING_PROVIDER` + key for real semantic search |

You can build and test the **entire workflow** above — agents, knowledge
bases, steering, surveys, campaigns, contacts, integrations — before
spending anything on real providers.

---

## 10. Analytics & Dashboard

**Dashboard** — top-level stats: total/connected/live calls, conversion
rate, AI resolution rate, active campaigns/agents, knowledge base chunks,
a 30-day call trend chart, and a call-outcomes breakdown.

**Analytics** — same stats with date-range filtering (Today / Yesterday /
7 Days / 30 Days), plus charts for calls-by-campaign, calls-by-language,
sentiment split.

**Live Calls** — real-time view of any call currently in Ringing/
Connected/Live/Transferred status, pushed via WebSocket (no polling
delay). Transfer or end a call directly from here.

**Call Detail** (click any call) — full transcript, sentiment, intent,
duration, outcome.

---

## 11. Roles & permissions

| Role | Can do |
|---|---|
| `SUPER_ADMIN` / `ADMIN` | Everything, including user management and business integration credentials |
| `MANAGER` | Contact request triage; most operational features |
| `AGENT` | Day-to-day use: agents, campaigns, calls, knowledge base |
| `VIEWER` | Read-only |
| `CUSTOMER` | A client business's own login. Sees only the Customer Portal and only its own data (see section 16) |

Manage users at **Settings → User Management** (admin only).

---

## 12. Safety guardrails already built in

- Agents never fabricate prices, medical advice, government rules, or
  policies — if the knowledge base doesn't cover it, they say so and offer
  a human transfer.
- The relevance engine flags any mention of OTP/PIN/CVV/password as
  `UNSAFE` and immediately routes to `next_action: transfer` rather than
  continuing the conversation.
- Knowledge-Only Mode (per agent) can force strict "never answer without a
  source" behavior — recommended for government/healthcare/financial use
  cases.
- Fallback messages are configurable per agent so "I don't know" always
  sounds appropriate to that agent's context.

---

## Appendix: end-to-end example scenario

Putting it all together — a public-perception survey bot for a government
scheme, following the same shape as the acceptance-test scenario this
platform was built against:

1. **Knowledge Base**: `AP Pension Services`, loaded with the pension Q&A
   document (Q1–Q47 pairs) via **+ Add Text**.
2. **Agent**: `AP Pension Assistant`, Telugu, Agent Type `Survey`,
   Knowledge-Only Mode ON, attached to the knowledge base above.
3. **Steering**: Primary Objective = "Answer citizen pension queries and
   collect satisfaction feedback"; Off-topic Strategy = Strict Knowledge
   Mode (appropriate for a government context — never guess).
4. **Test in the Playground**:
   ```
   "Naa pension enduku raaledu?"
   → FEEDBACK/INFORMATION_REQUEST, retrieves the relevant Q&A chunk,
     answers grounded in the knowledge base.

   "Naaku oka joke cheppu"
   → OFF_TOPIC → Strict Knowledge Mode response: redirected immediately.
   ```
5. **Campaign**: `Pension Satisfaction Survey — Sept 2026`, Type = Survey,
   language Telugu, this agent attached, contacts uploaded via CSV.
6. **Survey**: `Pension Scheme Satisfaction`, linked to this agent, with
   rating and yes/no questions matching the required_information fields
   configured in Steering.
7. Launch the campaign (or, in mock mode, review the whole configuration
   and defer launch until a real `TELEPHONY_PROVIDER` is connected).

---

## 13. Connecting real providers — Gemini + Twilio (step by step)

As of this update, **Gemini (AI) and Twilio (telephony) are real, working
implementations** — not mocks. Here's exactly how to turn them on.

### Gemini (AI answers)

1. Get an API key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
2. In Render → your service → **Environment**, set:
   ```
   AI_PROVIDER=gemini
   AI_API_KEY=<your key>
   ```
   **Important:** `AI_PROVIDER` must be the exact literal word `gemini` — not
   your API key. The key goes in `AI_API_KEY`. Mixing these up is the #1
   cause of "I set it up but it's still mock."
3. Optional: also set `EMBEDDING_PROVIDER=google` to get real semantic
   search in the Knowledge Base (uses the same `AI_API_KEY` automatically
   if `EMBEDDING_API_KEY` isn't set separately). **If you had any documents
   uploaded before turning this on, click ↻ Re-index on each one** —
   embeddings from the old mock provider aren't compatible with real ones.

### Twilio (real phone calls)

1. Get an Account SID, Auth Token, and a phone number from
   [twilio.com](https://twilio.com)
2. Set in Render:
   ```
   TELEPHONY_PROVIDER=twilio
   TELEPHONY_API_KEY=<Account SID>
   TELEPHONY_API_SECRET=<Auth Token>
   TELEPHONY_PHONE_NUMBER=<your Twilio number, e.g. +14155551234>
   PUBLIC_BASE_URL=https://your-app.onrender.com
   ```
   `PUBLIC_BASE_URL` is your own Render URL — Twilio needs a real address
   to call back into during the conversation.
3. That's it — no separate STT/TTS vendor needed. Real calls use Twilio's
   own built-in speech recognition (`<Gather input="speech">`) and
   text-to-speech (`<Say>`), running through the exact same conversation
   intelligence pipeline as the Testing Playground.

### Verify it's actually connected (not just "set")

Go to **Integrations** in the sidebar. Each Core Provider card now shows
one of three honest states:
- **CONNECTED** (green) — a real adapter exists and required keys are present
- **DISCONNECTED** (grey) — still on `mock`
- **ERROR** (red) — you set a real provider name but something's missing
  (wrong env var name, missing key) — the card tells you exactly what's wrong

### What still doesn't have a real adapter

Speech-to-Text and Text-to-Speech as *standalone* providers are not
implemented — and don't need to be, since Twilio handles both natively for
real phone calls. If you set `STT_PROVIDER` or `TTS_PROVIDER` to anything
other than `mock`, the Integrations page will now honestly show **ERROR**
rather than falsely claiming connection.

---

## 14. Changelog — issues found and fixed in this update

| Issue | Fix |
|---|---|
| Campaigns showed "Running" but never called anyone automatically | Added a real Campaign Dialer (`campaignDialer.js`) that ticks every 30s and places calls for pending contacts |
| Gemini/Twilio "integrated" but behaved like mock | Built real `GeminiAIProvider` and `TwilioProvider` classes — previously only comments/stubs existed |
| Integrations page falsely showed "CONNECTED" for unsupported provider names | Now validates against actually-implemented providers and required keys, with a real ERROR state |
| Customer create form missing Customer ID, Company, Category, Assigned Agent, Alternate Mobile, Tags, Notes | Added all fields — backend already supported them |
| User creation form missing "Agent ID" field | Added — the `users.agent_id` column existed but had no UI |
| Knowledge Base upload was one file at a time | Now supports multi-file select and sequential upload |
| No public "Contact Us" form despite a public backend endpoint | Added `/contact` page, linked from Login |
| `"pin"` substring matched inside ordinary words like "shopping"/"opinion", wrongly flagging them UNSAFE | Fixed with word-boundary matching |
| Testing Playground lost conversation state every message | Fixed with proper session continuity |
| Twilio/generic webhook signature validation was placeholder-only | Real Twilio HMAC-SHA1 signature validation implemented |
| Contacts stuck at `QUEUED` forever after their call ended | Now synced to `DONE`/`FAILED` when the call resolves |
| Customers had no way to be edited after creation | Added an **Edit** button on the Customers list and customer page; the update API now saves every field and can clear values |
| Creating a customer failed with a generic "Something went wrong" | Database errors now return clear messages (duplicate mobile/Customer ID, missing value); filters no longer clash on the shared `status` column |
| No call recording or storage | Added a browser voice recorder, private S3-compatible object storage and short-lived (5-minute) playback links (section 15) |
| Clients could not log in to see their own results | Added Customer Accounts and a Customer Portal with admin-controlled permissions and strict data isolation (section 16) |
| Admin APIs only checked "is logged in" | Customer logins are now blocked from every admin API, globally and per router |

---

## 15. Recordings & voice recorder

**Sidebar → Recordings** (admin/staff):
1. Press **● Record**, allow the microphone (the browser needs HTTPS), speak, press **■ Stop**.
2. Listen to the preview, then **Save recording** (or **Discard**).
3. Saved recordings appear in the list below: **Play** loads a short-lived secure
   link; **Delete** removes the file and its record (asks for confirmation; admin/manager only).

On a customer's page, open **Call History → Recordings** to record or play audio
for one specific call.

Recordings are stored in your private bucket (set `STORAGE_PROVIDER=s3` in
Render; the default `local` disk is wiped on every deploy). Tell people they are
being recorded where the law or your policy requires it.

---

## 16. Customer Accounts & the Customer Portal

A **Customer Account** is a client business (for example *ABC Hospital*) whose
staff log in to see their own campaigns, calls, recordings and analytics. This is
different from **Customers** (Sidebar → Customers), which are individual people.

**Create one** — Sidebar → **Customer Accounts** → **+ Add Customer**:
1. Enter name, company, email, phone.
2. Enter a **login email**. Leave the password blank to generate one. The temporary
   password is shown **once**; share it securely.
3. Tick what this customer may see (Dashboard, Campaigns, Contacts, Recordings,
   Call History, Analytics, Agents, Settings; plus Create/Edit/Delete, Download, Reports).
   Choosing an action automatically turns on its *View*. Turn on **Settings** if the
   customer should be able to change their own password.
4. Press **Manage** on the customer to edit details, change permissions, add or
   reset logins, **assign campaigns**, and see usage. Inactive customers cannot log in.

**What the customer sees** — after logging in they land in the Customer Portal
(a separate layout). The menu shows only the modules you enabled; everything is
limited to campaigns assigned to them. Phone numbers in call lists are partly masked.

**Good to know**
- Campaigns are **invisible to customers until you assign them** (Manage → Campaigns).
- Deleting a customer account removes its logins but **keeps** its campaigns and calls (they become unassigned).
- Permissions are checked by the server on every request, so typing a URL or calling
  the API directly does not bypass them.


---

## 17. Security, retention and consent (this release)

- **Playing and downloading recordings.** Play and Download are separate permissions. A customer with "Recordings: view"
  can listen but not download; turn on "Recordings: download" to allow it. Every play, download and delete is logged
  (Audit logs).
- **Retention.** Recordings are deleted automatically after the agent's retention period (or the deployment default).
  Leave it empty to keep recordings forever. Deleted recordings leave an audit entry.
- **Consent.** An agent can be set to require consent. The caller hears your consent message first; recording starts only if they agree.
  The wording is yours; check your local requirements. (Set through the agent API fields `recordingConsent`,
  `recordingConsentMessage`, `recordingRetentionDays`; there is no form for them in the UI yet.)
- **Deactivating a person or a customer** blocks them immediately, even if they are logged in. Changing a password signs out older sessions.
- **Too many attempts.** Login, password changes, calls, campaign launches, uploads and imports are rate limited; you will see "429 Too Many Requests". Wait and retry.
- **Integrations.** Saved API keys are never shown again (the page shows "credentials saved"). Integration URLs must be public HTTPS addresses.
- **Mock mode.** With mock providers nothing is a real call; the interface labels it as mock.
