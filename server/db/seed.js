// Development seed data — campaigns, calls, agents, knowledge bases, contact requests.
// Guarded so it can never accidentally run against production.
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import { pool } from "./pool.js";

dotenv.config();

if (process.env.NODE_ENV === "production") {
  console.error("[db:seed] Refusing to seed demo data in production. Aborting.");
  process.exit(1);
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // --- Users ---
    const passwordHash = await bcrypt.hash("Leomox@123", 10);
    const { rows: userRows } = await client.query(
      `INSERT INTO users (name, email, phone, role, password_hash)
       VALUES
        ('Admin User', 'admin@leomox.ai', '9999999999', 'SUPER_ADMIN', $1),
        ('Ops Manager', 'manager@leomox.ai', '9888888888', 'MANAGER', $1)
       ON CONFLICT (email) DO NOTHING
       RETURNING id, email`,
      [passwordHash]
    );
    console.log(`[seed] Users ready (${userRows.length} inserted, admin@leomox.ai / Leomox@123)`);

    const { rows: adminRows } = await client.query(`SELECT id FROM users WHERE email = 'admin@leomox.ai'`);
    const adminId = adminRows[0]?.id;

    // --- Knowledge bases ---
    const { rows: kbRows } = await client.query(
      `INSERT INTO knowledge_bases (name, description, created_by)
       VALUES
        ('AP Government Services', 'Citizen service info for Andhra Pradesh government schemes', $1),
        ('LeoMox Product Knowledge', 'Internal product documentation for support agents', $1),
        ('Sales FAQ', 'Common sales and pricing questions', $1)
       RETURNING id, name`,
      [adminId]
    );
    const kbByName = Object.fromEntries(kbRows.map((r) => [r.name, r.id]));

    for (const [name, count] of [
      ["AP Government Services", 12],
      ["LeoMox Product Knowledge", 8],
      ["Sales FAQ", 5],
    ]) {
      const kbId = kbByName[name];
      for (let i = 1; i <= count; i++) {
        await client.query(
          `INSERT INTO knowledge_documents (knowledge_base_id, title, source_type, file_type, status, chunk_count)
           VALUES ($1, $2, 'FILE', 'PDF', 'READY', $3)`,
          [kbId, `${name} - Document ${i}`, Math.floor(150 + Math.random() * 100)]
        );
      }
    }

    // --- Agents ---
    const { rows: agentRows } = await client.query(
      `INSERT INTO agents (name, description, status, language, voice, greeting, system_prompt, transfer_enabled, transfer_number, created_by)
       VALUES
        ('AP Citizen Assistant', 'Handles citizen queries for AP government schemes', 'ACTIVE', 'Telugu', 'Female Telugu',
         'Namaskaram! Nenu LeoMox AI Assistant ni. Meeku ela sahayam cheyagalanu?',
         'You are a helpful citizen services assistant for the Government of Andhra Pradesh. Only answer using the assigned knowledge base. If unsure, offer to transfer to a human.',
         true, '+91XXXXXXXXXX', $1),
        ('Sales Qualifier', 'Qualifies inbound sales leads', 'ACTIVE', 'English', 'Female English',
         'Hi, thanks for your interest in LeoMox! Can I ask a few quick questions?',
         'You are a sales development representative for LeoMox. Be concise, friendly, and qualify budget/timeline/use case.',
         true, '+91XXXXXXXXXX', $1),
        ('Payment Reminder Bot', 'Outbound payment reminder calls', 'PAUSED', 'Hindi', 'Male Hindi',
         'Namaste, main LeoMox ki taraf se baat kar raha hoon.',
         'You are a polite payment reminder assistant. Never threaten the customer. Offer payment link and human escalation.',
         false, NULL, $1)
       RETURNING id, name`,
      [adminId]
    );
    const agentByName = Object.fromEntries(agentRows.map((r) => [r.name, r.id]));

    await client.query(
      `INSERT INTO agent_knowledge_bases (agent_id, knowledge_base_id) VALUES ($1, $2), ($3, $4)
       ON CONFLICT DO NOTHING`,
      [agentByName["AP Citizen Assistant"], kbByName["AP Government Services"],
       agentByName["Sales Qualifier"], kbByName["Sales FAQ"]]
    );

    // --- Campaigns ---
    const { rows: campaignRows } = await client.query(
      `INSERT INTO campaigns (name, type, description, language, agent_id, knowledge_base_id, status, start_date, retry_attempts, created_by)
       VALUES
        ('AP Pension Survey - Aug 2026', 'Survey', 'Quarterly citizen satisfaction survey', 'Telugu',
          $1, $2, 'Running', now() - interval '3 days', 2, $5),
        ('Q3 Renewal Reminders', 'Payment Reminder', 'Subscription renewal reminders', 'Hindi',
          $3, NULL, 'Paused', now() - interval '10 days', 3, $5),
        ('Inbound Sales Qualification', 'Customer Support', 'Qualifies inbound website leads', 'English',
          $4, NULL, 'Running', now() - interval '20 days', 1, $5)
       RETURNING id, name`,
      [
        agentByName["AP Citizen Assistant"], kbByName["AP Government Services"],
        agentByName["Payment Reminder Bot"],
        agentByName["Sales Qualifier"],
        adminId,
      ]
    );
    const campaignByName = Object.fromEntries(campaignRows.map((r) => [r.name, r.id]));

    // --- Contacts ---
    const sampleNames = ["Ravi Kumar", "Lakshmi Devi", "Suresh Babu", "Anitha Reddy", "Mahesh Rao"];
    const contactIds = [];
    for (const campId of Object.values(campaignByName)) {
      for (let i = 0; i < 5; i++) {
        const { rows } = await client.query(
          `INSERT INTO contacts (campaign_id, name, phone, language, status, call_attempts)
           VALUES ($1, $2, $3, 'Telugu', 'DONE', 1) RETURNING id`,
          [campId, sampleNames[i], `9${Math.floor(100000000 + Math.random() * 899999999)}`]
        );
        contactIds.push({ id: rows[0].id, campaignId: campId });
      }
    }

    // --- Calls + transcript ---
    const statuses = ["Completed", "Completed", "Missed", "Failed", "Transferred"];
    const sentiments = ["Positive", "Neutral", "Negative"];
    const intents = ["Survey", "Payment", "Information", "Complaint", "Support"];

    for (const c of contactIds) {
      const status = statuses[Math.floor(Math.random() * statuses.length)];
      const duration = status === "Completed" ? Math.floor(60 + Math.random() * 240) : 0;
      const { rows: callRows } = await client.query(
        `INSERT INTO calls (campaign_id, contact_id, agent_id, direction, customer_name, phone, language,
                             status, sentiment, intent, ai_resolved, duration_sec, started_at, ended_at)
         VALUES ($1, $2, $3, 'OUTBOUND', $4, $5, 'Telugu', $6, $7, $8, $9, $10, now() - interval '1 day', now() - interval '1 day' + ($10 || ' seconds')::interval)
         RETURNING id`,
        [
          c.campaignId, c.id, agentByName["AP Citizen Assistant"],
          "Demo Citizen", `9${Math.floor(100000000 + Math.random() * 899999999)}`,
          status, sentiments[Math.floor(Math.random() * 3)], intents[Math.floor(Math.random() * intents.length)],
          status === "Completed", duration,
        ]
      );
      const callId = callRows[0].id;
      if (status === "Completed") {
        await client.query(
          `INSERT INTO call_messages (call_id, speaker, content, sequence) VALUES
            ($1, 'AI', 'Namaskaram! Nenu LeoMox AI Assistant ni. Mee gramamlo pension distribution gurinchi konni prashnalu adugutanu.', 1),
            ($1, 'CUSTOMER', 'Avunu, cheppandi.', 2),
            ($1, 'AI', 'Mee pension prati nela sariga vastundaa?', 3),
            ($1, 'CUSTOMER', 'Avunu, vastundi. Dhanyavadalu.', 4)`,
          [callId]
        );
      }
    }

    // --- Contact requests ---
    await client.query(
      `INSERT INTO contact_requests (name, email, phone, company, subject, message, status)
       VALUES
        ('Praveen Nair', 'praveen@example.com', '9876543210', 'Nair Enterprises', 'Enterprise pricing',
         'Interested in LeoMox for our 50-agent contact center. Please share enterprise pricing.', 'New'),
        ('Divya Menon', 'divya@example.com', '9123456780', 'Divya Retail', 'Demo request',
         'Would like a demo of the outbound campaign features.', 'In Progress')`
    );

    await client.query("COMMIT");
    console.log("[seed] Demo data seeded successfully.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[seed] Failed, rolled back:", err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
