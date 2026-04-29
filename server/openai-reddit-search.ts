import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const REDDIT_SEARCH_ENV = "OPENAI_REDDIT_SEARCH_API_KEY";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = process.env.OPENAI_REDDIT_SEARCH_MODEL ?? "gpt-5.2";
const MODEL_FALLBACKS = ["gpt-5.1", "gpt-5", "gpt-4.1", "gpt-4o", "gpt-4o-mini"];
const USER_AGENT = "boop-agent/0.1 (reddit search enrichment)";

interface RedditSearchArgs {
  query: string;
  maxResults?: number;
  subreddits?: string[];
  fromDate?: string;
  toDate?: string;
  includeComments?: boolean;
}

interface RedditThread {
  title: string;
  url: string;
  subreddit?: string;
  date?: string;
  relevance?: number;
  summary?: string;
  sourceTitle?: string;
  engagement?: {
    score?: number;
    numComments?: number;
    upvoteRatio?: number;
  };
  topComments?: Array<{
    score: number;
    author: string;
    excerpt: string;
    url?: string;
  }>;
  enrichmentStatus?: "ok" | "blocked" | "failed" | "skipped";
  enrichmentError?: string;
}

interface UrlCitation {
  url: string;
  title?: string;
}

interface OpenAISearchResult {
  model: string;
  outputText: string;
  citations: UrlCitation[];
  sources: UrlCitation[];
}

export function redditSearchAvailable(): boolean {
  return Boolean(process.env[REDDIT_SEARCH_ENV]);
}

export function createRedditSearchMcp() {
  return createSdkMcpServer({
    name: "boop-reddit-search",
    version: "0.1.0",
    tools: [
      tool(
        "search_reddit",
        "Search Reddit threads using OpenAI Responses API web_search restricted to reddit.com. Use this before generic WebSearch/WebFetch when the user asks for Reddit posts, subreddits, or Reddit sentiment.",
        {
          query: z.string().describe("The Reddit search topic, e.g. 'ZRS Management tenant experiences'."),
          maxResults: z
            .number()
            .int()
            .min(1)
            .max(25)
            .optional()
            .default(10)
            .describe("Maximum number of Reddit threads to return."),
          subreddits: z
            .array(z.string())
            .optional()
            .describe("Optional subreddit names to bias toward, without r/."),
          fromDate: z
            .string()
            .optional()
            .describe("Optional earliest date in YYYY-MM-DD format."),
          toDate: z
            .string()
            .optional()
            .describe("Optional latest date in YYYY-MM-DD format."),
          includeComments: z
            .boolean()
            .optional()
            .default(true)
            .describe("Whether to enrich top results with Reddit public JSON comments when reachable."),
        },
        async (args) => {
          if (!redditSearchAvailable()) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `${REDDIT_SEARCH_ENV} is not set. Ask the user to add an OpenAI API key before using Reddit search.`,
                },
              ],
            };
          }

          const result = await searchReddit(args);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        },
      ),
    ],
  });
}

async function searchReddit(args: RedditSearchArgs) {
  const maxResults = args.maxResults ?? 10;
  const openai = await runOpenAISearch(args);
  const parsed = parseThreads(openai, maxResults);
  const threads = args.includeComments === false ? parsed : await enrichThreads(parsed, maxResults);

  return {
    provider: "openai_responses_web_search",
    model: openai.model,
    domainFilter: ["reddit.com"],
    query: args.query,
    subreddits: args.subreddits ?? [],
    dateRange: {
      fromDate: args.fromDate ?? null,
      toDate: args.toDate ?? null,
    },
    threads,
    citations: openai.citations,
    sources: openai.sources,
    notes:
      threads.length === 0
        ? "OpenAI web search returned no valid Reddit thread URLs. Try a more specific property, product, subreddit, or phrase."
        : "Thread discovery used OpenAI web_search restricted to reddit.com. Engagement/comment enrichment is best-effort via Reddit public JSON and may be blocked independently.",
  };
}

async function runOpenAISearch(args: RedditSearchArgs): Promise<OpenAISearchResult> {
  const apiKey = process.env[REDDIT_SEARCH_ENV];
  if (!apiKey) throw new Error(`${REDDIT_SEARCH_ENV} is not set`);

  const models = [DEFAULT_MODEL, ...MODEL_FALLBACKS.filter((model) => model !== DEFAULT_MODEL)];
  let lastError: Error | undefined;
  for (const model of models) {
    try {
      return await callOpenAI(model, apiKey, args);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (!isModelAccessError(lastError)) break;
    }
  }
  throw lastError ?? new Error("OpenAI Reddit search failed");
}

async function callOpenAI(
  model: string,
  apiKey: string,
  args: RedditSearchArgs,
): Promise<OpenAISearchResult> {
  const res = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      tools: [
        {
          type: "web_search",
          filters: { allowed_domains: ["reddit.com"] },
          search_context_size: "medium",
        },
      ],
      input: buildPrompt(args),
    }),
  });

  const body = await res.text();
  if (!res.ok) {
    throw new Error(`openai reddit search ${res.status}: ${body}`);
  }

  const json = JSON.parse(body) as Record<string, unknown>;
  return {
    model,
    outputText: extractOutputText(json),
    citations: extractCitations(json),
    sources: extractSources(json),
  };
}

function buildPrompt(args: RedditSearchArgs): string {
  const subreddits = args.subreddits?.map((s) => s.replace(/^r\//i, "").trim()).filter(Boolean) ?? [];
  const subredditHint = subreddits.length
    ? `Prioritize these subreddits if relevant: ${subreddits.map((s) => `r/${s}`).join(", ")}.`
    : "Search broadly across Reddit, including likely relevant subreddits.";
  const dateHint =
    args.fromDate || args.toDate
      ? `Prefer threads in this date range when available: ${args.fromDate ?? "any"} to ${args.toDate ?? "now"}.`
      : "Prefer recent and high-signal threads, but include older threads if they are the best matches.";

  return `Search Reddit for real discussion threads about: ${args.query}

${subredditHint}
${dateHint}

Requirements:
- Use only reddit.com results.
- Return only real Reddit thread URLs containing /r/ and /comments/.
- Exclude Reddit search pages, user profiles, subreddit home pages, wiki pages, and non-thread URLs.
- Try query variants like "${args.query} site:reddit.com", "reddit ${args.query}", and "${args.query} reddit".
- Return at most ${args.maxResults ?? 10} threads.

Respond with JSON only in this shape:
{
  "threads": [
    {
      "title": "thread title",
      "url": "https://www.reddit.com/r/.../comments/...",
      "subreddit": "subreddit_name",
      "date": "YYYY-MM-DD or null",
      "relevance": 0.0,
      "summary": "why this thread is relevant"
    }
  ]
}`;
}

function parseThreads(openai: OpenAISearchResult, maxResults: number): RedditThread[] {
  const threads: RedditThread[] = [];
  const addThread = (candidate: Partial<RedditThread>) => {
    const url = normalizeRedditThreadUrl(candidate.url);
    if (!url || threads.some((thread) => thread.url === url)) return;
    threads.push({
      title: cleanString(candidate.title) ?? cleanString(candidate.sourceTitle) ?? "Reddit thread",
      url,
      subreddit: cleanString(candidate.subreddit) ?? subredditFromUrl(url),
      date: cleanString(candidate.date),
      relevance: typeof candidate.relevance === "number" ? candidate.relevance : undefined,
      summary: cleanString(candidate.summary),
      sourceTitle: cleanString(candidate.sourceTitle),
      enrichmentStatus: "skipped",
    });
  };

  const parsedJson = parseJsonObject(openai.outputText);
  if (parsedJson) {
    const rawThreads = Array.isArray(parsedJson)
      ? parsedJson
      : isRecord(parsedJson) && Array.isArray(parsedJson.threads)
        ? parsedJson.threads
        : [];
    for (const item of rawThreads) {
      if (!isRecord(item)) continue;
      addThread({
        title: stringField(item, "title"),
        url: stringField(item, "url"),
        subreddit: stringField(item, "subreddit"),
        date: stringField(item, "date"),
        relevance: numberField(item, "relevance"),
        summary: stringField(item, "summary") ?? stringField(item, "why_relevant"),
      });
      if (threads.length >= maxResults) break;
    }
  }

  for (const citation of [...openai.citations, ...openai.sources]) {
    if (threads.length >= maxResults) break;
    addThread({
      title: citation.title,
      sourceTitle: citation.title,
      url: citation.url,
      summary: "Reddit source found by OpenAI web search.",
    });
  }

  return threads.slice(0, maxResults);
}

async function enrichThreads(threads: RedditThread[], maxResults: number): Promise<RedditThread[]> {
  const enrichCount = Math.min(5, maxResults, threads.length);
  const enriched = await Promise.all(
    threads.slice(0, enrichCount).map(async (thread) => enrichThread(thread)),
  );
  return [...enriched, ...threads.slice(enrichCount)];
}

async function enrichThread(thread: RedditThread): Promise<RedditThread> {
  const url = normalizeRedditThreadUrl(thread.url);
  if (!url) return thread;

  try {
    const jsonUrl = `${url.replace(/\/?$/, "/")}.json?raw_json=1`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(jsonUrl, {
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.status === 403 || res.status === 429) {
      return {
        ...thread,
        enrichmentStatus: "blocked",
        enrichmentError: `Reddit public JSON returned ${res.status}`,
      };
    }
    if (!res.ok) {
      return {
        ...thread,
        enrichmentStatus: "failed",
        enrichmentError: `Reddit public JSON returned ${res.status}`,
      };
    }

    const data = (await res.json()) as unknown;
    return { ...thread, ...parseThreadJson(data), enrichmentStatus: "ok" };
  } catch (err) {
    return {
      ...thread,
      enrichmentStatus: "failed",
      enrichmentError: err instanceof Error ? err.message : String(err),
    };
  }
}

function parseThreadJson(data: unknown): Partial<RedditThread> {
  if (!Array.isArray(data)) return {};
  const submission = firstChildData(data[0]);
  const commentsListing = isRecord(data[1]) ? data[1] : undefined;
  const commentChildren = getNestedArray(commentsListing, ["data", "children"]);

  const topComments = commentChildren
    .map((child) => (isRecord(child) && child.kind === "t1" ? recordField(child, "data") : undefined))
    .filter(isRecord)
    .map((comment) => ({
      score: numberField(comment, "score") ?? 0,
      author: stringField(comment, "author") ?? "[deleted]",
      excerpt: (stringField(comment, "body") ?? "").slice(0, 280),
      url: stringField(comment, "permalink")
        ? `https://www.reddit.com${stringField(comment, "permalink")}`
        : undefined,
    }))
    .filter((comment) => comment.excerpt && !["[deleted]", "[removed]"].includes(comment.author))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  return {
    title: stringField(submission, "title"),
    date: dateFromUnix(numberField(submission, "created_utc")),
    engagement: {
      score: numberField(submission, "score"),
      numComments: numberField(submission, "num_comments"),
      upvoteRatio: numberField(submission, "upvote_ratio"),
    },
    topComments,
  };
}

function extractOutputText(json: Record<string, unknown>): string {
  const output = Array.isArray(json.output) ? json.output : [];
  const chunks: string[] = [];
  for (const item of output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (isRecord(content) && typeof content.text === "string") chunks.push(content.text);
    }
  }
  if (chunks.length > 0) return chunks.join("\n");
  return typeof json.output_text === "string" ? json.output_text : "";
}

function extractCitations(json: Record<string, unknown>): UrlCitation[] {
  const output = Array.isArray(json.output) ? json.output : [];
  const citations: UrlCitation[] = [];
  for (const item of output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (!isRecord(content) || !Array.isArray(content.annotations)) continue;
      for (const annotation of content.annotations) {
        if (!isRecord(annotation) || annotation.type !== "url_citation") continue;
        const url = stringField(annotation, "url");
        if (url) citations.push({ url, title: stringField(annotation, "title") });
      }
    }
  }
  return dedupeCitations(citations);
}

function extractSources(json: Record<string, unknown>): UrlCitation[] {
  const output = Array.isArray(json.output) ? json.output : [];
  const sources: UrlCitation[] = [];
  for (const item of output) {
    if (!isRecord(item)) continue;
    const action = recordField(item, "action");
    const rawSources = Array.isArray(action?.sources) ? action.sources : [];
    for (const source of rawSources) {
      if (!isRecord(source)) continue;
      const url = stringField(source, "url");
      if (url) sources.push({ url, title: stringField(source, "title") });
    }
  }
  return dedupeCitations(sources);
}

function normalizeRedditThreadUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return null;
  try {
    const parsed = new URL(rawUrl.trim());
    const host = parsed.hostname.toLowerCase();
    if (!host.endsWith("reddit.com")) return null;
    const match = parsed.pathname.match(/^\/r\/([^/]+)\/comments\/([^/]+)(?:\/([^/]+))?/i);
    if (!match) return null;
    const subreddit = match[1];
    const threadId = match[2];
    const slug = match[3];
    return `https://www.reddit.com/r/${subreddit}/comments/${threadId}/${slug ? `${slug}/` : ""}`;
  } catch {
    return null;
  }
}

function subredditFromUrl(url: string): string | undefined {
  const match = url.match(/\/r\/([^/]+)\//i);
  return match?.[1];
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1);
  if (!candidate.trim()) return null;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function isModelAccessError(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return (
    msg.includes("model") ||
    msg.includes("not found") ||
    msg.includes("does not exist") ||
    msg.includes("not supported") ||
    msg.includes("access") ||
    msg.includes("permission") ||
    msg.includes("unsupported")
  );
}

function firstChildData(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const children = getNestedArray(value, ["data", "children"]);
  const first = children[0];
  if (!isRecord(first)) return undefined;
  return recordField(first, "data");
}

function getNestedArray(value: unknown, path: string[]): unknown[] {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return [];
    current = current[key];
  }
  return Array.isArray(current) ? current : [];
}

function dedupeCitations(citations: UrlCitation[]): UrlCitation[] {
  const seen = new Set<string>();
  return citations.filter((citation) => {
    if (seen.has(citation.url)) return false;
    seen.add(citation.url);
    return true;
  });
}

function dateFromUnix(value: number | undefined): string | undefined {
  if (!value) return undefined;
  return new Date(value * 1000).toISOString().slice(0, 10);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function recordField(value: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const field = value?.[key];
  return isRecord(field) ? field : undefined;
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  return cleanString(value?.[key]);
}

function numberField(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const field = value?.[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
