// Applies every db/migrations/*.sql file exactly once, in name order.
// Applied files are recorded in the schema_migrations table, so it is safe to run on every deploy.
//   npm run db:migrate
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function runMigrations(client, dir, log = console.log) {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const done = new Set((await client.query(`SELECT name FROM schema_migrations`)).rows.map((r) => r.name));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  let applied = 0;
  for (const file of files) {
    if (done.has(file)) { log(`skip     ${file} (already applied)`); continue; }
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [file]);
      await client.query("COMMIT");
      log(`applied  ${file}`);
      applied++;
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`${file} failed and was rolled back: ${err.message}`);
    }
  }
  return applied;
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is not set"); process.exit(1); }
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../db/migrations");
  try {
    await client.connect();
    const n = await runMigrations(client, dir);
    console.log(n ? `Done: ${n} migration(s) applied.` : "Database is up to date.");
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}
