import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  mutation: vi.fn(),
  spawnExecutionAgent: vi.fn(),
}));

vi.mock("../server/convex-client.js", () => ({
  convex: {
    query: mocks.query,
    mutation: mocks.mutation,
  },
}));

vi.mock("../server/execution-agent.js", () => ({
  spawnExecutionAgent: mocks.spawnExecutionAgent,
}));

import { createDraftDecisionTools } from "../server/draft-tools.js";

describe("approved draft execution context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockResolvedValue({
      draftId: "draft-apple-1",
      conversationId: "conversation-1",
      kind: "apple.notes.append",
      summary: "Append the approved project update",
      payload: JSON.stringify({
        note_id: "note-1",
        content: "Approved text",
        expected_version: "20260724090000",
      }),
      status: "pending",
    });
    mocks.mutation.mockResolvedValue(null);
    mocks.spawnExecutionAgent.mockResolvedValue({
      agentId: "agent-1",
      result: "Done",
      status: "completed",
    });
  });

  it("threads the exact approved draft into the execution agent", async () => {
    const sendDraft = createDraftDecisionTools("conversation-1").find(
      (candidate) => candidate.name === "send_draft",
    );
    if (!sendDraft) throw new Error("Missing send_draft tool");

    const result = await sendDraft.handle({
      draftId: "draft-apple-1",
      integrations: ["apple"],
    });

    expect(result.success).toBe(true);
    expect(mocks.spawnExecutionAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        integrations: ["apple"],
        approvedDraft: {
          draftId: "draft-apple-1",
          kind: "apple.notes.append",
          payload: JSON.stringify({
            note_id: "note-1",
            content: "Approved text",
            expected_version: "20260724090000",
          }),
        },
      }),
    );
  });
});
