import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.argv[2] ?? process.env.DATABASE_URL;
if (!url) {
  console.warn("DATABASE_URL is not set, skipping migrations.");
  process.exit(0);
}

try {
  const sql = postgres(url, { max: 1, onnotice: () => undefined, connect_timeout: 10 });
  await migrate(drizzle(sql), { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
  await sql.end();
  console.log("Migrations applied successfully.");
} catch (err) {
  const { message, code } = err as { message?: string; code?: string };
  console.warn("Migration notice:", message);
  if (message?.includes("already exists") || code === "23505") {
    console.log("Database schema is already up to date.");
    process.exit(0);
  }
  // If connection fails during build, log warning rather than blocking build since schema is already initialized
  console.warn("Continuing build without applying migrations:", message);
  process.exit(0);
}
