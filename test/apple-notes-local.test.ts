import { describe, expect, it } from "vitest";
import {
  normalizeAppleNoteVersion,
  plainTextToNoteHtml,
} from "../server/apple/notes-local.js";

describe("Apple Notes plaintext conversion", () => {
  it("escapes HTML and preserves lines and blank lines", () => {
    expect(plainTextToNoteHtml("<Plan> & \"ship\"\n\nIt's ready")).toBe(
      "<div>&lt;Plan&gt; &amp; &quot;ship&quot;</div>" +
        "<div><br></div>" +
        "<div>It&#39;s ready</div>",
    );
  });

  it("accepts only the ASCII version token used by the stale-write guard", () => {
    expect(normalizeAppleNoteVersion("20260728092831")).toBe("20260728092831");
    expect(() =>
      normalizeAppleNoteVersion("Tuesday, July 28, 2026 at 9:28:31 PM"),
    ).toThrow("version is invalid");
  });
});
