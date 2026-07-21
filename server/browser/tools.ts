import { z } from "zod";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import { createClaudeMcpServer } from "../runtimes/claude.js";
import { defineRuntimeTool } from "../runtimes/tool.js";
import { runtimeText, type RuntimeTool } from "../runtimes/types.js";
import { getBrowserSettings } from "../runtime-config.js";
import {
  browserClick,
  browserFill,
  browserPress,
  browserScreenshot,
  browserSnapshot,
  browserText,
  browserUrl,
  launchLocalBrowser,
  openBrowserUrl,
} from "./launcher.js";

const MCP_NAMESPACE = "browser";
const RUNTIME_NAMESPACE = "local_browser";

const FALLBACK_NOTE =
  "Use this local browser only when a native integration does not cover the task, or when the site needs a real logged-in browser, visual interaction, or a bot-wall-resistant flow.";

export interface BrowserToolOptions {
  conversationId?: string;
  onAttachment?: (url: string) => void;
}

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function saveBrowserScreenshotAttachment(
  path: string,
  options: BrowserToolOptions = {},
): Promise<{ fileId: string; name: string; url: string }> {
  const bytes = await readFile(path);
  const fileId = randomId("file");
  const name = basename(path);
  await convex.action(api.files.saveBlob, {
    fileId,
    name,
    kind: "image",
    base64: bytes.toString("base64"),
    contentType: "image/png",
    description: "Screenshot captured with Boop's local browser",
    tags: ["browser", "screenshot"],
    source: "browser",
    conversationId: options.conversationId,
  });
  const url = await convex.query(api.files.getStorageUrl, { fileId });
  if (!url) throw new Error("Screenshot was saved, but no attachment URL was generated.");
  options.onAttachment?.(url);
  return { fileId, name, url };
}

function ok(text: string) {
  return runtimeText(text);
}

function toolError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return runtimeText(`[browser error] ${message}`, false);
}

async function wrap(fn: () => Promise<string>) {
  try {
    return ok(await fn());
  } catch (err) {
    return toolError(err);
  }
}

export function createBrowserTools(
  options: BrowserToolOptions = {},
  namespace = RUNTIME_NAMESPACE,
): RuntimeTool[] {
  return [
    defineRuntimeTool(
      namespace,
      "browser_open",
      `Launch or reuse the user's local Patchright Chrome/Chromium profile and navigate to a URL. ${FALLBACK_NOTE}`,
      {
        url: z.string().describe("URL to open. Include the scheme when possible."),
      },
      async ({ url }) => wrap(async () => `Opened ${await openBrowserUrl(url)}.`),
    ),
    defineRuntimeTool(
      namespace,
      "browser_snapshot",
      "Return an AI-oriented accessibility snapshot of the current browser page, including element refs like [ref=e2]. Call this before click/fill when possible.",
      {},
      async () => wrap(browserSnapshot),
    ),
    defineRuntimeTool(
      namespace,
      "browser_click",
      "Click an element. Pass an aria snapshot ref like e2, @e2, [ref=e2], or a CSS/text selector.",
      {
        selector: z.string(),
      },
      async ({ selector }) => wrap(async () => browserClick(selector)),
    ),
    defineRuntimeTool(
      namespace,
      "browser_fill",
      "Fill an input. Pass an aria snapshot ref like e2, @e2, [ref=e2], or a CSS/text selector.",
      {
        selector: z.string(),
        text: z.string(),
      },
      async ({ selector, text }) => wrap(async () => browserFill(selector, text)),
    ),
    defineRuntimeTool(
      namespace,
      "browser_press",
      "Press a key in the focused browser page, e.g. Enter, Tab, Escape, or Control+a.",
      {
        key: z.string(),
      },
      async ({ key }) => wrap(async () => browserPress(key)),
    ),
    defineRuntimeTool(
      namespace,
      "browser_get_text",
      "Read visible text from an element. Pass an aria snapshot ref like e2, @e2, [ref=e2], or a CSS/text selector.",
      {
        selector: z.string(),
      },
      async ({ selector }) => wrap(async () => browserText(selector)),
    ),
    defineRuntimeTool(
      namespace,
      "browser_get_url",
      "Return the current browser page URL.",
      {},
      async () => wrap(browserUrl),
    ),
    defineRuntimeTool(
      namespace,
      "browser_screenshot",
      "Capture the current browser page, save the PNG to the user's files store, and queue it as a real image attachment when the request came from iMessage. Do not expose a local file path in the final answer.",
      {},
      async () =>
        wrap(async () => {
          const path = await browserScreenshot();
          const saved = await saveBrowserScreenshotAttachment(path, options);
          return options.onAttachment
            ? `Screenshot captured and queued as an image attachment (${saved.fileId}). Tell the user it is attached; do not include a path or URL.`
            : JSON.stringify(saved);
        }),
    ),
    defineRuntimeTool(
      namespace,
      "browser_request_login",
      `Open a visible local browser instance so the user can log in by hand. Use this for login services, MFA, bot-wall-sensitive sites, or anything likely to detect automation. The setting "Spawn an instance to log in" must be enabled.`,
      {
        url: z
          .string()
          .optional()
          .describe("Optional login URL to open before asking the user to authenticate."),
      },
      async ({ url }) => {
        try {
          const settings = await getBrowserSettings();
          if (!settings.loginHandoffEnabled) {
            return runtimeText(
              "Login handoff is disabled in Settings. Ask the user to turn on \"Spawn an instance to log in\" before trying the handoff.",
              false,
            );
          }
          const result = await launchLocalBrowser({ url, forceVisible: true });
          return runtimeText(
            [
              "I need you to log in first. I’ve spawned an instance on your machine.",
              `Opened: ${result.url}`,
              "Ask the user to reply when they are done logging in, then continue from the same browser profile.",
            ].join("\n"),
          );
        } catch (err) {
          return toolError(err);
        }
      },
    ),
  ];
}

export function createBrowserMcp(options: BrowserToolOptions = {}) {
  return createClaudeMcpServer(MCP_NAMESPACE, createBrowserTools(options, MCP_NAMESPACE));
}
