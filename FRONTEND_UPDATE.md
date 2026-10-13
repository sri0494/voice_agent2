# Frontend update: what is in `src/` and how to apply it

Extract the zip over your project (`unzip -o`). Then `git add -A && git commit && git push` and let Render redeploy.

| File | Change |
|---|---|
| `src/components/Sidebar.jsx` | Adds **Recordings** and **Customer Accounts** to the menu (if your Sidebar lives elsewhere, copy it over that file) |
| `src/App.jsx` | Routes for `/recordings` and `/customer-accounts` |
| `src/main.jsx` | Wraps the app in the customer-portal gate (CUSTOMER logins see only their portal) |
| `src/pages/Dashboard.jsx` + `dashboard.css` | New index page: greeting, quick actions, 7/30-day toggle, KPI cards, area chart, outcome donut, recent calls, campaigns, system status, latest recordings, getting-started checklist |
| `src/pages/CallDetail.jsx` | **Call Recordings** section (play / download / delete, private signed links), consent status, voice-note recorder |
| `src/pages/Calls.jsx` | Search box, recording column (🎙️ count), start time |
| `src/pages/Campaigns.jsx` | Customer account dropdown on the create form and a Customer column (shown only if your login may list customer accounts) |
| `src/pages/PhoneNumbers.jsx` | Delete button |
| `src/pages/KnowledgeBase.jsx` | Delete button on each card |
| `src/pages/Settings.jsx` | Fixes the new-user form losing its Agent ID field after saving |
| `src/pages/LiveCalls.jsx` | Uses the authenticated live-calls socket |
| `src/pages/Recordings.jsx`, `AdminCustomers.jsx`, `Customers.jsx`, `CustomerDetail.jsx` | New or updated earlier |

Server side: `GET /api/calls` now includes `recording_count`, and `GET /api/campaigns` includes `client_name`.
Pages you sent that needed no change: Analytics, CampaignDetail, ContactRequests, ContactUs, Integrations, KnowledgeBaseDetail, Login, SurveyDetail, Surveys.
After deploying, hard-refresh the browser (Ctrl+Shift+R): the old JavaScript is cached.
