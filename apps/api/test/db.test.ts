import { describe, expect, it } from "vitest";

import { preparedStatementsEnabled } from "../src/db/client";

describe("prepared statements detection", () => {
  it("disables them for transaction-mode poolers", () => {
    expect(preparedStatementsEnabled("postgres://u:p@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres")).toBe(
      false,
    );
    expect(preparedStatementsEnabled("postgres://u:p@ep-cool-name-pooler.ap-southeast-1.aws.neon.tech/db")).toBe(false);
    expect(preparedStatementsEnabled("postgres://u:p@host:5432/db?pgbouncer=true")).toBe(false);
  });
  it("enables them for direct and session-mode connections", () => {
    expect(preparedStatementsEnabled("postgres://u:p@db.abcd.supabase.co:5432/postgres")).toBe(true);
    expect(preparedStatementsEnabled("postgres://localhost:5432/threads_story_studio")).toBe(true);
  });
  it("respects an explicit override", () => {
    expect(preparedStatementsEnabled("postgres://host:6543/db", true)).toBe(true);
    expect(preparedStatementsEnabled("postgres://localhost/db", false)).toBe(false);
  });
});
