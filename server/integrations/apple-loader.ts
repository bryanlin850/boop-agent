import { createAppleMcp, createAppleTools } from "../apple/tools.js";
import { getAppleSettings } from "../runtime-config.js";
import { registerIntegration } from "./registry.js";

export function registerAppleIntegration(): void {
  registerIntegration({
    name: "apple",
    description:
      "Local Apple data from the user's Mac: read-only iMessage and Reminders, Apple Notes with optional guarded writes, plus Apple Calendar events via the optional Apple bridge.",
    isEnabled: async () => (await getAppleSettings()).enabled,
    createServer: async (ctx) => createAppleMcp({ approvedDraft: ctx.approvedDraft }),
    createTools: async (ctx) => createAppleTools("apple", { approvedDraft: ctx.approvedDraft }),
  });
  console.log("[apple] registered Apple data integration");
}
