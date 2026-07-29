import { describe, expect, it } from "vitest";
import { buildIntegrationSummary } from "../server/integration-summary.js";

describe("buildIntegrationSummary", () => {
  it("includes per-source Apple status alongside Composio accounts", () => {
    const summary = buildIntegrationSummary(
      [
        {
          slug: "gmail",
          connectionId: "ca_gmail",
          status: "ACTIVE",
          accountEmail: "person@example.com",
        },
      ],
      ["gmail", "apple"],
      {
        enabled: true,
        messagesEnabled: false,
        notesEnabled: true,
        notesWriteEnabled: true,
        remindersEnabled: true,
      },
      {
        running: true,
        source: "local-server",
        permissions: {
          messages: "denied",
          notes: "granted",
          reminders: "granted",
          calendars: "notDetermined",
        },
      },
    );

    expect(summary).toEqual([
      {
        slug: "gmail",
        status: "ACTIVE",
        account: "person@example.com",
        connectionId: "ca_gmail",
        kind: "composio",
      },
      {
        slug: "apple",
        status: "ACTIVE",
        account: "Local Mac",
        connectionId: null,
        kind: "local",
        sources: {
          imessage: { enabled: false, permission: "denied" },
          notes: {
            enabled: true,
            writeEnabled: true,
            permission: "granted",
          },
          reminders: { enabled: true, permission: "granted" },
          calendar: { enabled: false, permission: "notDetermined" },
        },
      },
    ]);
  });

  it("omits Apple when the integration is disabled", () => {
    expect(
      buildIntegrationSummary(
        [],
        [],
        {
          enabled: false,
          messagesEnabled: false,
          notesEnabled: false,
          notesWriteEnabled: false,
          remindersEnabled: false,
        },
        null,
      ),
    ).toEqual([]);
  });

  it("includes other enabled local integrations", () => {
    expect(
      buildIntegrationSummary(
        [],
        ["browser"],
        {
          enabled: false,
          messagesEnabled: false,
          notesEnabled: false,
          notesWriteEnabled: false,
          remindersEnabled: false,
        },
        null,
      ),
    ).toEqual([
      {
        slug: "browser",
        status: "ACTIVE",
        account: "Local integration",
        connectionId: null,
        kind: "local",
      },
    ]);
  });
});
