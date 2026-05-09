import { action, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const kindV = v.union(
  v.literal("text"),
  v.literal("image"),
  v.literal("pdf"),
  v.literal("url"),
);

export const save = mutation({
  args: {
    fileId: v.string(),
    name: v.string(),
    kind: kindV,
    content: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
    externalUrl: v.optional(v.string()),
    description: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    source: v.optional(v.string()),
    contentType: v.optional(v.string()),
    conversationId: v.optional(v.string()),
    embedding: v.optional(v.array(v.float64())),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("files")
      .withIndex("by_file_id", (q) => q.eq("fileId", args.fileId))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        name: args.name,
        kind: args.kind,
        content: args.content ?? existing.content,
        storageId: args.storageId ?? existing.storageId,
        externalUrl: args.externalUrl ?? existing.externalUrl,
        description: args.description ?? existing.description,
        tags: args.tags ?? existing.tags,
        source: args.source ?? existing.source,
        contentType: args.contentType ?? existing.contentType,
        embedding: args.embedding ?? existing.embedding,
        lastAccessedAt: now,
      });
      return existing._id;
    }

    return await ctx.db.insert("files", {
      ...args,
      accessCount: 0,
      lastAccessedAt: now,
      createdAt: now,
    });
  },
});

export const setEmbedding = mutation({
  args: { fileId: v.string(), embedding: v.array(v.float64()) },
  handler: async (ctx, args) => {
    const file = await ctx.db
      .query("files")
      .withIndex("by_file_id", (q) => q.eq("fileId", args.fileId))
      .unique();
    if (!file) return null;
    await ctx.db.patch(file._id, { embedding: args.embedding });
    return file._id;
  },
});

export const getById = query({
  args: { fileId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("files")
      .withIndex("by_file_id", (q) => q.eq("fileId", args.fileId))
      .unique();
  },
});

// Substring match on name + tags. Case-insensitive. We pull the most-recent
// 500 files and filter in-memory; for the personal scale this stays cheap.
// Switch to a search index later if file count grows past a few thousand.
export const getByName = query({
  args: { query: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 10;
    const q = args.query.toLowerCase().trim();
    if (!q) return [];
    const recent = await ctx.db.query("files").order("desc").take(500);
    return recent
      .filter((f) => {
        if (f.name.toLowerCase().includes(q)) return true;
        if (f.tags?.some((t) => t.toLowerCase().includes(q))) return true;
        return false;
      })
      .slice(0, limit);
  },
});

export const getByIds = query({
  args: { ids: v.array(v.id("files")) },
  handler: async (ctx, args) => {
    const out = [];
    for (const id of args.ids) {
      const r = await ctx.db.get(id);
      if (r) out.push(r);
    }
    return out;
  },
});

export const vectorSearch = action({
  args: { embedding: v.array(v.float64()), limit: v.optional(v.number()) },
  handler: async (
    ctx,
    args,
  ): Promise<Array<{ _id: Id<"files">; score: number; record: any }>> => {
    const results = await ctx.vectorSearch("files", "by_embedding", {
      vector: args.embedding,
      limit: args.limit ?? 10,
    });
    const records = await ctx.runQuery(api.files.getByIds, {
      ids: results.map((r) => r._id),
    });
    const byId = new Map(records.map((r: any) => [r._id, r]));
    return results
      .map((r) => ({ _id: r._id, score: r._score, record: byId.get(r._id) }))
      .filter((r) => r.record);
  },
});

export const list = query({
  args: { tag: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 50;
    const recent = await ctx.db.query("files").order("desc").take(limit * 2);
    if (args.tag) {
      const tag = args.tag.toLowerCase();
      return recent
        .filter((f) => f.tags?.some((t) => t.toLowerCase() === tag))
        .slice(0, limit);
    }
    return recent.slice(0, limit);
  },
});

export const remove = mutation({
  args: { fileId: v.string() },
  handler: async (ctx, args) => {
    const file = await ctx.db
      .query("files")
      .withIndex("by_file_id", (q) => q.eq("fileId", args.fileId))
      .unique();
    if (!file) return null;
    if (file.storageId) {
      await ctx.storage.delete(file.storageId);
    }
    await ctx.db.delete(file._id);
    return file._id;
  },
});

export const markAccessed = mutation({
  args: { fileId: v.string() },
  handler: async (ctx, args) => {
    const file = await ctx.db
      .query("files")
      .withIndex("by_file_id", (q) => q.eq("fileId", args.fileId))
      .unique();
    if (!file) return null;
    await ctx.db.patch(file._id, {
      accessCount: file.accessCount + 1,
      lastAccessedAt: Date.now(),
    });
    return file._id;
  },
});

// Get a signed URL for a stored blob so the server can echo it back to the
// user via SendBlue's outbound media param. Returns null if the file has no
// blob (e.g. text-only or external URL).
export const getStorageUrl = query({
  args: { fileId: v.string() },
  handler: async (ctx, args) => {
    const file = await ctx.db
      .query("files")
      .withIndex("by_file_id", (q) => q.eq("fileId", args.fileId))
      .unique();
    if (!file?.storageId) return null;
    return await ctx.storage.getUrl(file.storageId);
  },
});

// Store raw bytes (base64) into Convex `_storage` and create a `files` row.
// Used by tools that produce content directly rather than fetching a URL —
// e.g. browser_screenshot. Caller sets embedding via files.setEmbedding.
export const saveBlob = action({
  args: {
    fileId: v.string(),
    name: v.string(),
    kind: kindV,
    base64: v.string(),
    contentType: v.optional(v.string()),
    description: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    source: v.optional(v.string()),
    conversationId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ fileId: string; storageId: Id<"_storage"> }> => {
    const bytes = Uint8Array.from(atob(args.base64), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], {
      type: args.contentType ?? "application/octet-stream",
    });
    const storageId = await ctx.storage.store(blob);
    await ctx.runMutation(api.files.save, {
      fileId: args.fileId,
      name: args.name,
      kind: args.kind,
      storageId,
      description: args.description,
      tags: args.tags,
      source: args.source,
      contentType: args.contentType,
      conversationId: args.conversationId,
    });
    return { fileId: args.fileId, storageId };
  },
});

// Fetch a remote URL, store the blob in Convex `_storage`, and create a
// `files` row pointing at it. Used for both inbound SendBlue attachments
// and files an execution-agent retrieves from Gmail/Drive/etc.
//
// Embedding is set separately by the caller via `files.setEmbedding` so we
// don't need to import the embeddings module here (Convex actions can't
// reach into the server/ tree).
export const ingestRemote = action({
  args: {
    fileId: v.string(),
    name: v.string(),
    sourceUrl: v.string(),
    kind: kindV,
    description: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    source: v.optional(v.string()),
    conversationId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ fileId: string; storageId: Id<"_storage"> }> => {
    const res = await fetch(args.sourceUrl);
    if (!res.ok) {
      throw new Error(`fetch ${args.sourceUrl} failed: ${res.status}`);
    }
    const contentType = res.headers.get("content-type") ?? undefined;
    const blob = await res.blob();
    const storageId = await ctx.storage.store(blob);
    await ctx.runMutation(api.files.save, {
      fileId: args.fileId,
      name: args.name,
      kind: args.kind,
      storageId,
      description: args.description,
      tags: args.tags,
      source: args.source,
      contentType,
      conversationId: args.conversationId,
    });
    return { fileId: args.fileId, storageId };
  },
});
