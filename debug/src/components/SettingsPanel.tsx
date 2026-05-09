import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api.js";

interface ToggleSetting {
  kind: "toggle";
  key: string;
  label: string;
  description: string;
  defaultEnabled: boolean;
}

interface TimezoneSetting {
  kind: "timezone";
  key: string;
  label: string;
  description: string;
}

interface NumberSetting {
  kind: "number";
  key: string;
  label: string;
  description: string;
  defaultValue: number;
  min: number;
  max: number;
  allowZero?: boolean;
  step?: number;
  unit?: string;
}

interface EnumSetting {
  kind: "enum";
  key: string;
  label: string;
  description: string;
  options: Array<{ value: string; label: string }>;
  defaultValue: string;
}

interface TextListSetting {
  kind: "textarea-list";
  key: string;
  label: string;
  description: string;
  placeholder?: string;
}

interface MultiSelectSetting {
  kind: "multiselect";
  key: string;
  label: string;
  description: string;
  options: Array<{ value: string; label: string }>;
}

interface ButtonSetting {
  kind: "button";
  key: string;
  label: string;
  description: string;
  buttonLabel: string;
  confirmText?: string;
  endpoint: string;
}

type Setting =
  | ToggleSetting
  | TimezoneSetting
  | NumberSetting
  | EnumSetting
  | TextListSetting
  | MultiSelectSetting
  | ButtonSetting;

interface Section {
  title: string;
  settings: Setting[];
}

const SECTIONS: Section[] = [
  {
    title: "Agent",
    settings: [
      {
        kind: "toggle",
        key: "proactive_enabled",
        label: "Proactive email surfacing",
        description:
          "Watch new Gmail messages. When something important arrives, you'll get an iMessage. Turn off to silence the watcher entirely without disconnecting Gmail.",
        defaultEnabled: true,
      },
      {
        kind: "timezone",
        key: "user_timezone",
        label: "Your timezone",
        description:
          "Used for deadline checks, 'today', and any time-of-day reasoning. The agent can also update this via iMessage when you tell it your timezone.",
      },
    ],
  },
  {
    title: "Browser (Patchright)",
    settings: [
      {
        kind: "toggle",
        key: "patchright.enabled",
        label: "Enable browser tools",
        description:
          "Master switch for the patchright Chrome automation tools. When off, the execution agent falls back to WebFetch/WebSearch only and the system prompt drops references to browser tools. Default falls back to PATCHRIGHT_BROWSER_ENABLED env var.",
        defaultEnabled: false,
      },
      {
        kind: "toggle",
        key: "patchright.headless",
        label: "Headless mode",
        description:
          "Run Chrome without a visible window. Faster and quieter, but significantly weakens patchright's anti-bot stealth — leave off unless you've verified the target site doesn't bot-check.",
        defaultEnabled: false,
      },
      {
        kind: "enum",
        key: "patchright.channel",
        label: "Browser channel",
        description:
          "Which Chromium-family build to launch. 'chrome' uses the system Chrome (best stealth). 'msedge' uses Edge. 'chromium' uses the bundled binary (no system install needed).",
        options: [
          { value: "chrome", label: "Google Chrome" },
          { value: "msedge", label: "Microsoft Edge" },
          { value: "chromium", label: "Bundled Chromium" },
        ],
        defaultValue: "chrome",
      },
      {
        kind: "number",
        key: "patchright.idleTimeoutMs",
        label: "Idle reaper timeout",
        description:
          "Auto-close a browser session if no tool calls touch it for this many milliseconds. 0 disables. Recommended: 600000 (10 min). Range: 0 or 10000–3600000.",
        defaultValue: 0,
        min: 10_000,
        max: 3_600_000,
        allowZero: true,
        step: 1000,
        unit: "ms",
      },
      {
        kind: "number",
        key: "patchright.maxSessionMs",
        label: "Max session lifetime",
        description:
          "Hard cap on how long any browser session can stay open. 0 disables. Recommended: 1800000 (30 min). Range: 0 or 60000–14400000.",
        defaultValue: 0,
        min: 60_000,
        max: 14_400_000,
        allowZero: true,
        step: 60_000,
        unit: "ms",
      },
      {
        kind: "number",
        key: "patchright.maxElements",
        label: "Snapshot maxElements",
        description:
          "Default cap on interactive elements returned by browser_get_state. Higher = better completeness on complex pages, more tokens per call. Range: 1–200.",
        defaultValue: 80,
        min: 1,
        max: 200,
        step: 1,
      },
      {
        kind: "number",
        key: "patchright.maxTextChars",
        label: "Extract maxChars",
        description:
          "Default cap on text returned by browser_extract_content before truncation. Range: 500–100000.",
        defaultValue: 20_000,
        min: 500,
        max: 100_000,
        step: 500,
      },
      {
        kind: "number",
        key: "patchright.actionTimeoutMs",
        label: "Action timeout",
        description:
          "Per-action timeout for clicks/typing/navigation. Bump for slow real-estate / banking sites. Range: 1000–120000.",
        defaultValue: 15_000,
        min: 1_000,
        max: 120_000,
        step: 1000,
        unit: "ms",
      },
      {
        kind: "toggle",
        key: "patchright.persistentProfile",
        label: "Persistent profile",
        description:
          "Reuse the same Chrome profile dir across sessions so cookies/logins stick. Off = fresh tmpdir per session, deleted on close (privacy mode, no carryover).",
        defaultEnabled: true,
      },
      {
        kind: "textarea-list",
        key: "patchright.domainAllowlist",
        label: "Domain allowlist",
        description:
          "If non-empty, the agent can ONLY navigate to these hostnames (exact or dotted-suffix match). One per line. Empty = no allowlist gate.",
        placeholder: "apartments.com\nzillow.com",
      },
      {
        kind: "textarea-list",
        key: "patchright.domainBlocklist",
        label: "Domain blocklist",
        description:
          "Agent will refuse to navigate to these hostnames (exact or dotted-suffix match). 'bank.com' blocks bank.com and *.bank.com but NOT evilbank.com. One per line.",
        placeholder: "mail.google.com\nbank.com",
      },
      {
        kind: "multiselect",
        key: "patchright.blockResources",
        label: "Block resource types",
        description:
          "Abort selected request types to speed page loads and reduce noise. 'stylesheet' may break some SPAs — leave off unless you know the target tolerates it.",
        options: [
          { value: "image", label: "image" },
          { value: "font", label: "font" },
          { value: "media", label: "media" },
          { value: "stylesheet", label: "stylesheet (risky)" },
        ],
      },
      {
        kind: "button",
        key: "patchright.resetProfiles",
        label: "Reset all browser profiles",
        description:
          "Closes any active browser sessions and deletes everything under data/patchright-browser/. Use when cookies are wedged or after a sensitive logged-in session.",
        buttonLabel: "Reset profiles",
        confirmText:
          "This will close any active browser sessions and delete all saved cookies/logins. Continue?",
        endpoint: "/api/admin/patchright/reset-profiles",
      },
    ],
  },
];

const COMMON_TIMEZONES: Array<{ value: string; label: string }> = [
  { value: "America/New_York", label: "America/New_York (Eastern)" },
  { value: "America/Chicago", label: "America/Chicago (Central)" },
  { value: "America/Denver", label: "America/Denver (Mountain)" },
  { value: "America/Phoenix", label: "America/Phoenix (Arizona)" },
  { value: "America/Los_Angeles", label: "America/Los_Angeles (Pacific)" },
  { value: "America/Anchorage", label: "America/Anchorage (Alaska)" },
  { value: "Pacific/Honolulu", label: "Pacific/Honolulu (Hawaii)" },
  { value: "Europe/London", label: "Europe/London" },
  { value: "Europe/Paris", label: "Europe/Paris" },
  { value: "Europe/Berlin", label: "Europe/Berlin" },
  { value: "Asia/Tokyo", label: "Asia/Tokyo" },
  { value: "Asia/Kolkata", label: "Asia/Kolkata" },
  { value: "Australia/Sydney", label: "Australia/Sydney" },
  { value: "UTC", label: "UTC" },
];

export function SettingsPanel({ isDark }: { isDark: boolean }) {
  const muted = isDark ? "text-slate-500" : "text-slate-400";
  const totalCount = SECTIONS.reduce((n, s) => n + s.settings.length, 0);

  return (
    <div className="flex flex-col h-full -m-5">
      <div
        className={`shrink-0 border-b px-5 py-3 flex items-center gap-3 ${
          isDark ? "border-slate-800" : "border-slate-200"
        }`}
      >
        <h2
          className={`text-xs font-semibold uppercase tracking-wider ${
            isDark ? "text-slate-500" : "text-slate-400"
          }`}
        >
          Agent Settings
        </h2>
        <span className={`text-xs mono ${muted}`}>{totalCount} setting(s)</span>
      </div>

      <div className="flex-1 overflow-y-auto debug-scroll p-5 space-y-6">
        {SECTIONS.map((section) => (
          <div key={section.title} className="space-y-3">
            <h3
              className={`text-[11px] font-semibold uppercase tracking-wider ${
                isDark ? "text-slate-400" : "text-slate-500"
              }`}
            >
              {section.title}
            </h3>
            {section.settings.map((s) => (
              <SettingRow key={s.key} setting={s} isDark={isDark} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function SettingRow({ setting, isDark }: { setting: Setting; isDark: boolean }) {
  switch (setting.kind) {
    case "toggle":
      return <ToggleRow setting={setting} isDark={isDark} />;
    case "timezone":
      return <TimezoneRow setting={setting} isDark={isDark} />;
    case "number":
      return <NumberRow setting={setting} isDark={isDark} />;
    case "enum":
      return <EnumRow setting={setting} isDark={isDark} />;
    case "textarea-list":
      return <TextListRow setting={setting} isDark={isDark} />;
    case "multiselect":
      return <MultiSelectRow setting={setting} isDark={isDark} />;
    case "button":
      return <ButtonRow setting={setting} isDark={isDark} />;
  }
}

function SettingShell({
  label,
  description,
  debugLine,
  control,
  isDark,
}: {
  label: string;
  description: string;
  debugLine: string;
  control: React.ReactNode;
  isDark: boolean;
}) {
  const cardBg = isDark
    ? "bg-slate-900/40 border-slate-800/60"
    : "bg-white border-slate-200";
  return (
    <div
      className={`border rounded-xl p-4 flex items-start justify-between gap-6 fade-in ${cardBg}`}
    >
      <div className="min-w-0 flex-1">
        <div
          className={`text-sm font-medium ${
            isDark ? "text-slate-200" : "text-slate-800"
          }`}
        >
          {label}
        </div>
        <div
          className={`text-xs mt-1 leading-relaxed ${
            isDark ? "text-slate-400" : "text-slate-600"
          }`}
        >
          {description}
        </div>
        <div
          className={`text-[10px] mono mt-2 ${
            isDark ? "text-slate-600" : "text-slate-400"
          }`}
        >
          {debugLine}
        </div>
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

function ToggleRow({
  setting,
  isDark,
}: {
  setting: ToggleSetting;
  isDark: boolean;
}) {
  const value = useQuery(api.settings.get, { key: setting.key });
  const setSetting = useMutation(api.settings.set);

  const loading = value === undefined;
  const enabled = loading
    ? setting.defaultEnabled
    : value === null
      ? setting.defaultEnabled
      : value !== "false";

  async function toggle() {
    if (loading) return;
    await setSetting({ key: setting.key, value: enabled ? "false" : "true" });
  }

  const debugLine = `settings.${setting.key} = ${
    loading
      ? "…"
      : value === null
        ? `(unset, default ${setting.defaultEnabled ? "true" : "false"})`
        : `"${value}"`
  }`;

  return (
    <SettingShell
      label={setting.label}
      description={setting.description}
      debugLine={debugLine}
      isDark={isDark}
      control={
        <button
          onClick={toggle}
          disabled={loading}
          role="switch"
          aria-checked={enabled}
          aria-label={`Toggle ${setting.label}`}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 ${
            loading ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
          } ${
            enabled
              ? isDark
                ? "bg-emerald-500 focus:ring-emerald-500/50 focus:ring-offset-slate-950"
                : "bg-emerald-500 focus:ring-emerald-500/50 focus:ring-offset-white"
              : isDark
                ? "bg-slate-700 focus:ring-slate-500/50 focus:ring-offset-slate-950"
                : "bg-slate-300 focus:ring-slate-400/50 focus:ring-offset-white"
          }`}
        >
          <span
            className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
              enabled ? "translate-x-5" : "translate-x-0.5"
            }`}
          />
        </button>
      }
    />
  );
}

function NumberRow({ setting, isDark }: { setting: NumberSetting; isDark: boolean }) {
  const value = useQuery(api.settings.get, { key: setting.key });
  const setSetting = useMutation(api.settings.set);
  const clearSetting = useMutation(api.settings.clear);

  const loading = value === undefined;
  const stored = !loading && value !== null ? value : null;

  const [draft, setDraft] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!loading) setDraft(stored ?? String(setting.defaultValue));
  }, [loading, stored, setting.defaultValue]);

  function clamp(n: number): number | null {
    if (!Number.isFinite(n)) return null;
    if (setting.allowZero && n === 0) return 0;
    if (n < setting.min || n > setting.max) {
      return Math.max(setting.min, Math.min(setting.max, n));
    }
    return n;
  }

  async function save() {
    const n = Number(draft);
    const clamped = clamp(n);
    if (clamped === null) {
      setError(`"${draft}" isn't a valid number.`);
      return;
    }
    if (clamped !== n) {
      setError(`Clamped to ${clamped} (range ${setting.allowZero ? "0 or " : ""}${setting.min}–${setting.max}).`);
    } else {
      setError(null);
    }
    setSaving(true);
    try {
      await setSetting({ key: setting.key, value: String(clamped) });
      setDraft(String(clamped));
    } finally {
      setSaving(false);
    }
  }

  async function clear() {
    setSaving(true);
    setError(null);
    try {
      await clearSetting({ key: setting.key });
    } finally {
      setSaving(false);
    }
  }

  const debugLine = `settings.${setting.key} = ${
    loading ? "…" : stored === null ? `(unset, default ${setting.defaultValue})` : `"${stored}"`
  }`;

  const inputBg = isDark
    ? "bg-slate-900 border-slate-700 text-slate-200"
    : "bg-white border-slate-300 text-slate-800";
  const btnBg = "bg-sky-600 hover:bg-sky-500 text-white";
  const clearBtnBg = isDark
    ? "text-slate-400 hover:text-slate-200 hover:bg-slate-800"
    : "text-slate-500 hover:text-slate-700 hover:bg-slate-100";

  return (
    <SettingShell
      label={setting.label}
      description={setting.description}
      debugLine={debugLine}
      isDark={isDark}
      control={
        <div className="flex flex-col items-end gap-2 min-w-[220px]">
          <div className="flex items-center gap-2 w-full">
            <input
              type="number"
              value={draft}
              min={setting.allowZero ? 0 : setting.min}
              max={setting.max}
              step={setting.step ?? 1}
              onChange={(e) => setDraft(e.target.value)}
              disabled={saving || loading}
              className={`text-xs px-2 py-1.5 border rounded-md flex-1 mono ${inputBg}`}
            />
            {setting.unit && (
              <span className={`text-[11px] mono ${isDark ? "text-slate-500" : "text-slate-400"}`}>
                {setting.unit}
              </span>
            )}
            <button
              onClick={save}
              disabled={saving || loading || draft === (stored ?? String(setting.defaultValue))}
              className={`text-xs px-3 py-1.5 rounded-md disabled:opacity-50 ${btnBg}`}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
          {stored !== null && (
            <button
              onClick={clear}
              disabled={saving || loading}
              className={`text-[11px] px-2 py-1 rounded-md ${clearBtnBg}`}
            >
              Reset to default
            </button>
          )}
          {error && <div className="text-[11px] text-rose-400">{error}</div>}
        </div>
      }
    />
  );
}

function EnumRow({ setting, isDark }: { setting: EnumSetting; isDark: boolean }) {
  const value = useQuery(api.settings.get, { key: setting.key });
  const setSetting = useMutation(api.settings.set);
  const clearSetting = useMutation(api.settings.clear);

  const loading = value === undefined;
  const stored = !loading && value !== null ? value : null;
  const current = stored ?? setting.defaultValue;

  const [saving, setSaving] = useState(false);

  async function save(next: string) {
    setSaving(true);
    try {
      await setSetting({ key: setting.key, value: next });
    } finally {
      setSaving(false);
    }
  }
  async function clear() {
    setSaving(true);
    try {
      await clearSetting({ key: setting.key });
    } finally {
      setSaving(false);
    }
  }

  const debugLine = `settings.${setting.key} = ${
    loading ? "…" : stored === null ? `(unset, default "${setting.defaultValue}")` : `"${stored}"`
  }`;

  const inputBg = isDark
    ? "bg-slate-900 border-slate-700 text-slate-200"
    : "bg-white border-slate-300 text-slate-800";
  const clearBtnBg = isDark
    ? "text-slate-400 hover:text-slate-200 hover:bg-slate-800"
    : "text-slate-500 hover:text-slate-700 hover:bg-slate-100";

  return (
    <SettingShell
      label={setting.label}
      description={setting.description}
      debugLine={debugLine}
      isDark={isDark}
      control={
        <div className="flex flex-col items-end gap-2 min-w-[220px]">
          <select
            value={current}
            onChange={(e) => save(e.target.value)}
            disabled={saving || loading}
            className={`text-xs px-2 py-1.5 border rounded-md w-full ${inputBg}`}
          >
            {setting.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {stored !== null && (
            <button
              onClick={clear}
              disabled={saving || loading}
              className={`text-[11px] px-2 py-1 rounded-md ${clearBtnBg}`}
            >
              Reset to default
            </button>
          )}
        </div>
      }
    />
  );
}

function TextListRow({ setting, isDark }: { setting: TextListSetting; isDark: boolean }) {
  const value = useQuery(api.settings.get, { key: setting.key });
  const setSetting = useMutation(api.settings.set);
  const clearSetting = useMutation(api.settings.clear);

  const loading = value === undefined;
  const stored = !loading && value !== null ? value : null;

  const [draft, setDraft] = useState<string>("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!loading) setDraft(stored ?? "");
  }, [loading, stored]);

  const lines = useMemo(
    () =>
      draft
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean),
    [draft],
  );

  async function save() {
    setSaving(true);
    try {
      await setSetting({ key: setting.key, value: lines.join("\n") });
    } finally {
      setSaving(false);
    }
  }
  async function clear() {
    setSaving(true);
    try {
      await clearSetting({ key: setting.key });
      setDraft("");
    } finally {
      setSaving(false);
    }
  }

  const debugLine = `settings.${setting.key} = ${
    loading ? "…" : stored === null ? "(unset, [])" : `[${lines.length} entries]`
  }`;

  const inputBg = isDark
    ? "bg-slate-900 border-slate-700 text-slate-200 placeholder:text-slate-600"
    : "bg-white border-slate-300 text-slate-800 placeholder:text-slate-400";
  const btnBg = "bg-sky-600 hover:bg-sky-500 text-white";
  const clearBtnBg = isDark
    ? "text-slate-400 hover:text-slate-200 hover:bg-slate-800"
    : "text-slate-500 hover:text-slate-700 hover:bg-slate-100";

  return (
    <SettingShell
      label={setting.label}
      description={setting.description}
      debugLine={debugLine}
      isDark={isDark}
      control={
        <div className="flex flex-col items-end gap-2 min-w-[280px]">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={setting.placeholder}
            disabled={saving || loading}
            rows={4}
            className={`text-xs px-2 py-1.5 border rounded-md w-full mono ${inputBg}`}
          />
          <div className="flex items-center gap-2">
            <button
              onClick={save}
              disabled={saving || loading || draft === (stored ?? "")}
              className={`text-xs px-3 py-1.5 rounded-md disabled:opacity-50 ${btnBg}`}
            >
              {saving ? "Saving…" : "Save"}
            </button>
            {stored !== null && (
              <button
                onClick={clear}
                disabled={saving || loading}
                className={`text-[11px] px-2 py-1 rounded-md ${clearBtnBg}`}
              >
                Clear
              </button>
            )}
          </div>
        </div>
      }
    />
  );
}

function MultiSelectRow({ setting, isDark }: { setting: MultiSelectSetting; isDark: boolean }) {
  const value = useQuery(api.settings.get, { key: setting.key });
  const setSetting = useMutation(api.settings.set);

  const loading = value === undefined;
  const stored = !loading && value !== null ? value : null;

  const selected = useMemo(() => {
    if (!stored) return new Set<string>();
    const trimmed = stored.trim();
    if (trimmed.startsWith("[")) {
      try {
        const arr = JSON.parse(trimmed);
        if (Array.isArray(arr)) return new Set(arr.map(String));
      } catch {
        // fall through
      }
    }
    return new Set(
      trimmed
        .split(/\r?\n|,/)
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }, [stored]);

  const [saving, setSaving] = useState(false);

  async function toggle(option: string) {
    const next = new Set(selected);
    if (next.has(option)) next.delete(option);
    else next.add(option);
    setSaving(true);
    try {
      await setSetting({ key: setting.key, value: [...next].join(",") });
    } finally {
      setSaving(false);
    }
  }

  const debugLine = `settings.${setting.key} = ${
    loading ? "…" : selected.size === 0 ? "(none)" : `[${[...selected].join(", ")}]`
  }`;

  return (
    <SettingShell
      label={setting.label}
      description={setting.description}
      debugLine={debugLine}
      isDark={isDark}
      control={
        <div className="flex flex-col items-end gap-2 min-w-[220px]">
          {setting.options.map((opt) => {
            const isOn = selected.has(opt.value);
            return (
              <label
                key={opt.value}
                className={`flex items-center gap-2 text-xs cursor-pointer w-full justify-between px-2 py-1 rounded-md ${
                  isDark ? "hover:bg-slate-800/60" : "hover:bg-slate-100"
                }`}
              >
                <span className={isDark ? "text-slate-300" : "text-slate-700"}>{opt.label}</span>
                <input
                  type="checkbox"
                  checked={isOn}
                  disabled={saving || loading}
                  onChange={() => toggle(opt.value)}
                />
              </label>
            );
          })}
        </div>
      }
    />
  );
}

function ButtonRow({ setting, isDark }: { setting: ButtonSetting; isDark: boolean }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function run() {
    if (setting.confirmText && !window.confirm(setting.confirmText)) return;
    setBusy(true);
    setResult(null);
    try {
      const r = await fetch(setting.endpoint, { method: "POST" });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setResult(`Error: ${data.error ?? r.statusText}`);
      } else if (data.closedSessions || data.dirsRemoved) {
        setResult(
          `Closed ${data.closedSessions?.length ?? 0} session(s), removed ${data.dirsRemoved?.length ?? 0} dir(s).`,
        );
      } else {
        setResult("Done.");
      }
    } catch (err) {
      setResult(`Error: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  const debugLine = `POST ${setting.endpoint}`;

  return (
    <SettingShell
      label={setting.label}
      description={setting.description}
      debugLine={debugLine}
      isDark={isDark}
      control={
        <div className="flex flex-col items-end gap-2 min-w-[180px]">
          <button
            onClick={run}
            disabled={busy}
            className="text-xs px-3 py-1.5 rounded-md bg-rose-600 hover:bg-rose-500 text-white disabled:opacity-50"
          >
            {busy ? "Working…" : setting.buttonLabel}
          </button>
          {result && (
            <div className={`text-[11px] ${result.startsWith("Error") ? "text-rose-400" : isDark ? "text-slate-400" : "text-slate-600"}`}>
              {result}
            </div>
          )}
        </div>
      }
    />
  );
}

function TimezoneRow({
  setting,
  isDark,
}: {
  setting: TimezoneSetting;
  isDark: boolean;
}) {
  const value = useQuery(api.settings.get, { key: setting.key });
  const setSetting = useMutation(api.settings.set);
  const clearSetting = useMutation(api.settings.clear);

  const [draft, setDraft] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [now, setNow] = useState<string>("");

  const loading = value === undefined;
  const stored = !loading && value !== null ? value : null;

  useEffect(() => {
    if (!loading) setDraft(stored ?? "");
  }, [loading, stored]);

  useEffect(() => {
    function tick() {
      const tz = stored ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      try {
        const d = new Date();
        const fmt = new Intl.DateTimeFormat(undefined, {
          timeZone: tz,
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          timeZoneName: "short",
        });
        setNow(fmt.format(d));
      } catch {
        setNow("(invalid timezone)");
      }
    }
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [stored]);

  async function save(value: string) {
    const trimmed = value.trim();
    if (!trimmed) {
      setError("Pick a timezone or clear to reset.");
      return;
    }
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: trimmed });
    } catch {
      setError(`"${trimmed}" isn't a recognized IANA timezone.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await setSetting({ key: setting.key, value: trimmed });
    } finally {
      setSaving(false);
    }
  }

  async function clear() {
    setSaving(true);
    setError(null);
    try {
      await clearSetting({ key: setting.key });
      setDraft("");
    } finally {
      setSaving(false);
    }
  }

  const debugLine = `settings.${setting.key} = ${
    loading ? "…" : stored === null ? "(unset, falling back to server zone)" : `"${stored}"`
  }${now ? ` · now: ${now}` : ""}`;

  const inputBg = isDark
    ? "bg-slate-900 border-slate-700 text-slate-200 placeholder:text-slate-600"
    : "bg-white border-slate-300 text-slate-800 placeholder:text-slate-400";
  const btnBg = isDark
    ? "bg-sky-600 hover:bg-sky-500 text-white"
    : "bg-sky-600 hover:bg-sky-500 text-white";
  const clearBtnBg = isDark
    ? "text-slate-400 hover:text-slate-200 hover:bg-slate-800"
    : "text-slate-500 hover:text-slate-700 hover:bg-slate-100";

  return (
    <SettingShell
      label={setting.label}
      description={setting.description}
      debugLine={debugLine}
      isDark={isDark}
      control={
        <div className="flex flex-col items-end gap-2 min-w-[260px]">
          <div className="flex items-center gap-2 w-full">
            <select
              value={
                COMMON_TIMEZONES.some((t) => t.value === draft) ? draft : ""
              }
              onChange={(e) => setDraft(e.target.value)}
              disabled={saving || loading}
              className={`text-xs px-2 py-1.5 border rounded-md flex-1 ${inputBg}`}
            >
              <option value="">— pick a common zone —</option>
              {COMMON_TIMEZONES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2 w-full">
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="or paste IANA ID e.g. America/Chicago"
              disabled={saving || loading}
              className={`text-xs px-2 py-1.5 border rounded-md flex-1 mono ${inputBg}`}
            />
            <button
              onClick={() => save(draft)}
              disabled={saving || loading || draft.trim() === (stored ?? "")}
              className={`text-xs px-3 py-1.5 rounded-md disabled:opacity-50 ${btnBg}`}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
          {stored !== null && (
            <button
              onClick={clear}
              disabled={saving || loading}
              className={`text-[11px] px-2 py-1 rounded-md ${clearBtnBg}`}
            >
              Reset to server default
            </button>
          )}
          {error && <div className="text-[11px] text-rose-400">{error}</div>}
        </div>
      }
    />
  );
}
