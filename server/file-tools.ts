import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { embed } from "./embeddings.js";

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function buildEmbeddingText(parts: {
  name: string;
  description?: string;
  content?: string;
  tags?: string[];
}): string {
  const chunks = [parts.name];
  if (parts.description) chunks.push(parts.description);
  if (parts.tags?.length) chunks.push(parts.tags.join(" "));
  if (parts.content) chunks.push(parts.content);
  return chunks.join("\n\n");
}

async function attachEmbedding(
  fileId: string,
  text: string,
): Promise<void> {
  const vec = await embed(text);
  if (vec) {
    await convex.mutation(api.files.setEmbedding, { fileId, embedding: vec });
  }
}

interface FilesMcpOpts {
  conversationId?: string;
  // When provided, exposes an `attach_file` tool that the dispatcher can
  // call to make the next outbound iMessage carry a real media attachment
  // (via SendBlue's `media_url` parameter) instead of just an inline URL
  // preview. Execution-agents don't need this — their results flow back
  // through the dispatcher which decides whether to attach.
  onAttach?: (url: string) => void;
}

/**
 * Files MCP — exposed to BOTH the dispatcher (for inbound iMessage saves and
 * fast lookups) and execution-agents (so a Gmail/Drive sub-agent can cache
 * what it retrieves into the same store).
 *
 * Source-of-content modes for save_file (exactly one):
 *   - `content`: raw text body (kind="text" or kind="url" with externalUrl)
 *   - `sourceUrl`: a URL to fetch and store as a blob (kind="image"|"pdf")
 *   - `externalUrl`: a pointer to keep without downloading (kind="url")
 */
export function createFilesMcp(
  conversationIdOrOpts?: string | FilesMcpOpts,
) {
  const opts: FilesMcpOpts =
    typeof conversationIdOrOpts === "string"
      ? { conversationId: conversationIdOrOpts }
      : (conversationIdOrOpts ?? {});
  const conversationId = opts.conversationId;
  const onAttach = opts.onAttach;

  const baseTools = [
      tool(
        "save_file",
        `Save a file (text, image, PDF, or URL pointer) for the user to look up later.

Use when the user is handing you something to remember:
- A snippet of text ("save this as 'office address': 123 Main St")
- An iMessage attachment they sent (use sourceUrl from the [Inbound attachments] block)
- A URL they want to bookmark (use externalUrl)
- A file you (an execution agent) just retrieved from email/drive/etc. — cache it here so the next lookup is instant

Provide exactly ONE of: content, sourceUrl, or externalUrl.

Embedding is generated automatically from name + description + content.`,
        {
          name: z.string().describe("Short title to look up later (e.g. 'office address', 'lease pdf')."),
          kind: z
            .enum(["text", "image", "pdf", "url"])
            .describe("text=raw text; image/pdf=binary blob (provide sourceUrl); url=pointer."),
          content: z
            .string()
            .optional()
            .describe("Raw text body. Use for kind='text'."),
          sourceUrl: z
            .string()
            .optional()
            .describe("URL to fetch and store as a blob. Use for kind='image' or 'pdf'."),
          externalUrl: z
            .string()
            .optional()
            .describe("URL to keep as a pointer (no download). Use for kind='url'."),
          description: z
            .string()
            .optional()
            .describe("Optional human description. Improves semantic lookup, especially for binaries."),
          tags: z.array(z.string()).optional(),
          source: z
            .string()
            .optional()
            .describe("Where the file came from: 'imessage', 'gmail', 'drive', 'web', etc."),
        },
        async (args) => {
          const fileId = randomId("file");
          const provided = [args.content, args.sourceUrl, args.externalUrl].filter(
            (v) => typeof v === "string" && v.length > 0,
          );
          if (provided.length !== 1) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `save_file requires exactly one of: content, sourceUrl, externalUrl. Got ${provided.length}.`,
                },
              ],
            };
          }

          if (args.sourceUrl) {
            await convex.action(api.files.ingestRemote, {
              fileId,
              name: args.name,
              sourceUrl: args.sourceUrl,
              kind: args.kind,
              description: args.description,
              tags: args.tags,
              source: args.source,
              conversationId,
            });
          } else {
            await convex.mutation(api.files.save, {
              fileId,
              name: args.name,
              kind: args.kind,
              content: args.content,
              externalUrl: args.externalUrl,
              description: args.description,
              tags: args.tags,
              source: args.source,
              conversationId,
            });
          }

          await attachEmbedding(
            fileId,
            buildEmbeddingText({
              name: args.name,
              description: args.description,
              content: args.content,
              tags: args.tags,
            }),
          );

          return {
            content: [
              {
                type: "text" as const,
                text: `Saved as ${fileId} (kind=${args.kind}, name="${args.name}").`,
              },
            ],
          };
        },
      ),

      tool(
        "lookup_file",
        `Look up a saved file by name and/or content. Use BEFORE spawning an integration agent — if the user previously saved or cached the file, this returns it instantly.

Mode:
  - "name" (default): substring match on name + tags. Best for "pull up my office address".
  - "semantic": vector search on (name+description+content). Best for "find that note about espresso settings".
  - "both": name first, fall back to semantic if no name hits.

Returns up to N files with id, name, kind, and (for binaries) a fetchable storage URL.`,
        {
          query: z.string().describe("What the user is looking for."),
          mode: z.enum(["name", "semantic", "both"]).optional(),
          limit: z.number().optional(),
        },
        async (args) => {
          const mode = args.mode ?? "both";
          const limit = args.limit ?? 5;

          const formatHit = async (record: any, score?: number) => {
            const url = record.storageId
              ? await convex.query(api.files.getStorageUrl, { fileId: record.fileId })
              : record.externalUrl ?? null;
            await convex.mutation(api.files.markAccessed, { fileId: record.fileId });
            return {
              fileId: record.fileId,
              name: record.name,
              kind: record.kind,
              source: record.source ?? null,
              description: record.description ?? null,
              tags: record.tags ?? [],
              content: record.kind === "text" ? record.content ?? null : null,
              url,
              createdAt: record.createdAt,
              score: score ?? null,
            };
          };

          let hits: any[] = [];

          if (mode === "name" || mode === "both") {
            const named = await convex.query(api.files.getByName, {
              query: args.query,
              limit,
            });
            hits = await Promise.all(named.map((r: any) => formatHit(r)));
          }

          if ((mode === "semantic" || mode === "both") && hits.length === 0) {
            const vec = await embed(args.query);
            if (vec) {
              const semantic = await convex.action(api.files.vectorSearch, {
                embedding: vec,
                limit,
              });
              hits = await Promise.all(
                semantic.map((s: any) => formatHit(s.record, s.score)),
              );
            }
          }

          if (hits.length === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `No saved files matched "${args.query}". (Lookup is over the local cache only — if the user expects this from email/drive, spawn an agent against the relevant integration.)`,
                },
              ],
            };
          }

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ hits }, null, 2),
              },
            ],
          };
        },
      ),

      tool(
        "list_files",
        "List recently saved files, optionally filtered by tag. Use when the user asks 'what files do I have?' or 'what did I save?'.",
        {
          tag: z.string().optional(),
          limit: z.number().optional(),
        },
        async (args) => {
          const rows = await convex.query(api.files.list, {
            tag: args.tag,
            limit: args.limit ?? 25,
          });
          if (rows.length === 0) {
            return {
              content: [{ type: "text" as const, text: "No saved files." }],
            };
          }
          const body = rows
            .map(
              (r: any) =>
                `• [${r.fileId}] ${r.name} (${r.kind}${r.source ? `, ${r.source}` : ""})${r.description ? ` — ${r.description}` : ""}`,
            )
            .join("\n");
          return { content: [{ type: "text" as const, text: body }] };
        },
      ),

      tool(
        "delete_file",
        "Permanently delete a saved file by fileId. Use when the user says 'delete the office address' or similar.",
        { fileId: z.string() },
        async (args) => {
          const removed = await convex.mutation(api.files.remove, {
            fileId: args.fileId,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: removed
                  ? `Deleted ${args.fileId}.`
                  : `No file with id ${args.fileId}.`,
              },
            ],
          };
        },
      ),
  ];

  const attachTool = onAttach
    ? [
        tool(
          "attach_file",
          `Attach a saved binary file (image/pdf) to the next iMessage you send the user. Call this AFTER lookup_file or after a sub-agent returns a fileId. The file becomes a true iMessage attachment via SendBlue's media_url, not just a link bubble. Only one attachment per turn — last call wins. Skip for text/url files.`,
          { fileId: z.string() },
          async (args) => {
            const url = await convex.query(api.files.getStorageUrl, {
              fileId: args.fileId,
            });
            if (!url) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `File ${args.fileId} has no storage blob (text or url-pointer file). Include the URL in your reply text instead.`,
                  },
                ],
              };
            }
            onAttach(url);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `OK — will attach ${args.fileId} to the next iMessage send.`,
                },
              ],
            };
          },
        ),
      ]
    : [];

  return createSdkMcpServer({
    name: "boop-files",
    version: "0.1.0",
    tools: [...baseTools, ...attachTool],
  });
}
