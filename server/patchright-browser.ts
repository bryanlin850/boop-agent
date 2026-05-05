import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { chromium, type BrowserContext, type Page } from "patchright";
import path from "node:path";
import { z } from "zod";

const ENABLED_ENV = "PATCHRIGHT_BROWSER_ENABLED";
const CHANNEL_ENV = "PATCHRIGHT_CHANNEL";
const PROFILE_DIR_ENV = "PATCHRIGHT_PROFILE_DIR";
const DEFAULT_CHANNEL = "chrome";
const DEFAULT_BASE_PROFILE_DIR = "data/patchright-browser";
const MAX_TEXT_CHARS = 20_000;

interface BrowserSession {
  context: BrowserContext;
  activePage: Page;
}

interface SnapshotElement {
  ref: string;
  tag: string;
  role?: string | null;
  name?: string | null;
  text?: string | null;
  href?: string | null;
  placeholder?: string | null;
  value?: string | null;
  type?: string | null;
  disabled: boolean;
  selector: string;
  rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

function isEnabled(): boolean {
  const v = process.env[ENABLED_ENV];
  if (!v) return false;
  const norm = v.trim().toLowerCase();
  return norm === "1" || norm === "true" || norm === "yes" || norm === "on";
}

export function patchrightBrowserAvailable(): boolean {
  return isEnabled();
}

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function profileDirForSession(sessionId: string): string {
  const explicit = process.env[PROFILE_DIR_ENV]?.trim();
  if (explicit) return path.resolve(explicit);
  return path.resolve(process.cwd(), DEFAULT_BASE_PROFILE_DIR, sessionId);
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

function clampText(text: string, maxChars = MAX_TEXT_CHARS): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} chars]` : text;
}

export function createPatchrightBrowserMcp() {
  const sessionId = randomId("browser");
  const refSelectors = new Map<string, string>();
  let session: BrowserSession | undefined;

  async function ensureSession(): Promise<BrowserSession> {
    if (session && !session.activePage.isClosed()) return session;

    const context = await chromium.launchPersistentContext(profileDirForSession(sessionId), {
      channel: process.env[CHANNEL_ENV]?.trim() || DEFAULT_CHANNEL,
      headless: false,
      viewport: null,
    });
    const activePage = context.pages()[0] ?? (await context.newPage());
    activePage.setDefaultTimeout(15_000);
    session = { context, activePage };
    return session;
  }

  async function getActivePage(): Promise<Page> {
    const current = await ensureSession();
    if (current.activePage.isClosed()) {
      current.activePage = current.context.pages().find((page) => !page.isClosed()) ?? (await current.context.newPage());
      current.activePage.setDefaultTimeout(15_000);
    }
    return current.activePage;
  }

  async function snapshotPage(page: Page, maxElements: number): Promise<{
    url: string;
    title: string;
    elements: SnapshotElement[];
  }> {
    const title = await page.title().catch(() => "");
    const elements = await page.evaluate((limit) => {
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

      const cssEscape = (value: string) => {
        const css = globalThis.CSS as typeof CSS | undefined;
        return css?.escape ? css.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
      };

      const visible = (el: Element) => {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = window.getComputedStyle(el);
        return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity || "1") > 0;
      };

      const selectorFor = (el: Element) => {
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
          const siblings = Array.from(parent.children).filter((child: Element) => child.tagName === currentTag);
          const nth = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : "";
          parts.unshift(`${tag}${nth}`);
          current = parent;
        }
        return parts.join(" > ");
      };

      const labelFor = (el: Element) => {
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
      };

      const candidates = Array.from(document.querySelectorAll(selectors)).filter(visible).slice(0, limit);
      return candidates.map((el, index) => {
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

    refSelectors.clear();
    for (const element of elements) refSelectors.set(element.ref, element.selector);

    return {
      url: page.url(),
      title,
      elements,
    };
  }

  function selectorForRef(ref: string): string {
    const selector = refSelectors.get(ref);
    if (!selector) {
      throw new Error(`Unknown browser ref "${ref}". Call browser_get_state first and use one of the returned refs.`);
    }
    return selector;
  }

  return createSdkMcpServer({
    name: "patchright-browser",
    version: "0.1.0",
    tools: [
      tool(
        "browser_navigate",
        "Open the local Patchright browser if needed and navigate the active tab to a URL.",
        { url: z.string().describe("URL to navigate to. https:// is added when no scheme is provided.") },
        async ({ url }) => {
          const page = await getActivePage();
          await page.goto(normalizeUrl(url), { waitUntil: "domcontentloaded" });
          return jsonText(await snapshotPage(page, 80));
        },
      ),

      tool(
        "browser_get_state",
        "Return the active tab URL, title, and interactive page elements with refs for browser_click/browser_type.",
        {
          maxElements: z.number().int().min(1).max(200).optional().default(80),
        },
        async ({ maxElements }) => {
          const page = await getActivePage();
          return jsonText(await snapshotPage(page, maxElements));
        },
      ),

      tool(
        "browser_click",
        "Click an element by ref from browser_get_state.",
        { ref: z.string().describe("Element ref from browser_get_state, e.g. e3.") },
        async ({ ref }) => {
          const page = await getActivePage();
          await page.locator(selectorForRef(ref)).first().click();
          await page.waitForLoadState("domcontentloaded").catch(() => {});
          return jsonText(await snapshotPage(page, 80));
        },
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
        async ({ text, ref, submit, append }) => {
          const page = await getActivePage();
          if (ref) {
            const locator = page.locator(selectorForRef(ref)).first();
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
          return jsonText(await snapshotPage(page, 80));
        },
      ),

      tool(
        "browser_extract_content",
        "Extract readable text from the current page or from a specific element ref.",
        {
          ref: z.string().optional().describe("Optional element ref from browser_get_state."),
          maxChars: z.number().int().min(500).max(100_000).optional().default(MAX_TEXT_CHARS),
        },
        async ({ ref, maxChars }) => {
          const page = await getActivePage();
          const text = ref
            ? await page.locator(selectorForRef(ref)).first().innerText()
            : await page.locator("body").innerText();
          return okText(clampText(text, maxChars));
        },
      ),

      tool(
        "browser_scroll",
        "Scroll the page or scroll an element ref into view.",
        {
          ref: z.string().optional().describe("Optional element ref from browser_get_state to scroll into view."),
          deltaY: z.number().optional().default(800).describe("Vertical wheel delta. Positive scrolls down."),
          deltaX: z.number().optional().default(0).describe("Horizontal wheel delta."),
        },
        async ({ ref, deltaY, deltaX }) => {
          const page = await getActivePage();
          if (ref) await page.locator(selectorForRef(ref)).first().scrollIntoViewIfNeeded();
          await page.mouse.wheel(deltaX, deltaY);
          return jsonText(await snapshotPage(page, 80));
        },
      ),

      tool(
        "browser_go_back",
        "Go back in the active tab history.",
        {},
        async () => {
          const page = await getActivePage();
          await page.goBack({ waitUntil: "domcontentloaded" });
          return jsonText(await snapshotPage(page, 80));
        },
      ),

      tool(
        "browser_list_tabs",
        "List tabs in the current Patchright browser session.",
        {},
        async () => {
          if (!session) return jsonText({ tabs: [] });
          const tabs = await Promise.all(
            session.context.pages().map(async (page, index) => ({
              index,
              active: page === session?.activePage,
              url: page.url(),
              title: await page.title().catch(() => ""),
            })),
          );
          return jsonText({ tabs });
        },
      ),

      tool(
        "browser_switch_tab",
        "Switch the active tab by index from browser_list_tabs.",
        { index: z.number().int().min(0) },
        async ({ index }) => {
          const current = await ensureSession();
          const page = current.context.pages()[index];
          if (!page) throw new Error(`No browser tab at index ${index}`);
          current.activePage = page;
          await page.bringToFront();
          return jsonText(await snapshotPage(page, 80));
        },
      ),

      tool(
        "browser_close_all",
        "Close all Patchright browser tabs and the underlying browser context for this agent.",
        {},
        async () => {
          if (session) await session.context.close().catch(() => {});
          session = undefined;
          refSelectors.clear();
          return okText("Patchright browser session closed.");
        },
      ),
    ],
  });
}
