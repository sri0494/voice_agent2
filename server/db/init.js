// Creates all tables/extensions from db/schema.sql against DATABASE_URL.
// Safe to re-run — schema.sql uses CREATE ... IF NOT EXISTS throughout and
// never drops existing data.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { pool } from "./pool.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const schemaPath = path.resolve(__dirname, "../../db/schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf-8");

  console.log("[db:init] Connecting to database...");
  const client = await pool.connect();
  try {
    console.log("[db:init] Applying schema.sql ...");
    await client.query(sql);
    console.log("[db:init] Schema applied successfully.");
  } catch (err) {
    console.error("[db:init] Failed to apply schema:", err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
