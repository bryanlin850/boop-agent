import { z } from "zod";
import type { ApprovedDraftExecution } from "../draft-types.js";
import { createClaudeMcpServer } from "../runtimes/claude.js";
import { defineRuntimeTool } from "../runtimes/tool.js";
import { runtimeText, type RuntimeTool } from "../runtimes/types.js";
import { redactContactHandle, redactPhoneNumbers } from "../privacy.js";
import { getAppleSettings } from "../runtime-config.js";
import { appleBridgeRequest, readBridgeInfo } from "./client.js";
import { listLocalChats, readLocalMessages } from "./messages-local.js";
import {
  APPLE_NOTE_VERSION_PATTERN,
  appendLocalNote,
  createLocalNote,
  readLocalNote,
  searchLocalNotes,
  updateLocalNote,
} from "./notes-local.js";
import { listLocalReminders } from "./reminders-local.js";

const NAMESPACE = "apple";

const LOCAL_NOTE =
  "Local data from the user's Mac. iMessage and Reminders are read-only. Apple Notes writes require a separate opt-in; Calendar uses the optional Apple bridge.";
const NOTES_WRITE_LIMIT = 40_000;
const APPLE_NOTE_WRITE_TOOLS = new Set([
  "apple_create_note",
  "apple_append_note",
  "apple_update_note",
]);

interface AppleToolOptions {
  approvedDraft?: ApprovedDraftExecution;
}

const MESSAGE_TEXT_LIMIT = 500;

interface BridgeChat {
  id: number;
  identifier: string;
  displayName: string;
  isGroup: boolean;
  lastMessageAt: string | null;
  participants: string[];
}

interface BridgeMessage {
  id: number;
  chatId: number;
  chatName: string;
  sender: string;
  isFromMe: boolean;
  text: string;
  sentAt: string;
  hasAttachments: boolean;
}

interface BridgeEvent {
  id: string;
  calendar: string;
  title: string;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  location: string | null;
  notes: string | null;
  status: string | null;
}

interface BridgeReminder {
  id: string;
  list: string;
  title: string;
  notes: string | null;
  dueAt: string | null;
  completed: boolean;
  completedAt: string | null;
  createdAt: string | null;
  modifiedAt: string | null;
  priority: number | null;
}

interface BridgeNoteSummary {
  id: string;
  name: string;
  folder: string;
  modifiedAt: string | null;
  version?: string;
  snippet: string;
}

interface BridgeNote {
  id: string;
  name: string;
  folder: string;
  body: string;
}

function ok(text: string) {
  return runtimeText(text);
}

function toolError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return runtimeText(`[apple error] ${message}`, false);
}

async function wrap(fn: () => Promise<string>) {
  try {
    return ok(await fn());
  } catch (err) {
    return toolError(err);
  }
}

function formatChat(chat: BridgeChat): string {
  const participants = chat.participants.map(redactContactHandle).join(", ");
  const name = redactContactHandle(chat.displayName?.trim() || participants || chat.identifier);
  const identifier = redactContactHandle(chat.identifier);
  return `#${chat.id} ${name} (${identifier}) — ${chat.participants.length} participants — last message ${chat.lastMessageAt ?? "unknown"}`;
}

function formatMessage(message: BridgeMessage): string {
  let text = redactPhoneNumbers(message.text?.trim() ?? "");
  if (text.length > MESSAGE_TEXT_LIMIT) text = `${text.slice(0, MESSAGE_TEXT_LIMIT)}…`;
  if (!text && message.hasAttachments) text = "(attachment)";
  return `[${message.sentAt}] ${redactContactHandle(message.sender)}: ${text}`;
}

function formatEvent(event: BridgeEvent): string {
  const when = event.allDay
    ? `${event.startsAt} → ${event.endsAt} (all day)`
    : `${event.startsAt} → ${event.endsAt}`;
  const calendar = redactPhoneNumbers(event.calendar);
  const title = redactPhoneNumbers(event.title);
  const location = event.location ? ` @ ${redactPhoneNumbers(event.location)}` : "";
  return `[${calendar}] ${title} — ${when}${location}`;
}

function formatReminder(reminder: BridgeReminder): string {
  const due = reminder.dueAt ? `due ${reminder.dueAt}` : "no due date";
  const done = reminder.completed ? " — completed" : "";
  const updated = reminder.modifiedAt ? ` — modified ${reminder.modifiedAt}` : "";
  const list = redactPhoneNumbers(reminder.list);
  const title = redactPhoneNumbers(reminder.title);
  return `[${list}] ${title} — ${due}${done}${updated}`;
}

function formatNoteSummary(note: BridgeNoteSummary): string {
  const modified = note.modifiedAt ? ` — modified ${note.modifiedAt}` : "";
  const version = note.version ? ` — version ${note.version}` : "";
  const name = redactPhoneNumbers(note.name);
  const folder = redactPhoneNumbers(note.folder);
  const snippet = redactPhoneNumbers(note.snippet);
  return `${name} (${note.id}) — folder ${folder}${modified}${version}\n  ${snippet}`;
}

async function messagesEnabled(): Promise<boolean> {
  return (await getAppleSettings()).messagesEnabled;
}

async function notesEnabled(): Promise<boolean> {
  return (await getAppleSettings()).notesEnabled;
}

async function notesWriteEnabled(): Promise<boolean> {
  return (await getAppleSettings()).notesWriteEnabled;
}

async function remindersEnabled(): Promise<boolean> {
  return (await getAppleSettings()).remindersEnabled;
}

async function bridgeAvailable(): Promise<boolean> {
  return Boolean(await readBridgeInfo());
}

async function listChats(limit: number | undefined): Promise<BridgeChat[]> {
  if (process.platform === "darwin") {
    try {
      return await listLocalChats(limit);
    } catch (err) {
      if (!(await bridgeAvailable())) throw err;
    }
  }
  const { chats } = await appleBridgeRequest<{ chats: BridgeChat[] }>("/messages/chats", {
    limit,
  });
  return chats;
}

async function listMessages(filters: {
  chat_id?: number;
  participant?: string;
  query?: string;
  since_hours?: number;
  limit?: number;
}): Promise<BridgeMessage[]> {
  if (process.platform === "darwin") {
    try {
      return await readLocalMessages({
        chatId: filters.chat_id,
        participant: filters.participant,
        query: filters.query,
        sinceHours: filters.since_hours,
        limit: filters.limit,
      });
    } catch (err) {
      if (!(await bridgeAvailable())) throw err;
    }
  }
  const { messages } = await appleBridgeRequest<{ messages: BridgeMessage[] }>(
    "/messages/list",
    {
      chatId: filters.chat_id,
      participant: filters.participant,
      query: filters.query,
      sinceHours: filters.since_hours,
      limit: filters.limit,
    },
  );
  return messages;
}

async function listNotes(filters: { query: string; limit?: number }): Promise<BridgeNoteSummary[]> {
  if (process.platform === "darwin") {
    try {
      return await searchLocalNotes(filters.query, filters.limit);
    } catch (err) {
      if (!(await bridgeAvailable())) throw err;
    }
  }
  const { notes } = await appleBridgeRequest<{ notes: BridgeNoteSummary[] }>(
    "/notes/search",
    { query: filters.query, limit: filters.limit },
  );
  return notes;
}

async function getNote(noteId: string): Promise<BridgeNote> {
  if (process.platform === "darwin") {
    try {
      return await readLocalNote(noteId);
    } catch (err) {
      if (!(await bridgeAvailable())) throw err;
    }
  }
  const { note } = await appleBridgeRequest<{ note: BridgeNote }>("/notes/get", {
    id: noteId,
  });
  return note;
}

function canonicalPayload(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const entries = Object.entries(record).filter(([, item]) => item !== undefined);
  if (entries.some(([, item]) => typeof item !== "string")) return null;
  return JSON.stringify(
    Object.fromEntries(
      entries.sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

function requireApprovedNoteDraft(
  approvedDraft: ApprovedDraftExecution | undefined,
  expectedKind: "apple.notes.append" | "apple.notes.update",
  expectedPayload: Record<string, string | undefined>,
  consumed: boolean,
): void {
  if (consumed) {
    throw new Error("This approved Apple Notes change has already been applied.");
  }
  if (!approvedDraft) {
    throw new Error(
      "Changing an existing Apple Note requires user confirmation. Save this action as a draft and apply it only after the user approves it.",
    );
  }
  if (approvedDraft.kind !== expectedKind) {
    throw new Error(
      `Approved draft ${approvedDraft.draftId} is for ${approvedDraft.kind}, not ${expectedKind}.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(approvedDraft.payload);
  } catch {
    throw new Error(`Approved draft ${approvedDraft.draftId} has invalid JSON.`);
  }
  if (canonicalPayload(parsed) !== canonicalPayload(expectedPayload)) {
    throw new Error(
      `Apple Notes arguments do not exactly match approved draft ${approvedDraft.draftId}.`,
    );
  }
}

async function listReminders(filters: {
  list?: string;
  include_completed?: boolean;
  due_within_days?: number;
  limit?: number;
}): Promise<BridgeReminder[]> {
  if (process.platform === "darwin") {
    try {
      return await listLocalReminders({
        list: filters.list,
        includeCompleted: filters.include_completed,
        dueWithinDays: filters.due_within_days,
        limit: filters.limit,
      });
    } catch (err) {
      if (!(await bridgeAvailable())) throw err;
    }
  }
  const { reminders } = await appleBridgeRequest<{ reminders: BridgeReminder[] }>(
    "/reminders/list",
    {
      list: filters.list,
      includeCompleted: filters.include_completed,
      dueWithinDays: filters.due_within_days,
      limit: filters.limit,
    },
  );
  return reminders;
}

export function createAppleTools(
  namespace = NAMESPACE,
  options: AppleToolOptions = {},
): RuntimeTool[] {
  let approvedDraftConsumed = false;
  const tools = [
    defineRuntimeTool(
      namespace,
      "apple_list_chats",
      `List the user's recent iMessage/SMS chats with their numeric chat ids. ${LOCAL_NOTE}`,
      {
        limit: z.number().optional().describe("Max chats to return (default 20)."),
      },
      async ({ limit }) =>
        wrap(async () => {
          if (!(await messagesEnabled())) {
            return "iMessage reads are disabled in Boop Connections. Turn on iMessage under Local Mac to use this tool.";
          }
          const chats = await listChats(limit);
          if (chats.length === 0) return "No chats found.";
          return chats.map(formatChat).join("\n");
        }),
    ),
    defineRuntimeTool(
      namespace,
      "apple_read_messages",
      `Read the user's iMessage/SMS history, newest first, optionally filtered by chat, participant, text query, or recency. ${LOCAL_NOTE}`,
      {
        chat_id: z.number().optional().describe("Numeric chat id from apple_list_chats."),
        participant: z
          .string()
          .optional()
          .describe("Filter by a participant contact name, phone number, or email."),
        query: z.string().optional().describe("Filter to messages containing this text."),
        since_hours: z
          .number()
          .optional()
          .describe("Only messages from the last N hours."),
        limit: z.number().optional().describe("Max messages to return (default 50, max 200)."),
      },
      async ({ chat_id, participant, query, since_hours, limit }) =>
        wrap(async () => {
          if (!(await messagesEnabled())) {
            return "iMessage reads are disabled in Boop Connections. Turn on iMessage under Local Mac to use this tool.";
          }
          const messages = await listMessages({
            chat_id,
            participant,
            query,
            since_hours,
            limit,
          });
          if (messages.length === 0) return "No messages found.";
          return messages.map(formatMessage).join("\n");
        }),
    ),
    defineRuntimeTool(
      namespace,
      "apple_calendar_events",
      `List the user's Apple Calendar events, defaulting to the next 7 days. ${LOCAL_NOTE}`,
      {
        from_date: z
          .string()
          .optional()
          .describe("Range start, ISO 8601 like 2026-06-12 or 2026-06-12T09:00:00Z. Defaults to now."),
        to_date: z
          .string()
          .optional()
          .describe("Range end, ISO 8601 like 2026-06-19 or 2026-06-19T17:00:00Z. Defaults to 7 days out."),
        calendar: z
          .string()
          .optional()
          .describe("Filter by calendar title (case-insensitive) or id."),
      },
      async ({ from_date, to_date, calendar }) =>
        wrap(async () => {
          const { events } = await appleBridgeRequest<{ events: BridgeEvent[] }>(
            "/calendar/events",
            { from: from_date, to: to_date, calendar },
          );
          if (events.length === 0) return "No calendar events found.";
          return events.map(formatEvent).join("\n");
        }),
    ),
    defineRuntimeTool(
      namespace,
      "apple_list_reminders",
      `List the user's Apple Reminders, optionally filtered by list, completion state, or due window. ${LOCAL_NOTE}`,
      {
        list: z.string().optional().describe("Filter by reminder list title or id."),
        include_completed: z
          .boolean()
          .optional()
          .describe("Include completed reminders (default false)."),
        due_within_days: z
          .number()
          .optional()
          .describe("Only reminders due within the next N days."),
        limit: z
          .number()
          .optional()
          .describe("Max reminders to return (default 1, max 20). Larger reads can be slow on macOS."),
      },
      async ({ list, include_completed, due_within_days, limit }) =>
        wrap(async () => {
          if (!(await remindersEnabled())) {
            return "Apple Reminders reads are disabled in Boop Connections. Turn on Apple Reminders under Local Mac to use this tool.";
          }
          const reminders = await listReminders({
            list,
            include_completed,
            due_within_days,
            limit,
          });
          if (reminders.length === 0) return "No reminders found.";
          return reminders.map(formatReminder).join("\n");
        }),
    ),
    defineRuntimeTool(
      namespace,
      "apple_search_notes",
      `Search the user's Apple Notes by text and return matching notes with snippets. ${LOCAL_NOTE}`,
      {
        query: z.string().describe("Text to search note titles and bodies for."),
        limit: z.number().optional().describe("Max notes to return (default 10)."),
      },
      async ({ query, limit }) =>
        wrap(async () => {
          if (!(await notesEnabled())) {
            return "Apple Notes reads are disabled in Boop Connections. Turn on Apple Notes under Local Mac to use this tool.";
          }
          const notes = await listNotes({ query, limit });
          if (notes.length === 0) return "No notes found.";
          return notes.map(formatNoteSummary).join("\n");
        }),
    ),
    defineRuntimeTool(
      namespace,
      "apple_read_note",
      `Read the full plaintext body of one Apple Note by id (from apple_search_notes). ${LOCAL_NOTE}`,
      {
        note_id: z.string().describe("Note id returned by apple_search_notes."),
      },
      async ({ note_id }) =>
        wrap(async () => {
          if (!(await notesEnabled())) {
            return "Apple Notes reads are disabled in Boop Connections. Turn on Apple Notes under Local Mac to use this tool.";
          }
          const note = await getNote(note_id);
          return `${redactPhoneNumbers(note.name)} (folder ${redactPhoneNumbers(note.folder)})\n\n${redactPhoneNumbers(note.body)}`;
        }),
    ),
    defineRuntimeTool(
      namespace,
      "apple_create_note",
      `Create a new Apple Note from a plaintext title and body. This is allowed only when Apple Notes writing is separately enabled. A folder name or id is optional; omit it to use the default Notes folder. ${LOCAL_NOTE}`,
      {
        title: z.string().trim().min(1).max(500).describe("Title for the new note."),
        body: z
          .string()
          .max(NOTES_WRITE_LIMIT)
          .optional()
          .describe("Plaintext note body. Newlines are preserved."),
        folder: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Optional Apple Notes folder name or id."),
      },
      async ({ title, body, folder }) =>
        wrap(async () => {
          if (!(await notesWriteEnabled())) {
            return "Apple Notes writing is disabled. Turn on Allow writes for Apple Notes under Connections → Local Mac.";
          }
          const note = await createLocalNote({ title, body, folder });
          return `Created Apple Note "${redactPhoneNumbers(note.name)}" (${note.id}) in folder ${redactPhoneNumbers(note.folder)}.`;
        }),
    ),
    defineRuntimeTool(
      namespace,
      "apple_append_note",
      `Append plaintext to an existing Apple Note. NEVER call this during the initial request. First save a draft with kind "apple.notes.append" and payload JSON exactly {"note_id":"…","content":"…","expected_version":"…"}, using the note id and ASCII version token from apple_search_notes. This tool only runs after send_draft supplies that exact approved payload. ${LOCAL_NOTE}`,
      {
        note_id: z.string().trim().min(1).describe("Note id returned by apple_search_notes."),
        content: z
          .string()
          .min(1)
          .max(NOTES_WRITE_LIMIT)
          .describe("Plaintext content to append."),
        expected_version: z
          .string()
          .trim()
          .regex(APPLE_NOTE_VERSION_PATTERN)
          .describe("Exact content-backed version token returned by apple_search_notes before approval."),
      },
      async ({ note_id, content, expected_version }) =>
        wrap(async () => {
          if (!(await notesWriteEnabled())) {
            return "Apple Notes writing is disabled. Turn on Allow writes for Apple Notes under Connections → Local Mac.";
          }
          requireApprovedNoteDraft(
            options.approvedDraft,
            "apple.notes.append",
            {
              note_id,
              content,
              expected_version,
            },
            approvedDraftConsumed,
          );
          const note = await appendLocalNote(note_id, content, expected_version);
          approvedDraftConsumed = true;
          return `Appended to Apple Note "${redactPhoneNumbers(note.name)}" (${note.id}).`;
        }),
    ),
    defineRuntimeTool(
      namespace,
      "apple_update_note",
      `Replace the title, plaintext body, or both on an existing Apple Note. NEVER call this during the initial request. First save a draft with kind "apple.notes.update" and payload JSON containing exactly note_id, expected_version, and whichever of title/body will change. Use the note id and ASCII version token from apple_search_notes. This tool only runs after send_draft supplies that exact approved payload. ${LOCAL_NOTE}`,
      {
        note_id: z.string().trim().min(1).describe("Note id returned by apple_search_notes."),
        expected_version: z
          .string()
          .trim()
          .regex(APPLE_NOTE_VERSION_PATTERN)
          .describe("Exact content-backed version token returned by apple_search_notes before approval."),
        title: z.string().trim().min(1).max(500).optional().describe("Replacement note title."),
        body: z
          .string()
          .max(NOTES_WRITE_LIMIT)
          .optional()
          .describe("Replacement plaintext body. Newlines are preserved."),
      },
      async ({ note_id, expected_version, title, body }) =>
        wrap(async () => {
          if (!(await notesWriteEnabled())) {
            return "Apple Notes writing is disabled. Turn on Allow writes for Apple Notes under Connections → Local Mac.";
          }
          if (title === undefined && body === undefined) {
            throw new Error("Apple Note update requires a title or body.");
          }
          requireApprovedNoteDraft(
            options.approvedDraft,
            "apple.notes.update",
            {
              note_id,
              expected_version,
              title,
              body,
            },
            approvedDraftConsumed,
          );
          const note = await updateLocalNote(note_id, {
            title,
            body,
            expectedVersion: expected_version,
          });
          approvedDraftConsumed = true;
          return `Updated Apple Note "${redactPhoneNumbers(note.name)}" (${note.id}).`;
        }),
    ),
  ];

  if (!options.approvedDraft) return tools;

  const approvedWriteTool =
    options.approvedDraft.kind === "apple.notes.append"
      ? "apple_append_note"
      : options.approvedDraft.kind === "apple.notes.update"
        ? "apple_update_note"
        : null;
  return tools.filter(
    (candidate) =>
      !APPLE_NOTE_WRITE_TOOLS.has(candidate.name) ||
      candidate.name === approvedWriteTool,
  );
}

export function createAppleMcp(options: AppleToolOptions = {}) {
  return createClaudeMcpServer(NAMESPACE, createAppleTools(NAMESPACE, options));
}
