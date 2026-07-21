import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveWebhookSecret,
  parseEnvText,
  parseApiWebhookListing,
  readEnvFiles,
  resynchronizeWebhookSecret,
  webhookCheck,
} from "../scripts/sendblue-webhook.mjs";
import {
  deriveSendblueWebhookSecret,
  verifySendblueWebhookSecret,
} from "../server/sendblue-webhook-auth.js";

describe("Sendblue webhook authentication", () => {
  it("parses quoted values without treating inline hashes as comments", () => {
    expect(
      parseEnvText(`
        SENDBLUE_API_KEY="quoted-key"
        SENDBLUE_API_SECRET='secret#inside' # trailing comment
        PUBLIC_URL=https://example.test # trailing comment
      `),
    ).toEqual({
      SENDBLUE_API_KEY: "quoted-key",
      SENDBLUE_API_SECRET: "secret#inside",
      PUBLIC_URL: "https://example.test",
    });
  });

  it("loads .env before .env.local and lets explicit process values win", () => {
    const root = mkdtempSync(join(tmpdir(), "boop-sendblue-env-"));
    try {
      const fallback = join(root, ".env");
      const local = join(root, ".env.local");
      writeFileSync(fallback, "SENDBLUE_API_KEY=fallback\nPUBLIC_URL=https://fallback.test\n");
      writeFileSync(local, "SENDBLUE_API_KEY=local\nSENDBLUE_API_SECRET=local-secret\n");

      expect(
        readEnvFiles([fallback, local], { SENDBLUE_API_SECRET: "process-secret" }),
      ).toMatchObject({
        SENDBLUE_API_KEY: "local",
        SENDBLUE_API_SECRET: "process-secret",
        PUBLIC_URL: "https://fallback.test",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("derives the same scoped secret in registration and request handling", () => {
    const apiSecret = "test-api-secret-not-real";
    expect(deriveWebhookSecret(apiSecret)).toBe(deriveSendblueWebhookSecret(apiSecret));
  });

  it("accepts only the expected signing header", () => {
    const apiSecret = "test-api-secret-not-real";
    const signingSecret = deriveSendblueWebhookSecret(apiSecret);

    expect(verifySendblueWebhookSecret(signingSecret, apiSecret)).toBe(true);
    expect(verifySendblueWebhookSecret("wrong", apiSecret)).toBe(false);
    expect(verifySendblueWebhookSecret(undefined, apiSecret)).toBe(false);
    expect(verifySendblueWebhookSecret(signingSecret, "")).toBe(false);
  });

  it("parses URL and object webhook entries without treating the global secret as a URL", () => {
    expect(
      parseApiWebhookListing({
        receive: [
          "https://first.example/sendblue/webhook",
          { url: "https://second.example/sendblue/webhook", secret: "hidden" },
        ],
        globalSecret: "hidden",
      }),
    ).toEqual({
      current: [
        { type: "receive", url: "https://first.example/sendblue/webhook" },
        { type: "receive", url: "https://second.example/sendblue/webhook" },
      ],
      globalSecret: "hidden",
    });
  });

  it("does not report a registered webhook as healthy until signing is synchronized", () => {
    const url = "https://active.example/sendblue/webhook";
    const result = webhookCheck(url, [{ type: "receive", url }], "api", false);

    expect(result.ok).toBe(false);
    expect(result.state).toBe("mismatch");
    expect(result.details).toContain("signing secret is not synchronized");
  });

  it("replaces a registered webhook before re-adding it with a new signing secret", async () => {
    const url = "https://active.example/sendblue/webhook";
    const operations: string[] = [];

    const changed = await resynchronizeWebhookSecret(
      url,
      { current: [{ type: "receive", url }], globalSecret: "old-secret" },
      "new-secret",
      async (hookUrl: string) => {
        operations.push(`remove:${hookUrl}`);
      },
      async (hookUrl: string) => {
        operations.push(`add:${hookUrl}`);
      },
    );

    expect(changed).toBe(true);
    expect(operations).toEqual([`remove:${url}`, `add:${url}`]);
  });

  it("leaves a registered webhook untouched when its signing secret already matches", async () => {
    const url = "https://active.example/sendblue/webhook";
    const operations: string[] = [];

    const changed = await resynchronizeWebhookSecret(
      url,
      { current: [{ type: "receive", url }], globalSecret: "current-secret" },
      "current-secret",
      async () => {
        operations.push("remove");
      },
      async () => {
        operations.push("add");
      },
    );

    expect(changed).toBe(false);
    expect(operations).toEqual([]);
  });
});
