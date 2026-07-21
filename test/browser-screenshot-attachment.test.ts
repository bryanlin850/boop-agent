import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  action: vi.fn(),
  query: vi.fn(),
}));

vi.mock("../server/convex-client.js", () => ({
  convex: {
    action: mocks.action,
    query: mocks.query,
  },
}));

import { saveBrowserScreenshotAttachment } from "../server/browser/tools.js";

describe("browser screenshot attachments", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    mocks.action.mockReset();
    mocks.query.mockReset();
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uploads the PNG and queues its signed URL without returning the local path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "boop-screenshot-test-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "browser-shot.png");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    writeFileSync(path, png);

    const attachmentUrl = "https://convex.example/storage/browser-shot.png";
    mocks.action.mockResolvedValue({ fileId: "ignored", storageId: "storage-id" });
    mocks.query.mockResolvedValue(attachmentUrl);
    const onAttachment = vi.fn();

    const saved = await saveBrowserScreenshotAttachment(path, {
      conversationId: "sms:test",
      onAttachment,
    });

    expect(mocks.action).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        name: "browser-shot.png",
        kind: "image",
        base64: png.toString("base64"),
        contentType: "image/png",
        conversationId: "sms:test",
      }),
    );
    expect(mocks.query).toHaveBeenCalledWith(expect.anything(), {
      fileId: saved.fileId,
    });
    expect(onAttachment).toHaveBeenCalledWith(attachmentUrl);
    expect(saved).toMatchObject({
      name: "browser-shot.png",
      url: attachmentUrl,
    });
    expect(JSON.stringify(saved)).not.toContain(directory);
  });
});
