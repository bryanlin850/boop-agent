import path from "node:path";
import fs from "node:fs/promises";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";

export type PatchrightChannel = "chrome" | "msedge" | "chromium";
export type PatchrightResource = "image" | "font" | "media" | "stylesheet";

export interface PatchrightConfig {
  enabled: boolean;
  headless: boolean;
  channel: PatchrightChannel;
  idleTimeoutMs: number;
  maxSessionMs: number;
  maxElements: number;
  maxTextChars: number;
  actionTimeoutMs: number;
  persistentProfile: boolean;
  domainBlocklist: string[];
  domainAllowlist: string[];
  blockResources: PatchrightResource[];
}

export const PATCHRIGHT_KEYS = [
  "patchright.enabled",
  "patchright.headless",
  "patchright.channel",
  "patchright.idleTimeoutMs",
  "patchright.maxSessionMs",
  "patchright.maxElements",
  "patchright.maxTextChars",
  "patchright.actionTimeoutMs",
  "patchright.persistentProfile",
  "patchright.domainBlocklist",
  "patchright.domainAllowlist",
  "patchright.blockResources",
] as const;

export const PERSISTENT_PROFILE_BASE_DIR = path.resolve(
  process.cwd(),
  process.env.PATCHRIGHT_PROFILE_DIR?.trim() || "data/patchright-browser",
);

const VALID_CHANNELS: PatchrightChannel[] = ["chrome", "msedge", "chromium"];
const VALID_RESOURCES: PatchrightResource[] = ["image", "font", "media", "stylesheet"];

const RANGES = {
  idleTimeoutMs: { min: 10_000, max: 3_600_000, allowZero: true },
  maxSessionMs: { min: 60_000, max: 14_400_000, allowZero: true },
  maxElements: { min: 1, max: 200, allowZero: false },
  maxTextChars: { min: 500, max: 100_000, allowZero: false },
  actionTimeoutMs: { min: 1_000, max: 120_000, allowZero: false },
} as const;

const DEFAULT_IDLE_MS = 0;
const DEFAULT_HARD_MS = 0;
const DEFAULT_MAX_ELEMENTS = 80;
const DEFAULT_MAX_TEXT_CHARS = 20_000;
const DEFAULT_ACTION_TIMEOUT_MS = 15_000;

const TTL_MS = 5_000;
let cached: { at: number; value: PatchrightConfig } | null = null;

function envEnabled(): boolean {
  const v = process.env.PATCHRIGHT_BROWSER_ENABLED;
  if (!v) return false;
  const norm = v.trim().toLowerCase();
  return norm === "1" || norm === "true" || norm === "yes" || norm === "on";
}

function envChannel(): PatchrightChannel {
  const v = process.env.PATCHRIGHT_CHANNEL?.trim().toLowerCase();
  if (v && (VALID_CHANNELS as string[]).includes(v)) return v as PatchrightChannel;
  return "chrome";
}

function parseBool(value: string | null, fallback: boolean, key: string): boolean {
  if (value === null) return fallback;
  const norm = value.trim().toLowerCase();
  if (norm === "true" || norm === "1" || norm === "yes" || norm === "on") return true;
  if (norm === "false" || norm === "0" || norm === "no" || norm === "off") return false;
  console.warn(`[patchright-config] invalid bool for ${key}: ${JSON.stringify(value)} — using default ${fallback}`);
  return fallback;
}

function parseNumber(
  value: string | null,
  fallback: number,
  range: { min: number; max: number; allowZero: boolean },
  key: string,
): number {
  if (value === null) return fallback;
  const trimmed = value.trim();
  // Accept JSON-encoded ("0") or bare ("0").
  let n: number;
  try {
    n = typeof JSON.parse(trimmed) === "number" ? JSON.parse(trimmed) : Number(trimmed);
  } catch {
    n = Number(trimmed);
  }
  if (!Number.isFinite(n)) {
    console.warn(`[patchright-config] invalid number for ${key}: ${JSON.stringify(value)} — using default ${fallback}`);
    return fallback;
  }
  if (range.allowZero && n === 0) return 0;
  if (n < range.min || n > range.max) {
    const clamped = Math.max(range.min, Math.min(range.max, n));
    console.warn(
      `[patchright-config] ${key}=${n} out of range [${range.min}, ${range.max}] — clamped to ${clamped}`,
    );
    return clamped;
  }
  return n;
}

function parseChannel(value: string | null, fallback: PatchrightChannel, key: string): PatchrightChannel {
  if (value === null) return fallback;
  const norm = value.trim().toLowerCase();
  if ((VALID_CHANNELS as string[]).includes(norm)) return norm as PatchrightChannel;
  console.warn(`[patchright-config] invalid channel for ${key}: ${JSON.stringify(value)} — using default ${fallback}`);
  return fallback;
}

function parseStringList(value: string | null, key: string): string[] {
  if (value === null) return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  // Accept JSON array or newline-separated.
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((x: unknown): x is string => typeof x === "string")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean);
      }
    } catch {
      console.warn(`[patchright-config] invalid JSON list for ${key}: ${JSON.stringify(value)}`);
      return [];
    }
  }
  return trimmed
    .split(/\r?\n|,/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function parseResourceSet(value: string | null, key: string): PatchrightResource[] {
  const list = parseStringList(value, key);
  const out: PatchrightResource[] = [];
  for (const item of list) {
    if ((VALID_RESOURCES as string[]).includes(item)) out.push(item as PatchrightResource);
    else console.warn(`[patchright-config] unknown resource type ${JSON.stringify(item)} in ${key}`);
  }
  return out;
}

async function fetchAll(): Promise<Record<string, string | null>> {
  try {
    return await convex.query(api.settings.getMany, { keys: [...PATCHRIGHT_KEYS] });
  } catch (err) {
    console.warn("[patchright-config] settings.getMany failed", err);
    return {};
  }
}

function buildConfig(values: Record<string, string | null>): PatchrightConfig {
  const get = (k: string): string | null => values[k] ?? null;
  return {
    enabled: parseBool(get("patchright.enabled"), envEnabled(), "patchright.enabled"),
    headless: parseBool(get("patchright.headless"), false, "patchright.headless"),
    channel: parseChannel(get("patchright.channel"), envChannel(), "patchright.channel"),
    idleTimeoutMs: parseNumber(get("patchright.idleTimeoutMs"), DEFAULT_IDLE_MS, RANGES.idleTimeoutMs, "patchright.idleTimeoutMs"),
    maxSessionMs: parseNumber(get("patchright.maxSessionMs"), DEFAULT_HARD_MS, RANGES.maxSessionMs, "patchright.maxSessionMs"),
    maxElements: parseNumber(get("patchright.maxElements"), DEFAULT_MAX_ELEMENTS, RANGES.maxElements, "patchright.maxElements"),
    maxTextChars: parseNumber(get("patchright.maxTextChars"), DEFAULT_MAX_TEXT_CHARS, RANGES.maxTextChars, "patchright.maxTextChars"),
    actionTimeoutMs: parseNumber(get("patchright.actionTimeoutMs"), DEFAULT_ACTION_TIMEOUT_MS, RANGES.actionTimeoutMs, "patchright.actionTimeoutMs"),
    persistentProfile: parseBool(get("patchright.persistentProfile"), true, "patchright.persistentProfile"),
    domainBlocklist: parseStringList(get("patchright.domainBlocklist"), "patchright.domainBlocklist"),
    domainAllowlist: parseStringList(get("patchright.domainAllowlist"), "patchright.domainAllowlist"),
    blockResources: parseResourceSet(get("patchright.blockResources"), "patchright.blockResources"),
  };
}

export async function loadPatchrightConfig(): Promise<PatchrightConfig> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
  const values = await fetchAll();
  const config = buildConfig(values);
  cached = { at: Date.now(), value: config };
  return config;
}

export async function isPatchrightEnabled(): Promise<boolean> {
  const config = await loadPatchrightConfig();
  return config.enabled;
}

export function invalidateConfigCache(): void {
  cached = null;
}

/**
 * Exact host match OR dotted-suffix match. Both sides lowercased.
 * "bank.com" matches "bank.com" and "x.bank.com" but NOT "evilbank.com".
 */
export function matchesHostPattern(host: string, pattern: string): boolean {
  const h = host.trim().toLowerCase();
  const p = pattern.trim().toLowerCase();
  if (!h || !p) return false;
  if (h === p) return true;
  return h.endsWith("." + p);
}

export interface HostDecision {
  allowed: boolean;
  reason?: string;
}

export function evaluateHost(host: string, config: PatchrightConfig): HostDecision {
  const h = host.trim().toLowerCase();
  if (!h) return { allowed: false, reason: "empty hostname" };
  if (config.domainAllowlist.length > 0) {
    const ok = config.domainAllowlist.some((p) => matchesHostPattern(h, p));
    if (!ok) {
      return {
        allowed: false,
        reason: `Host ${h} is not in patchright.domainAllowlist (${config.domainAllowlist.join(", ")})`,
      };
    }
  }
  for (const p of config.domainBlocklist) {
    if (matchesHostPattern(h, p)) {
      return { allowed: false, reason: `Host ${h} matches patchright.domainBlocklist entry "${p}"` };
    }
  }
  return { allowed: true };
}

/**
 * Wipe persistent profile dirs. Caller is expected to close active sessions
 * first (see closeAllActiveSessions in patchright-browser.ts) — Chrome holds
 * SingletonLock files and wiping mid-session leaves the browser in undefined
 * state. Returns the list of dir names removed.
 */
export async function wipePersistentProfileDirs(): Promise<string[]> {
  const removed: string[] = [];
  let entries: string[] = [];
  try {
    entries = await fs.readdir(PERSISTENT_PROFILE_BASE_DIR);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return removed;
    throw err;
  }
  for (const entry of entries) {
    const full = path.join(PERSISTENT_PROFILE_BASE_DIR, entry);
    try {
      await fs.rm(full, { recursive: true, force: true });
      removed.push(entry);
    } catch (err) {
      console.warn(`[patchright-config] failed to remove ${full}`, err);
    }
  }
  return removed;
}
