import { type PushMessage, sendPush } from "./expo-push";

/** User-facing events go to the user's devices as push notifications. */
export async function notify(userId: string, event: string, message: PushMessage) {
  await sendPush(userId, event, message);
}
