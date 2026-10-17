import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";

import { db } from "../db/client";
import { devices, notificationDeliveries } from "../db/schema";
import { env } from "../env";
import { log } from "../security/redact";

const PUSH_SEND = "https://exp.host/--/api/v2/push/send";
const PUSH_RECEIPTS = "https://exp.host/--/api/v2/push/getReceipts";

type Ticket = { status: "ok" | "error"; id?: string; message?: string; details?: { error?: string } };

function headers() {
  return {
    accept: "application/json",
    "content-type": "application/json",
    ...(env.EXPO_ACCESS_TOKEN ? { authorization: `Bearer ${env.EXPO_ACCESS_TOKEN}` } : {}),
  };
}

export type PushMessage = { title: string; body: string; data?: Record<string, unknown> };

/** Sends a push to all active devices of a user via the Expo push service. Never throws. */
export async function sendPush(userId: string, kind: string, message: PushMessage, fetchImpl: typeof fetch = fetch) {
  const targets = await db
    .select()
    .from(devices)
    .where(and(eq(devices.userId, userId), isNull(devices.disabledAt)));
  if (targets.length === 0) return;
  try {
    const response = await fetchImpl(PUSH_SEND, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(
        targets.map((d) => ({
          to: d.expoPushToken,
          title: message.title,
          body: message.body,
          data: message.data ?? {},
          sound: "default",
        })),
      ),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await response.json().catch(() => ({}))) as { data?: Ticket[] };
    const tickets = json.data ?? [];
    await db.insert(notificationDeliveries).values(
      targets.map((d, i) => {
        const t = tickets[i];
        return {
          deviceId: d.id,
          kind,
          ticketId: t?.id ?? null,
          status: t?.status === "ok" ? ("sent" as const) : ("error" as const),
          error:
            t?.status === "error"
              ? (t.details?.error ?? t.message ?? "error")
              : response.ok
                ? null
                : `HTTP ${response.status}`,
        };
      }),
    );
    const unregistered = targets
      .filter((_, i) => tickets[i]?.details?.error === "DeviceNotRegistered")
      .map((d) => d.id);
    if (unregistered.length)
      await db.update(devices).set({ disabledAt: new Date() }).where(inArray(devices.id, unregistered));
  } catch (err) {
    log.warn("push send failed", { err: String(err) });
  }
}

/** Checks push receipts (~15+ min after sending) and disables devices that are no longer registered. */
export async function checkPushReceipts(fetchImpl: typeof fetch = fetch) {
  const pending = await db
    .select()
    .from(notificationDeliveries)
    .where(
      and(
        eq(notificationDeliveries.status, "sent"),
        isNull(notificationDeliveries.receiptCheckedAt),
        lt(notificationDeliveries.createdAt, sql`now() - interval '15 minutes'`),
      ),
    )
    .limit(300);
  const withTicket = pending.filter((p) => p.ticketId);
  if (withTicket.length === 0) return;
  try {
    const response = await fetchImpl(PUSH_RECEIPTS, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ ids: withTicket.map((p) => p.ticketId) }),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await response.json().catch(() => ({}))) as { data?: Record<string, Ticket> };
    for (const delivery of withTicket) {
      const receipt = json.data?.[delivery.ticketId ?? ""];
      await db
        .update(notificationDeliveries)
        .set({
          receiptCheckedAt: new Date(),
          status: receipt?.status === "error" ? "error" : "ok",
          error: receipt?.status === "error" ? (receipt.details?.error ?? receipt.message ?? "error") : null,
        })
        .where(eq(notificationDeliveries.id, delivery.id));
      if (receipt?.details?.error === "DeviceNotRegistered") {
        await db.update(devices).set({ disabledAt: new Date() }).where(eq(devices.id, delivery.deviceId));
      }
    }
  } catch (err) {
    log.warn("push receipts failed", { err: String(err) });
  }
}
