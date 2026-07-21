import { describe, expect, it, vi } from "vitest";
import { syncWebhooks } from "../scripts/sendblue-webhook.mjs";

describe("Sendblue webhook synchronization", () => {
  it("keeps duplicate active hooks while removing stale tunnel URLs", async () => {
    const active = "https://active.ngrok-free.app/sendblue/webhook";
    const stale = "https://stale.ngrok-free.app/sendblue/webhook";
    const removeWebhook = vi.fn(async () => undefined);
    const addWebhook = vi.fn(async () => undefined);

    await syncWebhooks(
      active,
      [
        { type: "receive", url: active },
        { type: "receive", url: active },
        { type: "receive", url: stale },
      ],
      removeWebhook,
      addWebhook,
    );

    expect(removeWebhook).toHaveBeenCalledOnce();
    expect(removeWebhook).toHaveBeenCalledWith(stale);
    expect(addWebhook).not.toHaveBeenCalled();
  });

  it("registers the active hook when it is missing", async () => {
    const active = "https://active.ngrok-free.app/sendblue/webhook";
    const addWebhook = vi.fn(async () => undefined);

    await syncWebhooks(active, [], vi.fn(async () => undefined), addWebhook);

    expect(addWebhook).toHaveBeenCalledOnce();
    expect(addWebhook).toHaveBeenCalledWith(active);
  });
});
