import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

export default async function setup() {
  const url = process.env.DATABASE_URL_TEST ?? "postgres://localhost:5432/threads_story_studio_test";
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  const migrationsDir = fileURLToPath(new URL("../drizzle", import.meta.url));
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const content = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    const stmts = content
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of stmts) {
      try {
        await sql.unsafe(stmt);
      } catch (err: unknown) {
        // Ignore duplicate type / table / index errors if test DB persists
        const message = err instanceof Error ? err.message : String(err);
        if (
          !message.includes("already exists") &&
          !message.includes("does not exist, skipping")
        ) {
          throw err;
        }
      }
    }
  }
  await sql.end();
}
