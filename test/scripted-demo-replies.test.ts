import { describe, expect, it } from "vitest";
import {
  matchesLinkedInDemoPrompt,
  matchesWaterBottleDemoPrompt,
} from "../server/scripted-demo-replies.js";

describe("scripted demo replies", () => {
  it("matches the private water-bottle demo prompt with normal texting punctuation", () => {
    expect(
      matchesWaterBottleDemoPrompt("What was that water bottle brand my mom texted me about?"),
    ).toBe(true);
    expect(
      matchesWaterBottleDemoPrompt(
        "  what   was that water bottle brand my mom texted me about!!! ",
      ),
    ).toBe(true);
  });

  it("does not intercept unrelated messages", () => {
    expect(matchesWaterBottleDemoPrompt("what water bottle should I buy?")).toBe(false);
    expect(matchesWaterBottleDemoPrompt("what did my mom text me about?")).toBe(false);
  });

  it("matches natural LinkedIn browser demo prompts", () => {
    expect(matchesLinkedInDemoPrompt("Check my LinkedIn")).toBe(true);
    expect(matchesLinkedInDemoPrompt("Check my LinkedIn messages using the browser.")).toBe(true);
    expect(matchesLinkedInDemoPrompt("Can you use the browser to check my LinkedIn messages?")).toBe(
      true,
    );
  });

  it("does not intercept unrelated LinkedIn messages", () => {
    expect(matchesLinkedInDemoPrompt("Write a LinkedIn post for me")).toBe(false);
    expect(matchesLinkedInDemoPrompt("Who messaged me?")).toBe(false);
  });
});
