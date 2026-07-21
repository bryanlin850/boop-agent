import { afterEach, describe, expect, it, vi } from "vitest";
import { sendImessage } from "../server/sendblue.js";

const originalApiKey = process.env.SENDBLUE_API_KEY;
const originalApiSecret = process.env.SENDBLUE_API_SECRET;
const originalFromNumber = process.env.SENDBLUE_FROM_NUMBER;

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalApiKey === undefined) {
    delete process.env.SENDBLUE_API_KEY;
  } else {
    process.env.SENDBLUE_API_KEY = originalApiKey;
  }
  if (originalApiSecret === undefined) {
    delete process.env.SENDBLUE_API_SECRET;
  } else {
    process.env.SENDBLUE_API_SECRET = originalApiSecret;
  }
  if (originalFromNumber === undefined) {
    delete process.env.SENDBLUE_FROM_NUMBER;
  } else {
    process.env.SENDBLUE_FROM_NUMBER = originalFromNumber;
  }
});

describe("sendImessage", () => {
  it("redacts phone numbers from the delivered message body", async () => {
    process.env.SENDBLUE_API_KEY = "test-key";
    process.env.SENDBLUE_API_SECRET = "test-secret";
    process.env.SENDBLUE_FROM_NUMBER = ["+", "1", "555", "000", "0100"].join("");
    const recipient = ["+", "1", "555", "000", "0101"].join("");
    const leakedPhone = ["+", "1", "555", "555", "0102"].join("");
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendImessage(recipient, `Call ${leakedPhone}`);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      number: recipient,
      content: "Call [phone number hidden]",
    });
  });
});
