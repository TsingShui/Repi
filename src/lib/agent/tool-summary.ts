/**
 * What a tool call says about itself in the transcript.
 *
 * A tool call is an action, and an action is worth reading in one line: which tool, and on what.
 * The arguments arrive as an object shaped for the tool — a path, a command, a script — and the
 * transcript is read by a person, so each tool's arguments are written the way that person would
 * have written them. Anything unrecognized falls back to the JSON, because a new tool that shows
 * up unsummarized is better than one that shows up blank.
 *
 * This is presentation, so it is bounded: a one-line summary that runs to four hundred characters
 * is a script pasted into a heading.
 */
const LIMIT = 160;

function clip(text: string, limit = LIMIT): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit - 1)}…`;
}

function field(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function toolSummary(name: string, args: unknown): string {
  const record =
    args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {};

  switch (name) {
    case "device": {
      const command = field(record, "command") ?? "";
      const input = field(record, "input");
      const piped = input === null ? "" : ` (${input.split("\n").length} lines to stdin)`;
      return clip(`${command}${piped}`);
    }
    case "device_pull":
      return clip(
        `${field(record, "remote") ?? ""}${field(record, "path") ? ` → ${field(record, "path")}` : ""}`,
      );
    case "device_push": {
      const source = field(record, "source");
      const content = field(record, "content");
      const what = source !== null ? source : `${content?.length ?? 0} characters`;
      return clip(`${what} → ${field(record, "remote") ?? ""}`);
    }
    case "read": {
      const offset = record.offset;
      const limit = record.limit;
      const window =
        typeof offset === "number" || typeof limit === "number"
          ? ` lines ${typeof offset === "number" ? offset : 1}+${typeof limit === "number" ? `, ${limit} of them` : ""}`
          : "";
      return clip(`${field(record, "path") ?? ""}${window}`);
    }
    case "write":
      return clip(`${field(record, "path") ?? ""} (${(field(record, "text") ?? "").length} characters)`);
    case "edit":
      return clip(
        `${field(record, "path") ?? ""}: ${JSON.stringify(clip(field(record, "old") ?? "", 40))} → ${JSON.stringify(clip(field(record, "new") ?? "", 40))}`,
      );
    case "run_js": {
      // The transcript is an activity trace, not another code editor. Showing the source in the
      // call's own shape is enough to say what ran; engine output belongs to the agent's answer.
      const code = clip(field(record, "code") ?? "", LIMIT - 14);
      return `[${JSON.stringify(code)}]`;
    }
    case "list_binaries":
      return "";
    default: {
      const json = JSON.stringify(record);
      return json === "{}" ? "" : clip(json);
    }
  }
}
