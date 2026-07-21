import { z } from "zod";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { broadcast } from "./broadcast.js";
import {
  buildMcpServersForIntegrations,
  buildRuntimeToolsForIntegrations,
  listIntegrations,
} from "./integrations/registry.js";
import { createDraftStagingTools } from "./draft-tools.js";
import { createFilesMcp } from "./file-tools.js";
import { EMPTY_USAGE, type UsageTotals } from "./usage.js";
import { getRuntimeConfig, type RuntimeConfig } from "./runtime-config.js";
import { runAgentRuntime } from "./runtimes/index.js";
import { defineRuntimeTool } from "./runtimes/tool.js";
import { runtimeText, type RuntimeTool } from "./runtimes/types.js";
import { buildPromptWithImages, fetchStoredBytes } from "./images/content-blocks.js";
import { createRedditSearchMcp, redditSearchAvailable } from "./openai-reddit-search.js";
import { createPatchrightBrowserMcp, patchrightBrowserAvailable } from "./patchright-browser.js";

const AUTOMATION_NOTIFY_NAMESPACE = "boop-automation-notify";

const running = new Map<string, AbortController>();

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Composio surfaces the targeted account in a few different shapes depending on
// the tool. Pull whichever one is present so multi-account runs (e.g. 3 Gmail
// inboxes) make the chosen account visible per call.
function extractAccounts(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const accounts = new Set<string>();
  const collect = (v: unknown) => {
    if (typeof v === "string" && v.trim()) accounts.add(v.trim());
  };
  const obj = input as Record<string, unknown>;
  // Direct fields on the top-level call (single-execute, native Composio tools).
  collect(obj.account);
  collect(obj.connectedAccountId);
  collect(obj.connected_account_id);
  if (Array.isArray(obj.accounts)) obj.accounts.forEach(collect);
  // COMPOSIO_MULTI_EXECUTE_TOOL fans out: { tools: [{ account, ... }] }.
  if (Array.isArray(obj.tools)) {
    for (const t of obj.tools) {
      if (t && typeof t === "object") {
        const tt = t as Record<string, unknown>;
        collect(tt.account);
        collect(tt.connectedAccountId);
        collect(tt.connected_account_id);
      }
    }
  }
  return [...accounts];
}

function isBrowserFillTool(toolName: string): boolean {
  const shortName = toolName.split("__").pop() ?? toolName;
  return shortName === "browser_fill";
}

export function redactToolInputForLog(toolName: string, input: unknown): unknown {
  if (!isBrowserFillTool(toolName)) return input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  return {
    ...(input as Record<string, unknown>),
    text: "[redacted]",
  };
}

function buildExecutionSystem(
  patchrightEnabled: boolean,
  automationNotifyEnabled: boolean,
): string {
  const toolsLine = patchrightEnabled
    ? "2. Use your tools — search_reddit for Reddit-specific research, WebSearch, WebFetch, browser tools (when present) for real Chrome automation, and any integrations loaded for this spawn — to investigate and act."
    : "2. Use your tools — search_reddit for Reddit-specific research, WebSearch, WebFetch, and any integrations loaded for this spawn — to investigate and act.";
  const browserDiscipline = patchrightEnabled
    ? "- Reach for browser tools when WebFetch returns a stub/blocked page, when the page needs JavaScript, login, clicks, scrolling, or form input. Tools: browser_navigate, browser_click, browser_type, browser_get_state, browser_extract_content, browser_scroll, browser_go_back, browser_list_tabs, browser_switch_tab, browser_screenshot. Always close sessions with browser_close_all when done.\n- browser_screenshot saves to the user's files store and returns a url. Use it whenever the user asks to SEE something or visual confirmation matters; include the returned url on its own line in your final answer so iMessage previews the image.\n"
    : "";
  return `You are a focused background worker for the user.

Your job:
1. Perform the task you were given, end to end.
${toolsLine}
3. Return a concise, well-structured answer — not a data dump.

Research discipline:
- For Reddit-specific research, use search_reddit first when available. It uses OpenAI web search restricted to reddit.com and reports whether direct Reddit enrichment was blocked.
- Prefer WebSearch for fresh/factual questions. WebFetch when you need the content of a known URL.
${browserDiscipline}- Cite real URLs only — NEVER invent sources. If a page failed to load, say so.
- Cross-check when it matters: one search is rarely enough for a claim.

Local browser:
- If the optional "browser" integration is loaded, Local browser use is enabled and it controls a local Patchright Chrome/Chromium profile on the user's machine.
- Use browser tools only when native integrations or WebFetch/WebSearch are insufficient: login-only portals, JS-heavy apps, visual workflows, or services likely to detect bots.
- If you hit a login, MFA, or bot wall and the task requires the user's session, call browser_request_login. It opens a visible local browser instance and returns the exact handoff message to show the user.
- After browser_request_login, stop and tell the user what to do next. Do not claim the task is complete until they confirm they logged in.

Apple data:
- If the "apple" integration is loaded, its tools return read-only local Apple data from the user's Mac. iMessage reads run from the local server with Full Disk Access; Apple Notes and Apple Reminders read from the local server with macOS Automation permission; Apple Calendar uses the optional Apple bridge. They never modify anything.
- Never include phone numbers in your response. For iMessage/SMS lookups, refer to contact names, message text, timing, or "the matching thread" instead of phone numbers.

MANDATORY: for any task that used WebSearch or WebFetch, end your response with
a "Sources:" section listing the ACTUAL URLs you fetched or found. Example:

  Sources:
  - https://www.lonelyplanet.com/japan/tokyo
  - https://www.japan-guide.com/e/e3008.html

No URLs = no sources section. Never write vague names like "Lonely Planet" or
"official guide" without the specific URL. The interaction agent relays your
output to the user verbatim, so if you don't include URLs, the user won't see
any.

If you use search_reddit, include the Reddit thread URLs it returned and note
briefly if engagement/comment enrichment was blocked or failed.

Style:
- Optimize for iMessage delivery: short sentences, bullets over paragraphs, no tables.
- Prefer markdown with **bold** keywords and • bullets.
- Under 500 words unless explicitly asked for more.
- If you can't complete something, say why in one sentence.

Files cache:
- If you retrieve a file or attachment the user is likely to want again
  (an email attachment, a Drive doc, a downloaded asset), call save_file to
  cache it in the user's saved-files store before returning. Pass the
  download URL as sourceUrl, set kind appropriately (image/pdf/url), and
  set source to where it came from (e.g. "gmail", "drive"). Then mention
  in your final answer that you cached it. Next time the user asks, the
  dispatcher will hit it via lookup_file without spawning you again.
- Don't cache transient or one-off content (search results, raw web pages
  the user isn't asking to keep). Cache when the user clearly wants a
  copy: "find that PDF", "save the receipt from this email", "pull up the
  contract Anna sent."

Safety:
- Anything that sends a message, creates an event, or takes an external action: call save_draft with a JSON payload instead of the real send/create tool. Return the summary so the interaction agent can show it to the user.
- Only the interaction agent's send_draft tool commits. You never commit.${
    automationNotifyEnabled
      ? `

Automation notification contract:
- You are running as a scheduled automation. The user does NOT see your final assistant message — that goes to the run log only.
- To deliver something to the user, call the \`notify\` tool with the exact text you want them to receive. You may call \`notify\` multiple times; the chunks will be concatenated in order with blank lines between them.
- If nothing happened worth pinging the user about (e.g. "price unchanged", "no new emails", "still no replies"), do NOT call \`notify\`. Silence is the default and nothing will be delivered. Just explain in your final assistant message why you stayed quiet — that goes to the run log for debugging.
- Do NOT use \`notify\` to narrate your process. Use it only for the final user-facing message.`
      : ""
  }`;
}

function createAutomationNotifyTool(notifications: string[]): RuntimeTool {
  return defineRuntimeTool(
    AUTOMATION_NOTIFY_NAMESPACE,
    "notify",
    `Deliver a message to the user for this automation run. Call once with the exact text to deliver. You may call multiple times to send multiple chunks (they'll be concatenated in order). If nothing is worth notifying about, do NOT call this tool — silence is the default and nothing will be sent.`,
    {
      message: z.string().describe("The exact text to deliver to the user."),
    },
    async (args) => {
      notifications.push(args.message);
      return runtimeText("Notification queued.");
    },
  );
}

export interface SpawnOptions {
  task: string;
  integrations: string[];
  conversationId?: string;
  name?: string;
  runtimeConfig?: RuntimeConfig;
  imageStorageIds?: string[];
  /**
   * When true, the agent gets a `notify` tool and silence-is-default semantics.
   * The captured calls come back as `SpawnResult.notification`. Automation
   * runs set this; ad-hoc spawns from the interaction agent or drafts don't.
   */
  automationNotify?: boolean;
}

export type SpawnExecutionAgentOpts = SpawnOptions;

export interface SpawnResult {
  agentId: string;
  result: string;
  status: "completed" | "failed" | "cancelled";
  /**
   * Concatenated messages the agent passed to the `notify` tool, joined with
   * blank lines. Undefined when `automationNotify` was off or the agent never
   * called `notify`. Automation runners use this — not `result` — to decide
   * what to deliver to the user.
   */
  notification?: string;
}

export async function spawnExecutionAgent(opts: SpawnExecutionAgentOpts): Promise<SpawnResult> {
  const agentId = randomId("agent");
  const name = opts.name ?? (opts.integrations.join("+") || "general");
  const abort = new AbortController();
  running.set(agentId, abort);

  const shortId = agentId.slice(-6);
  const logAgent = (msg: string) => console.log(`[agent ${shortId}] ${msg}`);
  const taskPreview =
    opts.task.length > 120 ? opts.task.slice(0, 120) + "…" : opts.task;
  logAgent(
    `spawn: ${name} [${opts.integrations.join(", ") || "no integrations"}] images=${opts.imageStorageIds?.length ?? 0} — ${JSON.stringify(taskPreview)}`,
  );
  const agentStart = Date.now();
  const runtimeConfig = opts.runtimeConfig ?? (await getRuntimeConfig());

  // Claude-only extras: reddit search and the local Patchright browser MCP. Codex
  // runs don't get these — they're Claude-runtime MCP servers, not runtime tools.
  const isClaudeRuntime = runtimeConfig.runtime === "claude";
  const patchrightEnabled = isClaudeRuntime ? await patchrightBrowserAvailable() : false;
  const redditEnabled = isClaudeRuntime && redditSearchAvailable();

  // Compose the persisted mcpServers list. For Claude, append the actual extras
  // that were loaded for this run so the agent record reflects reality. For
  // Codex, just persist the integrations the caller requested.
  const persistedMcpServers = isClaudeRuntime
    ? [
        ...opts.integrations,
        ...(redditEnabled ? ["boop-reddit-search"] : []),
        ...(patchrightEnabled ? ["patchright-browser"] : []),
        "boop-files",
      ]
    : opts.integrations;

  await convex.mutation(api.agents.create, {
    agentId,
    conversationId: opts.conversationId,
    name,
    task: opts.task,
    runtime: runtimeConfig.runtime,
    model: runtimeConfig.model,
    reasoningEffort: runtimeConfig.reasoningEffort,
    billingMode: runtimeConfig.billingMode,
    mcpServers: persistedMcpServers,
  });
  broadcast("agent_spawned", { agentId, name, task: opts.task });

  await convex.mutation(api.agents.update, { agentId, status: "running" });

  // Draft staging is wired as runtime tools in both runtimes — the runtime
  // abstraction handles exposing them as either MCP tools (Claude) or function
  // tools (Codex).
  const draftTools = opts.conversationId ? createDraftStagingTools(opts.conversationId) : [];

  const integrationServers = isClaudeRuntime
    ? await buildMcpServersForIntegrations(opts.integrations, opts.conversationId)
    : {};
  const integrationTools =
    runtimeConfig.runtime === "codex"
      ? await buildRuntimeToolsForIntegrations(opts.integrations, opts.conversationId)
      : [];

  // Claude-only MCP servers: reddit search, patchright browser, files cache.
  const redditServer = redditEnabled ? createRedditSearchMcp() : undefined;
  const patchrightBrowserServer = patchrightEnabled
    ? createPatchrightBrowserMcp({ agentId, conversationId: opts.conversationId })
    : undefined;
  const filesServer = isClaudeRuntime ? createFilesMcp(opts.conversationId) : undefined;

  // Automation notify wiring: when this spawn is an automation run with a
  // notification target, give the agent a `notify` tool whose calls we capture
  // here. The automation runner uses the captured text to decide what to ship.
  const notifications: string[] = [];
  const notifyTools: RuntimeTool[] = opts.automationNotify
    ? [createAutomationNotifyTool(notifications)]
    : [];

  const mcpServers = {
    ...integrationServers,
    ...(redditServer ? { "boop-reddit-search": redditServer } : {}),
    ...(patchrightBrowserServer ? { "patchright-browser": patchrightBrowserServer } : {}),
    ...(filesServer ? { "boop-files": filesServer } : {}),
  };
  const runtimeTools = [...draftTools, ...integrationTools, ...notifyTools];
  const runtimeToolNamespaces = [...new Set(integrationTools.map((tool) => tool.namespace))];
  const allowedTools = [
    "WebSearch",
    "WebFetch",
    "Skill",
    ...Object.keys(mcpServers).flatMap((n) => [`mcp__${n}__*`]),
    ...(draftTools.length ? ["mcp__boop-drafts__*"] : []),
    ...runtimeToolNamespaces.flatMap((n) => [`mcp__${n}__*`]),
    ...(notifyTools.length ? [`mcp__${AUTOMATION_NOTIFY_NAMESPACE}__*`] : []),
  ];

  let buffer = "";
  let usage: UsageTotals = { ...EMPTY_USAGE };
  let status: "completed" | "failed" | "cancelled" = "completed";
  let errorMsg: string | undefined;

  try {
    const executionPrompt = await buildPromptWithImages({
      text: opts.task,
      imageStorageIds: opts.imageStorageIds,
      fetchBytes: fetchStoredBytes,
    });
    const result = await runAgentRuntime(runtimeConfig, {
      prompt: executionPrompt,
      systemPrompt: buildExecutionSystem(patchrightEnabled, !!opts.automationNotify),
      claudeMcpServers: mcpServers,
      tools: runtimeTools,
      allowedTools,
      abortController: abort,
      mode: "execution",
      onText: async (text) => {
        buffer += text;
        await convex.mutation(api.agents.addLog, {
          agentId,
          logType: "text",
          content: text,
        });
      },
      onToolUse: async (toolName, input) => {
        const toolShort = toolName.replace(/^mcp__[a-z-]+__/, "");
        const accounts = extractAccounts(input);
        const acctSuffix = accounts.length ? ` [${accounts.join(", ")}]` : "";
        logAgent(`tool: ${toolShort}${acctSuffix}`);
        const logInput = redactToolInputForLog(toolName, input);
        await convex.mutation(api.agents.addLog, {
          agentId,
          logType: "tool_use",
          toolName,
          ...(accounts.length ? { accounts } : {}),
          content: JSON.stringify(logInput).slice(0, 2000),
        });
        broadcast("agent_tool", { agentId, toolName, accounts });
      },
      onToolResult: async (_toolName, text) => {
        await convex.mutation(api.agents.addLog, {
          agentId,
          logType: "tool_result",
          content: text.slice(0, 2000),
        });
      },
    });
    if (!buffer) buffer = result.text;
    usage = result.usage;
  } catch (err) {
    status = abort.signal.aborted ? "cancelled" : "failed";
    errorMsg = String(err);
    await convex.mutation(api.agents.addLog, {
      agentId,
      logType: "error",
      content: errorMsg,
    });
  } finally {
    running.delete(agentId);
  }

  const elapsed = ((Date.now() - agentStart) / 1000).toFixed(1);
  logAgent(
    `done (${status}, ${elapsed}s, in/out tokens ${usage.inputTokens}/${usage.outputTokens}, cache r/w ${usage.cacheReadTokens}/${usage.cacheCreationTokens}, $${usage.costUsd.toFixed(4)})`,
  );

  await convex.mutation(api.agents.update, {
    agentId,
    status,
    result: buffer,
    error: errorMsg,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    costUsd: usage.costUsd,
  });
  // Also append to the usage log so total-cost queries cover every layer.
  if (usage.costUsd > 0 || usage.inputTokens > 0) {
    await convex.mutation(api.usageRecords.record, {
      source: "execution",
      conversationId: opts.conversationId,
      agentId,
      runtime: runtimeConfig.runtime,
      billingMode: runtimeConfig.billingMode,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      costUsd: usage.costUsd,
      durationMs: Date.now() - agentStart,
    });
  }
  broadcast("agent_done", { agentId, status, result: buffer.slice(0, 200) });

  const notification = notifications.length ? notifications.join("\n\n") : undefined;
  return { agentId, result: buffer || errorMsg || "(no output)", status, notification };
}

export function cancelAgent(agentId: string): boolean {
  const abort = running.get(agentId);
  if (!abort) return false;
  abort.abort();
  return true;
}

export function runningAgentIds(): string[] {
  return [...running.keys()];
}

export async function retryAgent(agentId: string): Promise<SpawnResult | null> {
  const existing = await convex.query(api.agents.get, { agentId });
  if (!existing) return null;
  const originalRuntime = existing as typeof existing & Partial<RuntimeConfig>;
  const runtimeConfig =
    originalRuntime.runtime && originalRuntime.model && originalRuntime.billingMode
      ? {
          runtime: originalRuntime.runtime,
          model: originalRuntime.model,
          reasoningEffort: originalRuntime.reasoningEffort,
          billingMode: originalRuntime.billingMode,
        }
      : undefined;
  // V1 limitation: image refs are not persisted to executionAgents and
  // therefore are not replayed on retry. Re-trigger from the original
  // turn if you need the image inputs.
  return await spawnExecutionAgent({
    task: existing.task,
    integrations: existing.mcpServers,
    conversationId: existing.conversationId,
    name: existing.name,
    runtimeConfig,
  });
}

export function availableIntegrations(): string[] {
  return listIntegrations().map((i) => i.name);
}
