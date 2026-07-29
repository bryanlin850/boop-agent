import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const OSASCRIPT_BIN = "/usr/bin/osascript";
const NOTES_TIMEOUT_MS = 15_000;
const NOTES_MAX_BUFFER = 5 * 1024 * 1024;
const NOTE_BODY_LIMIT = 40_000;
const NOTE_WRITE_LIMIT = 40_000;
export const APPLE_NOTE_VERSION_PATTERN = /^\d{14}$/;

export const LOCAL_NOTES_UNSUPPORTED_MESSAGE =
  "Local Apple Notes access is only available on macOS.";

export const LOCAL_NOTES_ACCESS_MESSAGE =
  "Boop needs macOS Automation permission to access Apple Notes. When prompted, allow Boop or the terminal app running npm run dev to control Notes. You can also enable it in System Settings -> Privacy & Security -> Automation.";

export type LocalNotesPermission = "granted" | "denied" | "notDetermined";

let cachedNotesPermission: LocalNotesPermission = "notDetermined";

interface RawNoteSummary {
  id: string;
  name: string;
  folder: string;
  modifiedAt: string | null;
  version: string;
  snippet: string;
}

interface RawNote {
  id: string;
  name: string;
  folder: string;
  modifiedAt: string | null;
  version: string;
  body: string;
}

export interface LocalNoteSummary {
  id: string;
  name: string;
  folder: string;
  modifiedAt: string | null;
  version: string;
  snippet: string;
}

export interface LocalNote {
  id: string;
  name: string;
  folder: string;
  modifiedAt: string | null;
  version: string;
  body: string;
}

export interface CreateLocalNoteInput {
  title: string;
  body?: string;
  folder?: string;
}

export interface UpdateLocalNoteInput {
  title?: string;
  body?: string;
  expectedVersion: string;
}

function isMac(): boolean {
  return process.platform === "darwin";
}

function capLimit(input: number | undefined, fallback: number): number {
  if (!Number.isFinite(input ?? NaN)) return fallback;
  return Math.max(1, Math.min(Math.trunc(input!), 50));
}

function normalizeNotesError(err: unknown): Error {
  const signal = typeof (err as { signal?: unknown })?.signal === "string"
    ? (err as { signal: string }).signal
    : "";
  const killed = Boolean((err as { killed?: unknown })?.killed);
  const stderr = typeof (err as { stderr?: unknown })?.stderr === "string"
    ? ((err as { stderr: string }).stderr.trim())
    : "";
  const text = stderr || (err instanceof Error ? err.message : String(err));
  if (
    text.includes("Not authorized to send Apple events") ||
    text.includes("not authorized to send Apple events") ||
    text.includes("Application isn") ||
    text.includes("-1743") ||
    text.includes("-1744") ||
    text.includes("User canceled") ||
    text.includes("Operation not permitted")
  ) {
    return new Error(LOCAL_NOTES_ACCESS_MESSAGE);
  }
  if (killed || signal === "SIGTERM" || text.includes("timed out") || text.includes("SIGTERM")) {
    return new Error("Apple Notes was too slow to return data before the read timeout. Try again with a smaller limit.");
  }
  if (text.includes("Apple Note was not found")) {
    return new Error("Apple Note was not found.");
  }
  if (text.includes("Apple Notes folder was not found")) {
    return new Error("Apple Notes folder was not found.");
  }
  if (text.includes("Apple Note changed since approval")) {
    return new Error(
      "Apple Note changed since it was approved. Search for it again and ask the user to approve the updated change.",
    );
  }
  if (text.includes("syntax error")) {
    return new Error("Local Apple Notes access failed: AppleScript syntax error.");
  }
  return new Error(`Local Apple Notes access failed: ${text}`);
}

function isPermissionError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes(LOCAL_NOTES_ACCESS_MESSAGE);
}

function createInputDelimiter(inputs: string[]): string {
  let delimiter: string;
  do {
    delimiter = `BOOP-NOTES-${randomUUID()}`;
  } while (inputs.some((input) => input.includes(delimiter)));
  return delimiter;
}

async function runNotesScript<T>(script: string, inputs: string[]): Promise<T> {
  if (!isMac()) throw new Error(LOCAL_NOTES_UNSUPPORTED_MESSAGE);
  if (!existsSync(OSASCRIPT_BIN)) {
    throw new Error("osascript is required to access Apple Notes, but /usr/bin/osascript was not found.");
  }

  const inputDirectory = await mkdtemp(join(tmpdir(), "boop-notes-"));
  const inputPath = join(inputDirectory, "input.txt");
  const inputDelimiter = createInputDelimiter(inputs);

  let stdout: string;
  try {
    // AppleScript's `system attribute` misdecodes non-ASCII environment bytes.
    // Pass only this ASCII path/delimiter through the environment and read the
    // actual values from a private UTF-8 file. The final empty field preserves
    // an intentionally empty last input (for example an omitted folder/body).
    await writeFile(inputPath, [...inputs, ""].join(inputDelimiter), {
      encoding: "utf8",
      mode: 0o600,
    });
    ({ stdout } = await execFileAsync(
      OSASCRIPT_BIN,
      ["-e", script],
      {
        timeout: NOTES_TIMEOUT_MS,
        maxBuffer: NOTES_MAX_BUFFER,
        env: {
          ...process.env,
          BOOP_NOTES_INPUT_PATH: inputPath,
          BOOP_NOTES_INPUT_DELIMITER: inputDelimiter,
        },
      },
    ));
  } catch (err) {
    throw normalizeNotesError(err);
  } finally {
    await rm(inputDirectory, { recursive: true, force: true }).catch(() => {});
  }

  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("Apple Notes returned an empty response.");
  try {
    const parsed = JSON.parse(trimmed) as T;
    cachedNotesPermission = "granted";
    return parsed;
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`Apple Notes returned unreadable data: ${err.message}`);
    }
    throw err;
  }
}

function capWriteText(value: string, label: string, allowEmpty = false): string {
  const normalized = value.replace(/\r\n?/g, "\n");
  if (!allowEmpty && !normalized.trim()) {
    throw new Error(`${label} is required.`);
  }
  if (normalized.length > NOTE_WRITE_LIMIT) {
    throw new Error(`${label} is too long. Apple Notes writes are limited to ${NOTE_WRITE_LIMIT} characters.`);
  }
  return normalized;
}

export function normalizeAppleNoteVersion(value: string): string {
  const normalized = value.trim();
  if (!APPLE_NOTE_VERSION_PATTERN.test(normalized)) {
    throw new Error("Apple Note version is invalid. Search for the note again before editing it.");
  }
  return normalized;
}

export function plainTextToNoteHtml(value: string): string {
  const escaped = value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
  return escaped
    .split("\n")
    .map((line) => `<div>${line || "<br>"}</div>`)
    .join("");
}

function mapRawNote(note: RawNote): LocalNote {
  return {
    id: note.id,
    name: note.name,
    folder: note.folder,
    modifiedAt: note.modifiedAt,
    version: normalizeAppleNoteVersion(note.version),
    body: note.body.length > NOTE_BODY_LIMIT
      ? `${note.body.slice(0, NOTE_BODY_LIMIT)}\n[truncated]`
      : note.body,
  };
}

export async function searchLocalNotes(query: string, limit?: number): Promise<LocalNoteSummary[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const rows = await runNotesScript<RawNoteSummary[]>(SEARCH_NOTES_SCRIPT, [
    trimmed,
    String(capLimit(limit, 10)),
  ]);

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    folder: row.folder,
    modifiedAt: row.modifiedAt,
    version: normalizeAppleNoteVersion(row.version),
    snippet: row.snippet,
  }));
}

export function getCachedLocalNotesAccess(): LocalNotesPermission {
  if (!isMac()) return "denied";
  return cachedNotesPermission;
}

export async function requestLocalNotesAccess(): Promise<LocalNotesPermission> {
  if (!isMac() || !existsSync(OSASCRIPT_BIN)) {
    cachedNotesPermission = "denied";
    return cachedNotesPermission;
  }
  try {
    await runNotesScript<{ ok: boolean }>(REQUEST_NOTES_ACCESS_SCRIPT, []);
    cachedNotesPermission = "granted";
  } catch (err) {
    cachedNotesPermission = isPermissionError(err)
      ? "denied"
      : cachedNotesPermission === "granted"
        ? "granted"
        : "notDetermined";
  }
  return cachedNotesPermission;
}

export async function readLocalNote(noteId: string): Promise<LocalNote> {
  const trimmed = noteId.trim();
  if (!trimmed) throw new Error("Apple Note id is required.");

  const note = await runNotesScript<RawNote>(READ_NOTE_SCRIPT, [trimmed]);

  return mapRawNote(note);
}

export async function createLocalNote(input: CreateLocalNoteInput): Promise<LocalNote> {
  const title = capWriteText(input.title.trim(), "Apple Note title");
  const body = capWriteText(input.body ?? "", "Apple Note body", true);
  const note = await runNotesScript<RawNote>(CREATE_NOTE_SCRIPT, [
    title,
    plainTextToNoteHtml(body),
    input.folder?.trim() ?? "",
  ]);
  return mapRawNote(note);
}

export async function appendLocalNote(
  noteId: string,
  content: string,
  expectedVersion: string,
): Promise<LocalNote> {
  const trimmedId = noteId.trim();
  if (!trimmedId) throw new Error("Apple Note id is required.");
  const expected = normalizeAppleNoteVersion(expectedVersion);
  const appendText = capWriteText(content, "Apple Note append content");
  const note = await runNotesScript<RawNote>(APPEND_NOTE_SCRIPT, [
    trimmedId,
    expected,
    `<div><br></div>${plainTextToNoteHtml(appendText)}`,
  ]);
  return mapRawNote(note);
}

export async function updateLocalNote(
  noteId: string,
  input: UpdateLocalNoteInput,
): Promise<LocalNote> {
  const trimmedId = noteId.trim();
  if (!trimmedId) throw new Error("Apple Note id is required.");
  const expected = normalizeAppleNoteVersion(input.expectedVersion);
  if (input.title === undefined && input.body === undefined) {
    throw new Error("Apple Note update requires a title or body.");
  }
  const title = input.title === undefined
    ? ""
    : capWriteText(input.title.trim(), "Apple Note title");
  const body = input.body === undefined
    ? ""
    : capWriteText(input.body, "Apple Note body", true);
  const note = await runNotesScript<RawNote>(UPDATE_NOTE_SCRIPT, [
    trimmedId,
    expected,
    input.title === undefined ? "false" : "true",
    title,
    input.body === undefined ? "false" : "true",
    plainTextToNoteHtml(body),
  ]);
  return mapRawNote(note);
}

const APPLESCRIPT_HELPERS = String.raw`
on replaceText(findText, replaceText, sourceText)
  set AppleScript's text item delimiters to findText
  set textItems to every text item of sourceText
  set AppleScript's text item delimiters to replaceText
  set resultText to textItems as text
  set AppleScript's text item delimiters to ""
  return resultText
end replaceText

on jsonString(sourceValue)
  set sourceText to sourceValue as text
  set sourceText to my replaceText("\\", "\\\\", sourceText)
  set sourceText to my replaceText("\"", "\\\"", sourceText)
  set sourceText to my replaceText(return, "\\n", sourceText)
  set sourceText to my replaceText(linefeed, "\\n", sourceText)
  set sourceText to my replaceText(tab, "\\t", sourceText)
  return "\"" & sourceText & "\""
end jsonString

on jsonNullableString(sourceValue)
  if sourceValue is missing value then return "null"
  if sourceValue is "" then return "null"
  return my jsonString(sourceValue)
end jsonNullableString

on joinJson(jsonItems)
  set AppleScript's text item delimiters to ","
  set resultText to jsonItems as text
  set AppleScript's text item delimiters to ""
  return resultText
end joinJson

on splitText(delimiterText, sourceText)
  set AppleScript's text item delimiters to delimiterText
  set resultItems to every text item of sourceText
  set AppleScript's text item delimiters to ""
  return resultItems
end splitText

on readInputValues()
  set inputPath to system attribute "BOOP_NOTES_INPUT_PATH"
  set inputDelimiter to system attribute "BOOP_NOTES_INPUT_DELIMITER"
  set inputText to read POSIX file inputPath as «class utf8»
  return my splitText(inputDelimiter, inputText)
end readInputValues

on noteFolderName(aNote)
  try
    tell application "Notes"
      return name of container of aNote as text
    end tell
  on error
    return "Notes"
  end try
end noteFolderName

on noteModifiedAt(aNote)
  try
    tell application "Notes"
      return modification date of aNote as text
    end tell
  on error
    return ""
  end try
end noteModifiedAt

on twoDigit(numberValue)
  set valueText to ((numberValue as integer) as text)
  if (length of valueText) is 1 then return "0" & valueText
  return valueText
end twoDigit

on dateVersion(dateValue)
  set yearText to (((year of dateValue) as integer) as text)
  set monthText to my twoDigit((month of dateValue) as integer)
  set dayText to my twoDigit(day of dateValue)
  set hourText to my twoDigit(hours of dateValue)
  set minuteText to my twoDigit(minutes of dateValue)
  set secondText to my twoDigit(seconds of dateValue)
  return yearText & monthText & dayText & hourText & minuteText & secondText
end dateVersion

on noteVersion(aNote)
  tell application "Notes"
    set modifiedDate to modification date of aNote
  end tell
  return my dateVersion(modifiedDate)
end noteVersion

on noteSnippet(bodyText)
  set cleanText to bodyText as text
  if (length of cleanText) > 240 then
    return (text 1 thru 240 of cleanText) & "..."
  end if
  return cleanText
end noteSnippet
`;

const REQUEST_NOTES_ACCESS_SCRIPT = String.raw`
tell application "Notes"
  set noteCount to count of notes
end tell
return "{\"ok\":true}"
`;

const SEARCH_NOTES_SCRIPT = `${APPLESCRIPT_HELPERS}
set inputValues to my readInputValues()
set queryText to item 1 of inputValues
set maxItemsText to item 2 of inputValues
set maxItems to maxItemsText as integer
set outputRows to {}

tell application "Notes"
  repeat with aNote in every note
    if (count of outputRows) is greater than or equal to maxItems then exit repeat
    set noteName to name of aNote as text
    set noteBody to plaintext of aNote as text
    if noteName contains queryText or noteBody contains queryText then
      set rowJson to "{" & ¬
        "\\"id\\":" & my jsonString(id of aNote) & "," & ¬
        "\\"name\\":" & my jsonString(noteName) & "," & ¬
        "\\"folder\\":" & my jsonString(my noteFolderName(aNote)) & "," & ¬
        "\\"modifiedAt\\":" & my jsonNullableString(my noteModifiedAt(aNote)) & "," & ¬
        "\\"version\\":" & my jsonString(my noteVersion(aNote)) & "," & ¬
        "\\"snippet\\":" & my jsonString(my noteSnippet(noteBody)) & ¬
        "}"
      set end of outputRows to rowJson
    end if
  end repeat
end tell

return "[" & my joinJson(outputRows) & "]"
`;

const READ_NOTE_SCRIPT = `${APPLESCRIPT_HELPERS}
set inputValues to my readInputValues()
set targetId to item 1 of inputValues

tell application "Notes"
  set matchedNotes to every note whose id is targetId
  if (count of matchedNotes) is 0 then
    error "Apple Note was not found."
  end if
  set aNote to item 1 of matchedNotes
  set rowJson to "{" & ¬
    "\\"id\\":" & my jsonString(id of aNote) & "," & ¬
    "\\"name\\":" & my jsonString(name of aNote) & "," & ¬
    "\\"folder\\":" & my jsonString(my noteFolderName(aNote)) & "," & ¬
    "\\"modifiedAt\\":" & my jsonNullableString(my noteModifiedAt(aNote)) & "," & ¬
    "\\"version\\":" & my jsonString(my noteVersion(aNote)) & "," & ¬
    "\\"body\\":" & my jsonString(plaintext of aNote) & ¬
    "}"
end tell

return rowJson
`;

const CREATE_NOTE_SCRIPT = `${APPLESCRIPT_HELPERS}
set inputValues to my readInputValues()
set noteTitle to item 1 of inputValues
set noteBodyHtml to item 2 of inputValues
set folderSelector to item 3 of inputValues

tell application "Notes"
  if folderSelector is "" then
    set targetFolder to default folder of default account
  else
    set matchingFolders to every folder whose id is folderSelector
    if (count of matchingFolders) is 0 then
      set matchingFolders to every folder whose name is folderSelector
    end if
    if (count of matchingFolders) is 0 then
      error "Apple Notes folder was not found."
    end if
    set targetFolder to item 1 of matchingFolders
  end if

  set aNote to make new note at targetFolder with properties {name:noteTitle, body:noteBodyHtml}
  set rowJson to "{" & ¬
    "\\"id\\":" & my jsonString(id of aNote) & "," & ¬
    "\\"name\\":" & my jsonString(name of aNote) & "," & ¬
    "\\"folder\\":" & my jsonString(my noteFolderName(aNote)) & "," & ¬
    "\\"modifiedAt\\":" & my jsonNullableString(my noteModifiedAt(aNote)) & "," & ¬
    "\\"version\\":" & my jsonString(my noteVersion(aNote)) & "," & ¬
    "\\"body\\":" & my jsonString(plaintext of aNote) & ¬
    "}"
end tell

return rowJson
`;

const APPEND_NOTE_SCRIPT = `${APPLESCRIPT_HELPERS}
set inputValues to my readInputValues()
set targetId to item 1 of inputValues
set expectedVersion to item 2 of inputValues
set appendHtml to item 3 of inputValues

tell application "Notes"
  set matchedNotes to every note whose id is targetId
  if (count of matchedNotes) is 0 then
    error "Apple Note was not found."
  end if
  set aNote to item 1 of matchedNotes
  if (my noteVersion(aNote)) is not expectedVersion then
    error "Apple Note changed since approval."
  end if
  set originalName to name of aNote as text
  set body of aNote to ((body of aNote as text) & appendHtml)
  set name of aNote to originalName
  set rowJson to "{" & ¬
    "\\"id\\":" & my jsonString(id of aNote) & "," & ¬
    "\\"name\\":" & my jsonString(name of aNote) & "," & ¬
    "\\"folder\\":" & my jsonString(my noteFolderName(aNote)) & "," & ¬
    "\\"modifiedAt\\":" & my jsonNullableString(my noteModifiedAt(aNote)) & "," & ¬
    "\\"version\\":" & my jsonString(my noteVersion(aNote)) & "," & ¬
    "\\"body\\":" & my jsonString(plaintext of aNote) & ¬
    "}"
end tell

return rowJson
`;

const UPDATE_NOTE_SCRIPT = `${APPLESCRIPT_HELPERS}
set inputValues to my readInputValues()
set targetId to item 1 of inputValues
set expectedVersion to item 2 of inputValues
set shouldSetTitle to (item 3 of inputValues) is "true"
set noteTitle to item 4 of inputValues
set shouldSetBody to (item 5 of inputValues) is "true"
set noteBodyHtml to item 6 of inputValues

tell application "Notes"
  set matchedNotes to every note whose id is targetId
  if (count of matchedNotes) is 0 then
    error "Apple Note was not found."
  end if
  set aNote to item 1 of matchedNotes
  if (my noteVersion(aNote)) is not expectedVersion then
    error "Apple Note changed since approval."
  end if
  set originalName to name of aNote as text
  if shouldSetBody then
    set body of aNote to noteBodyHtml
  end if
  if shouldSetTitle then
    set name of aNote to noteTitle
  else if shouldSetBody then
    set name of aNote to originalName
  end if
  set rowJson to "{" & ¬
    "\\"id\\":" & my jsonString(id of aNote) & "," & ¬
    "\\"name\\":" & my jsonString(name of aNote) & "," & ¬
    "\\"folder\\":" & my jsonString(my noteFolderName(aNote)) & "," & ¬
    "\\"modifiedAt\\":" & my jsonNullableString(my noteModifiedAt(aNote)) & "," & ¬
    "\\"version\\":" & my jsonString(my noteVersion(aNote)) & "," & ¬
    "\\"body\\":" & my jsonString(plaintext of aNote) & ¬
    "}"
end tell

return rowJson
`;
