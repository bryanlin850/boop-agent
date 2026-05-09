import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { chromium, type BrowserContext, type Page } from "patchright";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { z } from "zod";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { embed } from "./embeddings.js";
import {
  evaluateHost,
  isPatchrightEnabled as isEnabled,
  loadPatchrightConfig,
  PERSISTENT_PROFILE_BASE_DIR,
  wipePersistentProfileDirs,
  type PatchrightConfig,
} from "./patchright-config.js";

interface SessionRecord {
  sessionId: string;
  agentId?: string;
  context: BrowserContext;
  activePage: Page;
  profileDir: string;
  ephemeral: boolean;
  createdAt: number;
  lastActivityAt: number;
  idleTimer?: NodeJS.Timeout;
  hardTimer?: NodeJS.Timeout;
  refSelectors: Map<string, string>;
  config: PatchrightConfig;
}

const activeSessions = new Map<string, SessionRecord>();

// Re-exported as async (replaces the sync env check).
export async function patchrightBrowserAvailable(): Promise<boolean> {
  return isEnabled();
}

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function profileDirFor(sessionId: string, persistent: boolean): { dir: string; ephemeral: boolean } {
  if (persistent) return { dir: path.join(PERSISTENT_PROFILE_BASE_DIR, sessionId), ephemeral: false };
  return { dir: path.join(os.tmpdir(), `patchright-${sessionId}`), ephemeral: true };
}

function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) throw new Error("URL is required");
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function okText(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function jsonText(value: unknown) {
  return okText(JSON.stringify(value, null, 2));
}

function clampText(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} chars]` : text;
}

function clearTimers(record: SessionRecord) {
  if (record.idleTimer) {
    clearTimeout(record.idleTimer);
    record.idleTimer = undefined;
  }
  if (record.hardTimer) {
    clearTimeout(record.hardTimer);
    record.hardTimer = undefined;
  }
}

function armIdleTimer(record: SessionRecord) {
  if (record.idleTimer) clearTimeout(record.idleTimer);
  if (record.config.idleTimeoutMs <= 0) return;
  record.idleTimer = setTimeout(() => {
    console.log(
      `[patchright] reaper closing idle session=${record.sessionId} agent=${record.agentId ?? "?"} idle=${record.config.idleTimeoutMs}ms`,
    );
    closeSession(record.sessionId).catch((err) =>
      console.warn(`[patchright] idle reaper close failed for ${record.sessionId}`, err),
    );
  }, record.config.idleTimeoutMs);
  record.idleTimer.unref();
}

function armHardTimer(record: SessionRecord) {
  if (record.hardTimer) clearTimeout(record.hardTimer);
  if (record.config.maxSessionMs <= 0) return;
  record.hardTimer = setTimeout(() => {
    console.log(
      `[patchright] reaper closing aged session=${record.sessionId} agent=${record.agentId ?? "?"} maxAge=${record.config.maxSessionMs}ms`,
    );
    closeSession(record.sessionId).catch((err) =>
      console.warn(`[patchright] hard reaper close failed for ${record.sessionId}`, err),
    );
  }, record.config.maxSessionMs);
  record.hardTimer.unref();
}

function touchActivity(record: SessionRecord) {
  record.lastActivityAt = Date.now();
  armIdleTimer(record);
}

async function closeSession(sessionId: string): Promise<boolean> {
  const record = activeSessions.get(sessionId);
  if (!record) return false;
  activeSessions.delete(sessionId);
  clearTimers(record);
  try {
    await record.context.close();
  } catch (err) {
    console.warn(`[patchright] context.close failed for ${sessionId}`, err);
  }
  if (record.ephemeral) {
    await fs.rm(record.profileDir, { recursive: true, force: true }).catch((err) =>
      console.warn(`[patchright] ephemeral cleanup failed for ${record.profileDir}`, err),
    );
  }
  return true;
}

export async function closeAllActiveSessions(): Promise<string[]> {
  const ids = [...activeSessions.keys()];
  await Promise.all(ids.map((id) => closeSession(id)));
  return ids;
}

export function listActiveSessions(): Array<{
  sessionId: string;
  agentId?: string;
  url: string;
  profileDir: string;
  ephemeral: boolean;
  createdAt: number;
  lastActivityAt: number;
  ageMs: number;
  idleMs: number;
}> {
  const now = Date.now();
  return [...activeSessions.values()].map((r) => ({
    sessionId: r.sessionId,
    agentId: r.agentId,
    url: r.activePage.isClosed() ? "" : r.activePage.url(),
    profileDir: r.profileDir,
    ephemeral: r.ephemeral,
    createdAt: r.createdAt,
    lastActivityAt: r.lastActivityAt,
    ageMs: now - r.createdAt,
    idleMs: now - r.lastActivityAt,
  }));
}

export async function resetAllProfiles(): Promise<{ closedSessions: string[]; dirsRemoved: string[] }> {
  const closedSessions = await closeAllActiveSessions();
  const dirsRemoved = await wipePersistentProfileDirs();
  console.log(
    `[patchright] reset complete — closed ${closedSessions.length} session(s), removed ${dirsRemoved.length} profile dir(s)`,
  );
  return { closedSessions, dirsRemoved };
}

async function launchSession(sessionId: string, agentId: string | undefined, config: PatchrightConfig): Promise<SessionRecord> {
  const { dir: profileDir, ephemeral } = profileDirFor(sessionId, config.persistentProfile);
  console.log(
    `[patchright] launching session=${sessionId} agent=${agentId ?? "?"} headless=${config.headless} channel=${config.channel} persistent=${config.persistentProfile} actionTimeoutMs=${config.actionTimeoutMs} maxElements=${config.maxElements} blockResources=${config.blockResources.join(",") || "none"} allowlist=${config.domainAllowlist.length} blocklist=${config.domainBlocklist.length} idleMs=${config.idleTimeoutMs} hardMs=${config.maxSessionMs}`,
  );
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: config.channel,
    headless: config.headless,
    viewport: null,
  });

  // tsx/esbuild injects helpers like `__name` (used to set function names on
  // arrow expressions) into transformed source. When we serialize a callback
  // into the browser via page.evaluate, the helper definition is left behind
  // on the Node side, so the callback throws "__name is not defined" the moment
  // it tries to assign a name. Define no-op stubs in every page's main world
  // BEFORE any evaluate runs so our snapshot/extract calls don't blow up.
  // Passed as a string (not a function) so tsx can't transform it and
  // re-introduce the same problem inside the stub itself.
  // See: https://github.com/microsoft/playwright/issues/30580
  await context.addInitScript({
    content: `
      if (typeof globalThis.__name !== 'function') {
        globalThis.__name = function (fn) { return fn; };
      }
      if (typeof globalThis.__publicField !== 'function') {
        globalThis.__publicField = function (obj, key, value) { obj[key] = value; return value; };
      }
    `,
  });

  if (config.blockResources.length > 0) {
    const blocked = new Set<string>(config.blockResources);
    await context.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (blocked.has(type)) {
        route.abort().catch(() => {});
      } else {
        route.continue().catch(() => {});
      }
    });
  }

  const activePage = context.pages()[0] ?? (await context.newPage());
  activePage.setDefaultTimeout(config.actionTimeoutMs);

  const record: SessionRecord = {
    sessionId,
    agentId,
    context,
    activePage,
    profileDir,
    ephemeral,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    refSelectors: new Map(),
    config,
  };
  activeSessions.set(sessionId, record);
  armIdleTimer(record);
  armHardTimer(record);
  return record;
}

async function ensureSession(sessionId: string, agentId: string | undefined): Promise<SessionRecord> {
  const existing = activeSessions.get(sessionId);
  if (existing && !existing.activePage.isClosed()) {
    return existing;
  }
  if (existing) {
    // Stale entry (page closed underneath us) — clean up before relaunching.
    await closeSession(sessionId);
  }
  const config = await loadPatchrightConfig();
  return launchSession(sessionId, agentId, config);
}

async function getActivePage(record: SessionRecord): Promise<Page> {
  if (record.activePage.isClosed()) {
    record.activePage =
      record.context.pages().find((page) => !page.isClosed()) ?? (await record.context.newPage());
    record.activePage.setDefaultTimeout(record.config.actionTimeoutMs);
  }
  return record.activePage;
}

async function snapshotPage(
  record: SessionRecord,
  page: Page,
  maxElements: number,
): Promise<{
  url: string;
  title: string;
  elements: Array<Record<string, unknown>>;
}> {
  const title = await page.title().catch(() => "");
  const elements = await page.evaluate((limit) => {
    // IMPORTANT: every helper here MUST be a `function` declaration (not
    // `const f = () => …`). tsx/esbuild adds `__name(fn, "name")` to
    // arrow functions assigned to consts, and Playwright's evaluate runs
    // the serialized callback inside its UtilityScript isolated world
    // where addInitScript helpers are NOT visible — so the eval'd code
    // throws "ReferenceError: __name is not defined" the moment it
    // touches one. Function declarations don't need the helper because
    // they already carry their name natively.
    const selectors = [
      "a[href]",
      "button",
      "input",
      "textarea",
      "select",
      "summary",
      "[role='button']",
      "[role='link']",
      "[role='menuitem']",
      "[contenteditable='true']",
      "[onclick]",
    ].join(",");

    function cssEscape(value: string): string {
      const css = globalThis.CSS as typeof CSS | undefined;
      return css?.escape ? css.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
    }

    function visible(el: Element): boolean {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity || "1") > 0;
    }

    function selectorFor(el: Element): string {
      const parts: string[] = [];
      let current: Element | null = el;
      while (current && current.nodeType === Node.ELEMENT_NODE) {
        const tag = current.tagName.toLowerCase();
        if (current.id) {
          parts.unshift(`${tag}#${cssEscape(current.id)}`);
          break;
        }
        const parent: Element | null = current.parentElement;
        if (!parent) {
          parts.unshift(tag);
          break;
        }
        const currentTag = current.tagName;
        const siblings = Array.from(parent.children).filter(function (child: Element) {
          return child.tagName === currentTag;
        });
        const nth = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : "";
        parts.unshift(`${tag}${nth}`);
        current = parent;
      }
      return parts.join(" > ");
    }

    function labelFor(el: Element): string | null {
      const input = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      const placeholder =
        el instanceof HTMLInputElement
          ? el.placeholder
          : el instanceof HTMLTextAreaElement
            ? el.placeholder
            : "";
      const direct =
        el.getAttribute("aria-label") ||
        el.getAttribute("title") ||
        el.getAttribute("alt") ||
        placeholder ||
        input.value ||
        (el.textContent ?? "");
      return direct.replace(/\s+/g, " ").trim().slice(0, 160) || null;
    }

    const candidates = Array.from(document.querySelectorAll(selectors)).filter(visible).slice(0, limit);
    return candidates.map(function (el, index) {
      const htmlEl = el as HTMLElement;
      const input = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      const placeholder =
        el instanceof HTMLInputElement
          ? el.placeholder || null
          : el instanceof HTMLTextAreaElement
            ? el.placeholder || null
            : null;
      const rect = el.getBoundingClientRect();
      return {
        ref: `e${index + 1}`,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role"),
        name: labelFor(el),
        text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 240) || null,
        href: el instanceof HTMLAnchorElement ? el.href : null,
        placeholder,
        value: "value" in input ? String(input.value || "").slice(0, 240) || null : null,
        type: el instanceof HTMLInputElement ? el.type : null,
        disabled: Boolean((input as HTMLInputElement).disabled || htmlEl.getAttribute("aria-disabled") === "true"),
        selector: selectorFor(el),
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      };
    });
  }, maxElements);

  record.refSelectors.clear();
  for (const element of elements) {
    if (element && typeof element === "object" && "ref" in element && "selector" in element) {
      record.refSelectors.set(String(element.ref), String(element.selector));
    }
  }

  return {
    url: page.url(),
    title,
    elements: elements as Array<Record<string, unknown>>,
  };
}

function selectorForRef(record: SessionRecord, ref: string): string {
  const selector = record.refSelectors.get(ref);
  if (!selector) {
    throw new Error(`Unknown browser ref "${ref}". Call browser_get_state first and use one of the returned refs.`);
  }
  return selector;
}

function hostnameFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

interface CreateOpts {
  agentId?: string;
  conversationId?: string;
}

export function createPatchrightBrowserMcp(opts: CreateOpts = {}) {
  const sessionId = randomId("browser");
  const agentId = opts.agentId;
  const conversationId = opts.conversationId;

  async function withSession<T>(fn: (record: SessionRecord) => Promise<T>): Promise<T> {
    const record = await ensureSession(sessionId, agentId);
    try {
      return await fn(record);
    } finally {
      const current = activeSessions.get(sessionId);
      if (current) touchActivity(current);
    }
  }

  return createSdkMcpServer({
    name: "patchright-browser",
    version: "0.2.0",
    tools: [
      tool(
        "browser_navigate",
        "Open the local Patchright browser if needed and navigate the active tab to a URL.",
        { url: z.string().describe("URL to navigate to. https:// is added when no scheme is provided.") },
        async ({ url }) =>
          withSession(async (record) => {
            const target = normalizeUrl(url);
            const host = hostnameFromUrl(target);
            const decision = evaluateHost(host, record.config);
            if (!decision.allowed) {
              console.log(`[patchright] blocked navigate session=${record.sessionId} url=${target} reason=${decision.reason}`);
              return jsonText({ blocked: true, reason: decision.reason, url: target });
            }
            const page = await getActivePage(record);
            await page.goto(target, { waitUntil: "domcontentloaded" });
            return jsonText(await snapshotPage(record, page, record.config.maxElements));
          }),
      ),

      tool(
        "browser_get_state",
        "Return the active tab URL, title, and interactive page elements with refs for browser_click/browser_type.",
        {
          maxElements: z.number().int().min(1).max(200).optional(),
        },
        async ({ maxElements }) =>
          withSession(async (record) => {
            const page = await getActivePage(record);
            const limit = maxElements ?? record.config.maxElements;
            return jsonText(await snapshotPage(record, page, limit));
          }),
      ),

      tool(
        "browser_click",
        "Click an element by ref from browser_get_state.",
        { ref: z.string().describe("Element ref from browser_get_state, e.g. e3.") },
        async ({ ref }) =>
          withSession(async (record) => {
            const page = await getActivePage(record);
            await page.locator(selectorForRef(record, ref)).first().click();
            await page.waitForLoadState("domcontentloaded").catch(() => {});
            return jsonText(await snapshotPage(record, page, record.config.maxElements));
          }),
      ),

      tool(
        "browser_type",
        "Fill or type text into an element ref, or type into the currently focused element when no ref is provided.",
        {
          text: z.string(),
          ref: z.string().optional().describe("Optional element ref from browser_get_state."),
          submit: z.boolean().optional().default(false).describe("Press Enter after typing/filling."),
          append: z.boolean().optional().default(false).describe("Append keystrokes instead of replacing field content."),
        },
        async ({ text, ref, submit, append }) =>
          withSession(async (record) => {
            const page = await getActivePage(record);
            if (ref) {
              const locator = page.locator(selectorForRef(record, ref)).first();
              if (append) {
                await locator.click();
                await page.keyboard.type(text);
              } else {
                await locator.fill(text);
              }
            } else {
              await page.keyboard.type(text);
            }
            if (submit) await page.keyboard.press("Enter");
            await page.waitForLoadState("domcontentloaded").catch(() => {});
            return jsonText(await snapshotPage(record, page, record.config.maxElements));
          }),
      ),

      tool(
        "browser_extract_content",
        "Extract readable text from the current page or from a specific element ref.",
        {
          ref: z.string().optional().describe("Optional element ref from browser_get_state."),
          maxChars: z.number().int().min(500).max(100_000).optional(),
        },
        async ({ ref, maxChars }) =>
          withSession(async (record) => {
            const page = await getActivePage(record);
            const text = ref
              ? await page.locator(selectorForRef(record, ref)).first().innerText()
              : await page.locator("body").innerText();
            const limit = maxChars ?? record.config.maxTextChars;
            return okText(clampText(text, limit));
          }),
      ),

      tool(
        "browser_scroll",
        "Scroll the page or scroll an element ref into view.",
        {
          ref: z.string().optional().describe("Optional element ref from browser_get_state to scroll into view."),
          deltaY: z.number().optional().default(800).describe("Vertical wheel delta. Positive scrolls down."),
          deltaX: z.number().optional().default(0).describe("Horizontal wheel delta."),
        },
        async ({ ref, deltaY, deltaX }) =>
          withSession(async (record) => {
            const page = await getActivePage(record);
            if (ref) await page.locator(selectorForRef(record, ref)).first().scrollIntoViewIfNeeded();
            await page.mouse.wheel(deltaX, deltaY);
            return jsonText(await snapshotPage(record, page, record.config.maxElements));
          }),
      ),

      tool(
        "browser_go_back",
        "Go back in the active tab history.",
        {},
        async () =>
          withSession(async (record) => {
            const page = await getActivePage(record);
            await page.goBack({ waitUntil: "domcontentloaded" });
            return jsonText(await snapshotPage(record, page, record.config.maxElements));
          }),
      ),

      tool(
        "browser_list_tabs",
        "List tabs in the current Patchright browser session.",
        {},
        async () => {
          const record = activeSessions.get(sessionId);
          if (!record) return jsonText({ tabs: [] });
          const tabs = await Promise.all(
            record.context.pages().map(async (page, index) => ({
              index,
              active: page === record.activePage,
              url: page.url(),
              title: await page.title().catch(() => ""),
            })),
          );
          touchActivity(record);
          return jsonText({ tabs });
        },
      ),

      tool(
        "browser_switch_tab",
        "Switch the active tab by index from browser_list_tabs.",
        { index: z.number().int().min(0) },
        async ({ index }) =>
          withSession(async (record) => {
            const page = record.context.pages()[index];
            if (!page) throw new Error(`No browser tab at index ${index}`);
            record.activePage = page;
            await page.bringToFront();
            return jsonText(await snapshotPage(record, page, record.config.maxElements));
          }),
      ),

      tool(
        "browser_screenshot",
        `Capture a screenshot of the active tab and save it to the user's files store. Returns { fileId, url, name } — paste the url into your reply on its own line so iMessage previews the image inline. Use this when the user asks to "see" something visually, when a page result needs visual confirmation, or when text extraction wouldn't capture what they want (charts, screenshots of UIs, etc.).`,
        {
          name: z
            .string()
            .optional()
            .describe("Short title for the screenshot. Defaults to '<page-title> screenshot'."),
          fullPage: z
            .boolean()
            .optional()
            .default(false)
            .describe("Capture the entire scrollable page instead of just the viewport."),
          ref: z
            .string()
            .optional()
            .describe("Optional element ref from browser_get_state to screenshot just that element."),
        },
        async ({ name, fullPage, ref }) =>
          withSession(async (record) => {
            const page = await getActivePage(record);
            const buffer = ref
              ? await page.locator(selectorForRef(record, ref)).first().screenshot({ type: "png" })
              : await page.screenshot({ type: "png", fullPage });
            const base64 = Buffer.from(buffer).toString("base64");
            const pageTitle = await page.title().catch(() => "");
            const pageUrl = page.url();
            const finalName =
              name ?? (pageTitle ? `${pageTitle} screenshot` : "browser screenshot");
            const fileId = randomId("file");
            await convex.action(api.files.saveBlob, {
              fileId,
              name: finalName,
              kind: "image",
              base64,
              contentType: "image/png",
              description: `Screenshot of ${pageUrl}${pageTitle ? ` — ${pageTitle}` : ""}`,
              source: "browser",
              conversationId,
            });
            const embedText = `${finalName}\nScreenshot of ${pageUrl}${pageTitle ? ` — ${pageTitle}` : ""}`;
            const vec = await embed(embedText);
            if (vec) {
              await convex.mutation(api.files.setEmbedding, { fileId, embedding: vec });
            }
            const url = await convex.query(api.files.getStorageUrl, { fileId });
            return jsonText({ fileId, name: finalName, url, pageUrl, pageTitle });
          }),
      ),

      tool(
        "browser_close_all",
        "Close all Patchright browser tabs and the underlying browser context for this agent.",
        {},
        async () => {
          const closed = await closeSession(sessionId);
          return okText(closed ? "Patchright browser session closed." : "No active Patchright session to close.");
        },
      ),
    ],
  });
}
