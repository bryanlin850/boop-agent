import { describe, expect, it } from "vitest";
import { resolveCodexCommand } from "../server/runtimes/codex-app-server.js";

describe("Codex command resolution", () => {
  it("finds the Codex binary bundled with the ChatGPT macOS app", () => {
    const chatGptCodex = "/Applications/ChatGPT.app/Contents/Resources/codex";

    expect(
      resolveCodexCommand({
        configured: "",
        path: "/usr/bin:/bin",
        platform: "darwin",
        home: "/Users/test",
        executable: (candidate) => candidate === chatGptCodex,
      }),
    ).toBe(chatGptCodex);
  });

  it("prefers an explicitly configured Codex binary", () => {
    expect(
      resolveCodexCommand({
        configured: "/custom/bin/codex",
        path: "",
        executable: () => false,
      }),
    ).toBe("/custom/bin/codex");
  });
});
