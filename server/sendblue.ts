import express from "express";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { handleUserMessage } from "./interaction-agent.js";
import { broadcast } from "./broadcast.js";

const API_BASE = "https://api.sendblue.com/api";
const MAX_CHUNK = 2900;

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?|```/g, ""))
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#+\s+/gm, "")
    .replace(/\[(.+?)\]\((.+?)\)/g, "$1 ($2)")
    .trim();
}

function chunk(text: string, size = MAX_CHUNK): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  let buf = "";
  for (const line of text.split(/\n/)) {
    if ((buf + "\n" + line).length > size) {
      if (buf) out.push(buf);
      buf = line;
    } else {
      buf = buf ? buf + "\n" + line : line;
    }
  }
  if (buf) out.push(buf);
  return out;
}

function headers(): Record<string, string> | null {
  const apiKey = process.env.SENDBLUE_API_KEY;
  const apiSecret = process.env.SENDBLUE_API_SECRET;
  if (!apiKey || !apiSecret) return null;
  return {
    "Content-Type": "application/json",
    "sb-api-key-id": apiKey,
    "sb-api-secret-key": apiSecret,
  };
}

// SendBlue's webhook payload uses `media_url` (single string) for inbound
// attachments today; defensively also accept `media_urls` (array) in case
// they ever switch shapes for multi-attachment MMS.
function collectAttachmentUrls(
  mediaUrl: unknown,
  mediaUrls: unknown,
): string[] {
  const out: string[] = [];
  if (typeof mediaUrl === "string" && mediaUrl.length > 0) out.push(mediaUrl);
  if (Array.isArray(mediaUrls)) {
    for (const u of mediaUrls) {
      if (typeof u === "string" && u.length > 0 && !out.includes(u)) out.push(u);
    }
  }
  return out;
}

function normalizeE164(n: string | undefined): string | undefined {
  if (!n) return undefined;
  const trimmed = n.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("+")) return trimmed;
  // Bare US-length numbers get a +1. Longer/shorter just get a leading +.
  if (/^\d{10}$/.test(trimmed)) return `+1${trimmed}`;
  if (/^\d{11,15}$/.test(trimmed)) return `+${trimmed}`;
  return trimmed;
}

export async function sendImessage(
  toNumber: string,
  text: string,
  opts?: { mediaUrl?: string },
): Promise<void> {
  const h = headers();
  if (!h) {
    console.warn("[sendblue] missing credentials — not sending");
    return;
  }
  const from = normalizeE164(process.env.SENDBLUE_FROM_NUMBER);
  if (!from) {
    console.error(
      `[sendblue] SENDBLUE_FROM_NUMBER is not set. Run \`npm run sendblue:sync\` (pulls it from \`sendblue lines\`) or paste your provisioned number into .env.local, then restart \`npm run dev\`.`,
    );
    return;
  }
  const plain = stripMarkdown(text);
  // SendBlue requires a non-empty content. If we only have media to send,
  // give it a single space so the API accepts the request — iMessage just
  // shows the attachment with no caption.
  const parts = plain.trim().length === 0 && opts?.mediaUrl ? [" "] : chunk(plain);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const body: Record<string, unknown> = {
      number: toNumber,
      content: part,
      from_number: from,
    };
    // Attach media on the first chunk only — SendBlue's send-message endpoint
    // takes one media_url per request, and sending it on every chunk would
    // duplicate the file in the user's thread.
    if (opts?.mediaUrl && i === 0) {
      body.media_url = opts.mediaUrl;
    }
    const res = await fetch(`${API_BASE}/send-message`, {
      method: "POST",
      headers: h,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[sendblue] send failed ${res.status}: ${body}`);
      if (body.includes("missing required parameter") && body.includes("from_number")) {
        console.error(
          `[sendblue] → Set SENDBLUE_FROM_NUMBER in .env.local to your Sendblue-provisioned number and restart the server.`,
        );
      } else if (body.includes("Cannot send messages to self")) {
        console.error(
          `[sendblue] → SENDBLUE_FROM_NUMBER is your personal cell. It must be the Sendblue-provisioned number (the one people text TO).`,
        );
      } else if (body.includes("This phone number is not defined")) {
        console.error(
          `[sendblue] → Sendblue doesn't recognize from_number=${from}. Run \`npm run sendblue:sync\` to pull the correct one from \`sendblue lines\`, then restart the server.`,
        );
      }
    } else {
      console.log(`[sendblue] → sent ${part.length} chars to ${toNumber}`);
    }
  }
}

export async function sendTypingIndicator(toNumber: string): Promise<void> {
  const h = headers();
  if (!h) return;
  const from = process.env.SENDBLUE_FROM_NUMBER;
  try {
    await fetch(`${API_BASE}/send-typing-indicator`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ number: toNumber, from_number: from }),
    });
  } catch {
    /* non-fatal */
  }
}

export function startTypingLoop(toNumber: string): () => void {
  sendTypingIndicator(toNumber);
  const timer = setInterval(() => sendTypingIndicator(toNumber), 5000);
  return () => clearInterval(timer);
}

export function createSendblueRouter(): express.Router {
  const router = express.Router();

  router.post("/webhook", async (req, res) => {
    const { content, from_number, is_outbound, message_handle, media_url, media_urls } =
      req.body ?? {};
    // Allow attachment-only messages (image with no caption). SendBlue still
    // sends `content` as an empty string in that case; treat empty-content
    // with attachments as valid input by giving it a placeholder body.
    const attachments = collectAttachmentUrls(media_url, media_urls);
    const hasAttachments = attachments.length > 0;
    const effectiveContent =
      content && content.length > 0 ? content : hasAttachments ? "(attachment)" : "";
    if (is_outbound || !effectiveContent || !from_number) {
      res.json({ ok: true, skipped: true });
      return;
    }

    if (message_handle) {
      const { claimed } = await convex.mutation(api.sendblueDedup.claim, {
        handle: message_handle,
      });
      if (!claimed) {
        res.json({ ok: true, deduped: true });
        return;
      }
    }

    const conversationId = `sms:${from_number}`;
    const turnTag = Math.random().toString(36).slice(2, 8);
    const preview =
      effectiveContent.length > 100 ? effectiveContent.slice(0, 100) + "…" : effectiveContent;
    const attachmentTag = hasAttachments ? ` [+${attachments.length} attachment]` : "";
    console.log(
      `[turn ${turnTag}] ← ${from_number}: ${JSON.stringify(preview)}${attachmentTag}`,
    );
    const start = Date.now();

    broadcast("message_in", {
      conversationId,
      content: effectiveContent,
      from_number,
      handle: message_handle,
      attachments: hasAttachments ? attachments : undefined,
    });
    res.json({ ok: true });

    const stopTyping = startTypingLoop(from_number);
    try {
      const result = await handleUserMessage({
        conversationId,
        content: effectiveContent,
        turnTag,
        attachments: hasAttachments
          ? attachments.map((url) => ({ url }))
          : undefined,
        onThinking: (t) => broadcast("thinking", { conversationId, t }),
      });
      const replyText = result.text;
      if (replyText || result.mediaUrl) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        const replyPreview =
          replyText.length > 100 ? replyText.slice(0, 100) + "…" : replyText;
        const mediaTag = result.mediaUrl ? " [+media]" : "";
        console.log(
          `[turn ${turnTag}] → reply (${elapsed}s, ${replyText.length} chars)${mediaTag}: ${JSON.stringify(replyPreview)}`,
        );
        await sendImessage(from_number, replyText, { mediaUrl: result.mediaUrl });
        await convex.mutation(api.messages.send, {
          conversationId,
          role: "assistant",
          content: replyText,
        });
      } else {
        console.log(`[turn ${turnTag}] → (no reply)`);
      }
    } catch (err) {
      console.error(`[turn ${turnTag}] handler error`, err);
    } finally {
      stopTyping();
    }
  });

  return router;
}
