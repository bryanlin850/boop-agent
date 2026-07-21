import { describe, expect, it } from "vitest";
import { extractSendblueMediaUrls } from "../server/sendblue.js";

describe("Sendblue media payloads", () => {
  it("keeps the legacy media_url when media_urls is an empty array", () => {
    expect(
      extractSendblueMediaUrls("https://cdn.example/image.png", []),
    ).toEqual(["https://cdn.example/image.png"]);
  });

  it("combines and deduplicates both supported media fields", () => {
    expect(
      extractSendblueMediaUrls("https://cdn.example/one.png", [
        "https://cdn.example/one.png",
        "https://cdn.example/two.jpg",
      ]),
    ).toEqual([
      "https://cdn.example/one.png",
      "https://cdn.example/two.jpg",
    ]);
  });
});
