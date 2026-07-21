import { createHmac, timingSafeEqual } from "node:crypto";

const WEBHOOK_SECRET_CONTEXT = "boop-sendblue-webhook-v1";

export function deriveSendblueWebhookSecret(apiSecret: string): string {
  return createHmac("sha256", apiSecret).update(WEBHOOK_SECRET_CONTEXT).digest("hex");
}

export function verifySendblueWebhookSecret(
  received: string | undefined,
  apiSecret = process.env.SENDBLUE_API_SECRET,
): boolean {
  if (!received || !apiSecret) return false;

  const expected = Buffer.from(deriveSendblueWebhookSecret(apiSecret));
  const actual = Buffer.from(received);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
