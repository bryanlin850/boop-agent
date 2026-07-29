export interface ConnectedIntegrationRecord {
  slug: string;
  connectionId: string;
  status: string;
  alias?: string;
  accountLabel?: string;
  accountEmail?: string;
}

export interface AppleIntegrationSettings {
  enabled: boolean;
  messagesEnabled: boolean;
  notesEnabled: boolean;
  notesWriteEnabled: boolean;
  remindersEnabled: boolean;
}

export interface AppleIntegrationStatus {
  running: boolean;
  source: "desktop-bridge" | "local-server" | "unavailable";
  permissions: Record<string, string> | null;
}

export interface IntegrationSummaryItem {
  slug: string;
  status: string;
  account: string;
  connectionId: string | null;
  kind: "composio" | "local";
  sources?: {
    imessage: { enabled: boolean; permission: string | null };
    notes: {
      enabled: boolean;
      writeEnabled: boolean;
      permission: string | null;
    };
    reminders: { enabled: boolean; permission: string | null };
    calendar: { enabled: boolean; permission: string | null };
  };
}

export function buildIntegrationSummary(
  connected: ConnectedIntegrationRecord[],
  enabledIntegrationNames: string[],
  appleSettings: AppleIntegrationSettings,
  appleStatus: AppleIntegrationStatus | null,
): IntegrationSummaryItem[] {
  const summary: IntegrationSummaryItem[] = connected.map((connection) => ({
    slug: connection.slug,
    status: connection.status,
    account:
      connection.accountLabel ??
      connection.accountEmail ??
      connection.alias ??
      "(unknown)",
    connectionId: connection.connectionId,
    kind: "composio",
  }));

  const summarizedSlugs = new Set(summary.map((item) => item.slug));
  for (const name of enabledIntegrationNames) {
    if (summarizedSlugs.has(name)) continue;

    if (name === "apple" && appleSettings.enabled) {
      const permissions = appleStatus?.permissions;
      summary.push({
        slug: "apple",
        status: "ACTIVE",
        account: "Local Mac",
        connectionId: null,
        kind: "local",
        sources: {
          imessage: {
            enabled: appleSettings.messagesEnabled,
            permission: permissions?.messages ?? null,
          },
          notes: {
            enabled: appleSettings.notesEnabled,
            writeEnabled: appleSettings.notesWriteEnabled,
            permission: permissions?.notes ?? null,
          },
          reminders: {
            enabled: appleSettings.remindersEnabled,
            permission: permissions?.reminders ?? null,
          },
          calendar: {
            enabled: appleStatus?.running === true && appleStatus.source === "desktop-bridge",
            permission: permissions?.calendars ?? null,
          },
        },
      });
      summarizedSlugs.add(name);
      continue;
    }

    summary.push({
      slug: name,
      status: "ACTIVE",
      account: "Local integration",
      connectionId: null,
      kind: "local",
    });
    summarizedSlugs.add(name);
  }

  return summary;
}
