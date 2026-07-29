import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAppleSettings: vi.fn(),
  appendLocalNote: vi.fn(),
  createLocalNote: vi.fn(),
  readLocalNote: vi.fn(),
  searchLocalNotes: vi.fn(),
  updateLocalNote: vi.fn(),
}));

vi.mock("../server/runtime-config.js", () => ({
  getAppleSettings: mocks.getAppleSettings,
}));

vi.mock("../server/apple/notes-local.js", () => ({
  APPLE_NOTE_VERSION_PATTERN: /^\d{14}$/,
  appendLocalNote: mocks.appendLocalNote,
  createLocalNote: mocks.createLocalNote,
  readLocalNote: mocks.readLocalNote,
  searchLocalNotes: mocks.searchLocalNotes,
  updateLocalNote: mocks.updateLocalNote,
}));

import { createAppleTools } from "../server/apple/tools.js";

const note = {
  id: "note-1",
  name: "Project plan",
  folder: "Notes",
  modifiedAt: "Friday, July 24, 2026 at 9:00:00 AM",
  version: "20260724090000",
  body: "Body",
};

function tool(name: string, options: Parameters<typeof createAppleTools>[1] = {}) {
  const result = createAppleTools("apple", options).find((candidate) => candidate.name === name);
  if (!result) throw new Error(`Missing tool ${name}`);
  return result;
}

describe("guarded Apple Notes write tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAppleSettings.mockResolvedValue({
      enabled: true,
      messagesEnabled: false,
      notesEnabled: true,
      notesWriteEnabled: true,
      remindersEnabled: false,
    });
    mocks.appendLocalNote.mockResolvedValue(note);
    mocks.createLocalNote.mockResolvedValue(note);
    mocks.searchLocalNotes.mockResolvedValue([
      {
        ...note,
        snippet: "Body",
      },
    ]);
    mocks.updateLocalNote.mockResolvedValue(note);
  });

  it("exposes create, append, and update without exposing deletion", () => {
    const names = createAppleTools().map((candidate) => candidate.name);
    expect(names).toContain("apple_create_note");
    expect(names).toContain("apple_append_note");
    expect(names).toContain("apple_update_note");
    expect(names.some((name) => name.includes("delete_note"))).toBe(false);
  });

  it("keeps writes behind the separate setting", async () => {
    mocks.getAppleSettings.mockResolvedValue({
      enabled: true,
      messagesEnabled: false,
      notesEnabled: true,
      notesWriteEnabled: false,
      remindersEnabled: false,
    });

    const result = await tool("apple_create_note").handle({
      title: "Project plan",
      body: "Body",
    });

    expect(result.text).toContain("writing is disabled");
    expect(mocks.createLocalNote).not.toHaveBeenCalled();
  });

  it("creates a new note directly when writing is enabled", async () => {
    const result = await tool("apple_create_note").handle({
      title: "Project plan",
      body: "Body",
      folder: "Notes",
    });

    expect(result.success).toBe(true);
    expect(result.text).toContain("Created Apple Note");
    expect(mocks.createLocalNote).toHaveBeenCalledWith({
      title: "Project plan",
      body: "Body",
      folder: "Notes",
    });
  });

  it("returns the ASCII version token needed for an approved edit", async () => {
    const result = await tool("apple_search_notes").handle({
      query: "Project",
    });

    expect(result.success).toBe(true);
    expect(result.text).toContain(`version ${note.version}`);
  });

  it("rejects an existing-note change without an approved draft", async () => {
    const result = await tool("apple_append_note").handle({
      note_id: note.id,
      content: "Next step",
      expected_version: note.version,
    });

    expect(result.success).toBe(false);
    expect(result.text).toContain("requires user confirmation");
    expect(mocks.appendLocalNote).not.toHaveBeenCalled();
  });

  it("rejects arguments that differ from the approved payload", async () => {
    const result = await tool("apple_append_note", {
      approvedDraft: {
        draftId: "draft-1",
        kind: "apple.notes.append",
        payload: JSON.stringify({
          note_id: note.id,
          content: "Approved text",
          expected_version: note.version,
        }),
      },
    }).handle({
      note_id: note.id,
      content: "Different text",
      expected_version: note.version,
    });

    expect(result.success).toBe(false);
    expect(result.text).toContain("do not exactly match");
    expect(mocks.appendLocalNote).not.toHaveBeenCalled();
  });

  it("applies an exact approved append only once", async () => {
    const appendTool = tool("apple_append_note", {
      approvedDraft: {
        draftId: "draft-1",
        kind: "apple.notes.append",
        payload: JSON.stringify({
          note_id: note.id,
          content: "Approved text",
          expected_version: note.version,
        }),
      },
    });
    const args = {
      note_id: note.id,
      content: "Approved text",
      expected_version: note.version,
    };

    const first = await appendTool.handle(args);
    const second = await appendTool.handle(args);

    expect(first.success).toBe(true);
    expect(first.text).toContain("Appended to Apple Note");
    expect(second.success).toBe(false);
    expect(second.text).toContain("already been applied");
    expect(mocks.appendLocalNote).toHaveBeenCalledTimes(1);
  });

  it("passes an exact approved replacement to the local writer", async () => {
    const result = await tool("apple_update_note", {
      approvedDraft: {
        draftId: "draft-2",
        kind: "apple.notes.update",
        payload: JSON.stringify({
          note_id: note.id,
          expected_version: note.version,
          title: "Updated plan",
          body: "Replacement body",
        }),
      },
    }).handle({
      note_id: note.id,
      expected_version: note.version,
      title: "Updated plan",
      body: "Replacement body",
    });

    expect(result.success).toBe(true);
    expect(mocks.updateLocalNote).toHaveBeenCalledWith(note.id, {
      title: "Updated plan",
      body: "Replacement body",
      expectedVersion: note.version,
    });
  });

  it("rejects a localized date where the ASCII version token is required", async () => {
    await expect(
      tool("apple_append_note").handle({
        note_id: note.id,
        content: "Next step",
        expected_version: "Friday, July 24, 2026 at 9:00:00 AM",
      }),
    ).rejects.toThrow();
    expect(mocks.appendLocalNote).not.toHaveBeenCalled();
  });
});
