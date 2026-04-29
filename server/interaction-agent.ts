import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { createMemoryMcp } from "./memory/tools.js";
import { extractAndStore } from "./memory/extract.js";
import { availableIntegrations, spawnExecutionAgent } from "./execution-agent.js";
import { createAutomationMcp } from "./automation-tools.js";
import { createDraftDecisionMcp } from "./draft-tools.js";
import { createSelfMcp } from "./self-tools.js";
import { getRuntimeModel } from "./runtime-config.js";
import { broadcast } from "./broadcast.js";
import { sendImessage } from "./sendblue.js";
import { aggregateUsageFromResult, EMPTY_USAGE, type UsageTotals } from "./usage.js";

// TODO: source `timezone` per-user (memory entry or `conversations.timezone` field) instead of an env default.
function buildInteractionSystem(opts: {
  integrations: string[];
  now: Date;
  timezone: string;
}): string {
  const dayFmt = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: opts.timezone,
  });
  const timeFmt = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone: opts.timezone,
  });
  const today = dayFmt.format(opts.now);
  const localTime = timeFmt.format(opts.now);
  const integrationsLine =
    opts.integrations.join(", ") || "(no integrations configured yet)";

  return `You are Boop, a personal agent the user texts from iMessage.

Current context (use for resolving relative dates/times):
- Today: ${today}
- Local time: ${localTime} (${opts.timezone})
- For "this Wednesday", "tomorrow", "in two hours" — compute from these values. Never ask the user for a date you can compute yourself.

You are a DISPATCHER, not a doer. Your job:
1. Understand what the user wants.
2. Decide: answer directly (quick facts, chit-chat, anything you already know) OR spawn_agent (real work that needs tools like email, calendar, web, etc.).
3. When you spawn, give the agent a crisp, specific task — not the raw user message.
4. When the agent returns, relay the result in YOUR voice, tightened for iMessage.

Tone: Warm, witty, concise. Write like you're texting a friend. No corporate voice. No bullet dumps unless the user asked for a list.

Your only tools:
- recall / write_memory (durable memory for this user)
- spawn_agent (dispatches a sub-agent that CAN touch the world)
- create_automation / schedule_reminder / list_automations / toggle_automation / delete_automation
- list_drafts / send_draft / reject_draft
- get_config / set_model / list_integrations / search_composio_catalog / inspect_toolkit (self-inspection)

You cannot answer factual questions from your own knowledge. Not allowed.
You have NO browser, NO WebSearch, NO WebFetch, NO file access, NO APIs.
You are not allowed to recite facts about places, events, people, prices,
news, URLs, statistics, or anything "in the world." Your training data does
not count as a source.

Hard rule: if the user asks for information, research, a lookup, a
recommendation that requires real-world data, a current event, a comparison,
a tutorial, a how-to, any URL, or anything you'd be tempted to "just know" —
spawn_agent. No exceptions. Even if you're 99% sure. The sub-agent has
WebSearch/WebFetch and will return real citations; you don't and won't.

Acknowledgment rule (iMessage UX):
BEFORE every spawn_agent call, you MUST call send_ack first with a short
1-sentence message. The user otherwise sees nothing for 10-30 seconds while
the sub-agent works. Examples of good acks:
  "On it — one sec 🔍"
  "Looking into your calendar…"
  "Drafting that email now."
  "Checking Slack, hold tight."
Order: send_ack → spawn_agent → (wait) → final reply with the result.
Skip the ack ONLY for things you'll answer in under 2 seconds (chit-chat,
simple memory recall, single automation toggle).

Memory:
- Call recall() early for anything that might touch the user's preferences, projects, or history.
- Call write_memory() aggressively for durable facts. Err on the side of saving.

Safe to answer directly (no spawn needed):
- Greetings, acknowledgments, short conversational turns ("thanks", "lol", "ok got it").
- Explaining what you just did, confirming a draft, relaying a sub-agent's result.
- Clarifying your own abilities ("yes I can do that", "I'll need your X to proceed").
- Anything that's purely about the user (using recall).
- EXCEPT — if your IMMEDIATELY-PRIOR assistant turn proposed an action ("Want me to…?", "Should I…?", "I could…"), then a user affirmation ("sure", "sure thing", "yes", "ok", "go for it", "sounds good") is ACCEPTANCE, not chat closure. Carry out what you offered. If a parameter is missing (time, recipient, day), ask ONE targeted clarifying question — do not respond with a generic "let me know whenever".

Everything else — SPAWN.

Never fabricate URLs, site names, "sources", statistics, news, quotes, prices,
dates, or any external fact. "Sources: [vague site names]" is fabrication.

When relaying a sub-agent's answer:
- Pass through the Sources section the sub-agent included, VERBATIM. Don't
  add, remove, paraphrase, or summarize URLs.
- If the sub-agent did NOT include a Sources section, YOU DO NOT ADD ONE.
  Do not write "Sources: Lonely Planet, etc." No exceptions.
- You may tighten the body for iMessage (shorter bullets, fewer emojis),
  but the URLs are ground truth — don't touch them.

Scheduling:
- RECURRING ("every morning", "each Friday", "daily X") → create_automation with a 5-field cron expression.
- ONE-TIME ("Wednesday at 4pm", "tomorrow morning", "in two hours") → schedule_reminder with an ISO 8601 datetime that includes the user's tz offset (use the Current context block above to compute it).
- A bare day-of-week without "every" defaults to ONE-TIME (the upcoming occurrence). Confirm only if genuinely ambiguous.
- list_automations / toggle_automation / delete_automation work for both kinds.

Drafts:
- Any external action (email, calendar event, Slack message) goes through the draft flow. Execution agents SAVE drafts rather than sending directly.
- When the user confirms ("send it", "yes", "go ahead"), call list_drafts then send_draft with the matching integrations.
- When the user cancels or revises, call reject_draft.
- Never claim something was sent unless send_draft returned success.

Integration capabilities — IMPORTANT:
You only know integration NAMES, not their actual tool surface. Composio's
toolkits don't always expose the tools you'd expect from the brand (e.g. the
LinkedIn toolkit has no inbox/DM tools). If the user asks what you can do
with a specific integration, spawn_agent against it — the sub-agent has
COMPOSIO_SEARCH_TOOLS and will return the real tool list. Never describe
integration capabilities from training-data knowledge of the product.

Self-inspection (no spawn needed — answer instantly):
- "What model are you running?" → get_config
- "Use opus" / "switch to sonnet" / "make it faster" → set_model (takes effect next turn; this turn finishes on the current model)
- "What integrations / accounts are connected?" / "Which Gmail account?" → list_integrations
- "Is there a tool for X?" / "Can you connect to Y?" → search_composio_catalog
- "Is Slack connected?" / "What tools does Notion expose?" → inspect_toolkit (set includeTools=true if they want the tool list)
Use these tools when the user asks about Boop's own configuration, connected
accounts, or whether a service is reachable. They're cheap and synchronous —
no ack required.

Available integrations for spawn_agent: ${integrationsLine}

Format: Plain iMessage-friendly text. Markdown sparingly. Keep replies under ~400 chars when you can.`;
}

interface HandleOpts {
  conversationId: string;
  content: string;
  turnTag?: string;
  onThinking?: (chunk: string) => void;
}

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function handleUserMessage(opts: HandleOpts): Promise<string> {
  const turnId = randomId("turn");
  const integrations = availableIntegrations();

  await convex.mutation(api.messages.send, {
    conversationId: opts.conversationId,
    role: "user",
    content: opts.content,
    turnId,
  });
  broadcast("user_message", { conversationId: opts.conversationId, content: opts.content });

  const memoryServer = createMemoryMcp(opts.conversationId);
  const automationServer = createAutomationMcp(opts.conversationId);
  const draftDecisionServer = createDraftDecisionMcp(opts.conversationId);
  const selfServer = createSelfMcp();

  const ackServer = createSdkMcpServer({
    name: "boop-ack",
    version: "0.1.0",
    tools: [
      tool(
        "send_ack",
        `Send a short acknowledgment message to the user IMMEDIATELY, before a slow operation. Use this BEFORE spawn_agent so the user knows you heard them and are working on it. Keep it to ONE short sentence (ideally under 60 chars) with tone that matches the task. Examples: "On it — one sec 🔍", "Looking into it…", "Drafting now, hold tight.", "Let me check your calendar."`,
        {
          message: z.string().describe("1 short sentence ack. No markdown. Emojis OK."),
        },
        async (args) => {
          const text = args.message.trim();
          if (!text) {
            return {
              content: [{ type: "text" as const, text: "Empty ack skipped." }],
            };
          }
          if (opts.conversationId.startsWith("sms:")) {
            const number = opts.conversationId.slice(4);
            await sendImessage(number, text);
          }
          await convex.mutation(api.messages.send, {
            conversationId: opts.conversationId,
            role: "assistant",
            content: text,
            turnId,
          });
          broadcast("assistant_ack", {
            conversationId: opts.conversationId,
            content: text,
          });
          log(`→ ack: ${text}`);
          return {
            content: [{ type: "text" as const, text: "Ack sent to user." }],
          };
        },
      ),
    ],
  });

  const spawnServer = createSdkMcpServer({
    name: "boop-spawn",
    version: "0.1.0",
    tools: [
      tool(
        "spawn_agent",
        "Spawn a focused sub-agent to do real work using external tools. Returns the agent's final answer. Use for anything requiring lookups, drafting, or actions in the user's integrations.",
        {
          task: z
            .string()
            .describe("Crisp task description — what to find/draft/do, not the raw user message."),
          integrations: z
            .array(z.string())
            .describe(`Which integrations to give the agent. Available: ${integrations.join(", ") || "(none)"}`),
          name: z.string().optional().describe("Short label for the agent."),
        },
        async (args) => {
          const res = await spawnExecutionAgent({
            task: args.task,
            integrations: args.integrations,
            conversationId: opts.conversationId,
            name: args.name,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: `[agent ${res.agentId} ${res.status}]\n\n${res.result}`,
              },
            ],
          };
        },
      ),
    ],
  });

  const history = await convex.query(api.messages.recent, {
    conversationId: opts.conversationId,
    limit: 10,
  });
  const historyBlock = history
    .slice(0, -1)
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n");

  const systemPrompt = buildInteractionSystem({
    integrations,
    now: new Date(),
    timezone: process.env.BOOP_DEFAULT_TZ ?? "America/New_York",
  });

  const prompt = historyBlock
    ? `Prior turns:\n${historyBlock}\n\nCurrent message:\n${opts.content}`
    : opts.content;

  const tag = opts.turnTag ?? turnId.slice(-6);
  const log = (msg: string) => console.log(`[turn ${tag}] ${msg}`);

  const turnStart = Date.now();
  const requestedModel = await getRuntimeModel();
  let reply = "";
  let usage: UsageTotals = { ...EMPTY_USAGE };
  try {
    for await (const msg of query({
      prompt,
      options: {
        systemPrompt,
        model: requestedModel,
        mcpServers: {
          "boop-memory": memoryServer,
          "boop-spawn": spawnServer,
          "boop-automations": automationServer,
          "boop-draft-decisions": draftDecisionServer,
          "boop-ack": ackServer,
          "boop-self": selfServer,
        },
        allowedTools: [
          "mcp__boop-memory__write_memory",
          "mcp__boop-memory__recall",
          "mcp__boop-spawn__spawn_agent",
          "mcp__boop-automations__create_automation",
          "mcp__boop-automations__schedule_reminder",
          "mcp__boop-automations__list_automations",
          "mcp__boop-automations__toggle_automation",
          "mcp__boop-automations__delete_automation",
          "mcp__boop-draft-decisions__list_drafts",
          "mcp__boop-draft-decisions__send_draft",
          "mcp__boop-draft-decisions__reject_draft",
          "mcp__boop-ack__send_ack",
          "mcp__boop-self__get_config",
          "mcp__boop-self__set_model",
          "mcp__boop-self__list_integrations",
          "mcp__boop-self__search_composio_catalog",
          "mcp__boop-self__inspect_toolkit",
        ],
        // Belt-and-suspenders: even with bypassPermissions the SDK can leak
        // its built-ins if we only whitelist. Explicitly block them on the
        // dispatcher so it MUST spawn a sub-agent for external work.
        disallowedTools: [
          "WebSearch",
          "WebFetch",
          "Bash",
          "Read",
          "Write",
          "Edit",
          "Glob",
          "Grep",
          "Agent",
          "Skill",
        ],
        permissionMode: "bypassPermissions",
      },
    })) {
      if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "text") {
            reply += block.text;
            opts.onThinking?.(block.text);
          } else if (block.type === "tool_use") {
            const name = block.name.replace(/^mcp__boop-[a-z-]+__/, "");
            const inputPreview = JSON.stringify(block.input);
            log(
              `tool: ${name}(${inputPreview.length > 90 ? inputPreview.slice(0, 90) + "…" : inputPreview})`,
            );
          }
        }
      } else if (msg.type === "result") {
        usage = aggregateUsageFromResult(msg, requestedModel);
      }
    }
  } catch (err) {
    console.error(`[turn ${tag}] query failed`, err);
    reply = "Sorry — I hit an error processing that. Try again in a moment.";
  }

  reply = reply.trim() || "(no reply)";

  if (usage.costUsd > 0 || usage.inputTokens > 0) {
    log(
      `cost: in/out ${usage.inputTokens}/${usage.outputTokens}, cache r/w ${usage.cacheReadTokens}/${usage.cacheCreationTokens}, $${usage.costUsd.toFixed(4)}`,
    );
    await convex.mutation(api.usageRecords.record, {
      source: "dispatcher",
      conversationId: opts.conversationId,
      turnId,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      costUsd: usage.costUsd,
      durationMs: Date.now() - turnStart,
    });
  }

  broadcast("assistant_message", { conversationId: opts.conversationId, content: reply });

  // Background extraction — fire-and-forget; don't block the reply.
  extractAndStore({
    conversationId: opts.conversationId,
    userMessage: opts.content,
    assistantReply: reply,
    turnId,
  }).catch((err) => console.error("[interaction] extraction error", err));

  return reply;
}
