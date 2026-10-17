import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

export default async function setup() {
  const url = process.env.DATABASE_URL_TEST ?? "postgres://localhost:5432/threads_story_studio_test";
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  await migrate(drizzle(sql), { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
  await sql.end();
}
