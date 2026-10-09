// Runs AFTER the other suites: every audit action your policy requires must have been written by at least one of them.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".test-results");
const seen = new Set(fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".audit.json")).flatMap((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))) : []);
const required = ["login_success", "login_failure", "logout", "password_change", "password_reset", "user_create", "user_update", "user_disable", "permission_change",
  "customer_account_create", "customer_account_update", "customer_account_delete", "campaign_create", "campaign_update", "campaign_launch", "campaign_pause", "campaign_stop", "campaign_delete",
  "campaign_assign", "campaign_unassign", "call_initiate", "call_transfer", "recording_play", "recording_download", "recording_delete", "recording_upload", "recording_retention_delete",
  "integration_create", "integration_update", "integration_test", "credential_update", "kb_create", "kb_document_upload", "kb_document_delete", "agent_create", "agent_update", "contacts_import", "report_export"];
const missing = required.filter((a) => !seen.has(a));
console.log(missing.length ? `FAIL  audit actions never written: ${missing.join(", ")}` : `PASS  all ${required.length} required audit actions are written by the suites`);
console.log(`\n${missing.length ? 0 : 1} passed, ${missing.length ? 1 : 0} failed`); process.exit(missing.length ? 1 : 0);
